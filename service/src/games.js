// Stream games: short free games that run by themselves while the owner is live, so there is
// always something happening on the stream between bids. Nobody pays and nobody wins anything
// but a place on the board.
//
//   torch   Hold the torch: the flame's worth climbs and blows out at a moment nobody knows.
//           Bank before it does and you keep what it was worth; wait too long and you get nothing.
//   trivia  A question with four answers. Right and fast scores most.
//   guess   Closest guess: a question whose answer is a number. The closest guesses score.
//   mind    Hive mind: a this-or-that question. You score by voting with the majority.
//
// The owner switches the games on from the owner page. From then on every round follows from
// the clock: which game it is, its question and its outcome all come from the time the games
// were switched on and a secret drawn at that moment, so the stream overlay and every phone
// see the same round with nothing to keep in step. Only the picks are stored.
//
// People play at torchhive.com/play, signed in under their username or as a guest under a
// name made here (a guest never types a name, so there is nothing to moderate).
import { getSetting, setSetting } from './store.js';
import { TRIVIA } from './trivia.js';
import { GUESSES, THIS_OR_THAT } from './prompts.js';

// Seconds for each part of a round: picking, a beat of suspense, the result.
export const GAMES = {
  torch: { pick: 15, show: 0, result: 6 },
  trivia: { pick: 22, show: 3, result: 9 },
  guess: { pick: 24, show: 3, result: 10 },
  mind: { pick: 16, show: 2, result: 8 },
};
const LISTS = { mix: ['torch', 'trivia', 'mind', 'torch', 'guess', 'trivia'], torch: ['torch'], trivia: ['trivia'], guess: ['guess'], mind: ['mind'] };
// The torch: three seconds to get ready, then its worth climbs from 1x to 10x over twelve seconds.
export const TORCH = { lead: 3, max: 10, rate: Math.log(10) / 12, base: 50 };
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

const listOf = (g) => LISTS[g.mode] || LISTS.mix;
const secs = (game) => GAMES[game].pick + GAMES[game].show + GAMES[game].result;

// A round has a fixed length, except the torch: its round ends six seconds after the flame blows
// out, so an early blow-out goes straight to the next round instead of leaving a dead screen.
// So when each round starts is added up from the first one, and kept while this service runs.
const plans = new Map();
function starts(g, upTo, untilMs) {
  const key = g.since + ':' + g.salt + ':' + g.mode, list = listOf(g);
  let s = plans.get(key);
  if (!s) { if (plans.size > 20) plans.clear(); plans.set(key, s = [0]); }
  while (s.length <= upTo + 1 || (untilMs !== undefined && s[s.length - 1] <= untilMs)) {
    const round = s.length - 1, game = list[round % list.length];
    const len = game === 'torch' ? outcome(g, { round, game }).bustSec + GAMES.torch.result : secs(game);
    s.push(s[round] + Math.round(len * 1000));
  }
  return s;
}

// Round n of a session: its game, when it starts and ends, and how many rounds of that game came before it.
export function roundInfo(g, round) {
  const list = listOf(g), c = Math.floor(round / list.length), i = round % list.length, game = list[i];
  const s = starts(g, round);
  const nth = c * list.filter((k) => k === game).length + list.slice(0, i).filter((k) => k === game).length;
  return { round, game, startsAt: g.since + s[round], nextAt: g.since + s[round + 1], nth, pickMs: GAMES[game].pick * 1000 };
}

// The round being played at `now`, and which part of it. A torch round's picking ends the moment
// the flame blows out; `endsAt` for that part is the latest it could be, so it gives nothing away.
export function where(g, now) {
  const elapsed = Math.max(0, now - g.since), s = starts(g, 0, elapsed);
  let lo = 0, hi = s.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= elapsed) lo = mid; else hi = mid - 1; }
  const info = roundInfo(g, lo), time = GAMES[info.game], t = (elapsed - s[lo]) / 1000;
  const pickEnds = info.game === 'torch' ? outcome(g, info).bustSec : time.pick;
  const phase = t < pickEnds ? 'pick' : t < time.pick + time.show && info.game !== 'torch' ? 'show' : 'result';
  const endsAt = phase === 'pick' ? info.startsAt + time.pick * 1000 : phase === 'show' ? info.startsAt + (time.pick + time.show) * 1000 : info.nextAt;
  return { ...info, phase, endsAt };
}

// ---- what happens in a round -------------------------------------------------------

// What the torch is worth t seconds into its round.
export const torchX = (t) => (t <= TORCH.lead ? 1 : Math.min(TORCH.max, Math.exp(TORCH.rate * (t - TORCH.lead))));

