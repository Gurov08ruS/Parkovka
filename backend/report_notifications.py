import time
from contextlib import closing, contextmanager
from threading import Event, Thread

from database import DatabaseKeyError, open_database, sqlite3
from max_bot import MaxApiError


def deliver_next(connection, bot, logger):
    notification = connection.execute(
        """SELECT queued.event_id, queued.attempts, report_events.report_id, report_events.status, note, accounts.max_id,
                  reports.latitude, reports.longitude, reports.plate_number, reports.plate_region, reports.comment,
                  captures.address, captures.captured_at, captures.photo, captures.detail_photo
           FROM max_report_notifications AS queued
           JOIN report_events ON report_events.id = queued.event_id
           JOIN reports ON reports.id = report_events.report_id
           LEFT JOIN report_captures AS captures ON captures.report_id = reports.id
           JOIN accounts ON accounts.id = reports.owner_id
           WHERE queued.next_attempt <= ? AND NOT EXISTS (
               SELECT 1 FROM report_events AS previous
               JOIN max_report_notifications AS pending ON pending.event_id = previous.id
               WHERE previous.report_id = report_events.report_id AND previous.id < queued.event_id
           )
           ORDER BY queued.event_id LIMIT 1""",
        (int(time.time()),),
    ).fetchone()
    if notification is None:
        return False

    event_id = notification["event_id"]
    try:
        bot.send_report_notification(notification["max_id"], notification["report_id"],
                                     notification["status"], notification["note"], notification)
    except MaxApiError as error:
        logger.warning("Не удалось отправить уведомление MAX об обращении №%s: %s", notification["report_id"], error)
        if error.status not in {403, 404, 410}:
            delay = min(3600, 10 * 2 ** min(notification["attempts"], 9))
            with connection:
                connection.execute(
                    "UPDATE max_report_notifications SET attempts = attempts + 1, next_attempt = ? WHERE event_id = ?",
                    (int(time.time()) + delay, event_id),
                )
            return True

    with connection:
        connection.execute("DELETE FROM max_report_notifications WHERE event_id = ?", (event_id,))
    return True


def run_notifications(database, bot, logger, stopping):
    while not stopping.is_set():
        try:
            with closing(open_database(database)) as connection:
                while not stopping.is_set() and deliver_next(connection, bot, logger):
                    pass
        except (DatabaseKeyError, sqlite3.Error, OSError) as error:
            logger.warning("Очередь уведомлений MAX временно недоступна: %s", error)
        stopping.wait(2)


@contextmanager
def report_notifications(database, bot, logger):
    if bot is None:
        yield
        return
    stopping = Event()
    worker = Thread(target=run_notifications, args=(database, bot, logger, stopping), daemon=True)
    worker.start()
    try:
        yield
    finally:
        stopping.set()
        worker.join(timeout=10)
