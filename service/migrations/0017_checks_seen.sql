-- The owner sees what people asked for before bidding: the job's words, the bid
-- they had in mind and what they were told. No name, email or card is involved in a check.
ALTER TABLE checks ADD COLUMN task TEXT;
ALTER TABLE checks ADD COLUMN amount_cents INTEGER;
ALTER TABLE checks ADD COLUMN verdict TEXT;       -- ok, review, short, refused
ALTER TABLE checks ADD COLUMN cost_cents INTEGER; -- the costs the bidder was shown
ALTER TABLE checks ADD COLUMN told TEXT;          -- the words the bidder was shown
