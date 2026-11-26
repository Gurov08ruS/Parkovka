import argparse
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import sys
import time
from contextlib import closing
from functools import partial
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from accounts import (
    AccountBanned, COOKIE_NAME, MAX_COOKIE_NAME, SessionProfiles, clean_text, cookie_token, create_session,
    ensure_active, profile_names, session_account, session_token_hash, verify_max,
)
from device_logs import log_camera_error, log_location_error
from max_bot import WEBHOOK_PATH, MaxApiError, MaxBot, webhook_url

try:
    import sqlcipher3
except ImportError as error:
    project = Path(__file__).resolve().parent.parent
    environment = project / ".venv"
    interpreter = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    setup = ("Запустите start-windows.cmd из папки проекта." if os.name == "nt"
             else "Из папки проекта выполните:\n"
                  "  python3 -m venv .venv\n"
                  "  .venv/bin/python -m pip install -r requirements.txt")
    if interpreter.is_file() and Path(sys.prefix).resolve() != environment.resolve():
        command = [str(interpreter), str(Path(__file__).resolve()), *sys.argv[1:]]
        try:
            if os.name == "nt":
                raise SystemExit(subprocess.call(command)) from None
            os.execv(command[0], command)
        except OSError as launch_error:
            raise SystemExit(
                f"Не удалось запустить {interpreter}: {launch_error.strerror}\n"
                "Переименуйте папку .venv, чтобы создать новое окружение.\n"
                f"{setup}"
            ) from None
    raise SystemExit(f"Не удалось загрузить SQLCipher: {error}\n{setup}") from None

from database import DatabaseKeyError, database_has_data, migrate_plaintext, sqlite3
from reports import (
    MAX_PHOTO_BYTES, ApiError, account_report_stats, change_status, coordinates, create_draft,
    initialize_database, list_reports, open_database, report_detail, report_photo,
    reviewer_decision_stats, save_capture, set_author_ban, withdraw_report,
)
from server_logs import ServerLogs


