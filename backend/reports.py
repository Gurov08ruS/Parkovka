import base64
import re
from contextlib import closing
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

from accounts import clean_text
from database import open_database


SCHEMA = Path(__file__).with_name("schema.sql")
MAX_PHOTO_BYTES = 2 * 1024 * 1024
CAPTURE_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
CAPTURE_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z")
TRANSITIONS = {
    "pending": {"under_review", "approved", "rejected"},
    "under_review": {"approved", "rejected"},
}
REPORT_QUERY = """
    SELECT reports.id, reports.status, latitude, longitude, comment, created_at, submitted_at,
           address, captured_at, captures.report_id IS NOT NULL AS has_photo,
           detail_photo IS NOT NULL AS has_detail_photo
    FROM reports LEFT JOIN report_captures AS captures ON captures.report_id = reports.id
"""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def initialize_database(database):
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(open_database(database)) as connection, connection:
        connection.executescript(SCHEMA.read_text(encoding="utf-8"))
        connection.execute("BEGIN IMMEDIATE")
        for table, columns in (
            ("reports", {"owner_id": "INTEGER REFERENCES accounts(id)", "submitted_at": "TEXT"}),
            ("report_captures", {
                "detail_photo": "BLOB CHECK (length(detail_photo) BETWEEN 4 AND 2097152)",
                "captured_at": "TEXT",
            }),
        ):
            present = {column["name"] for column in connection.execute(f"PRAGMA table_info({table})")}
            for name, declaration in columns.items():
                if name not in present:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
        connection.execute("CREATE INDEX IF NOT EXISTS reports_owner ON reports(owner_id, id)")


def coordinates(data):
    latitude, longitude = data.get("latitude"), data.get("longitude")
    for value, limit in ((latitude, 90), (longitude, 180)):
        if type(value) not in (int, float) or not -limit <= value <= limit:
            raise ValueError("Широта и долгота должны быть числами в допустимом диапазоне.")
    return latitude, longitude


def decode_photo(value):
    if not isinstance(value, str):
        raise ValueError("Сделайте снимок с камеры сайта.")
    try:
        image = base64.b64decode(value, validate=True)
    except ValueError:
        raise ValueError("Некорректный снимок.") from None
    if not (4 <= len(image) <= MAX_PHOTO_BYTES
            and image.startswith(b"\xff\xd8\xff") and image.endswith(b"\xff\xd9")):
        raise ValueError("Загрузите снимки JPEG размером до 2 МБ каждый.")
    return image


def report_json(row):
    report = dict(row)
    report["has_photo"] = bool(report["has_photo"])
    report["has_detail_photo"] = bool(report["has_detail_photo"])
    return report


def create_draft(connection, data, owner_id):
    location = (None, None)
    if data.get("latitude") is not None or data.get("longitude") is not None:
        location = coordinates(data)
    comment = clean_text(data.get("comment", ""), "Комментарий", 1000)
    identifier = connection.execute(
        "INSERT INTO reports (owner_id, latitude, longitude, comment) VALUES (?, ?, ?, ?)",
        (owner_id, *location, comment),
    ).lastrowid
    return report_json(connection.execute(REPORT_QUERY + " WHERE reports.id = ?", (identifier,)).fetchone())


