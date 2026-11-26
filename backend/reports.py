import base64
import re
from contextlib import closing
from datetime import datetime
from http import HTTPStatus
from pathlib import Path

from accounts import clean_text, ensure_active
from achievements import award, award_accepted_reports, backfill_achievements
from database import ensure_key, open_database
from plates import LETTER_TRANSLATION, PLATE_CHARACTERS, PLATE_WITH_REGION, REGISTRATION_CODES


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
    SELECT reports.id, CASE WHEN withdrawn_at IS NOT NULL THEN 'withdrawn' ELSE reports.status END AS status,
           latitude, longitude, plate_number, plate_source, plate_verification, plate_region, plate_region_source,
           comment, created_at, submitted_at, withdrawn_at,
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
    ensure_key(database)
    with closing(open_database(database, create=True)) as connection, connection:
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
            ("reports", {
                "owner_id": "INTEGER REFERENCES accounts(id)", "submitted_at": "TEXT",
                "plate_number": "TEXT", "plate_source": "TEXT", "plate_verification": "TEXT", "withdrawn_at": "TEXT",
                "plate_region": "TEXT", "plate_region_source": "TEXT",
                "deleted_at": "TEXT", "deleted_capture_id": "TEXT",
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
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS reports_deleted_capture ON reports(deleted_capture_id) WHERE deleted_capture_id IS NOT NULL")
        if connection.execute("PRAGMA user_version").fetchone()[0] < 2:
            for ban in connection.execute("SELECT account_id, reviewer_id FROM account_bans WHERE active = 1"):
                reject_banned_reports(connection, ban["account_id"], ban["reviewer_id"])
            connection.execute("PRAGMA user_version = 2")
        if connection.execute("PRAGMA user_version").fetchone()[0] < 3:
            connection.execute("PRAGMA secure_delete = ON")
            columns = {column["name"] for column in connection.execute("PRAGMA table_info(accounts)")}
            for name in ("first_name", "last_name", "photo_url"):
                if name in columns:
                    connection.execute(f"ALTER TABLE accounts DROP COLUMN {name}")
            connection.execute("PRAGMA user_version = 3")
        if connection.execute("PRAGMA user_version").fetchone()[0] < 4:
            backfill_achievements(connection)
            connection.execute("PRAGMA user_version = 4")
        connection.execute("""CREATE TRIGGER IF NOT EXISTS enqueue_max_report_notification
            AFTER INSERT ON report_events
            WHEN NEW.status IN ('pending', 'approved', 'rejected') AND EXISTS (
                SELECT 1 FROM reports JOIN accounts ON accounts.id = reports.owner_id
                WHERE reports.id = NEW.report_id AND reports.submitted_at IS NOT NULL AND accounts.source = 'max'
                    AND (NEW.account_ban = 0 OR reports.status <> 'rejected')
            )
            BEGIN
                INSERT INTO max_report_notifications (event_id) VALUES (NEW.id);
            END""")


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


def report_fields(data, *, draft):
    has_position = data.get("latitude") is not None or data.get("longitude") is not None
    location = coordinates(data) if has_position or not draft else (None, None)
    comment = clean_text(data.get("comment", ""), "Комментарий", 1000)
    plate = clean_text(data.get("plate_number", ""), "Госномер", 32).upper().translate(LETTER_TRANSLATION)
    if not PLATE_CHARACTERS.fullmatch(plate):
        raise ValueError("В госномере допустимы цифры и буквы А, В, Е, К, М, Н, О, Р, С, Т, У, Х.")
    region = data.get("plate_region")
    provided_source = data.get("plate_region_source")
    if matched := PLATE_WITH_REGION.fullmatch(plate):
        plate, inline_region = matched.groups()
        if region is None:
            region, provided_source = inline_region, "manual"
    plate = plate or None
    region_source = None
    if region is not None:
        if not isinstance(region, str) or not re.fullmatch(r"[0-9]{2,3}", region):
            raise ValueError("Код региона должен состоять из двух или трёх цифр.")
        if region not in REGISTRATION_CODES:
            raise ValueError("Такого кода региона нет. Проверьте номер автомобиля.")
        region_source = "location" if has_position and provided_source == "location" else "manual"
    return (*location, comment, plate, "manual" if plate else None, "unverified" if plate else None, region, region_source)


def insert_report(connection, owner_id, fields):
    identifier = None if connection.execute("SELECT 1 FROM reports WHERE id = 0").fetchone() else 0
    return connection.execute(
        """INSERT INTO reports (id, owner_id, latitude, longitude, comment, plate_number, plate_source, plate_verification,
                                plate_region, plate_region_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (identifier, owner_id, *fields),
    ).lastrowid


def create_draft(connection, data, owner_id):
    fields = report_fields(data, draft=True)
    connection.execute("BEGIN IMMEDIATE")
    ensure_active(connection, owner_id)
    identifier = insert_report(connection, owner_id, fields)
    return report_json(connection.execute(REPORT_QUERY + " WHERE reports.id = ?", (identifier,)).fetchone())


def save_capture(connection, data, owner_id, *, draft=False):
    fields = report_fields(data, draft=draft)
    capture_id = data.get("capture_id")
    if not isinstance(capture_id, str) or not CAPTURE_ID.fullmatch(capture_id):
        raise ValueError("Некорректный идентификатор отправки.")
    address = data.get("address")
    if address is not None:
        address = clean_text(address, "Адрес", 1000) or None
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
    if connection.execute("SELECT 1 FROM reports WHERE deleted_capture_id = ?", (capture_id,)).fetchone():
        raise ApiError(HTTPStatus.GONE, "Этот черновик уже удалён.")
    previous = connection.execute(
        """SELECT report_id, owner_id, status, submitted_at
           FROM report_captures JOIN reports ON reports.id = report_id WHERE capture_id = ?""",
        (capture_id,),
    ).fetchone()
    if previous is None:
        identifier = insert_report(connection, owner_id, fields)
    else:
        if previous["owner_id"] != owner_id:
            raise ApiError(HTTPStatus.CONFLICT, "Создайте новое обращение и повторите отправку.")
        identifier = previous["report_id"]
        if previous["submitted_at"] is not None:
            return visible_report(connection, identifier, {"id": owner_id}, False), False
        if previous["status"] != "draft":
            raise ApiError(HTTPStatus.CONFLICT, "Этот черновик уже закрыт.")

        connection.execute(
            """UPDATE reports SET latitude = ?, longitude = ?, comment = ?,
                                  plate_number = ?, plate_source = ?, plate_verification = ?,
                                  plate_region = ?, plate_region_source = ? WHERE id = ?""",
            (*fields, identifier),
        )
    connection.execute(
        """INSERT INTO report_captures (report_id, capture_id, address, photo, detail_photo, captured_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(report_id) DO UPDATE SET
               address = excluded.address, photo = excluded.photo,
               detail_photo = excluded.detail_photo, captured_at = excluded.captured_at""",
        (identifier, capture_id, address, photo, detail, captured_at),
    )
    if previous is None and data.get("offline_created") is True:
        award(connection, owner_id, "offline_sync")
    if detail is not None:
        award(connection, owner_id, "two_photos")
    if not draft:
        connection.execute(
            "UPDATE reports SET status = 'pending', submitted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
            (identifier,),
        )
        connection.execute(
            "INSERT INTO report_events (report_id, actor_id, status) VALUES (?, ?, 'pending')",
            (identifier, owner_id),
        )
        award(connection, owner_id, "first_report")
        if captured_at is not None:
            award(connection, owner_id, "gps_capture")
    return visible_report(connection, identifier, {"id": owner_id}, False), previous is None


def report_scope(account, reviewer):
    if reviewer:
        return ("""(reports.submitted_at IS NOT NULL OR ban_event.id IS NOT NULL)
                   AND reports.withdrawn_at IS NULL AND reports.deleted_at IS NULL
                   AND reports.owner_id IN (SELECT id FROM accounts WHERE source = ?)""",
                account["source"])
    return "reports.owner_id = ? AND reports.deleted_at IS NULL", account["id"]


def account_report_stats(connection, account_id):
    return dict(connection.execute(
        """SELECT COUNT(*) FILTER (WHERE status = 'approved' AND withdrawn_at IS NULL) AS approved,
                  COUNT(*) FILTER (WHERE status = 'rejected' AND withdrawn_at IS NULL) AS rejected,
                  COUNT(withdrawn_at) AS withdrawn
           FROM reports WHERE owner_id = ? AND deleted_at IS NULL""",
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
    rows = connection.execute(REPORT_QUERY + f" WHERE {scope} ORDER BY {order}reports.created_at DESC, reports.id DESC", (value,))
    return [report_json(row) for row in rows]


def visible_report(connection, identifier, account, reviewer):
    scope, value = report_scope(account, reviewer)
    row = connection.execute(REPORT_QUERY + f" WHERE reports.id = ? AND {scope}", (identifier, value)).fetchone()
    if row is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
    return report_json(row)


def report_detail(connection, identifier, account, reviewer):
    report = visible_report(connection, identifier, account, reviewer)
    if not reviewer and report["status"] == "draft" and report["has_photo"]:
        row = connection.execute("SELECT capture_id FROM report_captures WHERE report_id = ?", (identifier,)).fetchone()
        if row is not None:
            report["capture_id"] = row["capture_id"]
    if reviewer:
        author = connection.execute(
            """SELECT accounts.id, accounts.max_id, accounts.source,
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
    if report["withdrawn_at"] is not None:
        report["events"].append({"status": "withdrawn", "occurred_at": report["withdrawn_at"], "note": ""})
    return report


def withdraw_report(connection, identifier, account):
    connection.execute("BEGIN IMMEDIATE")
    ensure_active(connection, account["id"])
    report = visible_report(connection, identifier, account, reviewer=False)
    if report["status"] == "withdrawn":
        return report_detail(connection, identifier, account, reviewer=False)
    if report["status"] not in TRANSITIONS:
        raise ApiError(HTTPStatus.CONFLICT, "Можно отозвать только обращение, по которому ещё нет решения.")
    connection.execute(
        "UPDATE reports SET withdrawn_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
        (identifier,),
    )
    return report_detail(connection, identifier, account, reviewer=False)


def delete_draft(connection, identifier, account):
    connection.execute("BEGIN IMMEDIATE")
    ensure_active(connection, account["id"])
    report = connection.execute(
        "SELECT status, submitted_at, deleted_at FROM reports WHERE id = ? AND owner_id = ?",
        (identifier, account["id"]),
    ).fetchone()
    if report is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Черновик не найден.")
    if report["submitted_at"] is not None or report["status"] != "draft":
        raise ApiError(HTTPStatus.CONFLICT, "Можно удалить только неотправленный черновик.")
    if report["deleted_at"] is None:
        connection.execute(
            """UPDATE reports SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                   deleted_capture_id = (SELECT capture_id FROM report_captures WHERE report_id = reports.id),
                   latitude = NULL, longitude = NULL, comment = '', plate_number = NULL,
                   plate_source = NULL, plate_verification = NULL, plate_region = NULL, plate_region_source = NULL WHERE id = ?""",
            (identifier,),
        )
        connection.execute("DELETE FROM report_captures WHERE report_id = ?", (identifier,))
    return {"deleted": True}


def reject_banned_reports(connection, author_id, reviewer_id, ban_report_id=None):
    connection.execute(
        """INSERT INTO report_events (report_id, actor_id, status, note, account_ban, ban_report_id)
           SELECT reports.id, ?, 'rejected', ?, 1, ? FROM reports
           WHERE reports.owner_id = ? AND reports.withdrawn_at IS NULL AND reports.deleted_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM report_events WHERE report_id = reports.id AND account_ban = 1
           )""",
        (reviewer_id, BAN_REJECTION_NOTE, ban_report_id, author_id),
    )
    connection.execute(
        """UPDATE reports SET status = 'rejected'
           WHERE owner_id = ? AND status <> 'rejected' AND withdrawn_at IS NULL AND deleted_at IS NULL""",
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
    if status == "approved":
        owner_id = connection.execute("SELECT owner_id FROM reports WHERE id = ?", (identifier,)).fetchone()[0]
        award_accepted_reports(connection, owner_id)
    return report_detail(connection, identifier, account, reviewer=True)
