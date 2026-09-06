CREATE TABLE saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL COLLATE NOCASE UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  checkpoint_at INTEGER NOT NULL,
  scan_until INTEGER,
  scan_cursor TEXT,
  last_attempt_at INTEGER,
  last_checked_at INTEGER,
  last_error TEXT
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uri TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  found_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX posts_unread ON posts(read_at, id);

CREATE TABLE matches (
  search_id TEXT NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  PRIMARY KEY (search_id, post_id)
);
CREATE INDEX matches_post ON matches(post_id, search_id);

CREATE TABLE collector_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_started_at INTEGER NOT NULL DEFAULT 0,
  session_handle TEXT,
  access_jwt TEXT,
  refresh_jwt TEXT,
  session_expires_at INTEGER
);
INSERT INTO collector_state (id) VALUES (1);

CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