REPORTS_PATH = "/api/reports"
CAPTURE_PATH = "/api/reports/capture"
DRAFT_CAPTURE_PATH = f"{CAPTURE_PATH}/draft"
REVIEW_PATH = "/api/review"
REPORT_ROUTE = re.compile(r"/api/(reports|review)/([1-9][0-9]{0,18})(?:/photos/(overview|detail))?")
STATUS_ROUTE = re.compile(r"/api/review/([1-9][0-9]{0,18})/status")
BAN_ROUTE = re.compile(r"/api/review/([1-9][0-9]{0,18})/author-ban")
WITHDRAW_ROUTE = re.compile(r"/api/reports/([1-9][0-9]{0,18})/withdraw")
DEVICE_DIAGNOSTICS = {
    "/api/diagnostics/camera": ("camera", log_camera_error),
    "/api/diagnostics/location": ("location", log_location_error),
}
MAX_BODY_BYTES = 16 * 1024
MAX_WEBHOOK_BODY_BYTES = 128 * 1024
MAX_CAPTURE_BODY_BYTES = 2 * ((MAX_PHOTO_BYTES + 2) // 3) * 4 + MAX_BODY_BYTES
MAX_REPORT_ID = 2**63 - 1
PHOTON_URL = os.environ.get("STUKACH_PHOTON_URL", "https://photon.komoot.io").rstrip("/")
DEFAULT_DATABASE = Path(__file__).parent / "data" / "stukach.encrypted.sqlite3"
LEGACY_DATABASE = Path(__file__).parent / "data" / "stukach.sqlite3"
FRONTEND = Path(__file__).parent.parent / "frontend"


def port_owners(port):
    if os.name == "nt":
        return []
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


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"

    def __init__(self, *args, logs, **kwargs):
        self.logs = logs
        self.session_profiles = SessionProfiles()
        super().__init__(*args, **kwargs)

    def server_bind(self):
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            self.logs.server.exception("Ошибка при обработке запроса от %s", client_address[0])


class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
    }

    def __init__(self, *args, database, bot_token, reviewer_key, secure_cookie, test_mode=False, max_bot=None, **kwargs):
        self.database = database
        self.bot_token = bot_token
        self.max_bot = max_bot
        self.reviewer_key = reviewer_key
        self.review_grant = hashlib.sha256(reviewer_key.encode()).hexdigest() if reviewer_key else None
        self.secure_cookie = secure_cookie
        self.source = "test" if test_mode else "max"
        super().__init__(*args, directory=FRONTEND, **kwargs)

    def log_message(self, format, *args):
        message = format % args
        message = re.sub(r"[\x00-\x1f\x7f-\x9f]", lambda match: ascii(match[0])[1:-1], message)
        self.server.logs.server.info("%s %s", self.client_address[0], message)

    def end_headers(self):
        path = getattr(self, "path", "").partition("?")[0]
        if path == "/" or path.endswith((".html", ".js", ".css")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

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

    def session_cookie(self, token, max_age, *, legacy=False):
        max_session = self.source == "max" and not legacy
        name = MAX_COOKIE_NAME if max_session else COOKIE_NAME
        cookie = SimpleCookie()
        cookie[name] = token
        entry = cookie[name]
        entry["path"] = "/"
        entry["httponly"] = True
        entry["samesite"] = "None" if max_session else "Lax"
        entry["max-age"] = max_age
        entry["secure"] = max_session or self.secure_cookie
        # SimpleCookie on older Python versions has no Partitioned attribute.
        attributes = "; Partitioned" if max_session else ""
        return ("Set-Cookie", entry.OutputString() + attributes)

    def request_session_token(self):
        return cookie_token(self.headers.get("Cookie"), self.source)

    def session_data(self, account, token_hash=None):
        user = None
        if account is not None:
            token_hash = token_hash or session_token_hash(self.request_session_token())
            profile = self.server.session_profiles.get(token_hash)
            default_name = ("Тестовый", "пользователь", None) if self.source == "test" else ("", "", None)
            first_name, last_name, photo_url = profile or default_name
            user = {
                "max_id": account["max_id"], "first_name": first_name, "last_name": last_name,
                "photo_url": photo_url, "reviewer": self.is_reviewer(account),
            }
        return {"mode": self.source, "review_enabled": bool(self.reviewer_key), "user": user}

    def account(self, connection, *, required=True, reviewer=False):
        current = session_account(connection, session_token_hash(self.request_session_token()), self.source)
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
            # Always revalidate the page and its modules as a single current UI.
            if path == "/" or path.endswith((".html", ".js", ".css")):
                if "If-Modified-Since" in self.headers:
                    del self.headers["If-Modified-Since"]
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
        except (DatabaseKeyError, sqlite3.Error):
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "База данных недоступна.")

    def get_api(self, path, connection):
        if path == "/api/session":
            self.send_json(HTTPStatus.OK, self.session_data(self.account(connection, required=False)))
            return
        if path == f"{REPORTS_PATH}/stats":
            account = self.account(connection)
            self.send_json(HTTPStatus.OK, account_report_stats(connection, account["id"]))
            return
        if path == f"{REVIEW_PATH}/stats":
            account = self.account(connection, reviewer=True)
            self.send_json(HTTPStatus.OK, reviewer_decision_stats(connection, account["id"]))
            return
        if path == f"{REVIEW_PATH}/storage":
            self.account(connection, reviewer=True)
            self.send_json(HTTPStatus.OK, {"low_space": self.server.logs.low_space})
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
        withdraw_route = WITHDRAW_ROUTE.fullmatch(path)
        diagnostic = DEVICE_DIAGNOSTICS.get(path)
        if path not in {
            "/api/session", "/api/logout", "/api/profile", "/api/reviewer", "/api/geocode", WEBHOOK_PATH,
            REPORTS_PATH, CAPTURE_PATH, DRAFT_CAPTURE_PATH,
        } and not (status_route or ban_route or withdraw_route or diagnostic):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            if path == WEBHOOK_PATH:
                self.receive_max_update()
                return
            if diagnostic:
                device, record = diagnostic
                record(getattr(self.server.logs, device), self.read_json(1024))
                self.send_json(HTTPStatus.OK, {"logged": True})
                return
            limit = MAX_CAPTURE_BODY_BYTES if path in (CAPTURE_PATH, DRAFT_CAPTURE_PATH) else MAX_BODY_BYTES
            data = self.read_json(limit)
            with closing(open_database(self.database)) as connection:
                self.post_api(path, status_route, ban_route, withdraw_route, data, connection)
        except ApiError as error:
            self.send_error(error.status, str(error))
        except AccountBanned as error:
            self.send_error(HTTPStatus.FORBIDDEN, str(error))
        except MaxApiError as error:
            self.log_error("Ошибка ответа бота MAX: %s", error)
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "Не удалось обработать событие MAX.")
        except (UnicodeError, json.JSONDecodeError, RecursionError):
            self.send_error(HTTPStatus.BAD_REQUEST, "Некорректный JSON в кодировке UTF-8.")
        except (DatabaseKeyError, sqlite3.Error):
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, "База данных недоступна.")
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def receive_max_update(self):
        if self.max_bot is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Страница не найдена.")
        if not self.max_bot.authenticates(self.headers.get("X-Max-Bot-Api-Secret")):
            raise ApiError(HTTPStatus.FORBIDDEN, "Неверный секрет вебхука MAX.")
        self.max_bot.handle_update(self.read_json(MAX_WEBHOOK_BODY_BYTES))
        self.send_json(HTTPStatus.OK, {"ok": True})

    def post_api(self, path, status_route, ban_route, withdraw_route, data, connection):
        old_token = self.request_session_token()
        token_hash = session_token_hash(old_token)
        if path == "/api/session":
            profile = None
            max_id = None
            if self.source == "max":
                if not self.bot_token:
                    raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "Вход через MAX пока недоступен.")
                try:
                    fields, photo_url = verify_max(data.get("init_data"), self.bot_token)
                except ValueError as error:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, str(error)) from error
                max_id, first_name, last_name = fields
                profile = (first_name, last_name, photo_url)
            with connection:
                token, account = create_session(connection, self.source, max_id, token_hash)
            profiles = self.server.session_profiles
            if token is not None:
                profiles.remove(token_hash)
                token_hash = session_token_hash(token)
            headers = ()
            if token is not None or self.source == "max":
                max_age = max(0, account["expires_at"] - int(time.time()))
                headers = (self.session_cookie(token or old_token, max_age),)
            if profile:
                profiles.put(token_hash, account["expires_at"], profile)
            self.send_json(HTTPStatus.OK, self.session_data(account, token_hash), *headers)
            return

        if path == "/api/logout":
            with connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            self.server.session_profiles.remove(token_hash)
            headers = [self.session_cookie("", 0)]
            if self.source == "max":
                headers.append(self.session_cookie("", 0, legacy=True))
            self.send_json(HTTPStatus.OK, self.session_data(None), *headers)
            return

        account = self.account(connection, reviewer=status_route is not None or ban_route is not None)
        if path == "/api/profile":
            if self.source == "max":
                raise ApiError(HTTPStatus.FORBIDDEN, "Имя, фамилия и фото берутся из профиля MAX.")
            first_name, last_name = profile_names(
                data.get("first_name"), data.get("last_name"), last_required=True,
            )
            self.server.session_profiles.put(token_hash, account["expires_at"], (first_name, last_name, None))
            self.send_json(HTTPStatus.OK, self.session_data(account))
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

        if status_route or ban_route or withdraw_route:
            identifier = int((status_route or ban_route or withdraw_route)[1])
            if identifier > MAX_REPORT_ID:
                raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
            with connection:
                if status_route:
                    report = change_status(connection, identifier, account, data)
                elif ban_route:
                    report = set_author_ban(connection, identifier, account, data)
                else:
                    report = withdraw_report(connection, identifier, account)
            self.send_json(HTTPStatus.OK, report)
            return

        with connection:
            if path in (CAPTURE_PATH, DRAFT_CAPTURE_PATH):
                if data.get("owner_max_id", account["max_id"]) != account["max_id"]:
                    raise ApiError(HTTPStatus.CONFLICT, "Войдите в аккаунт, в котором сделали снимок.")
                report, created = save_capture(connection, data, account["id"], draft=path == DRAFT_CAPTURE_PATH)
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
    parser.add_argument("--bot", action="store_true", help="Включить обработку событий бота MAX")
    parser.add_argument("--test", action="store_true", help="Разрешить вход в тестовый аккаунт без MAX")
    parser.add_argument("--register-max-webhook", action="store_true", help="Подключить вебхук MAX и завершить работу")
    options = parser.parse_args()
    if (options.cert is None) != (options.key is None):
        parser.error("Параметры --cert и --key нужно указывать вместе.")

    bot_token = os.environ.get("STUKACH_MAX_BOT_TOKEN")
    public_url = os.environ.get("STUKACH_MAX_PUBLIC_URL")
    if options.register_max_webhook and (not bot_token or not public_url):
        parser.error("Для регистрации задайте STUKACH_MAX_BOT_TOKEN и STUKACH_MAX_PUBLIC_URL.")
    if options.bot and not bot_token:
        parser.error("Для запуска с --bot задайте STUKACH_MAX_BOT_TOKEN.")
    max_bot = None
    if options.bot or options.register_max_webhook:
        try:
            max_bot = MaxBot(bot_token, ca_file=os.environ.get("STUKACH_MAX_CA_FILE") or None)
        except MaxApiError as error:
            raise SystemExit(f"Не удалось настроить бота MAX: {error}") from None

    if options.register_max_webhook:
        try:
            url = webhook_url(public_url)
            max_bot.register(url)
        except (ValueError, MaxApiError) as error:
            raise SystemExit(f"Не удалось подключить вебхук MAX: {error}") from None
        print(f"Вебхук MAX подключён: {url}", flush=True)
        return

    tls = None
    if options.cert is not None:
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(options.cert, options.key)

    reviewer_key = os.environ.get("STUKACH_REVIEW_KEY")
    generated_key = None
    if options.test and not reviewer_key:
        reviewer_key = generated_key = secrets.token_urlsafe(18)

    database_directory = options.db.resolve().parent
    default_directory = database_directory == DEFAULT_DATABASE.parent.resolve()
    if os.name == "nt":
        log_directory = Path.cwd() / "logs"
    else:
        log_directory = (FRONTEND.parent if default_directory else database_directory) / "logs"
    try:
        logs = ServerLogs(log_directory)
    except OSError as error:
        raise SystemExit(f"Не удалось открыть журналы в {log_directory}: {error}") from None

    source = options.migrate_from
    try:
        if (source is None and options.db == DEFAULT_DATABASE and not options.db.exists()
                and database_has_data(LEGACY_DATABASE)):
            source = LEGACY_DATABASE
        if source is not None:
            migrate_plaintext(source, options.db)
            logs.server.info("Зашифрованная копия создана: %s", options.db)
        initialize_database(options.db)
    except (OSError, ValueError, sqlite3.Error) as error:
        raise SystemExit(f"Не удалось открыть базу {options.db}: {error}") from None
    handler = partial(
        AppHandler, database=options.db, bot_token=bot_token, reviewer_key=reviewer_key, max_bot=max_bot,
        secure_cookie=tls is not None, test_mode=options.test,
    )
    try:
        server = AppServer((options.host, options.port), handler, logs=logs)
    except OSError as error:
        if error.errno != errno.EADDRINUSE and getattr(error, "winerror", None) != 10048:
            raise SystemExit(f"Не удалось слушать {options.host}:{options.port}: {error}\n"
                             "Проверьте адрес или укажите свободный порт через --port.") from None
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
        browser_host = "127.0.0.1" if options.host in ("", "0.0.0.0") else options.host
        logs.server.info("Сайт и API: %s://%s:%s/", scheme, browser_host, server.server_port)
        if max_bot is not None:
            logs.server.info("Бот MAX включён: %s", WEBHOOK_PATH)
        if generated_key:
            print(f"Тестовый секрет проверяющего: {generated_key}", flush=True)
        if source is not None or default_directory:
            logs.move_device_logs(source or LEGACY_DATABASE)
        logs.move_device_logs(options.db)
        try:
            with logs.monitor(database_directory):
                server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
