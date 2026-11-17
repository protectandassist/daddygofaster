// Stream games: short free games that run by themselves while the owner is live, so there is
// always something happening on the stream between bids. Nobody pays and nobody wins anything
// but a place on the board.
//
//   torch   Hold the torch: the flame's worth climbs and blows out at a moment nobody knows.
//           Bank before it does and you keep what it was worth; wait too long and you get nothing.
//   draw    Quick draw: wait for GO, then tap. Fastest wins; tap early and you are out.
//   stop    Stop the clock: the clock goes dark, and you stop it as near the target as you can.
//   trivia  A question with four answers. Right and fast scores most.
//   guess   Closest guess: a question whose answer is a number. The closest guesses score.
//   mind    Hive mind: a this-or-that question. You score by voting with the majority.
//
// The usual way to run them is a party: three rounds of one game, then a break in which the
// viewers vote for the next game (and are pointed at the bidding), then straight into it.
//
// The owner switches the games on from the owner page. From then on every round follows from
// the clock: its question and its outcome come from the time the games were switched on and a
// secret drawn at that moment, so the stream overlay and every phone see the same round with
// nothing to keep in step. Only the picks are stored, and which game won each vote.
//
// People play at torchhive.com/play, signed in under their username or as a guest under a
// name made here (a guest never types a name, so there is nothing to moderate).
import { getSetting, setSetting } from './store.js';
import { TRIVIA } from './trivia.js';
import { GUESSES, THIS_OR_THAT } from './prompts.js';

// Seconds for each part of a round: picking, a beat of suspense, the result. For the torch,
// quick draw and stop the clock, `pick` is the longest the picking can last.
export const GAMES = {
  torch: { pick: 15, show: 0, result: 6 },
  draw: { pick: 11.5, show: 0, result: 7 },
  stop: { pick: 12.5, show: 0, result: 7 },
  trivia: { pick: 22, show: 3, result: 9 },
  guess: { pick: 24, show: 3, result: 10 },
  mind: { pick: 16, show: 2, result: 8 },
  vote: { pick: 22, show: 0, result: 6 },
};
const PLAYABLE = ['torch', 'draw', 'stop', 'trivia', 'guess', 'mind'];
const MODES = ['party', ...PLAYABLE];
const SET = 3;   // rounds of a game before the break, in a party
const TITLES = { torch: 'Hold the torch', draw: 'Quick draw', stop: 'Stop the clock', trivia: 'Trivia', guess: 'Closest guess', mind: 'Hive mind', vote: 'Bid break' };
const BLURBS = { torch: 'Bank before the flame blows out', draw: 'Fastest tap after GO', stop: 'Stop the hidden clock on the dot', trivia: 'Fast right answers win', guess: 'The closest number wins', mind: 'Vote with the majority' };
// The torch: three seconds to get ready, then its worth climbs from 1x to 10x over twelve seconds.
export const TORCH = { lead: 3, max: 10, rate: Math.log(10) / 12, base: 50 };
// Quick draw: taps count for two seconds after GO. Stop the clock: it starts two seconds in,
// shows for two and a half, and taps count until two and a half seconds past the target.
export const DRAW = { window: 2 };
export const STOP = { lead: 2, shown: 2.5, after: 2.5 };
const MAX_GUESS = 1_000_000_000;
const MAX_MS = 6 * 3_600_000; // left on by mistake, the games stop by themselves
const MAX_PICKS_A_ROUND = 500;
const ROWS_READ = 3000;
const CARRY_MAX = 200;

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dice = (g, what, n) => rng(hash(g.salt + ':' + what + ':' + n));
function shuffled(list, r) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// The nth question from a list: every question is asked once, in a shuffled order, before any comes round again.
function nthOf(g, list, what, nth) {
  const order = shuffled(list.map((_, i) => i), dice(g, what, Math.floor(nth / list.length)));
  return list[order[nth % list.length]];
}

