// Hive Arena: one shared arena that anyone can fly a bee in, from a phone or a computer.
//
// Pollen makes a bee bigger and a bee swallows any bee a fifth smaller than itself. On top of that:
//   - dashing leaves a trail of fire that shrinks every other bee that crosses it;
//   - size that is spent or knocked off is not lost: what a dash cost is left where its fire burns
//     out, and what a fireball knocks off drops around the bee it hit, as glowing food that
//     anyone can eat for eight seconds before it is gone;
//   - the game runs in rounds whose length the owner picks: near the end a ring of fire closes in,
//     the biggest bee left when the round ends wins it, and then there is a break (the page
//     shows the day's bids during it) before the next round starts with everyone small again;
//   - pickups: fireballs to shoot, smoke (the other bees lose sight of you), honey (your trail
//     slows instead of burns), royal jelly (instant growth), the queen (for 15 seconds every
//     smaller bee nearby is unable to dash, all the food nearby comes to you, and your own
//     dashes cost nothing, so you can run them down);
//   - the biggest bee wears the crown: a wasp comes for it every so often, and burning it down pays extra.
//     The wasp can be killed: fire and fireballs wear it down, and a big enough bee can swallow it;
//   - bees flown by the service fill the arena, named after the day's bidders where there are any;
//   - the owner's page passes on Twitch chat: !join drops in a bee, !fire and !honey drop
//     trouble or food by the owner's bee.
//
// World is the game itself and uses nothing from Cloudflare, so it can be run and tested anywhere.
// Arena is the Durable Object that keeps one World going while anyone is connected, and talks to
// the pages over WebSockets. Nothing is stored: when the last page leaves, the arena is gone.
import { getSetting, setSetting } from './store.js';

export const ROUNDS = [60, 120, 180, 300, 600];   // seconds a round may last
export const RESTS = [15, 30, 45, 60, 90];        // seconds between rounds
const DEFAULTS = { round: 180, rest: 30 };
const VERSION = 9;   // sent to each page as it joins, so it can be seen which build a running arena is on
const R = 1500;                 // the arena is a circle this wide from its middle, which is at (R, R)
const RING_MIN = 320;           // how small the ring of fire gets
const START = 20, EAT = 1.2, POLLEN = 520, BEES = 18, MIN_BOTS = 6, MAX_CHAT = 25, MAX_PATCHES = 500;
// Dashing is a steady boost for as long as it is held, and costs this share of a bee's size a second.
// Someone else's fire takes BURN of a bee's size each second it is in it. A bee chasing a dasher
// down its trail is in fire about half the time, so it loses about 4% a second against the 3% a
// second the dasher spends: it can power through, at a price a little higher than the runner's.
export const BOOST = 0.03, BURN = 0.08;
const HOT_MS = 8000;   // how long dropped size stays on the field
const KINDS = ['fireball', 'smoke', 'honey', 'jelly', 'queen'];
const WASP = { m: 60, dead: 20, fireball: 15, fire: 25, prize: 40 };   // three fireballs, or about a second and a half in fire
export const QUEEN = { secs: 15, reach: 520, food: 260 };   // how long, how far it reaches, and how fast the food comes in
const ADJ = ['Lucky', 'Swift', 'Golden', 'Smoky', 'Bold', 'Sly', 'Sunny', 'Mighty', 'Quiet', 'Wild', 'Amber', 'Brave', 'Fuzzy', 'Nimble', 'Rusty', 'Jolly'];
const NOUN = ['Drone', 'Ember', 'Spark', 'Comet', 'Badger', 'Falcon', 'Otter', 'Hornet', 'Lantern', 'Rocket', 'Maple', 'Bandit', 'Pepper', 'Tiger', 'Walrus', 'Moose'];
export const rad = (m) => Math.sqrt(m) * 4.2;
const cleanCfg = (c) => ({ round: ROUNDS.includes(Number(c?.round)) ? Number(c.round) : DEFAULTS.round, rest: RESTS.includes(Number(c?.rest)) ? Number(c.rest) : DEFAULTS.rest });

export class World {
  constructor(cfg, bidders = [], rand = Math.random) {
    this.rand = rand; this.cfg = cleanCfg(cfg); this.bidders = bidders;
    this.t = 0; this.id = 1; this.round = 0; this.players = new Map(); this.outbox = []; this.cool = new Map();
    this.begin();
  }

