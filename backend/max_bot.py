import hashlib
import hmac
import json
from collections import OrderedDict
from threading import Lock
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


MAX_API = "https://platform-api2.max.ru"
WEBHOOK_PATH = "/api/max/webhook"
UPDATE_TYPES = ("bot_started", "message_created")
WELCOME_MESSAGE = (
    "Привет! Это «Чужое место». Здесь можно сообщить о нарушении парковки "
    "на месте для людей с инвалидностью. Откройте мини-приложение, "
    "сделайте фото и отправьте обращение на проверку."
)


class MaxApiError(Exception):
    pass


def webhook_url(public_url):
    message = "STUKACH_MAX_PUBLIC_URL должен быть публичным HTTPS-адресом корня сайта без указания порта."
    try:
        url = urlsplit(public_url)
        valid = (url.scheme == "https" and url.hostname and url.username is None and url.password is None
                 and url.port is None and url.path in ("", "/") and not url.query and not url.fragment
                 and not any(character.isspace() for character in public_url))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(message)
    return f"https://{url.netloc}{WEBHOOK_PATH}"


def object_field(data, key):
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def welcome_recipient(update):
    kind = update.get("update_type")
    if kind == "bot_started":
        sender = object_field(update, "user")
        timestamp = update.get("timestamp")
        event_id = timestamp if type(timestamp) is int else None
    elif kind == "message_created":
        message = object_field(update, "message")
        if object_field(message, "recipient").get("chat_type") != "dialog":
            return None
        sender = object_field(message, "sender")
        body = object_field(message, "body")
        text = body.get("text")
        if not isinstance(text, str) or text.strip().split(maxsplit=1)[:1] != ["/start"]:
            return None
        mid = body.get("mid")
        event_id = mid if isinstance(mid, str) and mid else None
    else:
        return None
    user_id = sender.get("user_id")
    if type(user_id) is not int or user_id <= 0 or sender.get("is_bot") is True:
        return None
    return user_id, (kind, user_id, event_id) if event_id is not None else None


class MaxBot:
    def __init__(self, token):
        self.token = token
        self.secret = hmac.new(token.encode(), b"Stukach MAX webhook v1", hashlib.sha256).hexdigest()
        self.bot_id = None
        self.lock = Lock()
        self.sent = OrderedDict()
        self.sending = set()

    def authenticates(self, secret):
        return bool(secret and hmac.compare_digest(secret.encode("utf-8"), self.secret.encode("ascii")))

    def api(self, path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        request = Request(f"{MAX_API}{path}", data, {"Content-Type": "application/json"} if data else {})
        request.add_unredirected_header("Authorization", self.token)
        try:
            with urlopen(request, timeout=8) as response:
                result = json.loads(response.read(1024 * 1024))
        except HTTPError as error:
            error.close()
            raise MaxApiError(f"MAX API вернул HTTP {error.code}.") from None
        except (OSError, ValueError, RecursionError):
            raise MaxApiError("MAX API недоступен или вернул некорректный ответ.") from None
        if not isinstance(result, dict) or result.get("success") is False:
            raise MaxApiError("MAX API отклонил запрос.")
        return result

    def register(self, url):
        result = self.api("/subscriptions", {"url": url, "update_types": UPDATE_TYPES, "secret": self.secret})
        if result.get("success") is not True:
            raise MaxApiError("MAX API не подтвердил подписку.")

    def send_welcome(self, user_id):
        if self.bot_id is None:
            bot_id = self.api("/me").get("user_id")
            if type(bot_id) is not int or bot_id <= 0:
                raise MaxApiError("MAX API не вернул идентификатор бота.")
            self.bot_id = bot_id
        button = {"type": "open_app", "text": "Открыть приложение", "contact_id": self.bot_id}
        self.api(f"/messages?{urlencode({'user_id': user_id})}", {
            "text": WELCOME_MESSAGE,
            "attachments": [{"type": "inline_keyboard", "payload": {"buttons": [[button]]}}],
        })

    def handle_update(self, update):
        recipient = welcome_recipient(update)
        if recipient is None:
            return
        user_id, key = recipient
        if key is None:
            self.send_welcome(user_id)
            return
        with self.lock:
            if key in self.sent:
                return
            if key in self.sending:
                raise MaxApiError("Это событие MAX уже обрабатывается.")
            self.sending.add(key)
        try:
            self.send_welcome(user_id)
            with self.lock:
                self.sent[key] = None
                if len(self.sent) > 1024:
                    self.sent.popitem(last=False)
        finally:
            with self.lock:
                self.sending.remove(key)
