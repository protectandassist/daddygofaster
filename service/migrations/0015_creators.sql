-- Creator pages: someone with an account asks for a page of their own, the owner
-- approves it, and people follow it to be told when bidding opens there.
CREATE TABLE creators (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id),  -- one page per account
  slug        TEXT NOT NULL UNIQUE,                          -- the page's address: torchhive.com/<slug>
  name        TEXT NOT NULL,
  bio         TEXT NOT NULL DEFAULT '',
  youtube     TEXT,                                          -- handles, without the @
  tiktok      TEXT,
  twitch      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',               -- pending | live | paused
  created_at  INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE TABLE creator_follows (
  creator_id INTEGER NOT NULL REFERENCES creators(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (creator_id, user_id)
);
