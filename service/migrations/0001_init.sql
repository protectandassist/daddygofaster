-- One row per job day. Bidding for a job day closes the evening before.
CREATE TABLE auctions (
  day           TEXT PRIMARY KEY,                -- the day the job is done, YYYY-MM-DD local
  closes_at     INTEGER NOT NULL,                -- epoch ms; moves when a late bid extends it
  extensions    INTEGER NOT NULL DEFAULT 0,      -- how many times a late bid has moved it
  status        TEXT NOT NULL DEFAULT 'open',    -- open | closed
  winner_bid_id INTEGER,
  closed_at     INTEGER
);

CREATE TABLE bids (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  day            TEXT NOT NULL REFERENCES auctions(day),
  name           TEXT NOT NULL,                  -- shown on the public board
  email          TEXT NOT NULL,                  -- never shown; lower-cased
  task           TEXT NOT NULL,                  -- never shown before the video
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL,                  -- qualified | held | short | refused
  est_minutes    REAL,
  est_cost_cents INTEGER,
  min_cents      INTEGER,
  screen_note    TEXT,                           -- why, for the owner
  screened_by    TEXT NOT NULL,                  -- ai | none | owner
  ip_hash        TEXT,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER,
  win_state      TEXT                            -- NULL | won | passed
);

CREATE INDEX bids_board ON bids (day, status, amount_cents DESC, created_at);
CREATE INDEX bids_email ON bids (email, day);
CREATE INDEX bids_ip ON bids (ip_hash, created_at);
