// dgf-bids: the bid service behind daddygofaster.com.
//
// Public:  GET  /board           this round's qualified bids (name, amount, time only)
//          POST /bids            place a bid or raise one, get a verdict back
//          POST /mine            how the bids this browser placed are standing
//          GET  /stop            turn off outbid emails for one bid
// Owner:   GET  /admin           the owner's page (asks for the admin key)
//          *    /admin/api/...   needs "Authorization: Bearer <admin key>"
//
// There is no scheduler. A round that has run past its close is settled the
// next time anyone reads the board, bids, or opens the admin page.
import {
  LIMITS, money, describeMinutes, coveredMinutes, minCentsFor, validateBid, validateRaise, applyScreen, raiseVerdict,
  resolveStandings, HELD_MESSAGE, nominalAuction, extendedClose, dayShift, pickWinner,
} from './rules.js';
import { screenBid } from './screen.js';
import { shouldEmail, outbidEmail, sendEmail } from './mail.js';
import {
  sha256, randomHex, sameText, getSetting, setSetting, deleteSetting, seal, providerKey,
  storeAdminKey, adminKeyIsSet, adminKeyMatches,
} from './store.js';
import ADMIN_HTML from './admin.html';

const IP_BIDS_PER_HOUR = 30;
const MAX_RAISES = 200; // per bid per round; far more than a person needs, enough to stop a script
const MAX_BODY = 4000;

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function settings(env) {
  return {
    open: env.OPEN === 'true',
    rate: int(env.RATE_PER_HOUR, 200),
    tz: env.TIME_ZONE || 'America/Chicago',
    closeHour: int(env.CLOSE_HOUR, 20),
    extend: int(env.EXTEND_MINUTES, 5),
    maxPerDay: int(env.MAX_BIDS_PER_DAY, 5),
    origins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    model: env.SCREEN_MODEL || 'claude-opus-5-5',
    siteUrl: (env.SITE_URL || 'https://daddygofaster.com').replace(/\/+$/, ''),
    mailFrom: env.MAIL_FROM || '',
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function corsHeaders(request, s) {
  const origin = request.headers.get('Origin');
  return origin && s.origins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
}

const mailKey = (env) => providerKey(env, 'RESEND_API_KEY', 'mail_key');
const aiKey = (env) => providerKey(env, 'ANTHROPIC_API_KEY', 'ai_key');

// ---- rounds ---------------------------------------------------------------------

async function chooseWinner(env, day) {
  const { results: bids } = await env.DB.prepare(
    "SELECT id, email, amount_cents, created_at FROM bids WHERE day = ? AND status = 'qualified' AND win_state IS NULL",
  ).bind(day).all();
  const { results: recent } = await env.DB.prepare(
    "SELECT DISTINCT email FROM bids WHERE win_state = 'won' AND day <> ? AND day >= ? AND day <= ?",
  ).bind(day, dayShift(day, -6), dayShift(day, 6)).all();
  const winner = pickWinner(bids, new Set(recent.map((r) => r.email)));
  if (winner) {
    await env.DB.batch([
      env.DB.prepare("UPDATE bids SET win_state = 'won' WHERE id = ?").bind(winner.id),
      env.DB.prepare('UPDATE auctions SET winner_bid_id = ? WHERE day = ?').bind(winner.id, day),
    ]);
  } else {
    await env.DB.prepare('UPDATE auctions SET winner_bid_id = NULL WHERE day = ?').bind(day).run();
  }
  return winner;
}

async function closeAuction(env, day, now) {
  // Only one caller gets to close it; everyone else sees zero rows changed.
  const r = await env.DB.prepare("UPDATE auctions SET status = 'closed', closed_at = ? WHERE day = ? AND status = 'open'")
    .bind(now, day).run();
  if (r.meta.changes) await chooseWinner(env, day);
  return Boolean(r.meta.changes);
}

async function settleDue(env, now) {
  const { results } = await env.DB.prepare("SELECT day FROM auctions WHERE status = 'open' AND closes_at <= ?").bind(now).all();
  for (const a of results) await closeAuction(env, a.day, now);
}

// The round people are bidding in right now. Creates it on the first visit
// after the last one closed.
async function currentAuction(env, s, now) {
  await settleDue(env, now);
  const open = await env.DB.prepare("SELECT * FROM auctions WHERE status = 'open' ORDER BY closes_at LIMIT 1").first();
  if (open) return open;
  const n = nominalAuction(now, s.tz, s.closeHour);
  await env.DB.prepare("INSERT OR IGNORE INTO auctions (day, closes_at, status) VALUES (?, ?, 'open')").bind(n.day, n.closesAt).run();
  return env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(n.day).first();
}

// ---- standings: auto-bids, the clock, and outbid emails ---------------------------

const TOP = "SELECT * FROM bids WHERE day = ? AND status = 'qualified' ORDER BY amount_cents DESC, created_at ASC, id ASC LIMIT 1";

function topBid(env, day) {
  return env.DB.prepare(TOP).bind(day).first();
}

// Lets the auto-bids answer whatever just changed, then deals with what follows
// from it. `before` is the leading bid as it stood before the change.
async function settleStandings(request, env, s, ctx, a, before, now) {
  const { results: bids } = await env.DB.prepare(
    "SELECT id, amount_cents, max_cents, created_at FROM bids WHERE day = ? AND status = 'qualified'",
  ).bind(a.day).all();
  const standing = resolveStandings(bids);
  const moved = bids.filter((b) => standing.amounts.get(b.id) !== b.amount_cents);
  if (moved.length) {
    await env.DB.batch(moved.map((b) => env.DB.prepare('UPDATE bids SET amount_cents = ? WHERE id = ?').bind(standing.amounts.get(b.id), b.id)));
  }

  // A higher high bid in the last few minutes moves the close back. No cap:
  // while people keep outbidding each other, the round runs on.
  const closesAt = extendedClose(a.closes_at, now, s.extend);
  if (standing.highCents > (before ? before.amount_cents : 0) && closesAt !== a.closes_at) {
    await env.DB.prepare(
      "UPDATE auctions SET closes_at = ?, extensions = extensions + 1 WHERE day = ? AND status = 'open' AND closes_at = ?",
    ).bind(closesAt, a.day, a.closes_at).run();
  }

  // Whoever was leading and is not any more gets told, if they asked to be.
  if (before && standing.leaderId !== before.id && shouldEmail(before, now)) {
    const work = emailOutbid(request, env, s, before, standing, now);
    if (ctx) ctx.waitUntil(work); else await work;
  }
  return standing;
}

async function emailOutbid(request, env, s, bid, standing, now) {
  const key = await mailKey(env);
  if (!key || !s.mailFrom) return;
  const message = outbidEmail({
    amountCents: standing.amounts.get(bid.id) ?? bid.amount_cents,
    highCents: standing.highCents,
    siteUrl: s.siteUrl,
    stopUrl: new URL(request.url).origin + '/stop?t=' + bid.token,
  });
  if (await sendEmail(env, { key, from: s.mailFrom, to: bid.email, ...message })) {
    await env.DB.prepare('UPDATE bids SET notified = notified + 1, notified_at = ? WHERE id = ?').bind(now, bid.id).run();
  }
}

// The sentence that tells a bidder where they stand after their bid went in.
function standingMessage(bidId, entered, before, standing) {
  const mine = standing.amounts.get(bidId);
  if (standing.leaderId === bidId) {
    return (mine > entered ? ` Your auto-bid took it to ${money(mine)}.` : '') + ' You are in the lead.';
  }
  const answered = before && standing.leaderId === before.id && entered > before.amount_cents;
  return (
    (mine > entered ? ` Your auto-bid went to your maximum of ${money(mine)}.` : '') +
    (answered ? ' Another bidder\'s auto-bid stayed ahead of you.' : '') +
    ` The high bid is ${money(standing.highCents)}.`
  );
}

function bidReply(row, verdict, message, standing) {
  const amountCents = standing ? standing.amounts.get(row.id) ?? row.amount_cents : row.amount_cents;
  return [200, {
    verdict,
    message,
    minCents: row.min_cents ?? null,
    token: row.token,
    amountCents,
    maxCents: row.max_cents ?? null,
    leading: Boolean(standing && standing.leaderId === row.id),
  }];
}

// ---- public: the board ------------------------------------------------------------

async function getBoard(env, s, now) {
  if (!s.open) return { status: 'soon', bids: [], alerts: false };
  const a = await currentAuction(env, s, now);
  const { results } = await env.DB.prepare(
    "SELECT name, amount_cents, created_at FROM bids WHERE day = ? AND status = 'qualified' ORDER BY amount_cents DESC, created_at ASC, id ASC LIMIT 50",
  ).bind(a.day).all();
  return {
    status: a.status === 'open' ? 'open' : 'closed',
    day: a.day,
    closesAt: new Date(a.closes_at).toISOString(),
    alerts: Boolean(s.mailFrom && (await mailKey(env))), // can the service email an outbid bidder?
    // Name, amount and time only. The job, the email and any maximum never leave the database here.
    bids: results.map((b) => ({ name: b.name, amountCents: b.amount_cents, placedAt: new Date(b.created_at).toISOString() })),
  };
}

// ---- public: placing and raising a bid ----------------------------------------------

// The same person sending the same job again, or the page sending the bid's
// private handle, raises that bid. No new screen, no new row, and it does not
// count against the daily limit. The bid and the maximum can only go up.
async function raiseBid(request, env, s, ctx, a, mine, { amountCents, maxCents, notify }, now) {
  if (mine.raises >= MAX_RAISES) return [429, { verdict: 'limit', message: 'That bid cannot be raised any more today.' }];
  const v = raiseVerdict(mine, amountCents, s.rate, maxCents);
  if (!v.ok) return [400, { verdict: 'invalid', message: v.message }];
  const before = await topBid(env, a.day);
  const r = await env.DB.prepare(
    `UPDATE bids SET amount_cents = ?, max_cents = ?, status = ?, created_at = ?, raises = raises + 1, notify = MAX(notify, ?)
     WHERE id = ? AND amount_cents = ? AND status = ?`,
  ).bind(v.amountCents, v.maxCents, v.status, now, notify ? 1 : 0, mine.id, mine.amount_cents, mine.status).run();
  if (!r.meta.changes) return [409, { verdict: 'invalid', message: 'That bid changed while you were raising it. Try again.' }];
  const row = { ...mine, amount_cents: v.amountCents, max_cents: v.maxCents };
  if (v.status !== 'qualified') return bidReply(row, v.status, v.message, null);
  const standing = await settleStandings(request, env, s, ctx, a, before, now);
  return bidReply(row, 'qualified', v.message + standingMessage(mine.id, v.amountCents, before, standing), standing);
}

async function postBid(request, env, s, ctx, now) {
  if (!s.open) return [403, { verdict: 'closed', message: 'Bidding is not open yet.' }];

  const text = await request.text();
  if (text.length > MAX_BODY) return [413, { verdict: 'invalid', message: 'That is too long.' }];
  let body;
  try { body = JSON.parse(text); } catch { return [400, { verdict: 'invalid', message: 'That did not arrive in one piece. Try again.' }]; }

  let a = await currentAuction(env, s, now);
  if (a.status !== 'open') return [409, { verdict: 'closed', message: 'Bidding is closed for today. It opens again soon.' }];

  // A raise sent with the bid's private handle.
  if (body && typeof body.token === 'string' && body.token) {
    const raise = validateRaise(body);
    if (!raise.ok) return [400, { verdict: 'invalid', message: raise.error }];
    const mine = await env.DB.prepare(
      "SELECT * FROM bids WHERE token = ? AND day = ? AND status IN ('qualified', 'short', 'held')",
    ).bind(body.token, a.day).first();
    if (!mine) return [404, { verdict: 'invalid', message: 'That bid is not in today\'s round. Place a new one.' }];
    return raiseBid(request, env, s, ctx, a, mine, { ...raise.value, notify: body.notify === true }, now);
  }

  const checked = validateBid(body);
  if (!checked.ok) return [400, { verdict: 'invalid', message: checked.error }];
  const bid = checked.value;

  const mine = await env.DB.prepare(
    "SELECT * FROM bids WHERE day = ? AND email = ? AND lower(task) = lower(?) AND status IN ('qualified', 'short', 'held') ORDER BY id DESC LIMIT 1",
  ).bind(a.day, bid.email, bid.task).first();
  if (mine) return raiseBid(request, env, s, ctx, a, mine, bid, now);

  const ipHash = await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + '|' + a.day);
  const [byEmail, byIp, wonLately] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('qualified', 'held') THEN 1 ELSE 0 END) AS landed FROM bids WHERE email = ? AND day = ?")
      .bind(bid.email, a.day),
    env.DB.prepare('SELECT COUNT(*) AS n FROM bids WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - 3_600_000),
    env.DB.prepare("SELECT day FROM bids WHERE email = ? AND win_state = 'won' AND day <> ? AND day >= ? LIMIT 1")
      .bind(bid.email, a.day, dayShift(a.day, -6)),
  ]);
  // The daily limit counts bids that landed. Tries that fell short or broke a
  // rule do not use it up, but they are capped too so the screen cannot be run up.
  if ((byEmail.results[0].landed || 0) >= s.maxPerDay) {
    return [429, { verdict: 'limit', message: `That is the limit of ${s.maxPerDay} jobs a day. You can still raise a bid you already placed.` }];
  }
  if (byEmail.results[0].n >= s.maxPerDay * 4) return [429, { verdict: 'limit', message: 'That is a lot of tries for one day. Try again tomorrow.' }];
  if (byIp.results[0].n >= IP_BIDS_PER_HOUR) return [429, { verdict: 'limit', message: 'Too many bids from here. Try again in an hour.' }];
  if (wonLately.results.length) {
    return [403, { verdict: 'limit', message: 'You won within the past week. It is one win per person per week, so try again in a few days.' }];
  }

  // The screen. With no key, or any failure, the bid waits for a person.
  const answer = await screenBid(env, { name: bid.name, task: bid.task, model: s.model, apiKey: await aiKey(env) });
  const verdict = answer
    ? applyScreen(answer, { amountCents: bid.amountCents, maxCents: bid.maxCents, ratePerHour: s.rate })
    : { status: 'held', message: HELD_MESSAGE };

  // The screen takes a few seconds; make sure the round did not close meanwhile.
  const after = Date.now();
  a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(a.day).first();
  if (a.status !== 'open' || a.closes_at <= after) return [409, { verdict: 'closed', message: 'Bidding closed while that was being checked.' }];

  const before = verdict.status === 'qualified' ? await topBid(env, a.day) : null;
  const token = randomHex(16);
  const placed = verdict.amountCents ?? bid.amountCents; // an auto-bid may have lifted it to cover the job
  const inserted = await env.DB.prepare(
    `INSERT INTO bids (day, name, email, task, amount_cents, max_cents, status, est_minutes, est_cost_cents, min_cents,
                       screen_note, screened_by, ip_hash, created_at, token, notify)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    a.day, bid.name, bid.email, bid.task, placed, bid.maxCents, verdict.status,
    verdict.estMinutes ?? null, verdict.estCostCents ?? null, verdict.minCents ?? null,
    answer ? String(answer.reason || '').slice(0, 300) : null, answer ? 'ai' : 'none', ipHash, after, token, bid.notify ? 1 : 0,
  ).run();
  const row = { id: inserted.meta.last_row_id, amount_cents: placed, max_cents: bid.maxCents, min_cents: verdict.minCents ?? null, token };

  // A refused try is kept so the limits can count it, but it gets no handle.
  if (verdict.status === 'refused') return [200, { verdict: 'refused', message: verdict.message, minCents: null }];
  if (verdict.status !== 'qualified') return bidReply(row, verdict.status, verdict.message, null);
  const standing = await settleStandings(request, env, s, ctx, a, before, after);
  return bidReply(row, 'qualified', verdict.message + standingMessage(row.id, placed, before, standing), standing);
}

// ---- public: how this browser's bids are standing ---------------------------------

async function postMine(request, env) {
  const body = await request.json().catch(() => null);
  const tokens = Array.isArray(body?.tokens) ? body.tokens.filter((t) => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)).slice(0, 10) : [];
  const out = [];
  for (const token of tokens) {
    const bid = await env.DB.prepare('SELECT * FROM bids WHERE token = ?').bind(token).first();
    if (!bid) continue;
    const a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(bid.day).first();
    const top = await topBid(env, bid.day);
    const open = a.status === 'open';
    let standing = bid.status === 'held' ? 'waiting' : bid.status; // waiting | short | refused | qualified
    if (bid.status === 'qualified') {
      if (open) standing = top && top.id === bid.id ? 'leading' : 'outbid';
      else standing = bid.win_state === 'won' ? 'won' : 'lost';
    }
    out.push({
      token, day: bid.day, open, standing,
      amountCents: bid.amount_cents, maxCents: bid.max_cents ?? null, minCents: bid.min_cents ?? null,
      highCents: top ? top.amount_cents : 0,
      closesAt: new Date(a.closes_at).toISOString(),
    });
  }
  return [200, { bids: out }];
}

async function stopEmails(env, token) {
  const ok = typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);
  if (ok) await env.DB.prepare('UPDATE bids SET notify = 0 WHERE token = ?').bind(token).run();
  const line = ok ? 'You will not get any more emails about this bid.' : 'That link is not valid.';
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>DaddyGoFaster</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0C0D10;color:#F5F5F6;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:24px"><p>${line}</p>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

// ---- owner ------------------------------------------------------------------------

function adminBid(b, s, showJobs) {
  // No maximum here on purpose: the owner should not know how high a bidder will go.
  return {
    id: b.id, name: b.name, amountCents: b.amount_cents, status: b.status, winState: b.win_state,
    covers: describeMinutes(coveredMinutes(b.amount_cents, s.rate)),
    estMinutes: b.est_minutes, estCostCents: b.est_cost_cents, minCents: b.min_cents,
    note: b.screen_note, screenedBy: b.screened_by, placedAt: new Date(b.created_at).toISOString(),
    task: showJobs ? b.task : null,
  };
}

async function adminState(env, s, now, showJobs) {
  await settleDue(env, now);
  const auction = s.open
    ? await currentAuction(env, s, now)
    : await env.DB.prepare("SELECT * FROM auctions WHERE status = 'open' ORDER BY closes_at LIMIT 1").first();
  const bids = auction
    ? (await env.DB.prepare('SELECT * FROM bids WHERE day = ? ORDER BY amount_cents DESC, created_at ASC, id ASC').bind(auction.day).all()).results
    : [];
  const last = await env.DB.prepare("SELECT * FROM auctions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 1").first();
  let previous = null;
  if (last) {
    const w = last.winner_bid_id ? await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(last.winner_bid_id).first() : null;
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM bids WHERE day = ? AND status = 'qualified' AND win_state IS NULL").bind(last.day).first();
    previous = {
      day: last.day,
      closedAt: new Date(last.closed_at).toISOString(),
      othersWaiting: left.n,
      // The winner's email is shown so the owner can reach them. Nobody else's is.
      winner: w ? { ...adminBid(w, s, showJobs), email: w.email, free: w.amount_cents < LIMITS.freeUnderCents } : null,
    };
  }
  return {
    open: s.open,
    screen: (await aiKey(env)) ? 'ai' : 'manual',
    email: s.mailFrom && (await mailKey(env)) ? 'on' : 'off',
    settings: { ratePerHour: s.rate, timeZone: s.tz, closeHour: s.closeHour, maxBidsPerDay: s.maxPerDay },
    auction: auction ? { day: auction.day, status: auction.status, closesAt: new Date(auction.closes_at).toISOString() } : null,
    bids: bids.map((b) => adminBid(b, s, showJobs)),
    previous,
  };
}

async function adminDecide(request, env, s, ctx, id, now) {
  const body = await request.json().catch(() => ({}));
  const bid = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(id).first();
  if (!bid) return [404, { message: 'No such bid.' }];
  if (bid.status !== 'held') return [409, { message: 'That bid has already been decided.' }];
  const a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(bid.day).first();
  if (a.status !== 'open' || a.closes_at <= now) return [409, { message: 'That round has closed.' }];

  if (body.decision === 'refuse') {
    await env.DB.prepare("UPDATE bids SET status = 'refused', screened_by = 'owner', decided_at = ? WHERE id = ? AND status = 'held'").bind(now, id).run();
    return [200, { status: 'refused' }];
  }
  if (body.decision !== 'approve') return [400, { message: 'Send decision: approve or refuse.' }];
  const minutes = Number(body.estMinutes);
  const hasEstimate = Number.isFinite(minutes) && minutes > 0;
  const costCents = Number.isFinite(Number(body.costDollars)) ? Math.max(0, Math.round(Number(body.costDollars) * 100)) : null;
  const before = await topBid(env, a.day);
  await env.DB.prepare(
    "UPDATE bids SET status = 'qualified', screened_by = 'owner', decided_at = ?, est_minutes = ?, est_cost_cents = ?, min_cents = ? WHERE id = ? AND status = 'held'",
  ).bind(now, hasEstimate ? minutes : null, costCents, hasEstimate ? minCentsFor(minutes, s.rate) : null, id).run();
  await settleStandings(request, env, s, ctx, a, before, now);
  return [200, { status: 'qualified' }];
}

// One-time setup. The owner's keys arrive as request headers that the caller's
// own network puts on, so they are never typed into a chat or a command line.
// It only works while a setup code is waiting in the database, and that code
// is written through the Cloudflare account, so only the account holder can
// start it.
async function adminSetup(request, env, now) {
  const waiting = await getSetting(env, 'setup_code');
  const [code, expires] = (waiting || '|0').split('|');
  const given = request.headers.get('X-Setup-Code') || '';
  if (!code || Number(expires) < now || !sameText(await sha256(given), await sha256(code))) {
    return [403, { message: 'No setup is waiting, or the code is wrong or out of date.' }];
  }
  const stored = [];
  const refused = [];
  const admin = request.headers.get('X-Admin-Key');
  if (admin) {
    if (admin.length < 16) refused.push('admin key (use at least 16 characters)');
    else { await storeAdminKey(env, admin, now); stored.push('admin key'); }
  }
  for (const [header, setting, label] of [['X-Mail-Key', 'mail_key', 'email key'], ['X-Ai-Key', 'ai_key', 'AI key']]) {
    const value = request.headers.get(header);
    if (!value) continue;
    const sealed = await seal(env, value);
    if (!sealed) refused.push(label + ' (the vault key is not set)');
    else { await setSetting(env, setting, sealed, now); stored.push(label); }
  }
  if (stored.length) await deleteSetting(env, 'setup_code');
  return [stored.length ? 200 : 400, { stored, refused }];
}

async function adminRoute(request, env, s, ctx, path, now) {
  if (request.method === 'POST' && path === '/admin/api/setup') return adminSetup(request, env, now);
  if (!(await adminKeyIsSet(env))) return [503, { message: 'The admin key has not been set yet.' }];
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await adminKeyMatches(env, given))) return [401, { message: 'Wrong or missing admin key.' }];
  const url = new URL(request.url);
  let m;
  if (request.method === 'GET' && path === '/admin/api/state') return [200, await adminState(env, s, now, url.searchParams.get('jobs') === '1')];
  if (request.method === 'POST' && (m = /^\/admin\/api\/bids\/(\d+)\/decide$/.exec(path))) return adminDecide(request, env, s, ctx, Number(m[1]), now);
  if (request.method === 'POST' && (m = /^\/admin\/api\/auctions\/(\d{4}-\d{2}-\d{2})\/close$/.exec(path))) {
    return (await closeAuction(env, m[1], now)) ? [200, { status: 'closed' }] : [409, { message: 'That round is not open.' }];
  }
  if (request.method === 'POST' && (m = /^\/admin\/api\/auctions\/(\d{4}-\d{2}-\d{2})\/pass$/.exec(path))) {
    // The winner did not pay in time, or the owner declined the job: the next bid wins.
    const a = await env.DB.prepare("SELECT * FROM auctions WHERE day = ? AND status = 'closed'").bind(m[1]).first();
    if (!a || !a.winner_bid_id) return [409, { message: 'There is no winner to pass on.' }];
    await env.DB.prepare("UPDATE bids SET win_state = 'passed' WHERE id = ?").bind(a.winner_bid_id).run();
    const next = await chooseWinner(env, a.day);
    return [200, { status: next ? 'next' : 'none-left' }];
  }
  return [404, { message: 'Not found.' }];
}

// ---- entry ------------------------------------------------------------------------

const PUBLIC = new Set(['/board', '/bids', '/mine']);

export default {
  async fetch(request, env, ctx) {
    const s = settings(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = Date.now();
    const cors = corsHeaders(request, s);

    try {
      if (PUBLIC.has(path)) {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' },
          });
        }
        if (path === '/board' && request.method === 'GET') return json(await getBoard(env, s, now), 200, cors);
        if (path === '/bids' && request.method === 'POST') {
          const [status, body] = await postBid(request, env, s, ctx, now);
          return json(body, status, cors);
        }
        if (path === '/mine' && request.method === 'POST') {
          const [status, body] = await postMine(request, env);
          return json(body, status, cors);
        }
        return json({ message: 'Method not allowed.' }, 405, cors);
      }
      if (path === '/stop' && request.method === 'GET') return stopEmails(env, url.searchParams.get('t'));
      if (path === '/admin' && request.method === 'GET') {
        return new Response(ADMIN_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
          },
        });
      }
      if (path.startsWith('/admin/api/')) {
        const [status, body] = await adminRoute(request, env, s, ctx, path, now);
        return json(body, status);
      }
      if (path === '/') return json({ service: 'dgf-bids', open: s.open });
      return json({ message: 'Not found.' }, 404);
    } catch (error) {
      console.error('[BIDS] unhandled', error && error.stack ? error.stack : String(error));
      return json({ message: 'Something went wrong on our side. Try again in a minute.' }, 500, cors);
    }
  },
};
