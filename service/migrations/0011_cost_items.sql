-- What a job's costs are made of, so the bidder can be shown the list and not
-- just a total. JSON: [{"item": "Bus fare", "cents": 500}, ...]. NULL when the
-- owner typed a single figure, or there are no costs.
ALTER TABLE bids ADD COLUMN cost_items TEXT;