  rnd(a, b) { return a + this.rand() * (b - a); }
  // A point inside the ring, spread evenly.
  spot(within) { const a = this.rnd(0, 6.2832), d = Math.sqrt(this.rand()) * within; return [R + Math.cos(a) * d, R + Math.sin(a) * d]; }
  say(k, extra) { this.events.push({ k, ...extra }); }

  // A new round: an empty arena, everyone small again.
  begin() {
    this.round++; this.phase = 'play'; this.phaseEnds = this.t + this.cfg.round * 1000; this.ring = R;
    this.bees = new Map(); this.pollen = new Map(); this.patches = new Map(); this.shots = []; this.pickups = new Map();
    this.events = []; this.pAdd = []; this.pDel = []; this.fAdd = []; this.moved = new Set(); this.crown = 0; this.winner = null;
    this.nextPickup = this.t + 4000; this.nextWasp = this.t + Math.min(50, this.cfg.round * 0.3) * 1000; this.nextBots = 0;
    for (let i = 0; i < POLLEN; i++) this.grain();
    for (const p of this.players.values()) { p.bee = null; this.enter(p); }
    this.bots();
    this.fresh = true; this.rosterDirty = true;
  }

  // Pollen. With `ms` it is dropped size: it glows, and is gone after that long.
  grain(x, y, m = 1, ms = 0) {
    if (x === undefined) [x, y] = this.spot(Math.max(RING_MIN, this.ring) - 20);
    const g = { id: this.id++, x, y, m: Math.round(m * 100) / 100, until: ms ? this.t + ms : 0 };
    this.pollen.set(g.id, g); this.pAdd.push([g.id, Math.round(g.x), Math.round(g.y), g.m, ms ? 1 : 0]);
    return g;
  }
  scatter(x, y, n, m = 2) { for (let i = 0; i < n; i++) this.grain(x + this.rnd(-45, 45), y + this.rnd(-45, 45), m); }
  // Size knocked off a bee, all of it, thrown clear of it (so it does not just swallow it back) as food that does not last.
  drop(x, y, mass, r) {
    const n = Math.max(1, Math.min(12, Math.ceil(mass / 4)));
    for (let i = 0; i < n; i++) { const a = this.rnd(0, 6.2832), d = r + this.rnd(30, 110); this.grain(x + Math.cos(a) * d, y + Math.sin(a) * d, mass / n, HOT_MS); }
  }

  spawn(name, kind, more = {}) {
    const b = { id: this.id++, name, kind, x: R, y: R, a: this.rnd(0, 6.28), m: START, tx: R, ty: R, think: 0, dashT: 0, dashCd: 0, trail: 0, fb: 0, shotCd: 0, smoke: 0, honey: 0, queen: 0, slow: 0, burn: 0, streak: 0, hitCd: 0, dash: false, fire: false, key: null, ...more };
    // never drop a new bee on top of a bigger one
    for (let tries = 0; tries < 14; tries++) {
      [b.x, b.y] = this.spot(Math.max(RING_MIN, this.ring) * 0.9);
      if ([...this.bees.values()].every((o) => Math.hypot(o.x - b.x, o.y - b.y) > rad(o.m) + 240)) break;
    }
    b.tx = b.x; b.ty = b.y;
    this.bees.set(b.id, b); this.rosterDirty = true;
    return b;
  }

  // ---- the people -------------------------------------------------------------------

