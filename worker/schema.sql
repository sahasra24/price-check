CREATE TABLE IF NOT EXISTS requests (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  where_txt     TEXT,
  item          TEXT,
  status        TEXT NOT NULL,          -- open | accepted | expired | failed
  staff_json    TEXT NOT NULL,          -- who was alerted (name, key, topic)
  accepted_by   TEXT,
  accepted_name TEXT,
  accepted_at   INTEGER,
  points        INTEGER DEFAULT 0,
  last_ring     INTEGER,
  rings         INTEGER DEFAULT 0,
  ip            TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_ip_time ON requests (ip, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_accepted ON requests (accepted_at);
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER
);
