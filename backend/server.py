import argparse
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
from contextlib import closing
from functools import partial
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from accounts import (
    AccountBanned, COOKIE_NAME, SESSION_SECONDS, clean_text, cookie_token_hash, create_session, ensure_active,
    session_account, user_fields, verify_max,
)
from device_logs import create_device_logger, log_camera_error, log_location_error

try:
    import sqlcipher3
except ModuleNotFoundError as error:
    if error.name != "sqlcipher3":
        raise
    project = Path(__file__).resolve().parent.parent
    environment = project / ".venv"
    interpreter = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if interpreter.is_file() and Path(sys.prefix).resolve() != environment.resolve():
        os.execv(str(interpreter), [str(interpreter), str(Path(__file__).resolve()), *sys.argv[1:]])
    raise SystemExit(
        "Не установлен SQLCipher. Выполните из папки проекта:\n"
        "python3 -m venv .venv\n"
        ".venv/bin/pip install -r requirements.txt"
    ) from None

from database import ensure_key, migrate_plaintext, sqlite3
from reports import (
    MAX_PHOTO_BYTES, ApiError, change_status, coordinates, create_draft, initialize_database,
    list_reports, open_database, report_detail, report_photo, set_author_ban, submit_report,
)


REPORTS_PATH = "/api/reports"
CAPTURE_PATH = "/api/reports/capture"
REVIEW_PATH = "/api/review"
REPORT_ROUTE = re.compile(r"/api/(reports|review)/([1-9][0-9]{0,18})(?:/photos/(overview|detail))?")
STATUS_ROUTE = re.compile(r"/api/review/([1-9][0-9]{0,18})/status")
BAN_ROUTE = re.compile(r"/api/review/([1-9][0-9]{0,18})/author-ban")
MAX_BODY_BYTES = 16 * 1024
MAX_CAPTURE_BODY_BYTES = 2 * ((MAX_PHOTO_BYTES + 2) // 3) * 4 + MAX_BODY_BYTES
MAX_REPORT_ID = 2**63 - 1
PHOTON_URL = os.environ.get("STUKACH_PHOTON_URL", "https://photon.komoot.io").rstrip("/")
DEFAULT_DATABASE = Path(__file__).parent / "data" / "stukach.encrypted.sqlite3"
LEGACY_DATABASE = Path(__file__).parent / "data" / "stukach.sqlite3"
FRONTEND = Path(__file__).parent.parent / "frontend"


def port_owners(port):
    try:
        result = subprocess.run(
            ["lsof", "-nP", "-Fpc", f"-iTCP:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=2, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    owners = []
    pid = None
    for line in result.stdout.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = line[1:]
        elif line.startswith("c") and pid:
            name = "".join(char for char in line[1:] if char.isprintable())[:100]
            owners.append(f"{name or 'процесс'} (PID {pid})")
            pid = None
    return owners


def reverse_geocode(latitude, longitude):
    query = urlencode({
        "lat": latitude, "lon": longitude, "limit": 1, "radius": 0.2,
    })
    request = Request(
        f"{PHOTON_URL}/reverse?{query}",
        headers={"Accept": "application/json", "User-Agent": "Stukach/0.1"},
    )
    with urlopen(request, timeout=5) as response:
        features = json.loads(response.read(64 * 1024))["features"]
    if not features:
        return None
    place = features[0]["properties"]
    street = place.get("street") or (place.get("name") if place.get("type") == "street" else None)
    if not street:
        return None
    return ", ".join(filter(None, (
        place.get("city") or place.get("locality"), street, place.get("housenumber"),
    )))


class AppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, database, bot_token, reviewer_key, secure_cookie, device_logs, **kwargs):
        self.database = database
        self.device_logs = device_logs
        self.bot_token = bot_token
        self.reviewer_key = reviewer_key
        self.review_grant = hashlib.sha256(reviewer_key.encode()).hexdigest() if reviewer_key else None
        self.secure_cookie = secure_cookie
        self.source = "max" if self.bot_token else "test"
        super().__init__(*args, directory=FRONTEND, **kwargs)

    def send_data(self, status, body, content_type, headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, data, *headers):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_data(status, body, "application/json; charset=utf-8", headers)

    def send_error(self, code, message=None, explain=None):
        self.close_connection = True
        self.send_json(code, {"error": message or HTTPStatus(code).phrase})

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def session_cookie(self, token, max_age):
        cookie = SimpleCookie()
        cookie[COOKIE_NAME] = token
        cookie[COOKIE_NAME]["path"] = "/"
        cookie[COOKIE_NAME]["httponly"] = True
        cookie[COOKIE_NAME]["samesite"] = "Lax"
        cookie[COOKIE_NAME]["max-age"] = max_age
        cookie[COOKIE_NAME]["secure"] = self.secure_cookie
        return ("Set-Cookie", cookie[COOKIE_NAME].OutputString())

    def session_data(self, account):
        user = None
        if account is not None:
            user = {field: account[field] for field in ("max_id", "first_name", "last_name", "photo_url")}
            user["reviewer"] = self.is_reviewer(account)
        return {"mode": self.source, "review_enabled": bool(self.reviewer_key), "user": user}

    def account(self, connection, *, required=True, reviewer=False):
        current = session_account(connection, cookie_token_hash(self.headers.get("Cookie")), self.source)
        if current is None and required:
            raise ApiError(HTTPStatus.UNAUTHORIZED, "Войдите в приложение.")
        if current is not None:
            ensure_active(connection, current["id"])
        if reviewer and not self.is_reviewer(current):
            raise ApiError(HTTPStatus.FORBIDDEN, "Войдите в кабинет проверяющего.")
        return current

    def is_reviewer(self, account):
        return self.review_grant is not None and account["review_grant"] == self.review_grant

    def read_json(self, limit):
        if self.headers.get_content_type() != "application/json":
            raise ApiError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Ожидается JSON.")
        origin = self.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or parsed.netloc != self.headers.get("Host"):
                raise ApiError(HTTPStatus.FORBIDDEN, "Запрос должен быть отправлен с сайта приложения.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            raise ValueError("Ожидается JSON в теле запроса.")
        if length > limit:
            raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Данные запроса слишком большие.")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError("Неполное тело запроса.")
        data = json.loads(body.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("Ожидается объект JSON.")
        return data

    def do_GET(self):
        path = self.path.partition("?")[0]
        if path != "/api" and not path.startswith("/api/"):
            super().do_GET()
            return
        if path == "/api/health":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
            return
        try:
            with closing(open_database(self.database)) as connection:
                self.get_api(path, connection)
        except ApiError as error:
            self.send_error(error.status, str(error))
        except AccountBanned as error:
            self.send_error(HTTPStatus.FORBIDDEN, str(error))
        except sqlite3.Error:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "База данных недоступна.")

    def get_api(self, path, connection):
        if path == "/api/session":
            self.send_json(HTTPStatus.OK, self.session_data(self.account(connection, required=False)))
            return
        if path in (REPORTS_PATH, REVIEW_PATH):
            reviewer = path == REVIEW_PATH
            account = self.account(connection, reviewer=reviewer)
            self.send_json(HTTPStatus.OK, {"reports": list_reports(connection, account, reviewer)})
            return
        route = REPORT_ROUTE.fullmatch(path)
        if route is None or int(route[2]) > MAX_REPORT_ID:
            raise ApiError(HTTPStatus.NOT_FOUND, "Страница не найдена.")
        reviewer = route[1] == "review"
        account = self.account(connection, reviewer=reviewer)
        identifier = int(route[2])
        if route[3]:
            image = report_photo(connection, identifier, route[3], account, reviewer)
            content_type = "image/png" if image.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
            self.send_data(HTTPStatus.OK, image, content_type)
        else:
            self.send_json(HTTPStatus.OK, report_detail(connection, identifier, account, reviewer))

    def do_POST(self):
        path = self.path.partition("?")[0]
        status_route = STATUS_ROUTE.fullmatch(path)
        ban_route = BAN_ROUTE.fullmatch(path)
        if path not in {
            "/api/session", "/api/logout", "/api/profile", "/api/reviewer", "/api/geocode",
            "/api/diagnostics/camera", "/api/diagnostics/location", REPORTS_PATH, CAPTURE_PATH,
        } and status_route is None and ban_route is None:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            limit = MAX_CAPTURE_BODY_BYTES if path == CAPTURE_PATH else MAX_BODY_BYTES
            data = self.read_json(limit)
            with closing(open_database(self.database)) as connection:
                self.post_api(path, status_route, ban_route, data, connection)
        except ApiError as error:
            self.send_error(error.status, str(error))
        except AccountBanned as error:
            self.send_error(HTTPStatus.FORBIDDEN, str(error))
        except (UnicodeError, json.JSONDecodeError, RecursionError):
            self.send_error(HTTPStatus.BAD_REQUEST, "Некорректный JSON в кодировке UTF-8.")
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))
        except sqlite3.Error:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "База данных недоступна.")

    def post_api(self, path, status_route, ban_route, data, connection):
        token_hash = cookie_token_hash(self.headers.get("Cookie"))
        if path == "/api/session":
            photo_url = None
            if self.bot_token:
                try:
                    fields, photo_url = verify_max(data.get("init_data"), self.bot_token)
                except ValueError as error:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, str(error)) from error
            else:
                fields = user_fields((data.get("max_id"), data.get("first_name"), data.get("last_name")), test=True)
            with connection:
                token = create_session(connection, self.source, fields, token_hash, photo_url)
            account = session_account(connection, cookie_token_hash(f"{COOKIE_NAME}={token}"), self.source)
            self.send_json(HTTPStatus.OK, self.session_data(account), self.session_cookie(token, SESSION_SECONDS))
            return

        if path == "/api/logout":
            with connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            self.send_json(HTTPStatus.OK, self.session_data(None), self.session_cookie("", 0))
            return

        account = self.account(connection, reviewer=status_route is not None or ban_route is not None)
        if path in self.device_logs:
            logger, record = self.device_logs[path]
            record(logger, data)
            self.send_json(HTTPStatus.OK, {"logged": True})
            return

        if path == "/api/profile":
            fields = user_fields(
                (account["max_id"], data.get("first_name"), data.get("last_name")), test=self.source == "test",
            )
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                ensure_active(connection, account["id"])
                connection.execute(
                    "UPDATE accounts SET first_name = ?, last_name = ? WHERE id = ?",
                    (*fields[1:], account["id"]),
                )
            self.send_json(HTTPStatus.OK, self.session_data(self.account(connection)))
            return

        if path == "/api/reviewer":
            secret = data.get("key")
            if not (self.reviewer_key and isinstance(secret, str)
                    and hmac.compare_digest(secret.encode(), self.reviewer_key.encode())):
                raise ApiError(HTTPStatus.FORBIDDEN, "Неверный секрет проверяющего.")
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                ensure_active(connection, account["id"])
                connection.execute(
                    "UPDATE sessions SET review_grant = ? WHERE token_hash = ?", (self.review_grant, token_hash),
                )
            self.send_json(HTTPStatus.OK, self.session_data(self.account(connection)))
            return

        if path == "/api/geocode":
            location = coordinates(data)
            try:
                address = reverse_geocode(*location)
            except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
                raise ApiError(HTTPStatus.BAD_GATEWAY, "Сервис поиска адреса недоступен.") from None
            self.send_json(HTTPStatus.OK, {"address": address})
            return

        if status_route is not None or ban_route is not None:
            identifier = int((status_route or ban_route)[1])
            if identifier > MAX_REPORT_ID:
                raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
            with connection:
                report = (change_status(connection, identifier, account, data) if status_route
                          else set_author_ban(connection, identifier, account, data))
            self.send_json(HTTPStatus.OK, report)
            return

        with connection:
            if path == CAPTURE_PATH:
                report, created = submit_report(connection, data, account["id"])
            else:
                report, created = create_draft(connection, data, account["id"]), True
        self.send_json(
            HTTPStatus.CREATED if created else HTTPStatus.OK,
            report,
            ("Location", f"{REPORTS_PATH}/{report['id']}"),
        )