const ADJ = ['Lucky', 'Swift', 'Golden', 'Smoky', 'Bold', 'Sly', 'Sunny', 'Mighty', 'Quiet', 'Wild', 'Amber', 'Brave', 'Fuzzy', 'Nimble', 'Rusty', 'Jolly'];
const NOUN = ['Drone', 'Ember', 'Spark', 'Comet', 'Badger', 'Falcon', 'Otter', 'Hornet', 'Lantern', 'Rocket', 'Maple', 'Bandit', 'Pepper', 'Tiger', 'Walrus', 'Moose'];
export function guestName(id) {
  const h = hash('guest:' + id);
  return ADJ[h % 16] + ' ' + NOUN[(h >>> 4) % 16] + ' ' + (10 + ((h >>> 8) % 90));
}

// ---- which round it is -----------------------------------------------------------

const secs = (game) => GAMES[game].pick + GAMES[game].show + GAMES[game].result;

// The game of round n. In a party, rounds come in fours: three of the game that won the last
// vote (g.sets, filled in by settle() as each vote closes), then the break with the next vote.
function gameOf(g, round) {
  if (g.mode !== 'party') return PLAYABLE.includes(g.mode) ? g.mode : 'torch';
  return round % (SET + 1) === SET ? 'vote' : (g.sets && g.sets[Math.floor(round / (SET + 1))]) || 'torch';
}

// A round has a fixed length, except the three whose picking ends at a moment of its own (the
// torch blowing out, GO, the clock's target): those rounds end a few seconds after that moment,
// so an early blow-out goes straight on instead of leaving a dead screen. So when each round
// starts is added up from the first one, and kept while this service runs.
const plans = new Map();
function starts(g, upTo, untilMs) {
  const key = g.since + ':' + g.salt + ':' + g.mode;
  let s = plans.get(key);
  if (!s) { if (plans.size > 20) plans.clear(); plans.set(key, s = [0]); }
  while (s.length <= upTo + 1 || (untilMs !== undefined && s[s.length - 1] <= untilMs)) {
    const round = s.length - 1, game = gameOf(g, round), out = outcome(g, { round, game, nth: round });
    s.push(s[round] + Math.round((out.pickSec === undefined ? secs(game) : out.pickSec + GAMES[game].result) * 1000));
  }
  return s;
}

// Round n of a session: its game and when it starts and ends.
export function roundInfo(g, round) {
  const game = gameOf(g, round), s = starts(g, round);
  const info = { round, game, startsAt: g.since + s[round], nextAt: g.since + s[round + 1], nth: round, pickMs: GAMES[game].pick * 1000 };
  if (g.mode === 'party' && game !== 'vote') info.set = { n: round % (SET + 1) + 1, of: SET };
  return info;
}

// The round being played at `now`, and which part of it. Where the picking ends at a moment
// nobody may know yet, `endsAt` for that part is the latest it could be, so it gives nothing away.
export function where(g, now) {
  const elapsed = Math.max(0, now - g.since), s = starts(g, 0, elapsed);
  let lo = 0, hi = s.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= elapsed) lo = mid; else hi = mid - 1; }
  const info = roundInfo(g, lo), time = GAMES[info.game], t = (elapsed - s[lo]) / 1000, own = outcome(g, info).pickSec;
  const phase = t < (own === undefined ? time.pick : own) ? 'pick' : own === undefined && t < time.pick + time.show ? 'show' : 'result';
  const endsAt = phase === 'pick' ? info.startsAt + time.pick * 1000 : phase === 'show' ? info.startsAt + (time.pick + time.show) * 1000 : info.nextAt;
  return { ...info, phase, endsAt };
}

// ---- what happens in a round -------------------------------------------------------

// What the torch is worth t seconds into its round.
export const torchX = (t) => (t <= TORCH.lead ? 1 : Math.min(TORCH.max, Math.exp(TORCH.rate * (t - TORCH.lead))));

