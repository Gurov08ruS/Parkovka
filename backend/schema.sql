CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('test', 'max')),
    max_id TEXT NOT NULL,
    UNIQUE (source, max_id)
);

CREATE TABLE IF NOT EXISTS account_bans (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
    reviewer_id INTEGER NOT NULL REFERENCES accounts(id),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    reason TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    review_grant TEXT
);

CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'draft',
    latitude REAL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL CHECK (longitude BETWEEN -180 AND 180),
    plate_number TEXT,
    plate_source TEXT,
    plate_verification TEXT,
    comment TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 1000),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    owner_id INTEGER REFERENCES accounts(id),
    submitted_at TEXT,
    withdrawn_at TEXT,
    CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE TABLE IF NOT EXISTS report_captures (
    report_id INTEGER PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
    capture_id TEXT NOT NULL UNIQUE,
    address TEXT,
    photo BLOB NOT NULL CHECK (length(photo) BETWEEN 4 AND 67108864),
    detail_photo BLOB CHECK (length(detail_photo) BETWEEN 4 AND 67108864),
    captured_at TEXT
);

CREATE TABLE IF NOT EXISTS report_events (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES accounts(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'under_review', 'approved', 'rejected')),
    note TEXT NOT NULL DEFAULT '',
    account_ban INTEGER NOT NULL DEFAULT 0 CHECK (account_ban IN (0, 1)),
    ban_report_id INTEGER REFERENCES reports(id) ON DELETE SET NULL,
    occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS report_events_report ON report_events(report_id, id);
CREATE INDEX IF NOT EXISTS report_events_actor_status ON report_events(actor_id, status);
