"""End-to-end checks for publication, visibility boundaries and ranking."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from database import ensure_key, open_database
from reports import initialize_database

IMAGE = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aR8AAAAASUVORK5CYII=')


class Client:
    def __init__(self, base):
        self.base, self.cookie = base, None

    def call(self, path, payload=None, expected=200):
        headers = {}
        if self.cookie:
            headers['Cookie'] = self.cookie
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            if response.status != expected:
                raise AssertionError((path, response.status, body))
            if response.headers.get('Set-Cookie'):
                self.cookie = response.headers['Set-Cookie'].split(';', 1)[0]
            if response.headers.get_content_type() == 'application/json':
                return json.loads(body)
            return body


class PublicAccessTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.tmp.name) / 'test.sqlite3'
        cls.log = tempfile.TemporaryFile()
        cls.child = subprocess.Popen([sys.executable, 'backend/server.py', '--test', '--port', '0', '--db', str(cls.db)],
                                     cwd=ROOT, stdout=cls.log, stderr=cls.log)
        for _ in range(200):
            output = os.pread(cls.log.fileno(), 100000, 0).decode(errors='replace')
            match = re.search(r'http://127\.0\.0\.1:\d+', output)
            if match:
                cls.base = match.group()
                break
            if cls.child.poll() is not None:
                raise RuntimeError(output)
            time.sleep(.05)
        else:
            raise RuntimeError(output)

    @classmethod
    def tearDownClass(cls):
        cls.child.terminate()
        cls.child.wait(timeout=10)
        cls.log.close()
        cls.tmp.cleanup()

    def test_public_access_and_owner_controls(self):
        owner, other, visitor = (Client(self.base) for _ in range(3))
        owner.call('/api/session', {})
        other.call('/api/session', {})
        with open_database(self.db) as conn, conn:
            owners = [row[0] for row in conn.execute('SELECT id FROM accounts ORDER BY id')]
            self.assertEqual(len(owners), 2)
            for identifier, status, public, submitted, withdrawn in [
                (10, 'approved', 0, True, False), (11, 'approved', 1, True, False),
                (12, 'draft', 1, False, False), (13, 'pending', 1, True, True),
            ]:
                conn.execute('''INSERT INTO reports (id, owner_id, status, is_public, submitted_at, withdrawn_at)
                    VALUES (?, ?, ?, ?, ?, ?)''', (identifier, owners[0], status, public,
                        '2026-01-01T00:00:00Z' if submitted else None,
                        '2026-01-02T00:00:00Z' if withdrawn else None))
                conn.execute('INSERT INTO report_captures (report_id, capture_id, photo) VALUES (?, ?, ?)',
                             (identifier, f'{identifier:08x}-0000-4000-8000-000000000000', IMAGE))
            conn.execute("INSERT INTO report_events (report_id, actor_id, status, note) VALUES (11, ?, 'approved', 'private reviewer note')", (owners[1],))
            conn.execute("INSERT INTO account_achievements (account_id, code) VALUES (?, 'first_report')", (owners[0],))
        result = visitor.call('/api/public/reports')['reports']
        self.assertEqual([r['id'] for r in result], [11])
        self.assertEqual(result[0]['author_id'], owners[0])
        self.assertNotIn('ban_report_id', result[0])
        self.assertEqual(owner.call('/api/public/reports')['reports'], [])
        self.assertEqual(len(other.call('/api/public/reports')['reports']), 1)
        report = visitor.call('/api/public/reports/11')
        self.assertEqual(report['events'], [])
        self.assertNotIn('private reviewer note', json.dumps(report))
        self.assertEqual(visitor.call('/api/public/reports/11/photos/overview'), IMAGE)
        for identifier in (10, 12, 13):
            visitor.call(f'/api/public/reports/{identifier}', expected=404)
            visitor.call(f'/api/public/reports/{identifier}/photos/overview', expected=404)
        other.call('/api/reports/10', expected=404)
        self.assertEqual(owner.call('/api/reports/10')['author_id'], owners[0])
        other.call('/api/reports/10/visibility', {'is_public': True}, expected=404)
        visitor.call('/api/reports/10/visibility', {'is_public': True}, expected=401)
        owner.call('/api/reports/10/visibility', {'is_public': 'true'}, expected=400)
        owner.call('/api/reports/10/visibility', {'is_public': True})
        visitor.call('/api/public/reports/10')
        owner.call('/api/reports/11/visibility', {'is_public': False})
        visitor.call('/api/public/reports/11', expected=404)
        visitor.call('/api/public/reports/11/photos/overview', expected=404)
        ranks = visitor.call('/api/public/leaderboard')['users']
        self.assertEqual(ranks, [{'id': owners[0], 'approved': 2}, {'id': owners[1], 'approved': 0}])
        profile = visitor.call(f'/api/public/users/{owners[0]}')
        self.assertEqual(profile['earned'], ['first_report'])
        self.assertEqual(profile['approved'], 2)
        self.assertEqual(profile['rank'], 1)
        self.assertEqual(visitor.call(f'/api/public/users/{owners[1]}')['rank'], 2)
        history = visitor.call(f'/api/public/users/{owners[0]}/reports')['reports']
        self.assertEqual([item['id'] for item in history], [10])
        self.assertEqual(visitor.call(f'/api/public/users/{owners[1]}/reports')['reports'], [])
        visitor.call('/api/public/users/9999/reports', expected=404)
        self.assertNotIn('max_id', profile)
        self.assertNotIn('source', profile)
        draft_body = {'capture_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      'photo': base64.b64encode(IMAGE).decode(), 'is_public': True}
        draft = owner.call('/api/reports/capture/draft', draft_body, expected=201)
        self.assertTrue(draft['is_public'])
        visitor.call(f"/api/public/reports/{draft['id']}", expected=404)
        del draft_body['is_public']
        self.assertTrue(owner.call('/api/reports/capture/draft', draft_body)['is_public'])
        draft_body['is_public'] = False
        self.assertFalse(owner.call('/api/reports/capture/draft', draft_body)['is_public'])

    def test_existing_database_migrates_to_private(self):
        with tempfile.TemporaryDirectory() as path:
            database = Path(path) / 'old.sqlite3'
            ensure_key(database)
            schema = (ROOT / 'backend/schema.sql').read_text().replace(
                '    is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),\n', '')
            with open_database(database, create=True) as conn, conn:
                conn.executescript(schema)
                conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'test', 'legacy')")
                conn.execute("INSERT INTO reports (id, owner_id, status, submitted_at) VALUES (1, 1, 'approved', '2026-01-01')")
                conn.execute('PRAGMA user_version = 4')
            initialize_database(database)
            with open_database(database) as conn:
                self.assertEqual(conn.execute('SELECT is_public FROM reports WHERE id = 1').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