// What a round is, as far as the secret decides it. Several games also depend on what people
// pick: see context(). `pickSec` is when the picking ends, where that is not the fixed time.
export function outcome(g, info) {
  if (info.game === 'torch') {
    // Half the rounds blow out before 2x; about one in ten burns all the way to 10x.
    const u = dice(g, 'torch', info.round)(), x = Math.min(TORCH.max, 1.1 + 0.9 * u / (1 - u)), full = x >= TORCH.max;
    const bustSec = full ? GAMES.torch.pick : TORCH.lead + Math.log(x) / TORCH.rate;
    return { prompt: 'Bank the torch before it blows out.', bustX: Math.floor(x * 100) / 100, bustSec, pickSec: bustSec, full };
  }
  if (info.game === 'draw') {
    const goSec = Math.round((3 + dice(g, 'draw', info.round)() * 6.5) * 100) / 100;
    return { prompt: 'Wait for GO, then tap. Tap early and you are out.', goSec, pickSec: goSec + DRAW.window };
  }
  if (info.game === 'stop') {
    const target = 5 + Math.floor(dice(g, 'stop', info.round)() * 4);
    return { prompt: 'Stop the clock at exactly ' + target + '.00 seconds. It goes dark on the way.', target, pickSec: STOP.lead + target + STOP.after };
  }
  if (info.game === 'trivia') {
    const q = nthOf(g, TRIVIA, 'questions', info.nth);
    const options = shuffled([0, 1, 2, 3], dice(g, 'answers', info.round));
    const answer = options.indexOf(0);
    return { prompt: q[0], options: options.map((i) => q[1 + i]), answer, points: options.map((i) => (i === 0 ? 100 : 0)), quick: 50 };
  }
  if (info.game === 'guess') {
    const q = nthOf(g, GUESSES, 'guesses', info.nth);
    return { prompt: q[0], answer: q[1] };
  }
  if (info.game === 'vote') {
    // Three games to choose from, never the one just played.
    const games = shuffled(PLAYABLE.filter((k) => k !== gameOf(g, info.round - 1)), dice(g, 'vote', info.round)).slice(0, 3);
    return { prompt: 'Vote for the next game.', games, options: games.map((k) => TITLES[k]), blurbs: games.map((k) => BLURBS[k]) };
  }
  const q = nthOf(g, THIS_OR_THAT, 'thisorthat', info.nth);
  return { prompt: q[0], options: [q[1], q[2]] };
}

// The distinct values of a list, smallest first: a pick's place is where its own value falls.
const places = (values) => [...new Set(values)].sort((a, b) => a - b);

// What a round's picks add to its outcome: who was closest or fastest, or which side won.
export function context(info, out, rows) {
  if (info.game === 'guess') return { dists: places(rows.map((r) => Math.abs(r.pick - out.answer))) };
  if (info.game === 'draw') { const goAt = info.startsAt + out.goSec * 1000; return { goAt, times: places(rows.filter((r) => r.at >= goAt).map((r) => r.at - goAt)) }; }
  if (info.game === 'stop') { const zeroAt = info.startsAt + STOP.lead * 1000, hit = zeroAt + out.target * 1000; return { zeroAt, hit, errs: places(rows.map((r) => Math.abs(r.at - hit))) }; }
  if (info.game === 'mind' || info.game === 'vote') {
    const counts = out.options.map(() => 0);
    rows.forEach((r) => { if (counts[r.pick] !== undefined) counts[r.pick]++; });
    if (info.game === 'vote') return { counts, answer: counts.indexOf(Math.max(...counts)) };   // a tie, or no votes: the first listed
    return { counts, answer: counts[0] === counts[1] ? -1 : counts[0] > counts[1] ? 0 : 1 };
  }
  return {};
}

