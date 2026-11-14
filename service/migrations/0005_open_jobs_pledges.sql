-- Open jobs and pooled money. The person posting a job chooses:
--   secret  the job stays hidden until the video, and only they can raise it (as before)
--   open    the job is shown on the board, and anyone can add money to it
-- bids.amount_cents stays the job's TOTAL, so ranking and winning work as before.
ALTER TABLE bids ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;   -- 1 = open job
ALTER TABLE bids ADD COLUMN pid TEXT;                            -- public handle of an open job (the private token is never shown)
ALTER TABLE bids ADD COLUMN own_cents INTEGER;                   -- the poster's own part of amount_cents; NULL means all of it
ALTER TABLE bids ADD COLUMN backers INTEGER NOT NULL DEFAULT 0;  -- how many others added money
CREATE UNIQUE INDEX bids_pid ON bids (pid) WHERE pid IS NOT NULL;

-- Money someone else added to an open job. Held on their card like a bid, charged
-- only if that job wins, released if it does not.
CREATE TABLE pledges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id      INTEGER NOT NULL REFERENCES bids(id),
  name        TEXT NOT NULL,                    -- never shown; the board shows only how many backers
  email       TEXT NOT NULL,                    -- never shown; lower-cased
  cents       INTEGER NOT NULL,
  status      TEXT NOT NULL,                    -- card | active | nocard | released | paid | failed | refunded
  token       TEXT,                             -- private handle the backer's browser keeps
  customer_id TEXT,
  card_id     TEXT,
  ip_hash     TEXT,
  paid_cents  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX pledges_bid ON pledges (bid_id, status);
CREATE INDEX pledges_email ON pledges (email, created_at);
CREATE INDEX pledges_ip ON pledges (ip_hash, created_at);
CREATE UNIQUE INDEX pledges_token ON pledges (token) WHERE token IS NOT NULL;

-- A hold belongs to the poster (pledge_id NULL) or to one pledge.
ALTER TABLE holds ADD COLUMN pledge_id INTEGER;
CREATE INDEX holds_pledge ON holds (pledge_id);
