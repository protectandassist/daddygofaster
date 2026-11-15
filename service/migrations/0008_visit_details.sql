-- Reports like the ones on Protect & Assist: where each visitor is, how they got
-- here, what they did and for how long (src/stats.js, src/reports.html).
ALTER TABLE events ADD COLUMN ip TEXT;        -- network address; cleared after 30 days
ALTER TABLE events ADD COLUMN country TEXT;   -- two-letter code, from the network edge
ALTER TABLE events ADD COLUMN region TEXT;
ALTER TABLE events ADD COLUMN city TEXT;
ALTER TABLE events ADD COLUMN label TEXT;     -- on a tap: what was tapped, by its fixed name (never typed words)
ALTER TABLE events ADD COLUMN secs INTEGER;   -- on a hide: seconds the page had been looked at so far
ALTER TABLE events ADD COLUMN src TEXT;       -- on a view: a campaign tag on the link (utm_source), if any
-- events.kind gains: hide | tap
CREATE INDEX events_at ON events (at);
