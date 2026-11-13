-- A bidder can raise their own bid. Count the raises so a script cannot do it forever.
ALTER TABLE bids ADD COLUMN raises INTEGER NOT NULL DEFAULT 0;
