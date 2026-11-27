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
from threading import Lock
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from accounts import (
    AccountBanned, COOKIE_NAME, MAX_COOKIE_NAME, SessionProfiles, clean_text, cookie_token, create_session,
    ensure_active, max_avatar_color, profile_names, session_account, session_token_hash, verify_max,
)
from achievements import award, earned_achievements
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
from plates import LOCATION_CODES, normalize_region
from plate_recognition import RecognitionUnavailable, analyze
from plate_boxes import cached_photo_boxes, remember_photo_boxes
from profile_cache import cached_profile, needs_avatar, save_profile, schedule_avatar, schedule_live_profile
from public import leaderboard, public_account, public_photo, public_report, public_reports, set_visibility
from report_notifications import report_notifications
from reports import (
    MAX_PHOTO_BYTES, ApiError, account_report_stats, change_status, confirm_plate, coordinates, create_draft, decode_photo, delete_draft,
    initialize_database, list_reports, open_database, report_detail, report_photo,
    reviewer_decision_stats, save_capture, set_author_ban, withdraw_report,
)
from server_logs import ServerLogs


REPORTS_PATH = "/api/reports"
CAPTURE_PATH = "/api/reports/capture"
DRAFT_CAPTURE_PATH = f"{CAPTURE_PATH}/draft"
REVIEW_PATH = "/api/review"
REPORT_ID = r"(0|[1-9][0-9]{0,18})"
REPORT_ROUTE = re.compile(rf"/api/(reports|review)/{REPORT_ID}(?:/photos/(overview|detail))?")
PHOTO_BOX_ROUTE = re.compile(rf"/api/(reports|review)/{REPORT_ID}/photos/(overview|detail)/boxes")
STATUS_ROUTE = re.compile(rf"/api/review/{REPORT_ID}/status")
BAN_ROUTE = re.compile(rf"/api/review/{REPORT_ID}/author-ban")
WITHDRAW_ROUTE = re.compile(rf"/api/reports/{REPORT_ID}/withdraw")
DELETE_DRAFT_ROUTE = re.compile(rf"/api/reports/{REPORT_ID}/delete-draft")
PLATE_ROUTE = re.compile(rf"/api/review/{REPORT_ID}/confirm-plate")
VISIBILITY_ROUTE = re.compile(rf"/api/reports/{REPORT_ID}/visibility")
PUBLIC_USER_ROUTE = re.compile(rf"/api/public/users/{REPORT_ID}")
PUBLIC_AVATAR_ROUTE = re.compile(rf"/api/public/users/{REPORT_ID}/avatar")
PUBLIC_USER_REPORTS_ROUTE = re.compile(rf"/api/public/users/{REPORT_ID}/reports")
PUBLIC_REPORT_ROUTE = re.compile(rf"/api/public/reports/{REPORT_ID}(?:/photos/(overview|detail)(/boxes)?)?")
CAMERA_TICKET = re.compile(r"[A-Za-z0-9_-]{43}")
DEVICE_DIAGNOSTICS = {
    "/api/diagnostics/camera": ("camera", log_camera_error),
    "/api/diagnostics/location": ("location", log_location_error),
}
MAX_BODY_BYTES = 16 * 1024
MAX_WEBHOOK_BODY_BYTES = 128 * 1024
MAX_CAPTURE_BODY_BYTES = 2 * ((MAX_PHOTO_BYTES + 2) // 3) * 4 + MAX_BODY_BYTES
MAX_REPORT_ID = 2**63 - 1
VERSION = "0.14.1"
PLATE_DETECT_PATH = "/api/plates/detect"
PHOTON_URL = os.environ.get("PARKOVKA_PHOTON_URL", "https://photon.komoot.io").rstrip("/")
DEFAULT_DATABASE = Path(__file__).parent / "data" / "parkovka.encrypted.sqlite3"
LEGACY_DATABASE = Path(__file__).parent / "data" / "parkovka.sqlite3"
FRONTEND = Path(__file__).parent.parent / "frontend"


def git_commit_id():
    try:
        result = subprocess.run(
            ["git", "-C", str(FRONTEND.parent), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=2, check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    commit = result.stdout.strip()
    return commit if re.fullmatch(r"[0-9a-f]{7,40}", commit) else None


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
    place = features[0]["properties"] if features else {}
    street = place.get("street") or (place.get("name") if place.get("type") == "street" else None)
    address = ", ".join(filter(None, (
        place.get("city") or place.get("locality"), street, place.get("housenumber"),
    ))) if street else None
    region = place.get("state") or (place.get("name") if place.get("type") == "state" else None)
    region_code = LOCATION_CODES.get(normalize_region(region)) if place.get("countrycode") == "RU" and isinstance(region, str) else None
    return {"address": address, "region_code": region_code}


class AppServer(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"

    def __init__(self, *args, logs, **kwargs):
        self.logs = logs
        self.session_profiles = SessionProfiles()
        self.max_profiles = SessionProfiles()
        self.camera_handoffs = SessionProfiles(limit=1024)
        self.reviewer_attempts = []
        self.reviewer_attempts_lock = Lock()
        self.commit_id = git_commit_id()
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

    def max_profile(self, connection, account_id, max_id, *, prefer_live=False):
        saved = cached_profile(connection, account_id)
        profile = self.server.max_profiles.get(max_id)
        if self.max_bot and (prefer_live or profile is None):
            live = self.max_bot.author_profile(max_id)
            if live:
                profile = live
                self.server.max_profiles.put(max_id, time.time() + 300, live)
        first, last, photo, link = profile or ("", "", None, None)
        avatar = f"/api/public/users/{account_id}/avatar" if saved.get("has_avatar") else photo or saved.get("photo_url")
        return first or saved.get("first_name") or "", last or saved.get("last_name") or "", avatar, link or saved.get("profile_url")

    def session_data(self, account, token_hash=None, *, connection=None):
        user = None
        if account is not None:
            if self.source == "max":
                first_name, last_name, photo_url, _ = self.max_profile(connection, account["id"], account["max_id"])
            else:
                token_hash = token_hash or session_token_hash(self.request_session_token())
                profile = self.server.session_profiles.get(token_hash)
                first_name, last_name, photo_url = profile or ("Тестовый", "пользователь", None)
            user = {
                "max_id": account["max_id"], "first_name": first_name, "last_name": last_name,
                "photo_url": photo_url, "avatar_color": max_avatar_color(account["max_id"]) if self.source == "max" else None,
                "reviewer": self.is_reviewer(account),
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
        if path == "/api/version":
            self.send_json(HTTPStatus.OK, {
                "version": VERSION, "commit": self.server.commit_id,
                "bot": self.max_bot is not None, "test": self.source == "test",
            })
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
        except RecognitionUnavailable as error:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, str(error))
        except ValueError as error:
            self.send_error(HTTPStatus.BAD_REQUEST, str(error))

    def get_api(self, path, connection):
        if path == "/api/public/leaderboard":
            self.send_json(HTTPStatus.OK, {"users": leaderboard(connection, self.source)})
            return
        public_user_reports = PUBLIC_USER_REPORTS_ROUTE.fullmatch(path)
        if public_user_reports and int(public_user_reports[1]) <= MAX_REPORT_ID:
            identifier = int(public_user_reports[1])
            if not connection.execute("SELECT 1 FROM accounts WHERE source = ? AND id = ?", (self.source, identifier)).fetchone():
                raise ApiError(HTTPStatus.NOT_FOUND, "Профиль не найден.")
            self.send_json(HTTPStatus.OK, {"reports": public_reports(connection, self.source, owner=identifier)})
            return
        public_avatar = PUBLIC_AVATAR_ROUTE.fullmatch(path)
        if public_avatar and int(public_avatar[1]) <= MAX_REPORT_ID:
            row = connection.execute("""SELECT avatar_png FROM max_profile_cache JOIN accounts ON accounts.id = account_id
                WHERE accounts.id = ? AND accounts.source = ?""", (int(public_avatar[1]), self.source)).fetchone()
            if not row or row[0] is None:
                raise ApiError(HTTPStatus.NOT_FOUND, "Аватар не найден.")
            self.send_data(HTTPStatus.OK, row[0], "image/png")
            return
        public_user = PUBLIC_USER_ROUTE.fullmatch(path)
        if public_user and int(public_user[1]) <= MAX_REPORT_ID:
            user = public_account(connection, self.source, int(public_user[1]))
            max_id = user.pop("max_id")
            source = user.pop("source")
            first, last, photo, link = self.max_profile(connection, user["id"], max_id) if source == "max" else ("", "", None, None)
            user.update(first_name=first, last_name=last, photo_url=photo, profile_url=link,
                        avatar_color=max_avatar_color(max_id) if source == "max" else None)
            self.send_json(HTTPStatus.OK, user)
            return
        if path == "/api/public/reports":
            current = session_account(connection, session_token_hash(self.request_session_token()), self.source)
            self.send_json(HTTPStatus.OK, {"reports": public_reports(connection, self.source, current["id"] if current else None)})
            return
        public_route = PUBLIC_REPORT_ROUTE.fullmatch(path)
        if public_route and int(public_route[1]) <= MAX_REPORT_ID:
            identifier, kind, boxes = int(public_route[1]), public_route[2], public_route[3]
            if kind:
                image = public_photo(connection, self.source, identifier, kind)
                if boxes:
                    with connection:
                        coordinates = cached_photo_boxes(connection, identifier, kind, image)
                    self.send_json(HTTPStatus.OK, {"boxes": coordinates})
                else:
                    content_type = "image/png" if image.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
                    self.send_data(HTTPStatus.OK, image, content_type)
            else:
                self.send_json(HTTPStatus.OK, public_report(connection, self.source, identifier))
            return
        if path == "/api/session":
            self.send_json(HTTPStatus.OK, self.session_data(self.account(connection, required=False), connection=connection))
            return
        if path == "/api/achievements":
            account = self.account(connection)
            self.send_json(HTTPStatus.OK, earned_achievements(connection, account["id"]))
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
        boxes_route = PHOTO_BOX_ROUTE.fullmatch(path)
        if boxes_route and int(boxes_route[2]) <= MAX_REPORT_ID:
            reviewer = boxes_route[1] == "review"
            account = self.account(connection, reviewer=reviewer)
            identifier, kind = int(boxes_route[2]), boxes_route[3]
            image = report_photo(connection, identifier, kind, account, reviewer)
            with connection:
                coordinates = cached_photo_boxes(connection, identifier, kind, image)
            self.send_json(HTTPStatus.OK, {"boxes": coordinates})
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
            report = report_detail(connection, identifier, account, reviewer)
            if reviewer and report["author"]["source"] == "max":
                author = report["author"]
                max_id = author["max_id"]
                first_name, last_name, photo_url, profile_url = self.max_profile(connection, author["id"], max_id, prefer_live=True)
                author.update(first_name=first_name, last_name=last_name, photo_url=photo_url, profile_url=profile_url,
                              avatar_color=max_avatar_color(max_id))
            self.send_json(HTTPStatus.OK, report)

    def do_POST(self):
        path = self.path.partition("?")[0]
        status_route = STATUS_ROUTE.fullmatch(path)
        ban_route = BAN_ROUTE.fullmatch(path)
        withdraw_route = WITHDRAW_ROUTE.fullmatch(path)
        delete_draft_route = DELETE_DRAFT_ROUTE.fullmatch(path)
        plate_route = PLATE_ROUTE.fullmatch(path)
        visibility_route = VISIBILITY_ROUTE.fullmatch(path)
        diagnostic = DEVICE_DIAGNOSTICS.get(path)
        if path not in {
            "/api/session", "/api/session/camera", "/api/camera/handoff", "/api/logout", "/api/profile", "/api/reviewer", "/api/geocode", WEBHOOK_PATH,
            REPORTS_PATH, CAPTURE_PATH, DRAFT_CAPTURE_PATH, PLATE_DETECT_PATH, "/api/achievements/rules", "/api/geocode/search",
        } and not (status_route or ban_route or withdraw_route or delete_draft_route or plate_route or visibility_route or diagnostic):
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
            limit = MAX_CAPTURE_BODY_BYTES if path in (CAPTURE_PATH, DRAFT_CAPTURE_PATH, PLATE_DETECT_PATH) else MAX_BODY_BYTES
            data = self.read_json(limit)
            with closing(open_database(self.database)) as connection:
                self.post_api(path, status_route, ban_route, withdraw_route, delete_draft_route, plate_route, visibility_route, data, connection)
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
        except RecognitionUnavailable as error:
            self.send_error(HTTPStatus.SERVICE_UNAVAILABLE, str(error))

    def receive_max_update(self):
        if self.max_bot is None:
            raise ApiError(HTTPStatus.NOT_FOUND, "Страница не найдена.")
        if not self.max_bot.authenticates(self.headers.get("X-Max-Bot-Api-Secret")):
            raise ApiError(HTTPStatus.FORBIDDEN, "Неверный секрет вебхука MAX.")
        self.max_bot.handle_update(self.read_json(MAX_WEBHOOK_BODY_BYTES))
        self.send_json(HTTPStatus.OK, {"ok": True})

    def post_api(self, path, status_route, ban_route, withdraw_route, delete_draft_route, plate_route, visibility_route, data, connection):
        old_token = self.request_session_token()
        token_hash = session_token_hash(old_token)
        if path == "/api/session/camera":
            ticket = data.get("ticket")
            if self.source != "max" or not isinstance(ticket, str) or not CAMERA_TICKET.fullmatch(ticket):
                raise ApiError(HTTPStatus.UNAUTHORIZED, "Откройте камеру заново из мини-приложения MAX.")
            origin_session = self.server.camera_handoffs.take(session_token_hash(ticket))
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                original = session_account(connection, origin_session, "max")
                if original is None:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, "Ссылка на камеру истекла или уже использована. Откройте её заново в MAX.")
                token, account = create_session(connection, "max", original["max_id"], None)
            max_age = max(0, account["expires_at"] - int(time.time()))
            self.send_json(HTTPStatus.OK, self.session_data(account, connection=connection), self.session_cookie(token, max_age))
            return
        if path == "/api/session":
            profile = None
            max_id = None
            chat_id = None
            if self.source == "max":
                if not self.bot_token:
                    raise ApiError(HTTPStatus.SERVICE_UNAVAILABLE, "Вход через MAX пока недоступен.")
                try:
                    max_id, profile, chat_id = verify_max(data.get("init_data"), self.bot_token)
                except ValueError as error:
                    raise ApiError(HTTPStatus.UNAUTHORIZED, str(error)) from error
            with connection:
                token, account = create_session(connection, self.source, max_id, token_hash)
                if profile:
                    save_profile(connection, account["id"], profile)
            profiles = self.server.session_profiles
            if token is not None:
                profiles.remove(token_hash)
                token_hash = session_token_hash(token)
            headers = ()
            if token is not None or self.source == "max":
                max_age = max(0, account["expires_at"] - int(time.time()))
                headers = (self.session_cookie(token or old_token, max_age),)
            if profile:
                self.server.max_profiles.put(max_id, account["expires_at"], profile)
                saved = cached_profile(connection, account["id"])
                if self.max_bot:
                    self.max_bot.remember_dialog(max_id, chat_id)
                    if chat_id is not None:
                        schedule_live_profile(self.database, account["id"], max_id, self.max_bot, profile, saved["revision"])
                if needs_avatar(saved):
                    schedule_avatar(self.database, account["id"], saved["photo_url"])
            self.send_json(HTTPStatus.OK, self.session_data(account, token_hash, connection=connection), *headers)
            return

        if path == "/api/logout":
            with connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            self.server.session_profiles.remove(token_hash)
            headers = [self.session_cookie("", 0)]
            if self.source == "max":
                headers.append(self.session_cookie("", 0, legacy=True))
            self.send_json(HTTPStatus.OK, self.session_data(None, connection=connection), *headers)
            return

        if path == "/api/reviewer":
            secret = data.get("key")
            valid = bool(self.reviewer_key and isinstance(secret, str)
                         and hmac.compare_digest(secret.encode(), self.reviewer_key.encode()))
            with self.server.reviewer_attempts_lock:
                now = time.monotonic()
                attempts = [attempt for attempt in self.server.reviewer_attempts if attempt > now - 900]
                if len(attempts) >= 10:
                    raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, "Слишком много попыток. Повторите через 15 минут.")
                if not valid:
                    attempts.append(now)
                self.server.reviewer_attempts = attempts
            if not valid:
                raise ApiError(HTTPStatus.FORBIDDEN, "Неверный секрет проверяющего.")
            with connection:
                connection.execute("BEGIN IMMEDIATE")
                account = session_account(connection, token_hash, self.source)
                token = None
                if account is None:
                    token, account = create_session(connection, self.source, "reviewer-account", None)
                    token_hash = session_token_hash(token)
                ensure_active(connection, account["id"])
                connection.execute("UPDATE sessions SET review_grant = ? WHERE token_hash = ?", (self.review_grant, token_hash))
                account = session_account(connection, token_hash, self.source)
            headers = (self.session_cookie(token, max(0, account["expires_at"] - int(time.time()))),) if token else ()
            self.send_json(HTTPStatus.OK, self.session_data(account, token_hash, connection=connection), *headers)
            return

        account = self.account(connection, reviewer=status_route is not None or ban_route is not None or plate_route is not None)
        if visibility_route:
            identifier = int(visibility_route[1])
            if identifier > MAX_REPORT_ID:
                raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
            with connection:
                result = set_visibility(connection, identifier, account["id"], data.get("is_public"))
            self.send_json(HTTPStatus.OK, result)
            return
        if path == PLATE_DETECT_PATH:
            image = decode_photo(data.get("photo"))
            result = analyze(image)
            remember_photo_boxes(image, result["boxes"])
            self.send_json(HTTPStatus.OK, result)
            return
        if path == "/api/geocode/search":
            query = clean_text(data.get("query", ""), "Адрес", 200, required=True)
            if len(query) < 3:
                raise ValueError("Введите не менее трёх символов адреса.")
            request = Request(f"{PHOTON_URL}/api/?{urlencode({'q': query, 'limit': 5})}", headers={"Accept": "application/json", "User-Agent": "Stukach/0.1"})
            try:
                with urlopen(request, timeout=5) as response:
                    features = json.loads(response.read(128 * 1024))["features"]
                results = []
                for feature in features:
                    props = feature["properties"]
                    longitude, latitude = feature["geometry"]["coordinates"]
                    coordinates({"latitude": latitude, "longitude": longitude})
                    address = ", ".join(dict.fromkeys(filter(None, (props.get("name"), props.get("street"), props.get("housenumber"), props.get("city"), props.get("state")))))
                    if address:
                        results.append({"address": address, "latitude": latitude, "longitude": longitude})
            except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
                raise ApiError(HTTPStatus.BAD_GATEWAY, "Поиск адреса временно недоступен.") from None
            self.send_json(HTTPStatus.OK, {"results": results})
            return
        if path == "/api/achievements/rules":
            with connection:
                award(connection, account["id"], "rules_read")
            self.send_json(HTTPStatus.OK, earned_achievements(connection, account["id"]))
            return
        if path == "/api/camera/handoff":
            if self.source != "max" or not self.bot_token:
                raise ApiError(HTTPStatus.FORBIDDEN, "Этот переход доступен из мини-приложения MAX.")
            try:
                max_id, _, _ = verify_max(data.get("init_data"), self.bot_token)
            except ValueError as error:
                raise ApiError(HTTPStatus.UNAUTHORIZED, "Откройте мини-приложение MAX заново и повторите попытку.") from error
            if max_id != account["max_id"]:
                raise ApiError(HTTPStatus.FORBIDDEN, "Откройте камеру из аккаунта, в котором вы вошли в MAX.")
            ticket = secrets.token_urlsafe(32)
            self.server.camera_handoffs.put(session_token_hash(ticket), time.time() + 120, token_hash)
            self.send_json(HTTPStatus.OK, {"ticket": ticket})
            return
        if path == "/api/profile":
            if self.source == "max":
                raise ApiError(HTTPStatus.FORBIDDEN, "Имя, фамилия и фото берутся из профиля MAX.")
            first_name, last_name = profile_names(
                data.get("first_name"), data.get("last_name"), last_required=True,
            )
            self.server.session_profiles.put(token_hash, account["expires_at"], (first_name, last_name, None))
            self.send_json(HTTPStatus.OK, self.session_data(account, connection=connection))
            return

        if path == "/api/geocode":
            location = coordinates(data)
            try:
                result = reverse_geocode(*location)
            except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
                raise ApiError(HTTPStatus.BAD_GATEWAY, "Сервис поиска адреса недоступен.") from None
            self.send_json(HTTPStatus.OK, result)
            return

        if status_route or ban_route or withdraw_route or delete_draft_route or plate_route:
            identifier = int((status_route or ban_route or withdraw_route or delete_draft_route or plate_route)[1])
            if identifier > MAX_REPORT_ID:
                raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
            with connection:
                if status_route:
                    report = change_status(connection, identifier, account, data)
                elif ban_route:
                    report = set_author_ban(connection, identifier, account, data)
                elif withdraw_route:
                    report = withdraw_report(connection, identifier, account)
                elif plate_route:
                    report = confirm_plate(connection, identifier, account)
                else:
                    report = delete_draft(connection, identifier, account)
            self.send_json(HTTPStatus.OK, report)
            return

        with connection:
            if path in (CAPTURE_PATH, DRAFT_CAPTURE_PATH):
                if data.get("owner_max_id", account["max_id"]) != account["max_id"]:
                    raise ApiError(HTTPStatus.CONFLICT, "Войдите в аккаунт, в котором сделали снимок.")
                report, created = save_capture(connection, data, account["id"], draft=path == DRAFT_CAPTURE_PATH)
                captures = connection.execute("SELECT photo, detail_photo FROM report_captures WHERE report_id = ?", (report["id"],)).fetchone()
                found = False
                for kind, image in zip(("overview", "detail"), captures):
                    if image is None:
                        continue
                    try:
                        found |= bool(cached_photo_boxes(connection, report["id"], kind, image))
                    except (RecognitionUnavailable, ValueError):
                        if path == CAPTURE_PATH:
                            raise
                        # Offline drafts can still be stored when recognition is unavailable.
                if path == CAPTURE_PATH and not found:
                    raise ValueError("Госномер не найден на фотографиях. Переснимите фото так, чтобы номер был хорошо виден.")
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

    bot_token = os.environ.get("PARKOVKA_MAX_BOT_TOKEN")
    public_url = os.environ.get("PARKOVKA_MAX_PUBLIC_URL")
    if options.register_max_webhook and (not bot_token or not public_url):
        parser.error("Для регистрации задайте PARKOVKA_MAX_BOT_TOKEN и PARKOVKA_MAX_PUBLIC_URL.")
    if options.bot and not bot_token:
        parser.error("Для запуска с --bot задайте PARKOVKA_MAX_BOT_TOKEN.")
    max_bot = None
    if options.bot or options.register_max_webhook:
        try:
            max_bot = MaxBot(bot_token, ca_file=os.environ.get("PARKOVKA_MAX_CA_FILE") or None)
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

    reviewer_key = os.environ.get("PARKOVKA_REVIEW_KEY")
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
            with logs.monitor(database_directory), report_notifications(options.db, None if options.test else max_bot, logs.server):
                server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
