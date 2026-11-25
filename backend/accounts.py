import hashlib
import hmac
import json
import re
import secrets
import time
from http.cookies import CookieError, SimpleCookie
from threading import Lock
from urllib.parse import parse_qsl, urlsplit


COOKIE_NAME = "stukach_session"
MAX_COOKIE_NAME = "__Host-stukach_max_session"
SESSION_SECONDS = 8 * 60 * 60
SIGNATURE_SECONDS = 60 * 60
MAX_ID = re.compile(r"[1-9][0-9]{0,18}")


class AccountBanned(Exception):
    pass


class SessionProfiles:
    def __init__(self):
        self.lock = Lock()
        self.profiles = {}
        self.next_cleanup = 0

    def get(self, token_hash):
        with self.lock:
            expiry, profile = self.profiles.get(token_hash, (0, None))
            if expiry > time.time():
                return profile
            self.profiles.pop(token_hash, None)
            return None

    def put(self, token_hash, expiry, profile):
        with self.lock:
            now = time.time()
            if now >= self.next_cleanup:
                for key in [key for key, (deadline, _) in self.profiles.items() if deadline <= now]:
                    del self.profiles[key]
                self.next_cleanup = now + 60
            self.profiles[token_hash] = (expiry, profile)

    def remove(self, token_hash):
        with self.lock:
            self.profiles.pop(token_hash, None)


def ensure_active(connection, account_id):
    if connection.execute(
        "SELECT 1 FROM account_bans WHERE account_id = ? AND active = 1", (account_id,),
    ).fetchone():
        raise AccountBanned("Аккаунт заблокирован проверяющим.")


def clean_text(value, label, limit, *, required=False):
    if not isinstance(value, str):
        raise ValueError(f"{label}: ожидается текст.")
    value = value.strip()
    if len(value) > limit or (required and not value) or "\x00" in value:
        length = f"от 1 до {limit}" if required else f"до {limit}"
        raise ValueError(f"{label}: введите {length} символов.")
    value.encode("utf-8")
    return value


def user_fields(data, *, test):
    max_id, first_name, last_name = data
    if not isinstance(max_id, str) or not MAX_ID.fullmatch(max_id):
        raise ValueError("ID MAX должен содержать от 1 до 19 цифр и начинаться с ненулевой цифры.")
    first_name = clean_text(first_name, "Имя", 80, required=True)
    last_name = clean_text(last_name, "Фамилия", 80, required=test)
    return max_id, first_name, last_name


def verify_max(init_data, token):
    if not isinstance(init_data, str) or not init_data:
        raise ValueError("MAX не передал данные для входа.")
    pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True, max_num_fields=32)
    params = dict(pairs)
    if len(params) != len(pairs):
        raise ValueError("Некорректные данные MAX.")
    signature = params.pop("hash", "")
    fields = "\n".join(f"{key}={value}" for key, value in sorted(params.items()))
    key = hmac.digest(b"WebAppData", token.encode(), "sha256")
    expected = hmac.new(key, fields.encode(), "sha256").hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", signature) or not hmac.compare_digest(expected, signature):
        raise ValueError("Подпись MAX недействительна.")

    try:
        issued = int(params["auth_date"])
        user = json.loads(params["user"])
        if type(user["id"]) is not int:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise ValueError("Некорректные данные профиля MAX.") from None
    if not -60 <= time.time() - issued <= SIGNATURE_SECONDS:
        raise ValueError("Срок входа истёк. Откройте мини-приложение заново в MAX.")
    fields = user_fields((str(user["id"]), user.get("first_name"), user.get("last_name") or ""), test=False)
    photo_url = user.get("photo_url")
    if not isinstance(photo_url, str) or len(photo_url) > 2048:
        photo_url = None
    if photo_url:
        try:
            parsed = urlsplit(photo_url)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
                photo_url = None
        except ValueError:
            photo_url = None
    return fields, photo_url or None


def cookie_token(header, source):
    try:
        cookie = SimpleCookie(header or "")
    except CookieError:
        return None
    names = (MAX_COOKIE_NAME, COOKIE_NAME) if source == "max" else (COOKIE_NAME,)
    for name in names:
        token = cookie.get(name)
        if token is not None and len(token.value) == 43 and token.value.isascii():
            return token.value
    return None


def session_token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest() if token else None


def create_session(connection, source, max_id, old_token):
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(
        "INSERT INTO accounts (source, max_id) VALUES (?, ?) ON CONFLICT (source, max_id) DO NOTHING",
        (source, max_id),
    )
    account = connection.execute(
        "SELECT id FROM accounts WHERE source = ? AND max_id = ?", (source, max_id),
    ).fetchone()
    ensure_active(connection, account["id"])
    current = session_account(connection, old_token, source)
    if current is not None and current["id"] == account["id"]:
        return None, current
    now = int(time.time())
    token = secrets.token_urlsafe(32)
    connection.execute("DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?", (now, old_token))
    token_hash = session_token_hash(token)
    connection.execute(
        "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
        (token_hash, account["id"], now + SESSION_SECONDS),
    )
    return token, session_account(connection, token_hash, source)


def session_account(connection, token_hash, source):
    if token_hash is None:
        return None
    return connection.execute(
        """SELECT accounts.id, accounts.source, accounts.max_id, sessions.review_grant, sessions.expires_at
           FROM sessions JOIN accounts
           ON sessions.account_id = accounts.id
           WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND accounts.source = ?""",
        (token_hash, int(time.time()), source),
    ).fetchone()