// Points for one pick made at `at`.
export function pointsFor(info, out, pick, at, ctx) {
  if (info.game === 'torch') {
    const t = (at - info.startsAt) / 1000;
    return t < out.bustSec ? Math.round(TORCH.base * torchX(t)) : 0;
  }
  if (info.game === 'draw') return at < ctx.goAt ? 0 : [200, 150, 100][ctx.times.indexOf(at - ctx.goAt)] || 50;
  if (info.game === 'stop') {
    const err = Math.abs(at - ctx.hit);
    return ([200, 150, 100][ctx.errs.indexOf(err)] || (err <= 1000 ? 50 : 0)) + (err <= 100 ? 100 : 0);
  }
  if (info.game === 'guess') {
    const d = Math.abs(pick - out.answer);
    return ([150, 100, 60][ctx.dists.indexOf(d)] || 0) + (d === 0 ? 100 : 0);
  }
  if (info.game === 'mind') return ctx.answer < 0 ? 50 : pick === ctx.answer ? 100 : 0;
  if (info.game === 'vote') return 25;   // for turning up to vote
  const base = out.points[pick] || 0;   // trivia: up to 50 more for answering fast
  if (!base) return 0;
  return base + Math.round(out.quick * (1 - Math.min(1, Math.max(0, (at - info.startsAt) / info.pickMs))));
}

function validPick(game, out, pick) {
  if (!Number.isInteger(pick) || pick < 0) return false;
  return out.options ? pick < out.options.length : game === 'guess' ? pick <= MAX_GUESS : pick === 0;
}

// What a screen may know right now: the outcome is held back until the picking is over. The
// exceptions are the torch blowing out and GO, which are sent a moment (0.7 s) ahead so every
// screen can show them at the same instant instead of whenever it next asks.
function view(w, out, now, rows, ctx) {
  const v = { on: true, now, round: w.round, game: w.game, title: TITLES[w.game], phase: w.phase, startsAt: w.startsAt, pickMs: w.pickMs, endsAt: w.endsAt, prompt: out.prompt, in: rows.length, counts: [rows.length] };
  const res = w.phase === 'result', best = (sorted, what) => sorted.slice(0, 3).map((r) => ({ name: r.name, ...what(r) }));
  if (w.set) v.set = w.set;
  if (w.game === 'torch') {
    Object.assign(v, TORCH);
    const bustAt = w.startsAt + Math.round(out.bustSec * 1000);
    if (res || now >= bustAt - 700) { v.bustAt = bustAt; v.bustX = out.bustX; v.full = out.full; }
    if (res) v.best = best(rows.slice().sort((a, b) => b.at - a.at), (r) => ({ x: Math.floor(torchX((r.at - w.startsAt) / 1000) * 100) / 100 }));
  } else if (w.game === 'draw') {
    v.window = DRAW.window;
    if (res || now >= ctx.goAt - 700) v.goAt = ctx.goAt;
    if (res) { v.times = ctx.times.slice(0, 3); v.best = best(rows.filter((r) => r.at >= ctx.goAt).sort((a, b) => a.at - b.at), (r) => ({ ms: r.at - ctx.goAt })); v.early = rows.filter((r) => r.at < ctx.goAt).length; }
  } else if (w.game === 'stop') {
    Object.assign(v, { zeroAt: ctx.zeroAt, target: out.target, shown: STOP.shown });
    if (res) { v.errs = ctx.errs.slice(0, 3); v.best = best(rows.slice().sort((a, b) => Math.abs(a.at - ctx.hit) - Math.abs(b.at - ctx.hit)), (r) => ({ ms: r.at - ctx.zeroAt })); }
  } else if (w.game === 'guess') {
    if (res) { v.answer = out.answer; v.dists = ctx.dists.slice(0, 3); v.best = best(rows.slice().sort((a, b) => Math.abs(a.pick - out.answer) - Math.abs(b.pick - out.answer) || a.at - b.at), (r) => ({ pick: r.pick })); }
  } else if (w.game === 'mind') {
    v.options = out.options;
    v.counts = res ? ctx.counts : [0, 0];   // how the vote is going stays hidden until it is over
    if (res) { v.answer = ctx.answer; v.points = [0, 1].map((i) => (ctx.answer < 0 ? 50 : i === ctx.answer ? 100 : 0)); }
  } else if (w.game === 'vote') {
    Object.assign(v, { options: out.options, blurbs: out.blurbs, counts: ctx.counts });
    if (res) v.answer = ctx.answer;
  } else {
    v.options = out.options; v.quick = out.quick;
    v.counts = out.options.map((_, i) => rows.filter((r) => r.pick === i).length);
    if (res) { v.answer = out.answer; v.points = out.points; }
  }
  return v;
}

