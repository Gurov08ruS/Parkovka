import base64
import re
from contextlib import closing
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

from accounts import clean_text, ensure_active
from database import open_database


SCHEMA = Path(__file__).with_name("schema.sql")
MAX_PHOTO_BYTES = 64 * 1024 * 1024
BAN_REJECTION_NOTE = "Автоматически отклонено из-за блокировки аккаунта."
CAPTURE_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
CAPTURE_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z")
TRANSITIONS = {
    "pending": {"under_review", "approved", "rejected"},
    "under_review": {"approved", "rejected"},
}
REPORT_QUERY = """
    SELECT reports.id, reports.status, latitude, longitude, plate_number, plate_source, plate_verification,
           comment, created_at, submitted_at,
           address, captured_at, captures.report_id IS NOT NULL AS has_photo,
           detail_photo IS NOT NULL AS has_detail_photo,
           COALESCE(ban_event.account_ban, 0) AS auto_rejected,
           ban_event.ban_report_id
    FROM reports LEFT JOIN report_captures AS captures ON captures.report_id = reports.id
    LEFT JOIN report_events AS ban_event ON ban_event.id = (
        SELECT id FROM report_events
        WHERE report_id = reports.id AND account_ban = 1
        ORDER BY id DESC LIMIT 1
    )
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
        if connection.execute("PRAGMA user_version").fetchone()[0] < 1:
            columns = {column["name"] for column in connection.execute("PRAGMA table_info(report_captures)")}
            if "detail_photo" not in columns:
                connection.execute("ALTER TABLE report_captures ADD COLUMN detail_photo BLOB")
            if "captured_at" not in columns:
                connection.execute("ALTER TABLE report_captures ADD COLUMN captured_at TEXT")
            connection.execute("""CREATE TABLE report_captures_new (
                report_id INTEGER PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
                capture_id TEXT NOT NULL UNIQUE,
                address TEXT,
                photo BLOB NOT NULL CHECK (length(photo) BETWEEN 4 AND 67108864),
                detail_photo BLOB CHECK (length(detail_photo) BETWEEN 4 AND 67108864),
                captured_at TEXT
            )""")
            connection.execute("""INSERT INTO report_captures_new
                (report_id, capture_id, address, photo, detail_photo, captured_at)
                SELECT report_id, capture_id, address, photo, detail_photo, captured_at FROM report_captures""")
            connection.execute("DROP TABLE report_captures")
            connection.execute("ALTER TABLE report_captures_new RENAME TO report_captures")
            connection.execute("PRAGMA user_version = 1")
        for table, columns in (
            ("accounts", {"photo_url": "TEXT"}),
            ("reports", {
                "owner_id": "INTEGER REFERENCES accounts(id)", "submitted_at": "TEXT",
                "plate_number": "TEXT", "plate_source": "TEXT", "plate_verification": "TEXT",
            }),
            ("report_events", {
                "account_ban": "INTEGER NOT NULL DEFAULT 0 CHECK (account_ban IN (0, 1))",
                "ban_report_id": "INTEGER REFERENCES reports(id) ON DELETE SET NULL",
            }),
        ):
            present = {column["name"] for column in connection.execute(f"PRAGMA table_info({table})")}
            for name, declaration in columns.items():
                if name not in present:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
        connection.execute("CREATE INDEX IF NOT EXISTS reports_owner ON reports(owner_id, id)")
        if connection.execute("PRAGMA user_version").fetchone()[0] < 2:
            for ban in connection.execute("SELECT account_id, reviewer_id FROM account_bans WHERE active = 1"):
                reject_banned_reports(connection, ban["account_id"], ban["reviewer_id"])
            connection.execute("PRAGMA user_version = 2")


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
    jpeg = image.startswith(b"\xff\xd8\xff") and image.endswith(b"\xff\xd9")
    png = image.startswith(b"\x89PNG\r\n\x1a\n") and image.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")
    if not (4 <= len(image) <= MAX_PHOTO_BYTES and (jpeg or png)):
        raise ValueError("Ожидается снимок PNG или JPEG размером до 64 МБ.")
    return image


def report_json(row):
    report = dict(row)
    report["has_photo"] = bool(report["has_photo"])
    report["has_detail_photo"] = bool(report["has_detail_photo"])
    report["auto_rejected"] = bool(report["auto_rejected"])
    return report


def create_draft(connection, data, owner_id):
    location = (None, None)
    if data.get("latitude") is not None or data.get("longitude") is not None:
        location = coordinates(data)
    comment = clean_text(data.get("comment", ""), "Комментарий", 1000)
    plate = clean_text(data.get("plate_number", ""), "Госномер", 32).upper() or None
    connection.execute("BEGIN IMMEDIATE")
    ensure_active(connection, owner_id)
    identifier = connection.execute(
        """INSERT INTO reports (owner_id, latitude, longitude, comment, plate_number, plate_source, plate_verification)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (owner_id, *location, comment, plate, "manual" if plate else None, "unverified" if plate else None),
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
    plate = clean_text(data.get("plate_number", ""), "Госномер", 32).upper() or None
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
    ensure_active(connection, owner_id)
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
        """INSERT INTO reports (owner_id, status, latitude, longitude, comment,
                                plate_number, plate_source, plate_verification, submitted_at)
           VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))""",
        (owner_id, latitude, longitude, comment, plate, "manual" if plate else None, "unverified" if plate else None),
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
        return ("""(reports.submitted_at IS NOT NULL OR ban_event.id IS NOT NULL)
                   AND reports.owner_id IN (SELECT id FROM accounts WHERE source = ?)""",
                account["source"])
    return "reports.owner_id = ?", account["id"]


