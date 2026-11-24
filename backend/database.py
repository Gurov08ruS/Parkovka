import os
import re
import secrets
import sqlite3 as plaintext_sqlite
import tempfile
from contextlib import closing
from pathlib import Path

from sqlcipher3 import dbapi2 as sqlite3


KEY_PATTERN = re.compile(r"[0-9a-f]{64}")


def key_path(database):
    return database.with_suffix(database.suffix + ".key")


def read_key(database):
    value = key_path(database).read_text(encoding="ascii").strip()
    if not KEY_PATTERN.fullmatch(value):
        raise ValueError("Ключ базы должен содержать 64 строчные шестнадцатеричные цифры.")
    return value


def ensure_key(database):
    path = key_path(database)
    if path.exists():
        return read_key(database)
    if database.exists():
        raise ValueError(f"Не найден ключ существующей базы: {path}")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return read_key(database)
    with os.fdopen(descriptor, "w", encoding="ascii") as key_file:
        key_file.write(secrets.token_hex(32) + "\n")
        key_file.flush()
        os.fsync(key_file.fileno())
    return read_key(database)


def open_database(database):
    key = read_key(database)
    connection = sqlite3.connect(str(database))
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
        os.link(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