// What a round is, as far as the secret decides it. Closest guess and Hive mind also depend on
// what people pick: see context().
export function outcome(g, info) {
  if (info.game === 'torch') {
    // Half the rounds blow out before 2x; about one in ten burns all the way to 10x.
    const u = dice(g, 'torch', info.round)(), x = Math.min(TORCH.max, 1.1 + 0.9 * u / (1 - u)), full = x >= TORCH.max;
    return { prompt: 'Bank the torch before it blows out.', bustX: Math.floor(x * 100) / 100, bustSec: full ? GAMES.torch.pick : TORCH.lead + Math.log(x) / TORCH.rate, full };
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
  const q = nthOf(g, THIS_OR_THAT, 'thisorthat', info.nth);
  return { prompt: q[0], options: [q[1], q[2]] };
}

// What a round's picks add to its outcome: how close the guesses came, or which side the hive took.
export function context(game, out, rows) {
  if (game === 'guess') return { dists: [...new Set(rows.map((r) => Math.abs(r.pick - out.answer)))].sort((a, b) => a - b) };
  if (game === 'mind') {
    const counts = [0, 0];
    rows.forEach((r) => { if (r.pick === 0 || r.pick === 1) counts[r.pick]++; });
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
  if (info.game === 'guess') {
    const d = Math.abs(pick - out.answer), place = ctx.dists.indexOf(d);
    return ([150, 100, 60][place] || 0) + (d === 0 ? 100 : 0);
  }
  if (info.game === 'mind') return ctx.answer < 0 ? 50 : pick === ctx.answer ? 100 : 0;
  const base = out.points[pick] || 0;   // trivia: up to 50 more for answering fast
  if (!base) return 0;
  return base + Math.round(out.quick * (1 - Math.min(1, Math.max(0, (at - info.startsAt) / info.pickMs))));
}

function validPick(game, out, pick) {
  if (!Number.isInteger(pick) || pick < 0) return false;
  return game === 'torch' ? pick === 0 : game === 'guess' ? pick <= MAX_GUESS : pick < out.options.length;
}

const TITLES = { torch: 'Hold the torch', trivia: 'Trivia', guess: 'Closest guess', mind: 'Hive mind' };

// What a screen may know right now: the outcome is held back until the picking is over. The one
// exception is the torch, whose end is sent a moment (0.7 s) ahead so every screen can show it
// blowing out at the same instant instead of whenever it next asks.
function view(w, out, now, rows, ctx) {
  const v = { on: true, now, round: w.round, game: w.game, title: TITLES[w.game], phase: w.phase, startsAt: w.startsAt, pickMs: w.pickMs, endsAt: w.endsAt, prompt: out.prompt, in: rows.length };
  const res = w.phase === 'result';
  if (w.game === 'torch') {
    Object.assign(v, TORCH);
    const bustAt = w.startsAt + Math.round(out.bustSec * 1000);
    if (res || now >= bustAt - 700) { v.bustAt = bustAt; v.bustX = out.bustX; v.full = out.full; }
    v.counts = [rows.length];
    if (res) v.best = rows.slice().sort((a, b) => b.at - a.at).slice(0, 3).map((r) => ({ name: r.name, x: Math.floor(torchX((r.at - w.startsAt) / 1000) * 100) / 100 }));
  } else if (w.game === 'guess') {
    v.counts = [rows.length];
    if (res) {
      v.answer = out.answer;
      v.dists = ctx.dists.slice(0, 3);
      v.best = rows.slice().sort((a, b) => Math.abs(a.pick - out.answer) - Math.abs(b.pick - out.answer) || a.at - b.at).slice(0, 3).map((r) => ({ name: r.name, pick: r.pick }));
    }
  } else if (w.game === 'mind') {
    v.options = out.options;
    v.counts = res ? ctx.counts : [0, 0];   // how the vote is going stays hidden until it is over
    if (res) { v.answer = ctx.answer; v.points = [0, 1].map((i) => (ctx.answer < 0 ? 50 : i === ctx.answer ? 100 : 0)); }
  } else {
    v.options = out.options; v.quick = out.quick;
    v.counts = out.options.map((_, i) => rows.filter((r) => r.pick === i).length);
    if (res) { v.answer = out.answer; v.points = out.points; }
  }
  return v;
}

// ---- switching on and off ----------------------------------------------------------

async function current(env, now) {
  try {
    const g = JSON.parse((await getSetting(env, 'games')) || 'null');
    return g && g.on && Number.isFinite(g.since) && now - (g.began || g.since) < MAX_MS ? g : null;
  } catch { return null; }
}

export async function gamesSetting(env, now) {
  const g = await current(env, now);
  return g ? { on: true, mode: LISTS[g.mode] ? g.mode : 'mix', since: new Date(g.began || g.since).toISOString() } : { on: false };
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
  const mode = LISTS[body.mode] ? body.mode : 'mix';
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
    const these = rounds.get(round), info = roundInfo(g, round), out = outcome(g, info), ctx = context(info.game, out, these);
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
      p.streak = won ? p.streak + 1 : 0;
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
  const state = view(w, out, now, t.rows, context(w.game, out, t.rows));
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
// game: the answer's place in the list (trivia, hive mind), the number guessed, or 0 to bank the torch.
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
