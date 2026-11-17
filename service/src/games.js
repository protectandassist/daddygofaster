// Stream games: short free games that run by themselves while the owner is live, so there is
// always something happening on the stream between bids. A round is a few seconds to pick, a
// few seconds of suspense, then the result and the night's scores. Nobody pays and nobody wins
// anything but a place on the board.
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

// Seconds for each part of a round.
export const GAMES = {
  race: { pick: 30, show: 15, result: 10 },
  trivia: { pick: 22, show: 3, result: 9 },
  hilo: { pick: 18, show: 4, result: 8 },
};
const LISTS = { mix: ['race', 'trivia', 'trivia', 'hilo', 'hilo'], race: ['race'], trivia: ['trivia'], hilo: ['hilo'] };
export const BEES = ['Blaze', 'Ember', 'Honey', 'Smoky', 'Zip'];
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

const ADJ = ['Lucky', 'Swift', 'Golden', 'Smoky', 'Bold', 'Sly', 'Sunny', 'Mighty', 'Quiet', 'Wild', 'Amber', 'Brave', 'Fuzzy', 'Nimble', 'Rusty', 'Jolly'];
const NOUN = ['Drone', 'Ember', 'Spark', 'Comet', 'Badger', 'Falcon', 'Otter', 'Hornet', 'Lantern', 'Rocket', 'Maple', 'Bandit', 'Pepper', 'Tiger', 'Walrus', 'Moose'];
export function guestName(id) {
  const h = hash('guest:' + id);
  return ADJ[h % 16] + ' ' + NOUN[(h >>> 4) % 16] + ' ' + (10 + ((h >>> 8) % 90));
}

// ---- which round it is -----------------------------------------------------------

const listOf = (g) => LISTS[g.mode] || LISTS.mix;
const secs = (game) => GAMES[game].pick + GAMES[game].show + GAMES[game].result;

// Round n of a session: its game, when it starts, and how many rounds of that game came before it.
export function roundInfo(g, round) {
  const list = listOf(g), cycle = list.reduce((sum, k) => sum + secs(k), 0);
  const c = Math.floor(round / list.length), i = round % list.length, game = list[i];
  const before = list.slice(0, i);
  const startsAt = g.since + (c * cycle + before.reduce((sum, k) => sum + secs(k), 0)) * 1000;
  const nth = c * list.filter((k) => k === game).length + before.filter((k) => k === game).length;
  return { round, game, startsAt, nth, pickMs: GAMES[game].pick * 1000 };
}

// The round being played at `now`, and which part of it.
export function where(g, now) {
  const list = listOf(g), cycle = list.reduce((sum, k) => sum + secs(k), 0);
  const elapsed = Math.max(0, (now - g.since) / 1000), c = Math.floor(elapsed / cycle);
  let t = elapsed - c * cycle, i = 0;
  while (i < list.length - 1 && t >= secs(list[i])) { t -= secs(list[i]); i++; }
  const info = roundInfo(g, c * list.length + i), time = GAMES[info.game];
  const phase = t < time.pick ? 'pick' : t < time.pick + time.show ? 'show' : 'result';
  const ends = phase === 'pick' ? time.pick : phase === 'show' ? time.pick + time.show : secs(info.game);
  return { ...info, phase, endsAt: info.startsAt + ends * 1000 };
}

// ---- what happens in a round -------------------------------------------------------

// The numbers of higher-or-lower. Odd rounds draw an even number and even rounds an odd one, so
// two in a row are never the same and "higher or lower" always has an answer.
const hiloNumber = (g, n) => 2 * Math.floor(dice(g, 'hilo', n)() * 50) + 1 + (n % 2);
// A safe pick pays little and a long shot pays a lot.
function worth(chance) {
  return chance <= 0 ? 0 : Math.min(500, Math.max(60, Math.round(55 / chance / 5) * 5));
}

export function outcome(g, info) {
  if (info.game === 'race') {
    const r = dice(g, 'race', info.round), order = shuffled([0, 1, 2, 3, 4], r);
    const finish = [], points = [0, 0, 0, 0, 0];
    let t = 9 + r();
    order.forEach((bee, place) => { finish[bee] = Math.round(t * 100) / 100; t += 0.3 + r() * 0.7; points[bee] = [100, 50, 25, 0, 0][place]; });
    return { options: BEES, answer: order[0], points, race: { finish, seed: hash(g.salt + ':wobble:' + info.round) } };
  }
  if (info.game === 'trivia') {
    const order = shuffled(TRIVIA.map((_, i) => i), dice(g, 'questions', Math.floor(info.nth / TRIVIA.length)));
    const q = TRIVIA[order[info.nth % TRIVIA.length]];
    const options = shuffled([0, 1, 2, 3], dice(g, 'answers', info.round));
    const answer = options.indexOf(0);
    return { prompt: q[0], options: options.map((i) => q[1 + i]), answer, points: options.map((i) => (i === 0 ? 100 : 0)), quick: 50 };
  }
  const from = hiloNumber(g, info.nth), to = hiloNumber(g, info.nth + 1);
  const pays = [worth((100 - from) / 99), worth((from - 1) / 99)], answer = to > from ? 0 : 1;
  return { options: ['Higher', 'Lower'], answer, from, to, pays, points: pays.map((p, i) => (i === answer ? p : 0)) };
}

