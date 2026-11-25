import os
import re
import secrets
import sqlite3 as plaintext_sqlite
import tempfile
from contextlib import closing, contextmanager
from pathlib import Path

from sqlcipher3 import dbapi2 as sqlite3


KEY_PATTERN = re.compile(r"[0-9a-f]{64}")


class DatabaseKeyError(ValueError):
    pass


def key_path(database):
    return database.with_suffix(database.suffix + ".key")


def decode_key(raw):
    encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    try:
        value = raw.decode(encoding).strip()
    except UnicodeError:
        raise DatabaseKeyError("Не удалось прочитать кодировку ключа базы.") from None
    if value and not KEY_PATTERN.fullmatch(value):
        raise DatabaseKeyError("Ключ базы должен содержать 64 строчные шестнадцатеричные цифры.")
    return value


def read_key(database):
    path = key_path(database)
    try:
        value = decode_key(path.read_bytes())
    except FileNotFoundError:
        raise DatabaseKeyError(f"Не найден ключ базы: {path}") from None
    except OSError as error:
        raise DatabaseKeyError(f"Не удалось прочитать ключ базы: {path}: {error.strerror}") from None
    if not value:
        raise DatabaseKeyError(f"Файл ключа базы пуст: {path}")
    return value


def database_has_data(database):
    try:
        return database.stat().st_size > 0
    except FileNotFoundError:
        return False


@contextmanager
def locked_key_file(path):
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(path, flags, 0o600), "r+b", buffering=0) as key_file:
        descriptor = key_file.fileno()
        if os.name == "nt":
            import msvcrt

            # Lock beyond the key so readers of an existing key can still open it.
            lock_offset = 4096
            key_file.seek(lock_offset)
            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
            key_file.seek(0)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX)
        try:
            yield key_file
        finally:
            if os.name == "nt":
                key_file.seek(lock_offset)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)


def ensure_key(database):
    if database_has_data(database):
        return read_key(database)
    path = key_path(database)
    with locked_key_file(path) as key_file:
        value = decode_key(key_file.read())
        if value:
            return value
        if database_has_data(database):
            raise DatabaseKeyError(f"Нет ключа для существующей базы: {path}")
        value = secrets.token_hex(32)
        key_file.seek(0)
        key_file.write((value + "\n").encode("ascii"))
        key_file.truncate()
        os.fsync(key_file.fileno())
        return value


def open_database(database, *, create=False):
    key = read_key(database)
    mode = "rwc" if create else "rw"
    connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode={mode}", uri=True)
    try:
        connection.execute(f'''PRAGMA key = "x'{key}'"''')
        if not connection.execute("PRAGMA cipher_version").fetchone():
            raise RuntimeError("SQLCipher недоступен.")
        connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection
    except BaseException:
        connection.close()
        raise


def migrate_plaintext(source, destination):
    if not source.is_file():
        raise ValueError(f"Исходная база не найдена: {source}")
    if destination.exists():
        raise ValueError(f"Зашифрованная база уже существует: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    key = ensure_key(destination)
    descriptor, name = tempfile.mkstemp(prefix=".encrypted-", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        # SQLCipher reads the source through a consistent SQLite transaction.
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Исходная база не прошла проверку целостности.")
            connection.execute(f'''ATTACH DATABASE ? AS encrypted KEY "x'{key}'"''', (str(temporary),))
            connection.execute("SELECT sqlcipher_export('encrypted')").fetchone()
            version = connection.execute("PRAGMA main.user_version").fetchone()[0]
            connection.execute(f"PRAGMA encrypted.user_version = {int(version)}")
            connection.execute("DETACH DATABASE encrypted")
        with closing(sqlite3.connect(str(temporary))) as connection:
            connection.execute(f'''PRAGMA key = "x'{key}'"''')
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Зашифрованная база не прошла проверку целостности.")
        try:
            with closing(plaintext_sqlite.connect(str(temporary))) as connection:
                connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except plaintext_sqlite.DatabaseError:
            pass
        else:
            raise ValueError("Проверка шифрования не пройдена.")
        if os.name == "nt":
            # Windows rename fails if the destination already exists.
            temporary.rename(destination)
        else:
            os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