  enter(p) {
    if (this.phase !== 'play' || p.bee) return;
    p.bee = this.spawn(p.name, 'p', { key: p.key, owner: p.owner }).id; p.killer = null;
    this.outbox.push([p.key, this.you(p.key)]);
  }
  addPlayer(key, name, owner) {
    let p = this.players.get(key);
    if (!p) this.players.set(key, p = { key, name, owner: Boolean(owner), bee: null, auto: true, deadAt: 0, killer: null, wins: 0 });
    p.name = name; p.owner = Boolean(owner);
    this.enter(p);
  }
  removePlayer(key) {
    const p = this.players.get(key);
    if (!p) return;
    if (p.bee && this.bees.delete(p.bee)) this.rosterDirty = true;
    this.players.delete(key);
  }
  you(key) { const p = this.players.get(key); return { t: 'y', id: p ? p.bee : null, killer: p ? p.killer : null, wins: p ? p.wins : 0 }; }
  // What a page sends: where its bee should head, whether it is dashing, a fireball, and whether the service should fly it.
  input(key, m) {
    const p = this.players.get(key);
    if (!p || !m) return;
    if (typeof m.auto === 'boolean') p.auto = m.auto;
    if (m.go) this.enter(p);
    const b = this.bees.get(p.bee);
    if (!b || p.auto) return;
    if (Number.isFinite(m.x) && Number.isFinite(m.y)) { b.tx = Math.max(0, Math.min(2 * R, m.x)); b.ty = Math.max(0, Math.min(2 * R, m.y)); }
    b.dash = Boolean(m.d);
    if (m.f) b.fire = true;
  }
  // Twitch chat, passed on by the owner's page. Each name may do one thing every 20 seconds.
  chat(kind, name) {
    name = String(name || '');
    if (!/^\w{3,25}$/.test(name) || this.phase !== 'play') return;
    const chatBees = [...this.bees.values()].filter((b) => b.kind === 'c');
    if (kind === 'join') {
      if (chatBees.some((b) => b.name === name) || chatBees.length >= MAX_CHAT) return;
      this.spawn(name, 'c', { m: START * 1.5 }); this.say('chat', { a: name, what: 'join' });
      return;
    }
    if ((this.cool.get(name) || 0) > this.t || (this.cool.get('*' + kind) || 0) > this.t) return;
    const humans = [...this.bees.values()].filter((b) => b.kind === 'p');
    const at = humans.find((b) => b.owner) || humans.sort((a, b) => b.m - a.m)[0];
    if (!at) return;
    this.cool.set(name, this.t + 20000); this.cool.set('*' + kind, this.t + 2500);
    const ahead = 170 + rad(at.m), x = at.x + Math.cos(at.a) * ahead, y = at.y + Math.sin(at.a) * ahead;
    if (kind === 'fire') for (let i = 0; i < 6; i++) this.patch(x + this.rnd(-60, 60), y + this.rnd(-60, 60), 34, 4500, 0, 'f');
    else if (kind === 'honey') this.scatter(x, y, 14, 2);
    else return;
    this.say('chat', { a: name, what: kind, b: at.name });
  }

  // ---- the bees the service flies ---------------------------------------------------