// ---- switching on and off ----------------------------------------------------------

// In a party, which game each set plays: the first is the torch, and each one after is whatever
// won the vote before it. Worked out once, the first time anyone asks after that vote closes.
async function settle(env, g, now) {
  if (g.mode !== 'party') return g;
  let changed = false;
  if (!Array.isArray(g.sets) || !g.sets.length) g.sets = ['torch'];
  for (let guard = 0; guard < 500; guard++) {
    const info = roundInfo(g, (g.sets.length - 1) * (SET + 1) + SET);   // the latest vote whose game is known
    if (now < info.nextAt) break;
    const { results } = await env.DB.prepare('SELECT pick, at FROM plays WHERE sid = ? AND round = ? LIMIT ?').bind(g.since, info.round, MAX_PICKS_A_ROUND).all();
    const out = outcome(g, info);
    g.sets.push(out.games[context(info, out, results).answer]);
    changed = true;
  }
  if (changed) await setSetting(env, 'games', JSON.stringify(g), now);
  return g;
}

async function current(env, now) {
  try {
    const g = JSON.parse((await getSetting(env, 'games')) || 'null');
    if (!(g && g.on && Number.isFinite(g.since) && now - (g.began || g.since) < MAX_MS)) return null;
    if (!MODES.includes(g.mode)) g.mode = 'party';
    return await settle(env, g, now);
  } catch { return null; }
}

export async function gamesSetting(env, now) {
  const g = await current(env, now);
  return g ? { on: true, mode: g.mode, since: new Date(g.began || g.since).toISOString() } : { on: false };
}

// Owner: POST /admin/api/games { on, mode }. Changing the game mid-stream starts a fresh run of
// rounds and carries everyone's points over.
export async function setGames(env, body, now) {
  const before = await current(env, now);
  if (!body || body.on !== true) {
    await setSetting(env, 'games', JSON.stringify({ on: false }), now);
    await env.DB.prepare('DELETE FROM plays').run();
    return [200, { on: false }];
  }
  const mode = MODES.includes(body.mode) ? body.mode : 'party';
  if (before && before.mode === mode) return [200, { on: true, mode }];
  let carry = {};
  if (before) {
    const totals = await tally(env, before, where(before, now), null);
    [...totals.all.values()].sort((a, b) => b.points - a.points).slice(0, CARRY_MAX).forEach((p) => { if (p.points > 0) carry[p.player] = { name: p.name, points: p.points }; });
  }
  const salt = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await setSetting(env, 'games', JSON.stringify({ on: true, mode, since: now, began: before ? before.began || before.since : now, salt, carry }), now);
  await env.DB.prepare('DELETE FROM plays WHERE sid < ?').bind(now).run();
  return [200, { on: true, mode }];
}

// ---- the scores ---------------------------------------------------------------------

