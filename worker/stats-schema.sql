-- Page view counters for the stats section of /admin. Only daily totals are
-- kept: no IP addresses, no browser details, nothing tied to a visitor.
CREATE TABLE IF NOT EXISTS page_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (day, path)
);

-- Which sites sent people here, by hostname only ("direct" when none).
CREATE TABLE IF NOT EXISTS referrers (
  day TEXT NOT NULL,
  host TEXT NOT NULL,
  views INTEGER NOT NULL,
  PRIMARY KEY (day, host)
);