  botName() {
    const taken = new Set([...this.bees.values()].map((b) => b.name));
    const bid = this.bidders.find((n) => !taken.has(n));
    if (bid) return bid;
    for (let i = 0; i < 30; i++) { const n = ADJ[Math.floor(this.rand() * 16)] + ' ' + NOUN[Math.floor(this.rand() * 16)]; if (!taken.has(n)) return n; }
    return 'Bee ' + this.id;
  }
  // Enough of them that the arena is never empty, fewer as real people arrive.
  bots() {
    const all = [...this.bees.values()], bots = all.filter((b) => b.kind === 'b').length, others = all.filter((b) => b.kind === 'p' || b.kind === 'c').length;
    for (let n = Math.max(MIN_BOTS, BEES - others) - bots; n > 0; n--) {
      const name = this.botName();
      this.spawn(name, 'b', { m: START * (name === this.bidders[0] ? 1.8 : this.rnd(0.8, 1.5)), bidder: this.bidders.includes(name) });
    }
  }
  think(b) {
    const r = rad(b.m), dc = Math.hypot(b.x - R, b.y - R);
    b.dash = false;
    if (b.kind === 'w') { const c = this.bees.get(this.crown); if (c) { b.tx = c.x; b.ty = c.y; } return; }
    if (dc > this.ring - r - 70) { b.tx = R; b.ty = R; b.dash = dc > this.ring; return; }   // get inside the fire
    let flee = null, fd = 1e9, prey = null, pd = 1e9;
    for (const o of this.bees.values()) {
      if (o === b || o.smoke > 0) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y) - rad(o.m);
      if (d > 420 + r * 2) continue;
      if ((o.kind === 'w' ? b.id === this.crown : o.m > b.m * EAT || (o.queen > 0 && o.m > b.m)) && d < fd) { fd = d; flee = o; }
      else if (o.kind !== 'w' && b.m > o.m * EAT && d < pd) { pd = d; prey = o; }
    }
    if (flee && fd < (flee.queen > 0 ? QUEEN.reach + 60 : 300 + r)) { b.tx = b.x + (b.x - flee.x) * 4; b.ty = b.y + (b.y - flee.y) * 4; b.dash = flee.queen > 0 || (fd < 110 && this.rand() < 0.6); return; }
    if (prey && pd < 380) { b.tx = prey.x; b.ty = prey.y; b.dash = pd < 120 && b.m > 40 && this.rand() < 0.4; if (b.fb > 0 && pd < 320 && this.rand() < 0.25) b.fire = true; return; }
    let best = null, bd = 1e9;
    for (const k of this.pickups.values()) { const d = Math.hypot(k.x - b.x, k.y - b.y); if (d < 380 && d < bd) { bd = d; best = k; } }
    if (!best) {
      const all = [...this.pollen.values()];
      for (let i = 0; i < 40 && all.length; i++) { const g = all[Math.floor(this.rand() * all.length)], d = Math.hypot(g.x - b.x, g.y - b.y); if (d < bd) { bd = d; best = g; } }
    }
    if (best) { b.tx = best.x; b.ty = best.y; }
  }

  // ---- fire -------------------------------------------------------------------------

  patch(x, y, r, ms, owner, kind, drop = 0) {
    if (this.patches.size >= MAX_PATCHES) return;
    const f = { id: this.id++, x, y, r, until: this.t + ms, owner, kind, drop };
    this.patches.set(f.id, f); this.fAdd.push([f.id, Math.round(x), Math.round(y), Math.round(r), ms, kind]);
  }
  kill(b, by, how) {
    if (!this.bees.delete(b.id)) return;
    this.rosterDirty = true;
    this.scatter(b.x, b.y, Math.min(14, Math.floor(b.m / 6)));
    if (by) { by.streak++; if ([3, 5, 8, 12].includes(by.streak)) this.say('streak', { a: by.name, n: by.streak }); }
    if (by && b.kind === 'w') by.m += WASP.prize;
    if (by && b.id === this.crown) { by.m += 30; this.say('crown', { a: by.name, b: b.name }); }   // bringing down the crowned bee pays extra
    this.say(how, { a: by ? by.name : null, b: b.name, ai: by ? by.id : 0, bi: b.id, x: Math.round(b.x), y: Math.round(b.y) });
    const p = b.key && this.players.get(b.key);
    if (p) { p.bee = null; p.deadAt = this.t; p.killer = by ? by.name : how === 'ring' ? 'the ring of fire' : 'the fire'; this.outbox.push([p.key, this.you(p.key)]); }
  }

  // ---- one step of the game ---------------------------------------------------------

  step(dt) {
    this.t += dt * 1000;
    if (this.phase === 'rest') { if (this.t >= this.phaseEnds) this.begin(); return; }
    const closing = Math.min(60, this.cfg.round * 0.4) * 1000, left = this.phaseEnds - this.t;
    this.ring = left < closing ? RING_MIN + (R - RING_MIN) * Math.max(0, left / closing) : R;
    if (this.t >= this.nextBots) { this.nextBots = this.t + 1500; this.bots(); }
    if (this.t >= this.nextPickup) {
      this.nextPickup = this.t + 5000;
      if (this.pickups.size < 6) { const [x, y] = this.spot(this.ring - 40), k = { id: this.id++, x, y, kind: KINDS[Math.floor(this.rand() * KINDS.length)] }; this.pickups.set(k.id, k); }
    }
    // the wasp: comes for whoever wears the crown, and leaves after 18 seconds
    if (this.t >= this.nextWasp && left > 25000) {
      this.nextWasp = this.t + 75000;
      const w = this.spawn('The Wasp', 'w', { m: WASP.m, leaves: this.t + 18000 }); const a = this.rnd(0, 6.28);
      w.x = R + Math.cos(a) * (this.ring - 60); w.y = R + Math.sin(a) * (this.ring - 60);
      this.say('wasp', {});
    }
    let top = null;
    for (const b of this.bees.values()) if (b.kind !== 'w' && (!top || b.m > top.m)) top = b;
    this.crown = top ? top.id : 0;

    // the queen: all the food within reach comes to her, and no smaller bee within reach can dash
    // (she dashes for nothing, so she runs them down)
    for (const q of this.bees.values()) {
      if (!(q.queen > 0)) continue;
      for (const g of this.pollen.values()) {
        const d = Math.hypot(q.x - g.x, q.y - g.y);
        if (d < 1 || d > QUEEN.reach) continue;
        g.x += (q.x - g.x) / d * QUEEN.food * dt; g.y += (q.y - g.y) / d * QUEEN.food * dt; this.moved.add(g.id);
      }
      for (const o of this.bees.values()) if (o !== q && o.kind !== 'w' && o.m < q.m && Math.hypot(q.x - o.x, q.y - o.y) <= QUEEN.reach) o.pulled = this.t + 150;
    }

    for (const b of [...this.bees.values()]) {
      if (b.kind === 'w' && this.t >= b.leaves) { this.bees.delete(b.id); this.rosterDirty = true; continue; }
      const p = b.key && this.players.get(b.key), flown = b.kind !== 'p' || (p && p.auto);
      if (flown) { b.think -= dt; if (b.think <= 0) { b.think = this.rnd(0.18, 0.4); this.think(b); } }
      const r = rad(b.m);
      for (const k of ['shotCd', 'smoke', 'honey', 'queen', 'hitCd']) if (b[k] > 0) b[k] -= dt;
      // dashing: a steady boost while it is held. It costs a little size all the while and leaves a
      // trail (fire, or honey after that pickup); what it cost is left along the trail when that
      // burns out. A smaller bee near a queen cannot dash at all, and the queen dashes for nothing.
      const boosting = b.dash && b.m > 24 && b.kind !== 'w' && !(b.pulled > this.t);
      b.dashT = boosting ? 1 : 0;
      if (boosting) {
        const cost = b.queen > 0 ? 0 : b.m * BOOST * dt;
        b.m -= cost; b.owed = (b.owed || 0) + cost; b.trail -= dt;
        if (b.trail <= 0) { b.trail = 0.06; this.patch(b.x - Math.cos(b.a) * r, b.y - Math.sin(b.a) * r, 18 + r * 0.3, b.honey > 0 ? 5000 : 3500, b.id, b.honey > 0 ? 'h' : 'f', b.owed); b.owed = 0; }
      }
      if (b.fire) {
        b.fire = false;
        if (b.fb > 0 && b.shotCd <= 0) { b.fb--; b.shotCd = 0.35; this.shots.push({ x: b.x + Math.cos(b.a) * (r + 12), y: b.y + Math.sin(b.a) * (r + 12), vx: Math.cos(b.a) * 780, vy: Math.sin(b.a) * 780, owner: b.id, until: this.t + 1100 }); }
      }
      const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy);
      const speed = (b.kind === 'w' ? 330 : 300 / (1 + r / 70)) * (b.dashT > 0 ? 2.3 : 1) * (b.slow > this.t ? 0.45 : 1) * Math.min(1, d / 30);
      if (d > 1) {
        const turn = ((Math.atan2(dy, dx) - b.a + 9.42478) % 6.28318) - 3.14159;
        b.a += Math.max(-8 * dt, Math.min(8 * dt, turn));
        b.x += Math.cos(b.a) * speed * dt; b.y += Math.sin(b.a) * speed * dt;
      }
      const out = Math.hypot(b.x - R, b.y - R);
      if (out > R - r) { b.x = R + (b.x - R) * (R - r) / out; b.y = R + (b.y - R) * (R - r) / out; }
      if (b.kind === 'w') {
        const c = this.bees.get(this.crown);
        if (c && b.hitCd <= 0 && Math.hypot(c.x - b.x, c.y - b.y) < r + rad(c.m)) { b.hitCd = 1.2; const loss = c.m * 0.3; c.m -= loss; this.scatter(c.x, c.y, Math.min(12, Math.floor(loss / 3))); this.say('sting', { b: c.name, bi: c.id }); }
        // fire wears the wasp down, and whoever laid it gets the kill
        b.burn = 0;
        for (const f of this.patches.values()) {
          if (f.kind !== 'f' || Math.hypot(f.x - b.x, f.y - b.y) > f.r + r * 0.6) continue;
          b.m -= WASP.fire * dt; b.burn = f.owner || -1;
        }
        if (b.m < WASP.dead) this.kill(b, b.burn > 0 ? this.bees.get(b.burn) : null, 'waspdown');
        continue;
      }
      if (b.m > 150) b.m -= b.m * 0.004 * dt;   // the big ones slowly shrink, so nobody stays on top for free
      for (const g of this.pollen.values()) {
        if (Math.abs(g.x - b.x) < r && Math.abs(g.y - b.y) < r && Math.hypot(g.x - b.x, g.y - b.y) < r) { b.m += g.m; this.pollen.delete(g.id); this.pDel.push(g.id); }
      }
      for (const k of this.pickups.values()) {
        if (Math.hypot(k.x - b.x, k.y - b.y) > r + 18) continue;
        this.pickups.delete(k.id);
        if (k.kind === 'fireball') b.fb = Math.min(5, b.fb + 3); else if (k.kind === 'smoke') b.smoke = 8; else if (k.kind === 'honey') b.honey = 8; else if (k.kind === 'queen') b.queen = QUEEN.secs; else b.m += Math.max(25, b.m * 0.3);
        this.say('pick', { a: b.name, ai: b.id, what: k.kind });
      }
      // fire: someone else's trail (or chat's) burns size away, honey slows; outside the ring everything burns
      b.burn = 0;
      for (const f of this.patches.values()) {
        if (f.owner === b.id || Math.hypot(f.x - b.x, f.y - b.y) > f.r + r * 0.6) continue;
        if (f.kind === 'h') b.slow = this.t + 300; else if (!b.burn) { b.m -= b.m * BURN * dt; b.burn = f.owner || -1; }   // once a step, however many patches overlap
      }
      if (out > this.ring) { b.m -= Math.max(2, b.m * 0.25) * dt; b.burn = -2; }
      if (b.m < 9) this.kill(b, b.burn > 0 ? this.bees.get(b.burn) : null, b.burn === -2 ? 'ring' : 'burn');
    }

    this.shots = this.shots.filter((s) => {
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (this.t > s.until || Math.hypot(s.x - R, s.y - R) > R) return false;
      for (const b of this.bees.values()) {
        if (b.id === s.owner || Math.hypot(b.x - s.x, b.y - s.y) > rad(b.m) + 10) continue;
        const by = this.bees.get(s.owner);
        if (b.kind === 'w') { b.m -= WASP.fireball; this.say('hit', { a: by ? by.name : null, b: b.name, bi: b.id }); if (b.m < WASP.dead) this.kill(b, by, 'waspdown'); return false; }
        const loss = b.m * 0.25; b.m -= loss; this.drop(b.x, b.y, loss, rad(b.m));
        this.say('hit', { a: by ? by.name : null, b: b.name, bi: b.id });
        if (b.m < 9) this.kill(b, by, 'burn');
        return false;
      }
      return true;
    });

    // Swallowing: the bigger bee must be a fifth bigger and reach just past the smaller one's middle.
    // (It used to have to cover most of it. A page draws its own bee a touch ahead of where the
    // service has it and the others a touch behind, so a bee plainly on top of another on screen
    // often was not yet, here, and the swallow did not come.) The wasp can be swallowed too.
    const list = [...this.bees.values()].sort((a, b) => b.m - a.m);
    for (const a of list) {
      if (a.kind === 'w' || !this.bees.has(a.id)) continue;
      for (const b of list) {
        if (a === b || !this.bees.has(b.id) || a.m < b.m * EAT) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < rad(a.m) + rad(b.m) * 0.15) {
          if (b.kind !== 'w') a.m += b.m * 0.8;
          this.kill(b, a, b.kind === 'w' ? 'waspdown' : 'eat');
        }
      }
    }
    for (const f of this.patches.values()) if (f.until <= this.t) { if (f.drop) this.grain(f.x, f.y, f.drop, HOT_MS); this.patches.delete(f.id); }
    for (const g of this.pollen.values()) if (g.until && g.until <= this.t) { this.pollen.delete(g.id); this.pDel.push(g.id); }
    for (let n = 0; n < 6 && this.pollen.size < POLLEN; n++) this.grain();
    for (const p of this.players.values()) if (!p.bee && p.auto && this.t - p.deadAt > 2500) this.enter(p);

    if (this.t >= this.phaseEnds) {
      const first = [...this.bees.values()].filter((b) => b.kind !== 'w').sort((a, b) => b.m - a.m)[0] || null;
      const p = first && first.key && this.players.get(first.key);
      if (p) p.wins++;
      this.winner = first ? { name: first.name, kind: first.kind, m: Math.round(first.m), wins: p ? p.wins : 0 } : null;
      this.phase = 'rest'; this.phaseEnds = this.t + this.cfg.rest * 1000;
      this.say('win', { a: first ? first.name : null });
      for (const q of this.players.values()) this.outbox.push([q.key, this.you(q.key)]);
    }
  }

  // ---- what the pages are sent ------------------------------------------------------

  roster() { return [...this.bees.values()].map((b) => [b.id, b.name, b.kind, b.owner ? 1 : 0, b.bidder ? 1 : 0]); }
  beesNow() {
    return [...this.bees.values()].map((b) => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.m * 10) / 10, Math.round(b.a * 100) / 100,
      (b.dashT > 0 ? 1 : 0) | (b.smoke > 0 ? 2 : 0) | (b.id === this.crown ? 4 : 0) | (b.honey > 0 ? 8 : 0) | (b.burn ? 16 : 0) | (b.queen > 0 ? 32 : 0) | (b.pulled > this.t ? 64 : 0), b.fb]);
  }
  head(t) { return { t, n: Math.round(this.t), round: this.round, ph: this.phase, left: Math.max(0, Math.round(this.phaseEnds - this.t)), ring: Math.round(this.ring), win: this.winner, b: this.beesNow(), sh: this.shots.map((s) => [Math.round(s.x), Math.round(s.y)]), pk: [...this.pickups.values()].map((k) => [k.id, Math.round(k.x), Math.round(k.y), k.kind]) }; }
  // Everything, for a page that has just arrived or a round that has just begun.
  full() {
    return { ...this.head('f'), v: VERSION, R, cfg: this.cfg, ro: this.roster(), p: [...this.pollen.values()].map((g) => [g.id, Math.round(g.x), Math.round(g.y), g.m, g.until ? 1 : 0]),
      f: [...this.patches.values()].map((f) => [f.id, Math.round(f.x), Math.round(f.y), Math.round(f.r), Math.round(f.until - this.t), f.kind]) };
  }
  // What changed since the last one.
  snap() {
    for (const id of this.moved) { const g = this.pollen.get(id); if (g) this.pAdd.push([g.id, Math.round(g.x), Math.round(g.y), g.m, g.until ? 1 : 0]); }   // food a queen is pulling in
    const s = { ...this.head('s'), pa: this.pAdd, pd: this.pDel, fa: this.fAdd, ev: this.events };
    if (this.rosterDirty) s.ro = this.roster();
    this.settle();
    return s;
  }
  settle() { this.pAdd = []; this.pDel = []; this.fAdd = []; this.moved = new Set(); this.events = []; this.rosterDirty = false; this.fresh = false; }
}