def main():
    parser = argparse.ArgumentParser(description="Сервер Stukach")
    parser.add_argument("--host", default="127.0.0.1", help="IP-адрес для прослушивания")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--migrate-from", type=Path, help="Скопировать SQLite в новую зашифрованную базу")
    parser.add_argument("--cert", type=Path, help="Сертификат HTTPS в формате PEM")
    parser.add_argument("--key", type=Path, help="Ключ сертификата HTTPS")
    options = parser.parse_args()
    if (options.cert is None) != (options.key is None):
        parser.error("Параметры --cert и --key нужно указывать вместе.")

    tls = None
    if options.cert is not None:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(options.cert, options.key)

    bot_token = os.environ.get("STUKACH_MAX_BOT_TOKEN")
    reviewer_key = os.environ.get("STUKACH_REVIEW_KEY")
    generated_key = None
    if not bot_token and not reviewer_key:
        reviewer_key = generated_key = secrets.token_urlsafe(18)

    options.db.parent.mkdir(parents=True, exist_ok=True)
    source = options.migrate_from
    if source is None and options.db == DEFAULT_DATABASE and not options.db.exists() and LEGACY_DATABASE.exists():
        source = LEGACY_DATABASE
    if source is not None:
        migrate_plaintext(source, options.db)
        print(f"Зашифрованная копия создана: {options.db}", flush=True)
    ensure_key(options.db)
    initialize_database(options.db)
    handler = partial(
        AppHandler, database=options.db, bot_token=bot_token, reviewer_key=reviewer_key,
        secure_cookie=tls is not None or bool(bot_token),
        device_logs={
            "/api/diagnostics/camera": (create_device_logger(options.db.with_suffix(".camera.log")), log_camera_error),
            "/api/diagnostics/location": (create_device_logger(options.db.with_suffix(".location.log")), log_location_error),
        },
    )
    try:
        server = ThreadingHTTPServer((options.host, options.port), handler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        owners = port_owners(options.port)
        detail = f"\nЗанимают порт: {', '.join(owners)}." if owners else "\nНе удалось определить процесс."
        raise SystemExit(
            f"Порт {options.port} уже занят.{detail}\n"
            "Остановите нужный процесс или укажите свободный порт через --port."
        ) from None

    with server:
        if tls is not None:
            server.socket = tls.wrap_socket(server.socket, server_side=True)
        scheme = "https" if tls is not None else "http"
        print(f"Сайт и API: {scheme}://{options.host}:{server.server_port}/", flush=True)
        if generated_key:
            print(f"Тестовый секрет проверяющего: {generated_key}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
