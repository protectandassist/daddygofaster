-- Keeping comments civil: visitors can report one, enough reports hide it until the
-- owner looks, and the owner can block a person from commenting.
ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;   -- 1 = may not comment

CREATE TABLE comment_reports (
  comment_id INTEGER NOT NULL REFERENCES comments(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)                                -- one report per person per comment
);
-- comments.status gains: hidden (reported enough times; waiting for the owner)