// Everyone's points so far tonight, and this round's picks. A round counts once its result is showing.
async function tally(env, g, w, me) {
  const { results } = await env.DB.prepare('SELECT round, player, name, pick, at FROM plays WHERE sid = ? ORDER BY round DESC LIMIT ?').bind(g.since, ROWS_READ).all();
  const all = new Map(), rounds = new Map();
  Object.entries(g.carry || {}).forEach(([player, p]) => all.set(player, { player, name: p.name, points: p.points, streak: 0 }));
  for (const row of results) { if (!rounds.has(row.round)) rounds.set(row.round, []); rounds.get(row.round).push(row); }
  let mine = null, rows = [];
  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    if (round > w.round) continue;
    const these = rounds.get(round), info = roundInfo(g, round), out = outcome(g, info), ctx = context(info, out, these);
    const counted = round < w.round || w.phase === 'result';
    if (round === w.round) rows = these;
    for (const row of these) {
      let p = all.get(row.player);
      if (!p) all.set(row.player, p = { player: row.player, name: row.name, points: 0, streak: 0 });
      p.name = row.name;
      if (round === w.round && row.player === me) mine = row;
      if (!counted) continue;
      const won = pointsFor(info, out, row.pick, row.at, ctx);
      p.points += won;
      if (info.game !== 'vote') p.streak = won ? p.streak + 1 : 0;
      if (round === w.round && row.player === me) mine = { ...row, won };
    }
  }
  return { all, rows, mine };
}

// GET /games: the round on now, how the picks are falling, the top of the board, and (for the
// player asking) their own pick and points.
export async function gamesState(env, now, who) {
  const g = await current(env, now);
  if (!g) return { on: false };
  const w = where(g, now), out = outcome(g, w);
  const t = await tally(env, g, w, who ? who.player : null);
  const board = [...t.all.values()].filter((p) => p.points > 0).sort((a, b) => b.points - a.points);
  const state = view(w, out, now, t.rows, context(w, out, t.rows));
  state.top = board.slice(0, 8).map((p) => ({ name: p.name, points: p.points, streak: p.streak }));
  state.players = t.all.size;
  if (who) {
    const p = t.all.get(who.player), rank = board.findIndex((b) => b.player === who.player);
    state.me = { name: who.name, points: p ? p.points : 0, streak: p ? p.streak : 0, rank: rank < 0 ? null : rank + 1, pick: t.mine ? t.mine.pick : null, at: t.mine ? t.mine.at : null, won: t.mine && t.mine.won !== undefined ? t.mine.won : null };
  }
  return state;
}

// Who is asking: the signed-in person under their username, or a guest by the code their browser keeps.
export function player(user, guest) {
  if (user && user.name && !user.blocked) return { player: 'u:' + user.id, name: user.name };
  const id = String(guest ?? '').toLowerCase();
  return /^[a-f0-9]{16,32}$/.test(id) ? { player: 'g:' + id, name: guestName(id) } : null;
}

// POST /games/pick { g, round, pick }. The first pick stands. What `pick` means depends on the
// game: the answer's place in the list (trivia, hive mind, the vote), the number guessed, or 0
// for the one-button games (bank the torch, quick draw, stop the clock), where the moment counts.
export async function postPick(env, who, body, now) {
  if (!who) return [400, { message: 'Open torchhive.com/play to join in.' }];
  const g = await current(env, now);
  if (!g) return [409, { message: 'No game is on right now.' }];
  const w = where(g, now), out = outcome(g, w), pick = Number(body?.pick);
  if (Number(body?.round) !== w.round || w.phase !== 'pick') return [409, { message: w.game === 'torch' && Number(body?.round) === w.round ? 'Too late. It blew out.' : 'Too late for that round. The next one is coming.', state: await gamesState(env, now, who) }];
  if (!validPick(w.game, out, pick)) return [400, { message: w.game === 'guess' ? 'Type a whole number.' : 'Pick one of the choices.' }];
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM plays WHERE sid = ? AND round = ?').bind(g.since, w.round).first();
  if (n.n >= MAX_PICKS_A_ROUND) return [429, { message: 'This round is full. Catch the next one.' }];
  await env.DB.prepare('INSERT OR IGNORE INTO plays (sid, round, player, name, pick, at) VALUES (?, ?, ?, ?, ?, ?)').bind(g.since, w.round, who.player, who.name, pick, now).run();
  return [200, await gamesState(env, now, who)];
}