def submit_report(connection, data, owner_id):
    latitude, longitude = coordinates(data)
    capture_id = data.get("capture_id")
    if not isinstance(capture_id, str) or not CAPTURE_ID.fullmatch(capture_id):
        raise ValueError("Некорректный идентификатор отправки.")
    address = data.get("address")
    if address is not None:
        address = clean_text(address, "Адрес", 1000) or None
    comment = clean_text(data.get("comment", ""), "Комментарий", 1000)
    captured_at = data.get("captured_at")
    if captured_at is not None:
        if not isinstance(captured_at, str) or not CAPTURE_TIME.fullmatch(captured_at):
            raise ValueError("Некорректное время съёмки.")
        try:
            datetime.fromisoformat(captured_at[:-1] + "+00:00")
        except ValueError:
            raise ValueError("Некорректное время съёмки.") from None
    photo = decode_photo(data.get("photo"))
    detail = decode_photo(data["detail_photo"]) if data.get("detail_photo") is not None else None

    connection.execute("BEGIN IMMEDIATE")
    previous = connection.execute(
        "SELECT report_id, owner_id FROM report_captures JOIN reports ON reports.id = report_id WHERE capture_id = ?",
        (capture_id,),
    ).fetchone()
    if previous is not None:
        if previous["owner_id"] != owner_id:
            raise ApiError(HTTPStatus.CONFLICT, "Создайте новое обращение и повторите отправку.")
        return report_json(connection.execute(
            REPORT_QUERY + " WHERE reports.id = ?", (previous["report_id"],),
        ).fetchone()), False

    identifier = connection.execute(
        """INSERT INTO reports (owner_id, status, latitude, longitude, comment, submitted_at)
           VALUES (?, 'pending', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))""",
        (owner_id, latitude, longitude, comment),
    ).lastrowid
    connection.execute(
        """INSERT INTO report_captures (report_id, capture_id, address, photo, detail_photo, captured_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (identifier, capture_id, address, photo, detail, captured_at),
    )
    connection.execute(
        "INSERT INTO report_events (report_id, actor_id, status) VALUES (?, ?, 'pending')",
        (identifier, owner_id),
    )
    return report_json(connection.execute(REPORT_QUERY + " WHERE reports.id = ?", (identifier,)).fetchone()), True


def report_scope(account, reviewer):
    if reviewer:
        return ("reports.submitted_at IS NOT NULL AND reports.owner_id IN (SELECT id FROM accounts WHERE source = ?)",
                account["source"])
    return "reports.owner_id = ?", account["id"]


def list_reports(connection, account, reviewer=False):
    scope, value = report_scope(account, reviewer)
    order = "CASE reports.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END, " if reviewer else ""
    rows = connection.execute(REPORT_QUERY + f" WHERE {scope} ORDER BY {order}reports.id DESC", (value,))
    return [report_json(row) for row in rows]


def visible_report(connection, identifier, account, reviewer):
    scope, value = report_scope(account, reviewer)
    row = connection.execute(REPORT_QUERY + f" WHERE reports.id = ? AND {scope}", (identifier, value)).fetchone()
    if row is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
    return report_json(row)


def report_detail(connection, identifier, account, reviewer):
    report = visible_report(connection, identifier, account, reviewer)
    report["events"] = [dict(row) for row in connection.execute(
        "SELECT status, note, occurred_at FROM report_events WHERE report_id = ? ORDER BY id",
        (identifier,),
    )]
    return report


def report_photo(connection, identifier, kind, account, reviewer):
    visible_report(connection, identifier, account, reviewer)
    column = "photo" if kind == "overview" else "detail_photo"
    row = connection.execute(f"SELECT {column} FROM report_captures WHERE report_id = ?", (identifier,)).fetchone()
    if row is None or row[0] is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Снимок не найден.")
    return row[0]


def change_status(connection, identifier, account, data):
    status = data.get("status")
    if not isinstance(status, str) or status not in {"under_review", "approved", "rejected"}:
        raise ValueError("Выберите результат проверки.")
    note = clean_text(data.get("note", ""), "Результат проверки", 1000, required=status == "rejected")
    connection.execute("BEGIN IMMEDIATE")
    current = visible_report(connection, identifier, account, reviewer=True)
    if status not in TRANSITIONS.get(current["status"], set()):
        raise ApiError(HTTPStatus.CONFLICT, "Статус уже изменился. Обновите очередь.")
    connection.execute("UPDATE reports SET status = ? WHERE id = ?", (status, identifier))
    connection.execute(
        "INSERT INTO report_events (report_id, actor_id, status, note) VALUES (?, ?, ?, ?)",
        (identifier, account["id"], status, note),
    )
    return report_detail(connection, identifier, account, reviewer=True)
