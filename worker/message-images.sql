-- Points at the KV entry holding an attached image, if the sender sent one.
ALTER TABLE messages ADD COLUMN image_key TEXT;