// ---- the owner's settings ------------------------------------------------------------

const stub = (env) => env.ARENA.get(env.ARENA.idFromName('main'));

export async function arenaSetting(env) {
  try { return cleanCfg(JSON.parse((await getSetting(env, 'arena')) || '{}')); } catch { return { ...DEFAULTS }; }
}
// Owner: POST /admin/api/arena { round, rest } in seconds. Takes effect from the next round.
export async function setArena(env, body, now) {
  const cfg = cleanCfg(body);
  await setSetting(env, 'arena', JSON.stringify(cfg), now);
  try { await stub(env).fetch('https://arena/config', { method: 'POST', body: JSON.stringify(cfg) }); } catch (error) { console.error('[ARENA] config', String(error)); }
  return [200, cfg];
}
// POST /arena/join: who is asking (worked out by the caller), and a one-use ticket to open the game's socket with.
export async function arenaJoin(env, who, owner, bidders, ip) {
  if (!who) return [400, { message: 'Open torchhive.com/arena to play.' }];
  if (!env.ARENA) return [503, { message: 'The arena is not switched on.' }];
  const r = await stub(env).fetch('https://arena/mint', { method: 'POST', body: JSON.stringify({ who, owner, bidders, ip, cfg: await arenaSetting(env) }) });
  return [r.status, await r.json()];
}
// GET /arena/ws?t=<ticket>, as a WebSocket.
export function arenaSocket(env, request) {
  if (!env.ARENA) return new Response('The arena is not switched on.', { status: 503 });
  return stub(env).fetch(request);
}

