"""MAX profile fallback must survive restarts and never accept unverified logins."""
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from database import ensure_key, open_database
from reports import initialize_database
import profile_cache

TOKEN = 'synthetic-test-token'
PNG = bytes.fromhex('89504e470d0a1a0a0000000049454e44ae426082')


def signed(user):
    fields = {'auth_date': str(int(time.time())), 'user': json.dumps(user, ensure_ascii=False)}
    key = hmac.digest(b'WebAppData', TOKEN.encode(), 'sha256')
    fields['hash'] = hmac.new(key, '\n'.join(f'{k}={v}' for k, v in sorted(fields.items())).encode(), 'sha256').hexdigest()
    return urllib.parse.urlencode(fields)


class Client:
    def __init__(self, base):
        self.base, self.cookie = base, None

    def call(self, path, payload=None, expected=200):
        headers = {'Cookie': self.cookie} if self.cookie else {}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode()
            headers['Content-Type'] = 'application/json'
        try:
            response = urllib.request.urlopen(urllib.request.Request(self.base + path, data=body, headers=headers), timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            result = response.read()
            if response.status != expected:
                raise AssertionError((path, response.status, result))
            if response.headers.get('Set-Cookie'):
                self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
            return json.loads(result) if response.headers.get_content_type() == 'application/json' else result


class Server:
    def __init__(self, database):
        self.log = tempfile.TemporaryFile()
        self.proc = subprocess.Popen([sys.executable, 'backend/server.py', '--port', '0', '--db', str(database)],
            cwd=ROOT, env={**os.environ, 'PARKOVKA_MAX_BOT_TOKEN': TOKEN, 'PARKOVKA_REVIEW_KEY': 'test-key'},
            stdout=self.log, stderr=self.log)
        for _ in range(200):
            output = os.pread(self.log.fileno(), 100000, 0).decode(errors='replace')
            if match := re.search(r'http://127\.0\.0\.1:\d+', output):
                self.base = match.group()
                return
            if self.proc.poll() is not None:
                raise RuntimeError(output)
            time.sleep(.05)
        raise RuntimeError(output)

    def close(self):
        self.proc.terminate()
        self.proc.wait(timeout=10)
        self.log.close()


class ProfileCacheTest(unittest.TestCase):
    def test_existing_database_gains_profile_cache(self):
        with tempfile.TemporaryDirectory() as path:
            db = Path(path) / 'old.sqlite3'
            ensure_key(db)
            schema = (ROOT / 'backend/schema.sql').read_text()
            schema = re.sub(r'CREATE TABLE IF NOT EXISTS max_profile_cache \(.*?\);\n', '', schema, flags=re.S)
            with open_database(db, create=True) as conn, conn:
                conn.executescript(schema)
                conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'max', '501')")
                conn.execute('PRAGMA user_version = 4')
            initialize_database(db)
            with open_database(db) as conn:
                self.assertEqual(conn.execute('SELECT COUNT(*) FROM accounts').fetchone()[0], 1)
                self.assertIsNotNone(conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='max_profile_cache'").fetchone())

    def test_verified_profile_survives_restart_and_missing_fields(self):
        with tempfile.TemporaryDirectory() as path:
            db = Path(path) / 'profiles.sqlite3'
            server = Server(db)
            try:
                client = Client(server.base)
                data = {'id': 501, 'first_name': 'Анна', 'last_name': 'Иванова',
                        'photo_url': 'https://avatar.example/signed.png', 'profile_url': 'https://max.ru/u/example'}
                response = client.call('/api/session', {'init_data': signed(data)})['user']
                self.assertEqual((response['first_name'], response['last_name']), ('Анна', 'Иванова'))
                bad = signed({**data, 'first_name': 'Подмена'})
                bad = bad[:-1] + ('0' if bad[-1] != '0' else '1')
                client.call('/api/session', {'init_data': bad}, expected=401)
                with open_database(db) as conn, conn:
                    owner = conn.execute("SELECT id FROM accounts WHERE max_id = '501'").fetchone()[0]
                    conn.execute('UPDATE max_profile_cache SET avatar_png = ? WHERE account_id = ?', (PNG, owner))
                    conn.execute("INSERT INTO reports (id, owner_id, status, submitted_at) VALUES (1, ?, 'pending', '2026-01-01')", (owner,))
                server.close()
                server = Server(db)
                client.base = server.base
                own = client.call('/api/session')['user']
                self.assertEqual((own['first_name'], own['last_name']), ('Анна', 'Иванова'))
                self.assertEqual(own['photo_url'], f'/api/public/users/{owner}/avatar')
                public = Client(server.base)
                profile = public.call(f'/api/public/users/{owner}')
                self.assertEqual((profile['first_name'], profile['last_name']), ('Анна', 'Иванова'))
                self.assertEqual(profile['profile_url'], 'https://max.ru/u/example')
                self.assertEqual(public.call(profile['photo_url']), PNG)
                client.call('/api/reviewer', {'key': 'test-key'})
                author = client.call('/api/review/1')['author']
                self.assertEqual((author['first_name'], author['last_name'], author['photo_url']),
                                 ('Анна', 'Иванова', f'/api/public/users/{owner}/avatar'))
                update = {'id': 501, 'first_name': 'Анна-Мария', 'last_name': '', 'photo_url': None}
                own = client.call('/api/session', {'init_data': signed(update)})['user']
                self.assertEqual((own['first_name'], own['last_name']), ('Анна-Мария', 'Иванова'))
                server.close()
                server = Server(db)
                public.base = server.base
                profile = public.call(f'/api/public/users/{owner}')
                self.assertEqual((profile['first_name'], profile['last_name']), ('Анна-Мария', 'Иванова'))
                self.assertEqual(public.call(profile['photo_url']), PNG)
            finally:
                server.close()

    def test_avatar_url_allowlist(self):
        self.assertTrue(profile_cache.allowed_avatar_url('https://i.oneme.ru/avatar.png'))
        for value in ['http://i.oneme.ru/a', 'https://i.oneme.ru.evil.example/a',
                      'https://i.oneme.ru:8443/a', 'https://localhost/a',
                      'https://i.oneme.ru@evil.example/a', None]:
            self.assertFalse(profile_cache.allowed_avatar_url(value), value)

    @unittest.skipUnless(importlib.util.find_spec('PIL'), 'Pillow is not installed')
    def test_avatar_is_size_limited_and_converted_to_safe_png(self):
        from PIL import Image
        source = io.BytesIO()
        Image.new('RGB', (512, 384), 'red').save(source, format='JPEG')
        class Opener:
            def __init__(self, data):
                self.data = data
            def open(self, *_args, **_kwargs):
                return io.BytesIO(self.data)
        with patch.object(profile_cache, 'build_opener', return_value=Opener(source.getvalue())):
            image = profile_cache.download_avatar('https://i.oneme.ru/picture')
        with Image.open(io.BytesIO(image)) as decoded:
            self.assertEqual(decoded.format, 'PNG')
            self.assertEqual(decoded.size, (256, 192))
        with patch.object(profile_cache, 'build_opener', return_value=Opener(b'x' * (profile_cache.MAX_AVATAR_BYTES + 1))):
            self.assertIsNone(profile_cache.download_avatar('https://i.oneme.ru/picture'))

    def test_async_avatar_does_not_overwrite_newer_url(self):
        with tempfile.TemporaryDirectory() as path:
            db = Path(path) / 'profiles.sqlite3'
            initialize_database(db)
            with open_database(db) as conn, conn:
                conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'max', '101')")
                profile_cache.save_profile(conn, 1, ('Имя', '', 'https://i.oneme.ru/new', None))
            with patch.object(profile_cache, 'download_avatar', return_value=PNG):
                profile_cache.schedule_avatar(db, 1, 'https://i.oneme.ru/old')
                for _ in range(100):
                    with profile_cache._pending_lock:
                        pending = bool(profile_cache._pending)
                    if not pending:
                        break
                    time.sleep(.02)
                self.assertFalse(pending)
            with open_database(db) as conn:
                self.assertIsNone(conn.execute('SELECT avatar_png FROM max_profile_cache WHERE account_id=1').fetchone()[0])

    def test_async_avatar_is_saved_and_used_as_fallback(self):
        with tempfile.TemporaryDirectory() as path:
            db = Path(path) / 'profiles.sqlite3'
            initialize_database(db)
            url = 'https://i.oneme.ru/avatar'
            with open_database(db) as conn, conn:
                conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'max', '101')")
                profile_cache.save_profile(conn, 1, ('Имя', '', url, None))
            with patch.object(profile_cache, 'download_avatar', return_value=PNG):
                profile_cache.schedule_avatar(db, 1, url)
                for _ in range(100):
                    with profile_cache._pending_lock:
                        pending = bool(profile_cache._pending)
                    if not pending:
                        break
                    time.sleep(.02)
                self.assertFalse(pending)
            with open_database(db) as conn:
                self.assertEqual(conn.execute('SELECT avatar_png FROM max_profile_cache WHERE account_id=1').fetchone()[0], PNG)
                self.assertFalse(profile_cache.needs_avatar(profile_cache.cached_profile(conn, 1)))

    def test_live_fallback_updates_missing_fields_without_overwriting_newer_login(self):
        with tempfile.TemporaryDirectory() as path:
            db = Path(path) / 'profiles.sqlite3'
            initialize_database(db)
            with open_database(db) as conn, conn:
                conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'max', '101')")
                profile_cache.save_profile(conn, 1, ('Имя', 'Старая', 'https://i.oneme.ru/old', None))
                profile_cache.save_profile(conn, 1, ('Имя', '', None, None))
                revision = profile_cache.cached_profile(conn, 1)['revision']
            entered, release = threading.Event(), threading.Event()
            class Bot:
                def author_profile(self, _identifier):
                    entered.set()
                    release.wait(3)
                    return ('Имя', 'Из MAX', 'https://i.oneme.ru/from-max', None)
            with patch.object(profile_cache, 'download_avatar', return_value=None):
                profile_cache.schedule_live_profile(db, 1, '101', Bot(), ('Имя', '', None, None), revision)
                self.assertTrue(entered.wait(3))
                with open_database(db) as conn, conn:
                    profile_cache.save_profile(conn, 1, ('Новое имя', 'Новая', 'https://i.oneme.ru/new', None))
                release.set()
                for _ in range(150):
                    with profile_cache._pending_lock:
                        pending = bool(profile_cache._pending)
                    if not pending:
                        break
                    time.sleep(.02)
                self.assertFalse(pending)
            with open_database(db) as conn:
                cached = profile_cache.cached_profile(conn, 1)
            self.assertEqual((cached['first_name'], cached['last_name'], cached['photo_url']),
                             ('Новое имя', 'Новая', 'https://i.oneme.ru/new'))

    def test_live_fallback_refreshes_fields_missing_from_signed_login(self):
        with tempfile.TemporaryDirectory() as path:
            db = Path(path) / 'profiles.sqlite3'
            initialize_database(db)
            with open_database(db) as conn, conn:
                conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'max', '101')")
                profile_cache.save_profile(conn, 1, ('Имя', 'Старая', 'https://i.oneme.ru/old', None))
                profile_cache.save_profile(conn, 1, ('Имя', '', None, None))
                revision = profile_cache.cached_profile(conn, 1)['revision']
            class Bot:
                def author_profile(self, _identifier):
                    return ('Другое имя', 'Новая', 'https://i.oneme.ru/new', None)
            with patch.object(profile_cache, 'download_avatar', return_value=None):
                profile_cache.schedule_live_profile(db, 1, '101', Bot(), ('Имя', '', None, None), revision)
                for _ in range(150):
                    with profile_cache._pending_lock:
                        pending = bool(profile_cache._pending)
                    if not pending:
                        break
                    time.sleep(.02)
                self.assertFalse(pending)
            with open_database(db) as conn:
                cached = profile_cache.cached_profile(conn, 1)
            self.assertEqual((cached['first_name'], cached['last_name'], cached['photo_url']),
                             ('Имя', 'Новая', 'https://i.oneme.ru/new'))


if __name__ == '__main__':
    unittest.main()
