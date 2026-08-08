-- Public guestbook. Kept separate from the private messages table on purpose:
-- everything here is shown to everyone.
CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
