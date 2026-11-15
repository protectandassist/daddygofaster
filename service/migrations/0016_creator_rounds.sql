-- Each creator's page runs its own bidding round. creator_id 0 is the site's own
-- page. A creator round's key in `day` is the date followed by "~" and the
-- creator's id ("2026-11-16~7"), so everything that looks a round up by its key
-- keeps working, and the main page's rounds keep their plain dates.
ALTER TABLE auctions ADD COLUMN creator_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bids ADD COLUMN creator_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX auctions_creator ON auctions (creator_id, status, closes_at);

-- Getting creators paid. Stripe holds their bank details; this keeps only Stripe's id for them.
ALTER TABLE creators ADD COLUMN stripe_account TEXT;
ALTER TABLE creators ADD COLUMN payouts_ready INTEGER NOT NULL DEFAULT 0;   -- 1 once Stripe says money can be sent to them
ALTER TABLE creators ADD COLUMN bidding INTEGER NOT NULL DEFAULT 0;         -- 1 = the creator has opened bidding on their page

-- What was sent to a creator for each charge on a winning job: the charge, less
-- the card processing fee, less the site's share.
CREATE TABLE payouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  hold_id       INTEGER NOT NULL UNIQUE REFERENCES holds(id),              -- one payout per charge, ever
  bid_id        INTEGER NOT NULL REFERENCES bids(id),
  creator_id    INTEGER NOT NULL REFERENCES creators(id),
  charged_cents INTEGER NOT NULL,
  fee_cents     INTEGER NOT NULL,                                          -- card processing
  cut_cents     INTEGER NOT NULL,                                          -- the site's share
  paid_cents    INTEGER NOT NULL,                                          -- sent to the creator
  transfer_id   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX payouts_creator ON payouts (creator_id, id);