// ---- the Durable Object ---------------------------------------------------------------

const MAX_PAGES = 80;
// Against someone filling the arena with scripted pages: one internet address may have this many
// pages in the game at once and ask for this many tickets a minute. The owner is not limited.
const PAGES_PER_ADDRESS = 4, TICKETS_PER_MINUTE = 12;

export class Arena {
  constructor(state, env) {
    this.env = env; this.conns = new Map(); this.tickets = new Map(); this.world = null; this.timer = null;
    this.cfg = { ...DEFAULTS }; this.bidders = []; this.n = 0; this.last = 0; this.asked = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url), now = Date.now();
    if (url.pathname === '/config') {
      this.cfg = cleanCfg(await request.json().catch(() => null));
      if (this.world) this.world.cfg = this.cfg;
      return Response.json(this.cfg);
    }
    if (url.pathname === '/mint') {
      const body = await request.json().catch(() => null);
      if (!body || !body.who || !body.who.player) return Response.json({ message: 'Open torchhive.com/arena to play.' }, { status: 400 });
      if (this.conns.size >= MAX_PAGES && !this.conns.has(body.who.player)) return Response.json({ message: 'The arena is full right now. Try again in a minute.' }, { status: 429 });
      const ip = String(body.ip || '').slice(0, 60);
      if (ip && !body.owner) {
        if (this.asked.size > 2000) this.asked.clear();
        const a = this.asked.get(ip) || { since: now, n: 0 };
        if (now - a.since > 60000) { a.since = now; a.n = 0; }
        a.n++; this.asked.set(ip, a);
        const here = [...this.conns.entries()].filter(([key, c]) => c.ip === ip && key !== body.who.player).length;
        if (a.n > TICKETS_PER_MINUTE || here >= PAGES_PER_ADDRESS) return Response.json({ message: 'Too many pages are open from this connection. Close one and try again in a minute.' }, { status: 429 });
      }
      this.cfg = cleanCfg(body.cfg);
      this.bidders = Array.isArray(body.bidders) ? body.bidders.filter((n) => typeof n === 'string' && n.length <= 30).slice(0, 12) : [];
      if (this.world) { this.world.cfg = this.cfg; this.world.bidders = this.bidders; }
      for (const [t, v] of this.tickets) if (v.exp < now) this.tickets.delete(t);
      const ticket = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      this.tickets.set(ticket, { player: body.who.player, name: String(body.who.name).slice(0, 30), owner: Boolean(body.owner), ip, exp: now + 30000 });
      return Response.json({ ticket, name: body.who.name });
    }
    if (url.pathname === '/arena/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
      const who = this.tickets.get(url.searchParams.get('t') || '');
      if (!who || who.exp < now) return new Response('That ticket has run out.', { status: 403 });
      this.tickets.delete(url.searchParams.get('t'));
      const pair = new WebSocketPair();
      pair[1].accept();
      this.join(pair[1], who);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('Not found.', { status: 404 });
  }

