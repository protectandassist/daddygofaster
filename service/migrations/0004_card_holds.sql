-- Card holds. A bid's amount (or its auto-bid maximum) is held on the bidder's card
-- when the bid is placed. The winner's hold is charged when the round closes and
-- every other hold is released. No card number is ever stored here: only the ids
-- the card provider (Stripe) hands back.
ALTER TABLE bids ADD COLUMN customer_id TEXT;   -- the provider's customer for this bid
ALTER TABLE bids ADD COLUMN card_id TEXT;       -- the provider's id for the card
ALTER TABLE bids ADD COLUMN next_status TEXT;   -- what a bid in status 'card' becomes once its bank check passes
ALTER TABLE bids ADD COLUMN pay_state TEXT;     -- NULL | paid | free | manual | failed | refunded
ALTER TABLE bids ADD COLUMN paid_cents INTEGER;

-- bids.status gains two values:
--   card    waiting for the bidder's bank to confirm the card (3-D Secure)
--   nocard  the card was declined, so the bid never went in

CREATE TABLE holds (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id         INTEGER NOT NULL REFERENCES bids(id),
  intent_id      TEXT NOT NULL UNIQUE,           -- the provider's id for this hold
  cents          INTEGER NOT NULL,
  state          TEXT NOT NULL,                  -- action | held | captured | released | failed | refunded
  captured_cents INTEGER,
  pending        TEXT,                           -- JSON: what to do once the bank check passes
  created_at     INTEGER NOT NULL,
  settled_at     INTEGER
);
CREATE INDEX holds_bid ON holds (bid_id, state);
CREATE INDEX holds_state ON holds (state, created_at);

-- Money for a closed round: NULL (not started or more to do) | settling | done.
ALTER TABLE auctions ADD COLUMN money_state TEXT;
ALTER TABLE auctions ADD COLUMN money_at INTEGER;
