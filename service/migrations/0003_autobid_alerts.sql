-- Auto-bid: a hidden maximum the bid may rise to on its own. NULL means none.
ALTER TABLE bids ADD COLUMN max_cents INTEGER;
-- A private handle the bidder's browser keeps, so the page can show how their bid stands.
ALTER TABLE bids ADD COLUMN token TEXT;
-- Outbid emails: asked for (1/0), how many were sent, and when the last one went.
ALTER TABLE bids ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bids ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bids ADD COLUMN notified_at INTEGER;
CREATE UNIQUE INDEX bids_token ON bids (token) WHERE token IS NOT NULL;

-- Small things the service keeps for itself: the admin key (salted hash only),
-- sealed provider keys, and the one-time setup code.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
