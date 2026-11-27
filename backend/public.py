"""Public views. Private reports never use these queries."""
from http import HTTPStatus

from achievements import earned_achievements
from reports import ApiError, REPORT_QUERY, report_json

PUBLIC_SCOPE = """reports.is_public = 1 AND reports.submitted_at IS NOT NULL
    AND reports.withdrawn_at IS NULL AND reports.deleted_at IS NULL
    AND reports.owner_id IN (SELECT id FROM accounts WHERE source = ?)"""
PUBLIC_QUERY = REPORT_QUERY.replace("SELECT reports.id,", "SELECT reports.id, reports.owner_id AS author_id,", 1)


def leaderboard(connection, source):
    rows = connection.execute("""SELECT accounts.id,
            COUNT(reports.id) AS approved
        FROM accounts LEFT JOIN reports ON reports.owner_id = accounts.id AND reports.status = 'approved'
          AND reports.withdrawn_at IS NULL AND reports.deleted_at IS NULL
        WHERE accounts.source = ? AND accounts.max_id <> 'reviewer-account'
        GROUP BY accounts.id ORDER BY approved DESC, accounts.id ASC""", (source,))
    return [dict(row) for row in rows]


def public_account(connection, source, identifier):
    row = connection.execute("SELECT id, source, max_id FROM accounts WHERE source = ? AND id = ?", (source, identifier)).fetchone()
    if row is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Профиль не найден.")
    result = dict(row)
    result["approved"] = connection.execute("""SELECT COUNT(*) FROM reports WHERE owner_id = ?
        AND status = 'approved' AND withdrawn_at IS NULL AND deleted_at IS NULL""", (identifier,)).fetchone()[0]
    result.update(earned_achievements(connection, identifier))
    return result


def public_reports(connection, source, exclude_owner=None):
    query = PUBLIC_QUERY + " WHERE " + PUBLIC_SCOPE
    params = [source]
    if exclude_owner is not None:
        query += " AND reports.owner_id != ?"
        params.append(exclude_owner)
    query += " ORDER BY reports.submitted_at DESC, reports.id DESC"
    return [_sanitize(report_json(row)) for row in connection.execute(query, params)]


def _sanitize(report):
    # Reviewer-only ban references and decision notes are never part of the public feed.
    report.pop("auto_rejected", None)
    report.pop("ban_report_id", None)
    return report


def public_report(connection, source, identifier):
    row = connection.execute(PUBLIC_QUERY + " WHERE reports.id = ? AND " + PUBLIC_SCOPE, (identifier, source)).fetchone()
    if row is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Публичное обращение не найдено.")
    report = _sanitize(report_json(row))
    report["events"] = []
    return report


def public_photo(connection, source, identifier, kind):
    public_report(connection, source, identifier)
    column = "photo" if kind == "overview" else "detail_photo"
    row = connection.execute(f"SELECT {column} FROM report_captures WHERE report_id = ?", (identifier,)).fetchone()
    if row is None or row[0] is None:
        raise ApiError(HTTPStatus.NOT_FOUND, "Снимок не найден.")
    return row[0]


def set_visibility(connection, identifier, owner, visibility):
    if type(visibility) is not bool:
        raise ValueError("Выберите, будет ли обращение публичным.")
    connection.execute("BEGIN IMMEDIATE")
    changed = connection.execute("""UPDATE reports SET is_public = ? WHERE id = ? AND owner_id = ?
        AND deleted_at IS NULL""", (int(visibility), identifier, owner)).rowcount
    if not changed:
        raise ApiError(HTTPStatus.NOT_FOUND, "Обращение не найдено.")
    return {"is_public": visibility}