def account_report_stats(connection, account_id):
    return dict(connection.execute(
        """SELECT COUNT(*) FILTER (WHERE status = 'approved') AS approved,
                  COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
           FROM reports WHERE owner_id = ? AND status IN ('approved', 'rejected')""",
        (account_id,),
    ).fetchone())


def reviewer_decision_stats(connection, account_id):
    return dict(connection.execute(
        """SELECT COUNT(*) FILTER (WHERE status = 'approved') AS approved,
                  COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
           FROM report_events WHERE actor_id = ? AND account_ban = 0 AND status IN ('approved', 'rejected')""",
        (account_id,),
    ).fetchone())


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
    if reviewer:
        author = connection.execute(
            """SELECT accounts.id, accounts.max_id, accounts.first_name, accounts.last_name,
                      COALESCE(account_bans.active, 0) AS banned,
                      account_bans.reason AS ban_reason
               FROM reports JOIN accounts ON accounts.id = reports.owner_id
               LEFT JOIN account_bans ON account_bans.account_id = accounts.id
               WHERE reports.id = ?""", (identifier,),
        ).fetchone()
        report["author"] = dict(author)
        report["author"]["banned"] = bool(report["author"]["banned"])
        report["author"]["stats"] = account_report_stats(connection, author["id"])
    report["events"] = [dict(row) for row in connection.execute(
        "SELECT status, note, occurred_at FROM report_events WHERE report_id = ? ORDER BY id",
        (identifier,),
    )]
    return report


def reject_banned_reports(connection, author_id, reviewer_id, ban_report_id=None):
    connection.execute(
        """INSERT INTO report_events (report_id, actor_id, status, note, account_ban, ban_report_id)
           SELECT reports.id, ?, 'rejected', ?, 1, ? FROM reports
           WHERE reports.owner_id = ? AND NOT EXISTS (
               SELECT 1 FROM report_events WHERE report_id = reports.id AND account_ban = 1
           )""",
        (reviewer_id, BAN_REJECTION_NOTE, ban_report_id, author_id),
    )
    connection.execute(
        "UPDATE reports SET status = 'rejected' WHERE owner_id = ? AND status <> 'rejected'",
        (author_id,),
    )


def set_author_ban(connection, identifier, account, data):
    banned = data.get("banned")
    if type(banned) is not bool:
        raise ValueError("Укажите действие с аккаунтом.")
    reason = clean_text(data.get("reason", ""), "Причина блокировки", 1000, required=banned)
    connection.execute("BEGIN IMMEDIATE")
    ensure_active(connection, account["id"])
    visible_report(connection, identifier, account, reviewer=True)
    author_id = connection.execute("SELECT owner_id FROM reports WHERE id = ?", (identifier,)).fetchone()[0]
    if author_id == account["id"]:
        raise ApiError(HTTPStatus.CONFLICT, "Нельзя заблокировать собственный аккаунт.")
    current = connection.execute("SELECT active FROM account_bans WHERE account_id = ?", (author_id,)).fetchone()
    if bool(current and current["active"]) == banned:
        return report_detail(connection, identifier, account, reviewer=True)
    connection.execute(
        """INSERT INTO account_bans (account_id, reviewer_id, active, reason)
           VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
           reviewer_id = excluded.reviewer_id, active = excluded.active, reason = excluded.reason,
           changed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')""",
        (author_id, account["id"], banned, reason),
    )
    if banned:
        reject_banned_reports(connection, author_id, account["id"], identifier)
    return report_detail(connection, identifier, account, reviewer=True)


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
    ensure_active(connection, account["id"])
    current = visible_report(connection, identifier, account, reviewer=True)
    if status not in TRANSITIONS.get(current["status"], set()):
        raise ApiError(HTTPStatus.CONFLICT, "Статус уже изменился. Обновите очередь.")
    connection.execute("UPDATE reports SET status = ? WHERE id = ?", (status, identifier))
    connection.execute(
        "INSERT INTO report_events (report_id, actor_id, status, note) VALUES (?, ?, ?, ?)",
        (identifier, account["id"], status, note),
    )
    return report_detail(connection, identifier, account, reviewer=True)
