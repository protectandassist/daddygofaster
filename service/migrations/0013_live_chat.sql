-- The chat beside the live stream. Anyone with an account can write in it while
-- the owner is live. Whether he is live, and the stream's link, sit in `settings`.
CREATE TABLE chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,                     -- the username as it was when they wrote it
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'shown',     -- shown | removed
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_recent ON chat (status, id);
CREATE INDEX chat_user ON chat (user_id, id);
