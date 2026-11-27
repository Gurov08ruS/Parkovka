"""The detector cache follows the exact saved photo and survives process restarts."""
import base64
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import plate_boxes
from database import open_database
from reports import initialize_database, save_capture


def photo(marker):
    return b'\xff\xd8\xff' + marker + b'\xff\xd9'


class PlateBoxesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'db.sqlite3'
        initialize_database(self.db)
        self.conn = open_database(self.db)
        with self.conn:
            self.conn.execute("INSERT INTO accounts (id, source, max_id) VALUES (1, 'test', 'one')")
        self.payload = {'capture_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'photo': base64.b64encode(photo(b'a')).decode()}
        with self.conn:
            report, _ = save_capture(self.conn, self.payload, 1, draft=True)
        self.identifier = report['id']
        plate_boxes._recent.clear()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()
        plate_boxes._recent.clear()

    def test_cache_survives_restart_and_same_photo_update(self):
        boxes = [[.1, .2, .3, .4]]
        with patch.object(plate_boxes, 'analyze', return_value={'boxes': boxes}) as detector:
            with self.conn:
                self.assertEqual(plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'a')), boxes)
            self.assertEqual(detector.call_count, 1)
            plate_boxes._recent.clear()
            self.conn.close()
            self.conn = open_database(self.db)
            with self.conn:
                self.assertEqual(plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'a')), boxes)
            self.assertEqual(detector.call_count, 1)
            self.payload['comment'] = 'edited'
            with self.conn:
                save_capture(self.conn, self.payload, 1, draft=True)
            with self.conn:
                self.assertEqual(plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'a')), boxes)
            self.assertEqual(detector.call_count, 1)

    def test_retake_invalidates_only_changed_photo_and_empty_is_cached(self):
        self.payload['detail_photo'] = base64.b64encode(photo(b'b')).decode()
        with self.conn:
            save_capture(self.conn, self.payload, 1, draft=True)
        with patch.object(plate_boxes, 'analyze', return_value={'boxes': []}) as detector:
            with self.conn:
                plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'a'))
                plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'detail', photo(b'b'))
            self.assertEqual(detector.call_count, 2)
            self.payload['photo'] = base64.b64encode(photo(b'c')).decode()
            with self.conn:
                save_capture(self.conn, self.payload, 1, draft=True)
            plate_boxes._recent.clear()
            with self.conn:
                plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'detail', photo(b'b'))
                plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'c'))
            self.assertEqual(detector.call_count, 3)

    def test_model_version_change_recomputes(self):
        with patch.object(plate_boxes, 'analyze', return_value={'boxes': []}) as detector:
            with self.conn:
                plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'a'))
            with patch.object(plate_boxes, 'BOX_CACHE_VERSION', 'another-detector'):
                with self.conn:
                    plate_boxes.cached_photo_boxes(self.conn, self.identifier, 'overview', photo(b'a'))
            self.assertEqual(detector.call_count, 2)


if __name__ == '__main__':
    unittest.main()
