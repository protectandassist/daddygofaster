-- Accounts people own: a username nobody else has, Google sign-in, and alerts
-- by email and on their devices.
ALTER TABLE users ADD COLUMN name_key TEXT;                        -- the username lower-cased with spaces and punctuation out; one person per key
ALTER TABLE users ADD COLUMN name_at INTEGER;                      -- when the username was last set
ALTER TABLE users ADD COLUMN google_sub TEXT;                      -- Google's id for this person, once they have signed in with Google
ALTER TABLE users ADD COLUMN alerts INTEGER NOT NULL DEFAULT 0;    -- 1 = email me alerts
ALTER TABLE users ADD COLUMN alerts_token TEXT;                    -- the handle in the "stop these emails" link

-- Names chosen before this: the first person to have a name keeps it.
UPDATE users SET name_key = lower(replace(replace(replace(replace(name, ' ', ''), '.', ''), '_', ''), '-', ''))
 WHERE name IS NOT NULL AND id IN (
   SELECT MIN(id) FROM users WHERE name IS NOT NULL
   GROUP BY lower(replace(replace(replace(replace(name, ' ', ''), '.', ''), '_', ''), '-', '')));
CREATE UNIQUE INDEX users_name_key ON users (name_key) WHERE name_key IS NOT NULL;
CREATE UNIQUE INDEX users_google ON users (google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX users_alerts_token ON users (alerts_token) WHERE alerts_token IS NOT NULL;

-- A device that asked for notifications. The push service's address is all that is
-- kept; the words wait in `pending` until the device comes to collect them.
CREATE TABLE push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL UNIQUE,
  pending    TEXT,                                                 -- JSON: {title, body}
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subs_user ON push_subs (user_id);

-- Alerts waiting to go out. One row per person per event; `ref` keeps the same
-- event from being told twice.
CREATE TABLE notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,                                        -- launch | outbid | ending | result
  ref        TEXT NOT NULL,
  subject    TEXT NOT NULL,                                        -- the email subject and the notification title
  short      TEXT NOT NULL,                                        -- the notification's one line
  body       TEXT NOT NULL,                                        -- the email
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  UNIQUE (user_id, kind, ref)
);
CREATE INDEX notices_due ON notices (sent_at, id);

-- Which alerts a round has sent: 1 = closing soon, 2 = the result.
ALTER TABLE auctions ADD COLUMN noticed INTEGER NOT NULL DEFAULT 0;
UPDATE auctions SET noticed = 3 WHERE status = 'closed';
