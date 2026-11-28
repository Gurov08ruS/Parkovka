import io
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from accounts import clean_text, safe_max_profile_url, safe_photo_url
from database import open_database

LOG = logging.getLogger(__name__)
MAX_AVATAR_BYTES = 2 * 1024 * 1024
AVATAR_DOMAINS = ("oneme.ru", "max.ru", "mycdn.me", "userapi.com")
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="max-avatar")
_pending = set()
_pending_lock = threading.Lock()


def cached_profile(connection, account_id):
    row = connection.execute("""SELECT first_name, last_name, photo_url, profile_url,
        avatar_png IS NOT NULL AS has_avatar, avatar_source_url, avatar_updated_at, revision
        FROM max_profile_cache WHERE account_id = ?""", (account_id,)).fetchone()
    return dict(row) if row else {}


def save_profile(connection, account_id, profile):
    first, last, photo, link = profile
    connection.execute("""INSERT INTO max_profile_cache (account_id, first_name, last_name, photo_url, profile_url)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
        first_name = COALESCE(NULLIF(excluded.first_name, ''), max_profile_cache.first_name),
        last_name = COALESCE(NULLIF(excluded.last_name, ''), max_profile_cache.last_name),
        photo_url = COALESCE(excluded.photo_url, max_profile_cache.photo_url),
        profile_url = COALESCE(excluded.profile_url, max_profile_cache.profile_url),
        revision = max_profile_cache.revision + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')""",
        (account_id, first or None, last or None, safe_photo_url(photo), safe_max_profile_url(link)))


def allowed_avatar_url(url):
    if not safe_photo_url(url):
        return False
    try:
        parts = urlsplit(url)
        host = parts.hostname.lower().rstrip('.')
        return parts.port in (None, 443) and any(host == domain or host.endswith('.' + domain) for domain in AVATAR_DOMAINS)
    except (ValueError, AttributeError):
        return False


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download_avatar(url):
    if not allowed_avatar_url(url):
        return None
    from PIL import Image, ImageOps, UnidentifiedImageError
    opener = build_opener(NoRedirect())
    try:
        with opener.open(Request(url, headers={"User-Agent": "Stukach/0.1", "Accept": "image/*"}), timeout=5) as response:
            data = response.read(MAX_AVATAR_BYTES + 1)
        if len(data) > MAX_AVATAR_BYTES:
            return None
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > 20_000_000:
                return None
            image = ImageOps.exif_transpose(image).convert("RGBA")
            image.thumbnail((256, 256), Image.Resampling.LANCZOS)
            result = io.BytesIO()
            image.save(result, format="PNG", optimize=True)
            return result.getvalue()
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        return None


def needs_avatar(profile):
    return bool(profile.get("photo_url")) and (not profile.get("has_avatar")
        or profile.get("avatar_source_url") != profile.get("photo_url")
        or (profile.get("avatar_updated_at") or 0) < time.time() - 86400)


def schedule_avatar(database, account_id, url):
    if not allowed_avatar_url(url):
        return
    key = (str(database), account_id, url)
    with _pending_lock:
        if key in _pending or len(_pending) >= 128:
            return
        _pending.add(key)
    def work():
        try:
            image = download_avatar(url)
            if image:
                with closing(open_database(database)) as connection, connection:
                    connection.execute("""UPDATE max_profile_cache SET avatar_png = ?, avatar_source_url = ?,
                        avatar_updated_at = ? WHERE account_id = ? AND photo_url = ?""",
                        (image, url, int(time.time()), account_id, url))
        except Exception:
            LOG.exception("Не удалось сохранить аватар MAX")
        finally:
            with _pending_lock:
                _pending.discard(key)
    _executor.submit(work)


def schedule_live_profile(database, account_id, max_id, bot, signed_profile, revision):
    key = (str(database), account_id, "live", revision)
    with _pending_lock:
        if key in _pending or len(_pending) >= 128:
            return
        _pending.add(key)
    def work():
        try:
            profile = bot.author_profile(max_id)
            if not profile:
                return
            _, last, photo, link = profile
            last = clean_text(last or "", "Фамилия", 80) or None
            with closing(open_database(database)) as connection, connection:
                connection.execute("""UPDATE max_profile_cache SET
                    last_name = CASE WHEN ? THEN COALESCE(?, last_name) ELSE last_name END,
                    photo_url = CASE WHEN ? THEN COALESCE(?, photo_url) ELSE photo_url END,
                    profile_url = CASE WHEN ? THEN COALESCE(?, profile_url) ELSE profile_url END
                    WHERE account_id = ? AND revision = ?""",
                    (not signed_profile[1], last, not signed_profile[2], safe_photo_url(photo),
                     not signed_profile[3], safe_max_profile_url(link), account_id, revision))
                saved = cached_profile(connection, account_id)
            if needs_avatar(saved):
                schedule_avatar(database, account_id, saved['photo_url'])
        except Exception:
            LOG.exception("Не удалось обновить профиль MAX")
        finally:
            with _pending_lock:
                _pending.discard(key)
    _executor.submit(work)
