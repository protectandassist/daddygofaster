-- Signing in, voting and commenting on open jobs.
-- Sign-in is by a link sent to the person's email: no passwords are kept.
CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,              -- lower-cased; never shown to anyone else
  name       TEXT,                              -- shown beside their comments; chosen when they first comment
  created_at INTEGER NOT NULL
);

-- A sign-in link that has been emailed. Only a hash of its code is kept.
CREATE TABLE logins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL UNIQUE,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX logins_email ON logins (email, created_at);
CREATE INDEX logins_ip ON logins (ip_hash, created_at);

-- A signed-in browser. Only a hash of its key is kept.
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  key_hash   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- One vote per person per open job. Votes show interest; money decides who wins.
CREATE TABLE votes (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  bid_id     INTEGER NOT NULL REFERENCES bids(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, bid_id)
);
CREATE INDEX votes_bid ON votes (bid_id);

-- Comments on an open job, from people who have put money on it.
CREATE TABLE comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id     INTEGER NOT NULL REFERENCES bids(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,                     -- as it was when they wrote it
  text       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'shown',     -- shown | removed
  created_at INTEGER NOT NULL
);
CREATE INDEX comments_bid ON comments (bid_id, status, created_at);
CREATE INDEX comments_user ON comments (user_id, created_at);
