-- Replies to comments, and an account's own view of who replied to it.
ALTER TABLE comments ADD COLUMN parent_id INTEGER;                       -- the comment this one sits under; NULL for a top-level comment
ALTER TABLE comments ADD COLUMN reply_user_id INTEGER;                   -- whose comment was replied to
CREATE INDEX comments_reply ON comments (reply_user_id, id);
ALTER TABLE users ADD COLUMN replies_seen_at INTEGER NOT NULL DEFAULT 0; -- when they last looked at their replies
