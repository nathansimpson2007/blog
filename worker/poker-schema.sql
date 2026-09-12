-- Poker sessions for the public bankroll tracker. Money is stored in whole
-- cents so running totals never pick up floating-point drift.
CREATE TABLE IF NOT EXISTS poker_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  played_on TEXT NOT NULL,
  game TEXT,
  stakes TEXT,
  location TEXT,
  hours REAL,
  buy_in_cents INTEGER NOT NULL,
  cash_out_cents INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- Small key/value store for one-off values like the starting bankroll.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
