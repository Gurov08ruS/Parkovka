def award(connection, account_id, *codes):
    connection.executemany(
        "INSERT OR IGNORE INTO account_achievements (account_id, code) VALUES (?, ?)",
        ((account_id, code) for code in codes),
    )


def earned_achievements(connection, account_id):
    return {"earned": [row["code"] for row in connection.execute(
        "SELECT code FROM account_achievements WHERE account_id = ? ORDER BY code", (account_id,),
    )]}


def award_accepted_reports(connection, account_id):
    accepted = connection.execute(
        """SELECT COUNT(*) FROM reports WHERE owner_id = ? AND (
               status = 'approved' OR EXISTS (
                   SELECT 1 FROM report_events WHERE report_id = reports.id AND status = 'approved'
               )
           )""",
        (account_id,),
    ).fetchone()[0]
    if accepted >= 3:
        award(connection, account_id, "three_accepted")


def backfill_achievements(connection):
    connection.execute("""INSERT OR IGNORE INTO account_achievements (account_id, code)
        SELECT owner_id, 'first_report' FROM reports WHERE owner_id IS NOT NULL AND submitted_at IS NOT NULL
        UNION
        SELECT owner_id, 'two_photos' FROM reports JOIN report_captures ON report_id = reports.id
        WHERE owner_id IS NOT NULL AND detail_photo IS NOT NULL
        UNION
        SELECT owner_id, 'gps_capture' FROM reports JOIN report_captures ON report_id = reports.id
        WHERE owner_id IS NOT NULL AND submitted_at IS NOT NULL AND latitude IS NOT NULL
            AND longitude IS NOT NULL AND captured_at IS NOT NULL
        UNION
        SELECT owner_id, 'three_accepted' FROM reports WHERE owner_id IS NOT NULL AND (
            status = 'approved' OR EXISTS (
                SELECT 1 FROM report_events WHERE report_id = reports.id AND status = 'approved'
            )
        ) GROUP BY owner_id HAVING COUNT(*) >= 3""")
