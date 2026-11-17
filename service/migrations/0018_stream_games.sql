-- Stream games: the picks people make in the free games that run on the live stream.
-- Whether the games are on, and which, sits in `settings` under 'games'. `sid` is the moment
-- that run of rounds began; a round's question and outcome follow from the clock, so only the
-- picks are kept, and they are cleared when the games are switched off.
CREATE TABLE plays (
  sid    INTEGER NOT NULL,
  round  INTEGER NOT NULL,
  player TEXT NOT NULL,       -- 'u:<user id>' or 'g:<a code the guest's browser keeps>'
  name   TEXT NOT NULL,       -- the username, or the name made for a guest
  pick   INTEGER NOT NULL,
  at     INTEGER NOT NULL,
  PRIMARY KEY (sid, round, player)
);