// Points for one pick. Trivia adds up to 50 for answering fast.
export function pointsFor(info, out, pick, at) {
  const base = out.points[pick] || 0;
  if (!base || !out.quick) return base;
  const early = 1 - Math.min(1, Math.max(0, (at - info.startsAt) / info.pickMs));
  return base + Math.round(out.quick * early);
}

const TITLES = { race: 'Bee race', trivia: 'Trivia', hilo: 'Higher or lower' };
const PROMPTS = { race: 'Which bee reaches the hive first?', hilo: 'Will the next number be higher or lower?' };

// What a screen may know right now: the outcome is held back until the picking is over.
function view(w, out, now) {
  const v = { on: true, now, round: w.round, game: w.game, title: TITLES[w.game], phase: w.phase, startsAt: w.startsAt, pickMs: w.pickMs, endsAt: w.endsAt, prompt: out.prompt || PROMPTS[w.game], options: out.options };
  if (w.game === 'hilo') { v.from = out.from; v.pays = out.pays; }
  if (w.game === 'trivia') v.quick = out.quick;
  if (w.game === 'race' && w.phase !== 'pick') v.race = out.race;
  if (w.phase === 'result') { v.answer = out.answer; v.points = out.points; if (w.game === 'hilo') v.to = out.to; }
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
  results.sort((a, b) => a.round - b.round);
  const all = new Map(), outs = new Map(), counts = [];
  Object.entries(g.carry || {}).forEach(([player, p]) => all.set(player, { player, name: p.name, points: p.points, streak: 0 }));
  let mine = null;
  for (const row of results) {
    let p = all.get(row.player);
    if (!p) all.set(row.player, p = { player: row.player, name: row.name, points: 0, streak: 0 });
    p.name = row.name;
    if (row.round === w.round) {
      counts[row.pick] = (counts[row.pick] || 0) + 1;
      if (row.player === me) mine = row;
    }
    if (row.round > w.round || (row.round === w.round && w.phase !== 'result')) continue;
    if (!outs.has(row.round)) { const info = roundInfo(g, row.round); outs.set(row.round, [info, outcome(g, info)]); }
    const [info, out] = outs.get(row.round), won = pointsFor(info, out, row.pick, row.at);
    p.points += won;
    p.streak = won ? p.streak + 1 : 0;
    if (row.round === w.round && row.player === me) mine = { ...row, won };
  }
  return { all, counts, mine };
}

// GET /games: the round on now, how the picks are falling, the top of the board, and (for the
// player asking) their own pick and points.
export async function gamesState(env, now, who) {
  const g = await current(env, now);
  if (!g) return { on: false };
  const w = where(g, now), out = outcome(g, roundInfo(g, w.round));
  const t = await tally(env, g, w, who ? who.player : null);
  const board = [...t.all.values()].filter((p) => p.points > 0).sort((a, b) => b.points - a.points);
  const state = view(w, out, now);
  state.counts = out.options.map((_, i) => t.counts[i] || 0);
  state.top = board.slice(0, 8).map((p) => ({ name: p.name, points: p.points, streak: p.streak }));
  state.players = t.all.size;
  if (who) {
    const p = t.all.get(who.player), rank = board.findIndex((b) => b.player === who.player);
    state.me = { name: who.name, points: p ? p.points : 0, streak: p ? p.streak : 0, rank: rank < 0 ? null : rank + 1, pick: t.mine ? t.mine.pick : null, won: t.mine && t.mine.won !== undefined ? t.mine.won : null };
  }
  return state;
}

// Who is asking: the signed-in person under their username, or a guest by the code their browser keeps.
export function player(user, guest) {
  if (user && user.name && !user.blocked) return { player: 'u:' + user.id, name: user.name };
  const id = String(guest ?? '').toLowerCase();
  return /^[a-f0-9]{16,32}$/.test(id) ? { player: 'g:' + id, name: guestName(id) } : null;
}

// POST /games/pick { g, round, pick }. The first pick stands.
export async function postPick(env, who, body, now) {
  if (!who) return [400, { message: 'Open torchhive.com/play to join in.' }];
  const g = await current(env, now);
  if (!g) return [409, { message: 'No game is on right now.' }];
  const w = where(g, now), out = outcome(g, roundInfo(g, w.round)), pick = Number(body?.pick);
  if (Number(body?.round) !== w.round || w.phase !== 'pick') return [409, { message: 'Too late for that round. The next one is coming.', state: await gamesState(env, now, who) }];
  if (!Number.isInteger(pick) || pick < 0 || pick >= out.options.length) return [400, { message: 'Pick one of the choices.' }];
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM plays WHERE sid = ? AND round = ?').bind(g.since, w.round).first();
  if (n.n >= MAX_PICKS_A_ROUND) return [429, { message: 'This round is full. Catch the next one.' }];
  await env.DB.prepare('INSERT OR IGNORE INTO plays (sid, round, player, name, pick, at) VALUES (?, ?, ?, ?, ?, ?)').bind(g.since, w.round, who.player, who.name, pick, now).run();
  return [200, await gamesState(env, now, who)];
}