  join(ws, who) {
    const opened = !this.world;
    if (opened) { this.world = new World(this.cfg, this.bidders); this.last = Date.now(); }
    const key = who.player, old = this.conns.get(key);
    if (old) try { old.ws.close(4000, 'Opened somewhere else.'); } catch {}
    const conn = { ws, owner: who.owner, ip: who.ip || '', count: 0, since: Date.now() };
    this.conns.set(key, conn);
    this.world.addPlayer(key, who.name, who.owner);
    this.world.outbox = this.world.outbox.filter((m) => m[0] !== key);
    this.send(conn, { ...this.world.full(), you: this.world.you(key), owner: who.owner, name: who.name });
    if (opened) this.world.settle();   // the first page has just been sent everything
    const bye = () => {
      if (this.conns.get(key) !== conn) return;
      this.conns.delete(key);
      if (this.world) this.world.removePlayer(key);
      if (!this.conns.size) { clearInterval(this.timer); this.timer = null; this.world = null; }   // nobody left: the arena is gone
    };
    ws.addEventListener('message', (e) => {
      // at most 40 messages a second from one page
      const t = Date.now();
      if (t - conn.since > 1000) { conn.since = t; conn.count = 0; }
      if (++conn.count > 40 || typeof e.data !== 'string' || e.data.length > 300 || !this.world) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'i') this.world.input(key, m);
      else if (m.t === 'chat' && conn.owner) this.world.chat(m.k, m.name);
    });
    ws.addEventListener('close', bye); ws.addEventListener('error', bye);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 33);
  }

  send(conn, data) { try { conn.ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch { try { conn.ws.close(1011, 'Lost.'); } catch {} } }

  // Up to thirty steps a second; the pages are sent what changed about twenty times a second.
  tick() {
    const w = this.world;
    if (!w) return;
    try {
      const now = Date.now(), dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      w.step(dt);
      if (w.fresh) { const all = w.full(); w.settle(); for (const [key, c] of this.conns) this.send(c, { ...all, you: w.you(key) }); }
      else if (now - this.n >= 45) { this.n = now; const s = JSON.stringify(w.snap()); for (const c of this.conns.values()) this.send(c, s); }
      for (const [key, msg] of w.outbox.splice(0)) { const c = this.conns.get(key); if (c) this.send(c, msg); }
    } catch (error) { console.error('[ARENA] tick', error && error.stack ? error.stack : String(error)); }
  }
}
