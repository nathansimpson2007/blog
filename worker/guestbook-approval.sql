-- Entries stay hidden until approved from /admin.
ALTER TABLE guestbook ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
