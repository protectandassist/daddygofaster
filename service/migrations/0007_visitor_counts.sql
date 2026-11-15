-- Our own visitor counts (src/stats.js). One row per moment the page reports.
-- No address, no cookie id: `visitor` is a hash that changes every day.
CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  day     TEXT NOT NULL,          -- YYYY-MM-DD in the site's time zone
  at      INTEGER NOT NULL,       -- epoch ms
  kind    TEXT NOT NULL,          -- view | start | placed | declined | pledged | signup
  visitor TEXT NOT NULL,          -- daily hash; cannot be turned back into an address
  ref     TEXT,                   -- host the visitor came from, on a view
  device  TEXT                    -- phone | computer
);
CREATE INDEX events_day ON events (day, kind);
CREATE INDEX events_visitor ON events (day, visitor);
