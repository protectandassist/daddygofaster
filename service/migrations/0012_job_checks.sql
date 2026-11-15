-- A job checked before its bid is placed. The screen's answer is kept for a
-- short while so the bid that follows is priced exactly as the bidder was shown,
-- and so checks from one place can be counted.
CREATE TABLE checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_hash  TEXT NOT NULL,                     -- of the job's words; the words themselves are not kept here
  ip_hash    TEXT,
  answer     TEXT,                              -- the screen's answer as JSON; NULL when a person has to look
  created_at INTEGER NOT NULL
);
CREATE INDEX checks_task ON checks (task_hash, created_at);
CREATE INDEX checks_ip ON checks (ip_hash, created_at);
