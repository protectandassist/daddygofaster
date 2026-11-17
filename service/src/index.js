// dgf-bids: the bid service behind torchhive.com (it began as daddygofaster.com).
//
// Public:  GET  /board           this round's qualified bids (name, amount, time only)
//          POST /bids            place a bid or raise one, get a verdict back
//          POST /bids/confirm    finish a bid whose bank asked the cardholder to confirm
//          POST /pledges         add money to someone's open job
//          POST /pledges/confirm finish that after the bank asked the cardholder to confirm
//          POST /mine            how the bids this browser placed are standing
//          POST /auth/start      email a sign-in link;  POST /auth/finish  use it;  POST /auth/end  sign out
//          GET  /me              who is signed in, their votes, and where they can comment
//          POST /votes           vote for an open job, or take the vote back (signed in)
//          GET  /comments        comments on an open job;  POST /comments  add one (signed in)
//          POST /a               count a visit or a step in the bid form (see stats.js)
//          GET  /stop            turn off outbid emails for one bid
// Owner:   GET  /admin           the owner's page (asks for the admin key)
//          *    /admin/api/...   needs "Authorization: Bearer <admin key>"
//
// A round that has run past its close is settled the next time anyone reads the
// board, bids, or opens the admin page, and by a timer every minute. The timer
// is also what charges the winner's card and releases every other hold.
import {
  LIMITS, TIME_POLICY, money, describeMinutes, coveredMinutes, timeAllowance, approveDuration, validateBid, validateRaise, validatePledge, applyScreen, raiseVerdict,
  resolveStandings, HELD_MESSAGE, nominalAuction, scheduleWindow, readSchedule, extendedClose, dayShift, pickWinner, holdTarget, extraHold, readCostItems, checkReply, taskKey, roundKey, roundDate, roundCreator,
} from './rules.js';
import { cardKeys, readIntent } from './cards.js';
import {
  MAX_CARD_FAILS, MAX_HOLDS, heldSummary, takeHold, releaseHold, releaseBidHolds, undoCharge, chargeWinner, chargeBackers, settleMoney, unsettledDays, sweepStale, sweepOwed, SETTLE_RETRY_MS, costCents } from './holds.js';
import { screenBid } from './screen.js';
import { shouldEmail, outbidEmail, sendEmail } from './mail.js';
import { listCreators, getCreator, myCreator, saveCreator, followCreator, adminCreators, decideCreator, creatorScope, ownCreator, startPayouts, setBidding, payCreators } from './creators.js';
import { liveState, setLive, getLive, postChat, recentChat, removeChat, blockChatter } from './live.js';
import { pageUrl, pushKey, pushSubscribe, pushUnsubscribe, pushNext, outbidNotices, roundNotices, sendNotices, stopAlerts } from './alerts.js';
import {
  sha256, randomHex, sameText, getSetting, setSetting, deleteSetting, seal, providerKey,
  storeAdminKey, adminKeyIsSet, adminKeyMatches,
} from './store.js';
import {
  signInOn, emailLinksOn, sessionUser, namedUser, isAdminEmail, listMembers, getActivity, postSeen, deleteAccount, authGoogle, postMe, authStart, authFinish, authEnd, getMe, postVote, getComments, postComment, reportComment, recentComments, removeComment, restoreComment, blockCommenter,
} from './social.js';
import { record, report, tidy, liveNow } from './stats.js';
import { gamesState, gamesSetting, setGames, postPick, player } from './games.js';
import { Arena, arenaJoin, arenaSocket, arenaSetting, setArena } from './arena.js';
export { Arena };
import ADMIN_HTML from './admin.html';
import REPORTS_HTML from './reports.html';

const IP_BIDS_PER_HOUR = 30;
const IP_CHECKS_PER_HOUR = 20; // jobs one place may have checked before bidding
const CHECK_KEEP_MS = 60 * 60_000; // how long a check's answer stands for the bid that follows
const MAX_RAISES = 200; // per bid per round; far more than a person needs, enough to stop a script
const MAX_BODY = 4000;
const PLEDGES_PER_EMAIL_PER_DAY = 20;

const CARD_NEEDED = 'Add a card to place this bid. Your bid is held on the card, not charged. Only the winner is charged.';
const CARD_CONFIRM = 'Your bank wants you to confirm this card.';
const HOLD_NOTE = ' It is held on your card, not charged. You are only charged if you win, and the hold is released if you do not.';

// The card the page sent: Stripe's id for it, never a card number.
function cardFrom(body) {
  const id = body && typeof body.paymentMethod === 'string' ? body.paymentMethod : '';
  return /^pm_[A-Za-z0-9_]{6,120}$/.test(id) ? id : null;
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function settings(env) {
  return {
    open: env.OPEN === 'true',
    tz: env.TIME_ZONE || 'America/Chicago',
    closeHour: int(env.CLOSE_HOUR, 21),
    extend: int(env.EXTEND_MINUTES, 5),
    maxPerDay: int(env.MAX_BIDS_PER_DAY, 5),
    origins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    model: env.SCREEN_MODEL || 'claude-opus-5-5',
    openaiModel: env.OPENAI_MODEL || 'gpt-4.1',
    siteUrl: (env.SITE_URL || 'https://torchhive.com').replace(/\/+$/, ''),
    mailFrom: env.MAIL_FROM || '',
    apiUrl: (env.API_URL || 'https://dgf-bids.trevor-c2b.workers.dev').replace(/\/+$/, ''),
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
const openaiKey = (env) => providerKey(env, 'OPENAI_API_KEY', 'openai_key');

// ---- rounds ---------------------------------------------------------------------

async function chooseWinner(env, day) {
  const { results: bids } = await env.DB.prepare(
    "SELECT id, email, amount_cents, created_at FROM bids WHERE day = ? AND status = 'qualified' AND win_state IS NULL",
  ).bind(day).all();
  const { results: recent } = await env.DB.prepare(
    "SELECT DISTINCT email FROM bids WHERE win_state = 'won' AND creator_id = ? AND day <> ? AND substr(day, 1, 10) >= ? AND substr(day, 1, 10) <= ?",
  ).bind(roundCreator(day), day, dayShift(roundDate(day), -6), dayShift(roundDate(day), 6)).all();
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

// The owner's weekly schedule, applied to the site's own page. On a bidding day, inside the
// hours, a round runs and closes at the schedule's time. Outside them bidding reads as not
// open, and `nextOpensAt` says when it is back. A round already running is never cut short.
async function applySchedule(env, s, now) {
  let sch = null;
  try { sch = JSON.parse((await getSetting(env, 'schedule')) || 'null'); } catch { sch = null; }
  if (!sch || !Array.isArray(sch.days) || !sch.days.length) return s;
  s.schedule = sch;
  if (!s.open) return s;
  const running = await env.DB.prepare("SELECT closes_at FROM auctions WHERE status = 'open' AND creator_id = 0 AND closes_at > ? LIMIT 1").bind(now).first();
  if (running) {
    // A round that closes before its day's hours are over (closed early, or opened under an
    // older schedule) still counts as that day's round: the next opening is the day after.
    let after = scheduleWindow(running.closes_at, s.tz, sch);
    if (after && after.opensAt <= now) after = scheduleWindow(after.closesAt, s.tz, sch);
    if (after) s.nextOpensAt = after.opensAt;
    return s;
  }
  const w = scheduleWindow(now, s.tz, sch);
  if (!w) return s;
  if (w.on) {
    // One round a day: if today's has already closed (he closed it early), the next day is next.
    const had = await env.DB.prepare('SELECT status FROM auctions WHERE day = ?').bind(roundKey(w.day, 0)).first();
    const after = scheduleWindow(w.closesAt, s.tz, sch);
    if (!had) { s.window = w; if (after) s.nextOpensAt = after.opensAt; return s; }
    s.open = false; s.offDay = true;
    if (after) s.nextOpensAt = after.opensAt;
    return s;
  }
  s.open = false; s.offDay = true; s.nextOpensAt = w.opensAt;
  return s;
}

// Owner: save the weekly schedule, or clear it to go back to a round every day.
async function adminSchedule(request, env, s, now) {
  const body = await request.json().catch(() => null);
  const sch = readSchedule(body);
  if (sch && sch.error) return [400, { message: sch.error }];
  if (!sch) { await deleteSetting(env, 'schedule'); return [200, { status: 'cleared', message: 'Saved. A new round opens every day, as before.' }]; }
  await setSetting(env, 'schedule', JSON.stringify(sch), now);
  return [200, { status: 'saved', message: 'Saved. A round that is already open keeps its own closing time; the schedule applies from the next one.' }];
}

// The round people are bidding in right now. Creates it on the first visit
// after the last one closed.
async function currentAuction(env, s, now) {
  await settleDue(env, now);
  const page = s.creatorId || 0; // 0 is the site's own page
  const open = await env.DB.prepare("SELECT * FROM auctions WHERE status = 'open' AND creator_id = ? ORDER BY closes_at LIMIT 1").bind(page).first();
  if (open) return open;
  const n = s.window && !page ? s.window : nominalAuction(now, s.tz, s.closeHour);
  const key = roundKey(n.day, page);
  await env.DB.prepare("INSERT OR IGNORE INTO auctions (day, closes_at, status, creator_id) VALUES (?, ?, 'open', ?)").bind(key, n.closesAt, page).run();
  return env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(key).first();
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
  // While he is live with a fixed close, the time he announced stands: late bids add nothing.
  const live = await liveState(env);
  const closesAt = live.fixedClose ? a.closes_at : extendedClose(a.closes_at, now, s.extend);
  if (standing.highCents > (before ? before.amount_cents : 0) && closesAt !== a.closes_at) {
    await env.DB.prepare(
      "UPDATE auctions SET closes_at = ?, extensions = extensions + 1 WHERE day = ? AND status = 'open' AND closes_at = ?",
    ).bind(closesAt, a.day, a.closes_at).run();
  }

  // Whoever was leading and is not any more gets told, if they asked to be.
  if (before && standing.leaderId !== before.id) {
    const work = (async () => {
      // People with an account are told through their account's alerts (email and devices),
      // backers of the job included. Anyone else who ticked the box gets the plain outbid email.
      const covered = await outbidNotices(env, s, before, standing.highCents, now);
      if (!covered && shouldEmail(before, now)) await emailOutbid(request, env, s, before, standing, now);
      await sendNotices(env, s, now, 8);
    })().catch((error) => console.error('[ALERTS] outbid', String(error)));
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
    siteUrl: await pageUrl(env, s, bid.day),
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

// How people can sign in, for the page: at all, by emailed link, and with Google (its
// public client id). And the public key a device needs to ask for notifications.
async function signInWays(env, s) {
  return { signIn: await signInOn(env, s), emailLinks: await emailLinksOn(env, s), google: env.GOOGLE_CLIENT_ID || null, pushKey: pushKey(env) };
}

// A pretend bid for the stream overlay only, sent from the owner page to see the overlay react.
// It lasts 25 seconds, is never on the site's board, and no card or bidder is involved.
async function overlayTest(env, now) {
  try {
    const t = JSON.parse((await getSetting(env, 'overlay_test')) || 'null');
    return t && t.until > now ? { id: t.id, name: t.name, amountCents: t.amountCents } : null;
  } catch { return null; }
}
async function sendOverlayTest(env, s, now) {
  const a = s.open ? await currentAuction(env, s, now) : null;
  const top = a ? await env.DB.prepare("SELECT MAX(amount_cents) AS c FROM bids WHERE day = ? AND status = 'qualified'").bind(a.day).first() : null;
  const amountCents = (top && top.c ? top.c : 0) + 500; // five dollars over the high bid, so it takes the lead
  await setSetting(env, 'overlay_test', JSON.stringify({ id: now, name: 'Test bid', amountCents, until: now + 25_000 }), now);
  return [200, { status: 'sent', amountCents, message: `A pretend bid of ${money(amountCents)} is on the stream overlay for 25 seconds. It is not on the site and nobody is charged.` }];
}

async function getBoard(env, s, now) {
  // Before bidding opens there is no board, but people can already make an account.
  if (!s.open) return { status: 'soon', ...(s.nextOpensAt ? { nextOpensAt: new Date(s.nextOpensAt).toISOString() } : {}), bids: [], alerts: false, live: s.creator ? false : (await liveState(env)).on, ...(s.creator ? { creator: s.creator } : {}), ...(await signInWays(env, s)) };
  const a = await currentAuction(env, s, now);
  const { results } = await env.DB.prepare(
    `SELECT name, amount_cents, created_at, shared, pid, task, backers,
            (SELECT COUNT(*) FROM votes v WHERE v.bid_id = bids.id) AS votes,
            (SELECT COUNT(*) FROM comments c WHERE c.bid_id = bids.id AND c.status = 'shown') AS comments
     FROM bids WHERE day = ? AND status = 'qualified' ORDER BY amount_cents DESC, created_at ASC, id ASC LIMIT 50`,
  ).bind(a.day).all();
  return {
    status: a.status === 'open' ? 'open' : 'closed',
    day: a.day,
    closesAt: new Date(a.closes_at).toISOString(),
    ...(s.nextOpensAt ? { nextOpensAt: new Date(s.nextOpensAt).toISOString() } : {}),
    alerts: Boolean(s.mailFrom && (await mailKey(env))), // can the service email an outbid bidder?
    cardKey: cardKeys(env)?.publishable ?? null, // set when a bid needs a card; the page shows the card box
    pooling: Boolean(cardKeys(env)), // can people add money to an open job? It needs card holds.
    minPledgeCents: LIMITS.minPledgeCents,
    ...(await signInWays(env, s)),
    live: s.creator ? false : (await liveState(env)).on, // is he streaming right now? The page then shows the stream and its chat.
    ...(s.creator ? { creator: s.creator } : {}), // whose page this is
    // A secret job gives name, amount and time only: the job itself never leaves the database
    // here. An open job, which its poster chose to show, also gives the job, a public
    // handle to add money to, and how many people have. Never an email or a maximum.
    bids: results.map((b) => ({
      name: b.name, amountCents: b.amount_cents, placedAt: new Date(b.created_at).toISOString(),
      ...(b.shared ? { open: true, id: b.pid, task: b.task, backers: b.backers, votes: b.votes, comments: b.comments } : { open: false }),
    })),
  };
}

// ---- public: placing and raising a bid ----------------------------------------------

// The same person sending the same job again, or the page sending the bid's
// private handle, raises that bid. No new screen, no new row, and it does not
// count against the daily limit. The bid and the maximum can only go up.
async function raiseBid(request, env, s, ctx, a, mine, { amountCents, maxCents, notify }, now, card = { id: null, saved: false }) {
  if (mine.raises >= MAX_RAISES) return [429, { verdict: 'limit', message: 'That bid cannot be raised any more today.' }];
  if (mine.shared) maxCents = null; // an open job has no hidden maximum: anyone can add to it instead
  const v = raiseVerdict(mine, amountCents, maxCents);
  if (!v.ok) return [400, { verdict: 'invalid', message: v.message }];
  // What other people added stays theirs. The poster's raise grows only their own part.
  const others = mine.amount_cents - (mine.own_cents ?? mine.amount_cents);
  v.ownCents = mine.shared ? v.amountCents - others : null;

  // A raise that takes the bid past what is already held needs more held first.
  const keys = cardKeys(env);
  let hold = null;
  if (keys && (v.status === 'qualified' || v.status === 'held')) {
    const target = mine.shared ? holdTarget(v.ownCents) : holdTarget(v.amountCents, v.maxCents);
    const have = await heldSummary(env, mine.id);
    let cents = extraHold(target, have.cents);
    if (cents > 0) {
      // The saved card is only used for the browser that holds the bid's private
      // handle. Someone who only knows the email and the job has to bring a card.
      const cardId = card.id || (card.saved ? mine.card_id : null);
      if (!cardId) return [402, { verdict: 'card', message: CARD_NEEDED, token: card.saved ? mine.token : undefined }];
      if (have.failed >= MAX_CARD_FAILS) return [429, { verdict: 'limit', message: 'That card has been turned down too many times today.' }];
      if (cardId !== mine.card_id) await env.DB.prepare('UPDATE bids SET card_id = ? WHERE id = ?').bind(cardId, mine.id).run();
      // After many small raises, one hold for the whole amount replaces the pile.
      const swap = have.held >= MAX_HOLDS - 1;
      if (swap) cents = target;
      const h = await takeHold(env, keys.secret, { ...mine, card_id: cardId }, cents, now, { raise: { amountCents, maxCents, notify: Boolean(notify) }, swap });
      if (h.outcome === 'action') return [200, { verdict: 'card_action', message: CARD_CONFIRM, clientSecret: h.clientSecret, token: mine.token }];
      if (h.outcome !== 'held') return [402, { verdict: 'declined', message: h.message, token: card.saved ? mine.token : undefined }];
      hold = { id: h.holdId, intent_id: h.intentId, cents, swap, first: have.cents === 0 };
    }
  }
  return applyRaise(request, env, s, ctx, a, mine, v, notify, now, hold);
}

// Writes a raise whose money is already held (or needed none) and lets the
// auto-bids answer it.
async function applyRaise(request, env, s, ctx, a, mine, v, notify, now, hold) {
  const keys = cardKeys(env);
  const before = await topBid(env, a.day);
  const r = await env.DB.prepare(
    `UPDATE bids SET amount_cents = ?, max_cents = ?, own_cents = ?, status = ?, min_cents = ?, created_at = ?, raises = raises + 1, notify = MAX(notify, ?)
     WHERE id = ? AND amount_cents = ? AND status = ?`,
  ).bind(
    v.amountCents, v.maxCents, mine.shared ? v.amountCents - (mine.amount_cents - (mine.own_cents ?? mine.amount_cents)) : mine.own_cents ?? null,
    v.status, v.minCents === undefined ? mine.min_cents : v.minCents, now, notify ? 1 : 0, mine.id, mine.amount_cents, mine.status,
  ).run();
  if (!r.meta.changes) {
    if (hold && keys) await releaseHold(env, keys.secret, hold, now);
    return [409, { verdict: 'invalid', message: 'That bid changed while you were raising it. Nothing more was held. Try again.' }];
  }
  if (hold && hold.swap && keys) {
    const tidy = releaseBidHolds(env, keys.secret, mine.id, now, hold.id);
    if (ctx) ctx.waitUntil(tidy); else await tidy;
  }
  const note = !hold ? '' : hold.first ? HOLD_NOTE : hold.swap
    ? ` ${money(hold.cents)} is now held on your card in place of the earlier holds.`
    : ` Another ${money(hold.cents)} is held on your card.`;
  const row = { ...mine, amount_cents: v.amountCents, max_cents: v.maxCents, min_cents: v.minCents === undefined ? mine.min_cents : v.minCents };
  if (v.status !== 'qualified') return bidReply(row, v.status, v.message + note, null);
  const standing = await settleStandings(request, env, s, ctx, a, before, now);
  return bidReply(row, 'qualified', v.message + standingMessage(mine.id, v.amountCents, before, standing) + note, standing);
}

// A new bid whose hold is in place goes from 'card' to what the screen decided.
async function activateBid(request, env, s, ctx, a, bidId, message, now) {
  const bid = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(bidId).first();
  const status = bid.next_status || 'held';
  const before = status === 'qualified' ? await topBid(env, a.day) : null;
  const r = await env.DB.prepare("UPDATE bids SET status = ?, next_status = NULL WHERE id = ? AND status = 'card'").bind(status, bidId).run();
  if (!r.meta.changes) return [409, { verdict: 'invalid', message: 'That bid has already been dealt with.' }];
  if (status !== 'qualified') return bidReply(bid, status, message + HOLD_NOTE, null);
  const standing = await settleStandings(request, env, s, ctx, a, before, now);
  return bidReply(bid, 'qualified', message + standingMessage(bid.id, bid.amount_cents, before, standing) + HOLD_NOTE, standing);
}

// The page comes back here after the bidder's bank asked them to confirm the
// card. What the bank decided is read from Stripe, never taken from the page.
async function confirmBid(request, env, s, ctx, now) {
  const keys = cardKeys(env);
  const body = await request.json().catch(() => null);
  const token = body && typeof body.token === 'string' && /^[0-9a-f]{32}$/.test(body.token) ? body.token : null;
  if (!keys || !token) return [400, { verdict: 'invalid', message: 'That did not arrive in one piece. Try again.' }];
  const bid = await env.DB.prepare('SELECT * FROM bids WHERE token = ?').bind(token).first();
  const hold = bid && await env.DB.prepare("SELECT * FROM holds WHERE bid_id = ? AND pledge_id IS NULL AND state = 'action' ORDER BY id DESC LIMIT 1").bind(bid.id).first();
  if (!hold) return [404, { verdict: 'invalid', message: 'There is no card check waiting for that bid.' }];

  const seen = await readIntent(env, keys.secret, hold.intent_id);
  if (!seen.ok) return [502, { verdict: 'invalid', message: 'The card could not be checked just now. Try again in a minute.' }];
  const drop = async (verdict, message, code) => {
    await releaseHold(env, keys.secret, hold, now);
    await env.DB.prepare("UPDATE bids SET status = 'nocard', next_status = NULL WHERE id = ? AND status = 'card'").bind(bid.id).run();
    return [code, { verdict, message }];
  };
  if (seen.data.status !== 'requires_capture') return drop('declined', 'That card was not confirmed. Nothing was held. Try again, or use a different card.', 402);

  const a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(bid.day).first();
  if (a.status !== 'open' || a.closes_at <= now) return drop('closed', 'Bidding closed while your bank was checking. Nothing was held.', 409);
  const claimed = await env.DB.prepare("UPDATE holds SET state = 'held', pending = NULL WHERE id = ? AND state = 'action'").bind(hold.id).run();
  if (!claimed.meta.changes) return [409, { verdict: 'invalid', message: 'That bid has already been dealt with.' }];

  let pending = {};
  try { pending = JSON.parse(hold.pending || '{}'); } catch { /* treated as a plain new bid */ }
  if (!pending.raise) return activateBid(request, env, s, ctx, a, bid.id, pending.message || 'Your bid is in.', now);
  const v = raiseVerdict(bid, pending.raise.amountCents, pending.raise.maxCents);
  if (!v.ok || !['qualified', 'short', 'held'].includes(bid.status)) {
    await releaseHold(env, keys.secret, hold, now);
    return [400, { verdict: 'invalid', message: (v.ok ? 'That bid can no longer be raised.' : v.message) + ' Nothing more was held.' }];
  }
  const have = await heldSummary(env, bid.id);
  return applyRaise(request, env, s, ctx, a, bid, v, pending.raise.notify, now, { id: hold.id, intent_id: hold.intent_id, cents: hold.cents, swap: Boolean(pending.swap), first: have.cents === hold.cents });
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
    return raiseBid(request, env, s, ctx, a, mine, { ...raise.value, notify: body.notify === true }, now, { id: cardFrom(body), saved: true });
  }

  const checked = validateBid(body);
  if (!checked.ok) return [400, { verdict: 'invalid', message: checked.error }];
  const bid = checked.value;
  // The poster's choice: an open job is shown on the board and anyone can add money to it.
  const shared = body.open === true;
  if (shared && bid.maxCents) {
    return [400, { verdict: 'invalid', message: 'An open job cannot have a hidden maximum. Leave the maximum empty, or keep the job secret.' }];
  }

  const mine = await env.DB.prepare(
    "SELECT * FROM bids WHERE day = ? AND email = ? AND lower(task) = lower(?) AND status IN ('qualified', 'short', 'held') ORDER BY id DESC LIMIT 1",
  ).bind(a.day, bid.email, bid.task).first();
  if (mine) return raiseBid(request, env, s, ctx, a, mine, bid, now, { id: cardFrom(body), saved: false });

  // With card holds on, a bid arrives with a card. Asked for before the screen
  // runs, so the screen is never spent on a bid that cannot be held.
  const keys = cardKeys(env);
  const cardId = cardFrom(body);
  if (keys && !cardId) return [402, { verdict: 'card', message: CARD_NEEDED }];

  const ipHash = await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + '|' + a.day);
  const [byEmail, byIp, wonLately] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('qualified', 'held') THEN 1 ELSE 0 END) AS landed FROM bids WHERE email = ? AND day = ?")
      .bind(bid.email, a.day),
    env.DB.prepare('SELECT COUNT(*) AS n FROM bids WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - 3_600_000),
    env.DB.prepare("SELECT day FROM bids WHERE email = ? AND win_state = 'won' AND creator_id = ? AND day <> ? AND substr(day, 1, 10) >= ? LIMIT 1")
      .bind(bid.email, s.creatorId || 0, a.day, dayShift(roundDate(a.day), -6)),
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

  // The screen. With no key, or any failure, the bid waits for a person. The job was
  // normally checked a moment ago, before the bidder could submit: the name is new
  // here, so the screen runs again, but the costs stay the ones the bidder was shown.
  let answer = await screenBid(env, { name: bid.name, task: bid.task, model: s.model, apiKey: await aiKey(env), openaiKey: await openaiKey(env), openaiModel: s.openaiModel });
  const shown = await recentCheck(env, bid.task, now);
  if (answer && shown) answer = { ...answer, est_cost_dollars: shown.est_cost_dollars, cost_items: shown.cost_items };
  const verdict = answer
    ? applyScreen(answer, { amountCents: bid.amountCents, maxCents: bid.maxCents })
    : { status: 'held', message: HELD_MESSAGE };

  // The screen takes a few seconds; make sure the round did not close meanwhile.
  const after = Date.now();
  a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(a.day).first();
  if (a.status !== 'open' || a.closes_at <= after) return [409, { verdict: 'closed', message: 'Bidding closed while that was being checked.' }];

  // A bid that would go on the board, or wait for the owner, is held on the card
  // first. Until the bank answers it sits in status 'card', which nothing shows.
  const wantsHold = Boolean(keys) && (verdict.status === 'qualified' || verdict.status === 'held');
  const before = verdict.status === 'qualified' && !wantsHold ? await topBid(env, a.day) : null;
  const token = randomHex(16);
  const placed = verdict.amountCents ?? bid.amountCents; // an auto-bid may have lifted it to cover the job
  const inserted = await env.DB.prepare(
    `INSERT INTO bids (day, name, email, task, amount_cents, max_cents, status, est_minutes, est_cost_cents, min_cents,
                       screen_note, screened_by, ip_hash, created_at, token, notify, card_id, next_status, shared, pid, own_cents, cost_items, creator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    a.day, bid.name, bid.email, bid.task, placed, bid.maxCents, wantsHold ? 'card' : verdict.status,
    verdict.estMinutes ?? null, verdict.estCostCents ?? null, verdict.minCents ?? null,
    answer ? String(answer.reason || '').slice(0, 300) : null, answer ? 'ai' : 'none', ipHash, after, token, bid.notify ? 1 : 0,
    keys ? cardId : null, wantsHold ? verdict.status : null,
    shared ? 1 : 0, shared ? randomHex(6) : null, shared ? placed : null,
    verdict.costItems && verdict.costItems.length ? JSON.stringify(verdict.costItems) : null,
    s.creatorId || 0,
  ).run();
  const row = { id: inserted.meta.last_row_id, amount_cents: placed, max_cents: bid.maxCents, min_cents: verdict.minCents ?? null, token };

  // A refused try is kept so the limits can count it, but it gets no handle.
  if (verdict.status === 'refused') return [200, { verdict: 'refused', message: verdict.message, minCents: null }];
  if (wantsHold) {
    const h = await takeHold(
      env, keys.secret, { id: row.id, email: bid.email, day: a.day, customer_id: null, card_id: cardId },
      holdTarget(placed, bid.maxCents), after, { message: verdict.message },
    );
    if (h.outcome === 'action') return [200, { verdict: 'card_action', message: CARD_CONFIRM, clientSecret: h.clientSecret, token }];
    if (h.outcome !== 'held') {
      // Kept, like a refused try, so the limits count it. That is what stops a script trying cards here.
      await env.DB.prepare("UPDATE bids SET status = 'nocard', next_status = NULL WHERE id = ?").bind(row.id).run();
      return [402, { verdict: 'declined', message: h.message }];
    }
    return activateBid(request, env, s, ctx, a, row.id, verdict.message, after);
  }
  if (verdict.status !== 'qualified') return bidReply(row, verdict.status, verdict.message, null);
  const standing = await settleStandings(request, env, s, ctx, a, before, after);
  return bidReply(row, 'qualified', verdict.message + standingMessage(row.id, placed, before, standing), standing);
}

// ---- public: checking a job before bidding on it ------------------------------------

async function recentCheck(env, task, now) {
  const row = await env.DB.prepare('SELECT answer FROM checks WHERE task_hash = ? AND created_at > ? AND answer IS NOT NULL ORDER BY id DESC LIMIT 1')
    .bind(await sha256(taskKey(task)), now - CHECK_KEEP_MS).first();
  if (!row) return null;
  try { return JSON.parse(row.answer); } catch { return null; }
}

// Owner: the jobs people checked lately, newest first, and whether a bid followed.
async function recentChecks(env) {
  const { results } = await env.DB.prepare(
    'SELECT c.id, c.task, c.amount_cents, c.verdict, c.cost_cents, c.told, c.created_at, ' +
    'EXISTS (SELECT 1 FROM bids b WHERE lower(b.task) = lower(c.task) AND b.created_at >= c.created_at - 1000) AS bid ' +
    'FROM checks c WHERE c.task IS NOT NULL ORDER BY c.id DESC LIMIT 60',
  ).all();
  return results.map((c) => ({ id: c.id, task: c.task, amountCents: c.amount_cents, verdict: c.verdict, costCents: c.cost_cents, told: c.told, at: new Date(c.created_at).toISOString(), bid: Boolean(c.bid) }));
}

// POST /check { task, amountCents, maxCents }: is this job allowed, and what would
// it cost on top of the bid? Asked before a bid can be submitted. Nothing is placed
// or held here, and no name, email or card is involved.
async function postCheck(request, env, s, now) {
  if (!s.open) return [403, { verdict: 'closed', message: 'Bidding is not open yet.' }];
  const body = await request.json().catch(() => null);
  const task = String(body?.task ?? '').replace(/\s+/g, ' ').trim();
  if (task.length < LIMITS.taskMin) return [400, { verdict: 'invalid', message: 'Describe the job in a few more words.' }];
  if (task.length > LIMITS.taskMax) return [400, { verdict: 'invalid', message: `Keep the job to ${LIMITS.taskMax} characters.` }];
  const amountCents = body.amountCents;
  if (!Number.isInteger(amountCents) || amountCents < LIMITS.minBidCents || amountCents > LIMITS.maxCents) return [400, { verdict: 'invalid', message: `The reserve is ${money(LIMITS.minBidCents)}. Enter a bid of at least that.` }];
  const maxCents = Number.isInteger(body.maxCents) && body.maxCents >= amountCents ? body.maxCents : null;

  let answer = await recentCheck(env, task, now); // the same job asked again costs nothing
  let fresh = false;
  const ipHash = await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + '|check');
  if (!answer) {
    const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM checks WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - 3_600_000).first();
    if (seen.n >= IP_CHECKS_PER_HOUR) return [429, { verdict: 'limit', message: 'That is a lot of jobs checked from here. Try again in an hour.' }];
    // No name yet: the board name is checked when the bid itself comes in.
    answer = await screenBid(env, { name: 'Bidder', task, model: s.model, apiKey: await aiKey(env), openaiKey: await openaiKey(env), openaiModel: s.openaiModel });
    fresh = true;
  }
  const reply = checkReply(answer ? applyScreen({ ...answer, name_ok: true }, { amountCents, maxCents }) : null);
  // Kept for the owner to see: the job, the bid they had in mind and what they were told. A repeat
  // of the same job is kept too, without its answer, so it is not counted as a fresh check.
  await env.DB.prepare('INSERT INTO checks (task_hash, ip_hash, answer, created_at, task, amount_cents, verdict, cost_cents, told) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(taskKey(task)), fresh ? ipHash : null, fresh && answer ? JSON.stringify(answer) : null, now, task, amountCents, reply.verdict, reply.costCents, reply.message).run();
  return [200, reply];
}

// ---- public: adding money to an open job ------------------------------------------

// Anyone can put money behind an open job. It is held on their card, charged
// only if that job wins, and released if it does not. The job's total is what
// competes, so a crowd can outbid one big bidder.
async function postPledge(request, env, s, ctx, now) {
  if (!s.open) return [403, { verdict: 'closed', message: 'Bidding is not open yet.' }];
  const keys = cardKeys(env);
  if (!keys) return [503, { verdict: 'closed', message: 'Adding money to a job is not available yet.' }];
  const text = await request.text();
  if (text.length > MAX_BODY) return [413, { verdict: 'invalid', message: 'That is too long.' }];
  let body;
  try { body = JSON.parse(text); } catch { return [400, { verdict: 'invalid', message: 'That did not arrive in one piece. Try again.' }]; }
  const checked = validatePledge(body);
  if (!checked.ok) return [400, { verdict: 'invalid', message: checked.error }];
  const p = checked.value;
  const cardId = cardFrom(body);
  if (!cardId) return [402, { verdict: 'card', message: 'Add a card. Your money is held on it, not charged, and only charged if this job wins.' }];

  const a = await currentAuction(env, s, now);
  if (a.status !== 'open') return [409, { verdict: 'closed', message: 'Bidding is closed for today. It opens again soon.' }];
  const pid = body && typeof body.job === 'string' && /^[0-9a-f]{12}$/.test(body.job) ? body.job : '';
  const job = pid && await env.DB.prepare("SELECT * FROM bids WHERE pid = ? AND day = ? AND shared = 1 AND status = 'qualified'").bind(pid, a.day).first();
  if (!job) return [404, { verdict: 'invalid', message: 'That job is not open for money in today\'s round.' }];

  const ipHash = await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + '|' + a.day);
  const [byEmail, byIp] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM pledges WHERE email = ? AND created_at > ?').bind(p.email, now - 86_400_000),
    env.DB.prepare('SELECT COUNT(*) AS n FROM pledges WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - 3_600_000),
  ]);
  if (byEmail.results[0].n >= PLEDGES_PER_EMAIL_PER_DAY) return [429, { verdict: 'limit', message: 'That is a lot for one day. Try again tomorrow.' }];
  if (byIp.results[0].n >= IP_BIDS_PER_HOUR) return [429, { verdict: 'limit', message: 'Too many tries from here. Try again in an hour.' }];

  const token = randomHex(16);
  const made = await env.DB.prepare(
    "INSERT INTO pledges (bid_id, name, email, cents, status, token, card_id, ip_hash, created_at) VALUES (?, ?, ?, ?, 'card', ?, ?, ?, ?)",
  ).bind(job.id, p.name, p.email, p.amountCents, token, cardId, ipHash, now).run();
  const pledgeId = made.meta.last_row_id;
  const h = await takeHold(
    env, keys.secret, { id: job.id, pledge_id: pledgeId, email: p.email, day: a.day, customer_id: null, card_id: cardId }, p.amountCents, now, { pledge: true },
  );
  if (h.outcome === 'action') return [200, { verdict: 'card_action', message: CARD_CONFIRM, clientSecret: h.clientSecret, token, pledge: true }];
  if (h.outcome !== 'held') {
    await env.DB.prepare("UPDATE pledges SET status = 'nocard' WHERE id = ?").bind(pledgeId).run();
    return [402, { verdict: 'declined', message: h.message }];
  }
  return activatePledge(request, env, s, ctx, a, pledgeId, { id: h.holdId, intent_id: h.intentId }, now);
}

// A pledge whose money is held joins the job's total.
async function activatePledge(request, env, s, ctx, a, pledgeId, hold, now) {
  const keys = cardKeys(env);
  const pledge = await env.DB.prepare('SELECT * FROM pledges WHERE id = ?').bind(pledgeId).first();
  const before = await topBid(env, a.day);
  const fresh = await env.DB.prepare('SELECT status, closes_at FROM auctions WHERE day = ?').bind(a.day).first();
  const joined = fresh.status === 'open' && fresh.closes_at > now
    ? await env.DB.prepare("UPDATE bids SET amount_cents = amount_cents + ?, backers = backers + 1 WHERE id = ? AND status = 'qualified' AND shared = 1")
      .bind(pledge.cents, pledge.bid_id).run()
    : { meta: { changes: 0 } };
  if (!joined.meta.changes) {
    if (keys) await releaseHold(env, keys.secret, hold, now);
    await env.DB.prepare("UPDATE pledges SET status = 'released' WHERE id = ?").bind(pledgeId).run();
    return [409, { verdict: 'closed', message: 'That job closed before your money went in. Nothing was held.' }];
  }
  await env.DB.prepare("UPDATE pledges SET status = 'active' WHERE id = ?").bind(pledgeId).run();
  const standing = await settleStandings(request, env, s, ctx, a, before, now);
  const total = standing.amounts.get(pledge.bid_id);
  const leading = standing.leaderId === pledge.bid_id;
  return [200, {
    verdict: 'pledged', token: pledge.token, amountCents: pledge.cents, totalCents: total, leading,
    message: `You added ${money(pledge.cents)}. This job is now at ${money(total)}` +
      (leading ? ' and in the lead.' : `. The high bid is ${money(standing.highCents)}.`) +
      ' Your money is held on your card, not charged. It is only charged if this job wins.',
  }];
}

async function confirmPledge(request, env, s, ctx, now) {
  const keys = cardKeys(env);
  const body = await request.json().catch(() => null);
  const token = body && typeof body.token === 'string' && /^[0-9a-f]{32}$/.test(body.token) ? body.token : null;
  if (!keys || !token) return [400, { verdict: 'invalid', message: 'That did not arrive in one piece. Try again.' }];
  const pledge = await env.DB.prepare('SELECT * FROM pledges WHERE token = ?').bind(token).first();
  const hold = pledge && await env.DB.prepare("SELECT * FROM holds WHERE pledge_id = ? AND state = 'action' ORDER BY id DESC LIMIT 1").bind(pledge.id).first();
  if (!hold) return [404, { verdict: 'invalid', message: 'There is no card check waiting for that.' }];
  const seen = await readIntent(env, keys.secret, hold.intent_id);
  if (!seen.ok) return [502, { verdict: 'invalid', message: 'The card could not be checked just now. Try again in a minute.' }];
  if (seen.data.status !== 'requires_capture') {
    await releaseHold(env, keys.secret, hold, now);
    await env.DB.prepare("UPDATE pledges SET status = 'nocard' WHERE id = ? AND status = 'card'").bind(pledge.id).run();
    return [402, { verdict: 'declined', message: 'That card was not confirmed. Nothing was held. Try again, or use a different card.' }];
  }
  const claimed = await env.DB.prepare("UPDATE holds SET state = 'held', pending = NULL WHERE id = ? AND state = 'action'").bind(hold.id).run();
  if (!claimed.meta.changes) return [409, { verdict: 'invalid', message: 'That has already been dealt with.' }];
  const job = await env.DB.prepare('SELECT day FROM bids WHERE id = ?').bind(pledge.bid_id).first();
  const a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(job.day).first();
  return activatePledge(request, env, s, ctx, a, pledge.id, hold, now);
}

// ---- public: how this browser's bids are standing ---------------------------------

async function postMine(request, env, s) {
  const body = await request.json().catch(() => null);
  const tokens = Array.isArray(body?.tokens) ? body.tokens.filter((t) => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t)).slice(0, 10) : [];
  const out = [];
  for (const token of tokens) {
    const bid = await env.DB.prepare('SELECT * FROM bids WHERE token = ?').bind(token).first();
    if (bid && roundCreator(bid.day) !== (s.creatorId || 0)) continue; // placed on another page
    if (!bid) {
      // Not a bid: money this browser added to someone's open job.
      const pledge = await env.DB.prepare("SELECT * FROM pledges WHERE token = ? AND status IN ('active', 'paid', 'released', 'failed', 'refunded')").bind(token).first();
      if (!pledge) continue;
      const job = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(pledge.bid_id).first();
      if (roundCreator(job.day) !== (s.creatorId || 0)) continue;
      const round = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(job.day).first();
      const lead = await topBid(env, job.day);
      const live = round.status === 'open';
      out.push({
        token, kind: 'pledge', day: job.day, open: live, jobId: job.pid, task: job.task,
        standing: live ? (lead && lead.id === job.id ? 'leading' : 'outbid') : (job.win_state === 'won' && pledge.status !== 'failed' ? 'won' : 'lost'),
        amountCents: pledge.cents, totalCents: job.amount_cents, highCents: lead ? lead.amount_cents : 0,
        closesAt: new Date(round.closes_at).toISOString(),
      });
      continue;
    }
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
      shared: Boolean(bid.shared), backers: bid.backers, ownCents: bid.own_cents ?? bid.amount_cents,
      amountCents: bid.amount_cents, maxCents: bid.max_cents ?? null, minCents: bid.min_cents ?? null,
      approvedMinutes: bid.screened_by === 'owner' ? bid.est_minutes : null,
      costCents: bid.status === 'qualified' ? costCents(bid) || null : null, // what the job costs to do, on top of the bid
      costItems: bid.status === 'qualified' ? readCostItems(bid.cost_items) : null, // what that is made of
      costOnCard: Boolean(bid.customer_id && bid.card_id), // charged with the bid, or collected by hand
      highCents: top ? top.amount_cents : 0,
      closesAt: new Date(a.closes_at).toISOString(),
    });
  }
  return [200, { bids: out }];
}

async function stopEmails(env, token, account) {
  let line;
  if (account !== null) {
    line = (await stopAlerts(env, account)) ? 'Alert emails are off for your account. You can turn them back on from your account on TorchHive.' : 'That link is not valid.';
  } else {
    const ok = typeof token === 'string' && /^[0-9a-f]{32}$/.test(token);
    if (ok) await env.DB.prepare('UPDATE bids SET notify = 0 WHERE token = ?').bind(token).run();
    line = ok ? 'You will not get any more emails about this bid.' : 'That link is not valid.';
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>TorchHive</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0C0D10;color:#F5F5F6;font:18px/1.5 system-ui,sans-serif;text-align:center;padding:24px"><p>${line}</p>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

// ---- owner ------------------------------------------------------------------------

function adminBid(b, s, showJobs, cards = null) {
  // No maximum here on purpose: the owner should not know how high a bidder will go.
  return {
    id: b.id, name: b.name, amountCents: b.amount_cents, status: b.status, winState: b.win_state,
    covers: b.screened_by === 'owner' && b.est_minutes > 0 ? 'Agreed: ' + describeMinutes(b.est_minutes) : timeAllowance(b.amount_cents),
    approvedMinutes: b.screened_by === 'owner' ? b.est_minutes : null,
    maxMinutes: coveredMinutes(b.amount_cents),
    estMinutes: b.est_minutes, estCostCents: b.est_cost_cents, minCents: b.min_cents,
    note: b.screen_note, screenedBy: b.screened_by, placedAt: new Date(b.created_at).toISOString(),
    task: showJobs ? b.task : null,
    // Whether a card is holding this bid. Never how much: that would give away the maximum.
    card: cards ? (cards.get(b.id) ? 'held' : 'none') : null,
    payState: b.pay_state ?? null, paidCents: b.paid_cents ?? null, costCents: costCents(b),
    shared: Boolean(b.shared), backers: b.backers, ownCents: b.own_cents ?? b.amount_cents,
  };
}

async function adminState(env, s, now, showJobs) {
  await settleDue(env, now);
  const auction = s.open
    ? await currentAuction(env, s, now)
    : await env.DB.prepare("SELECT * FROM auctions WHERE status = 'open' AND creator_id = ? ORDER BY closes_at LIMIT 1").bind(s.creatorId || 0).first();
  const bids = auction
    ? (await env.DB.prepare('SELECT * FROM bids WHERE day = ? ORDER BY amount_cents DESC, created_at ASC, id ASC').bind(auction.day).all()).results
    : [];
  const cardsOn = Boolean(cardKeys(env));
  const cards = new Map();
  if (cardsOn && auction) {
    const { results } = await env.DB.prepare(
      "SELECT h.bid_id AS id FROM holds h JOIN bids b ON b.id = h.bid_id WHERE b.day = ? AND h.state = 'held' GROUP BY h.bid_id",
    ).bind(auction.day).all();
    for (const r of results) cards.set(r.id, true);
  }
  const last = await env.DB.prepare("SELECT * FROM auctions WHERE status = 'closed' AND creator_id = ? ORDER BY closed_at DESC LIMIT 1").bind(s.creatorId || 0).first();
  let previous = null;
  if (last) {
    const w = last.winner_bid_id ? await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(last.winner_bid_id).first() : null;
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM bids WHERE day = ? AND status = 'qualified' AND win_state IS NULL").bind(last.day).first();
    previous = {
      day: last.day,
      closedAt: new Date(last.closed_at).toISOString(),
      othersWaiting: left.n,
      moneySettled: last.money_state === 'done',
      // The winner's email is shown so the owner can reach them. Nobody else's is.
      winner: w ? { ...adminBid(w, s, showJobs), email: w.email, free: w.amount_cents < LIMITS.freeUnderCents } : null,
    };
  }
  return {
    open: s.open || Boolean(s.offDay),
    schedule: s.schedule || null,
    nextOpensAt: s.nextOpensAt ? new Date(s.nextOpensAt).toISOString() : null,
    screen: (await openaiKey(env)) || (await aiKey(env)) ? 'ai' : 'manual',
    email: s.mailFrom && (await mailKey(env)) ? 'on' : 'off',
    cards: cardsOn ? 'on' : 'off',
    settings: { ...TIME_POLICY, timeZone: s.tz, closeHour: s.closeHour, maxBidsPerDay: s.maxPerDay },
    auction: auction ? { day: auction.day, status: auction.status, closesAt: new Date(auction.closes_at).toISOString() } : null,
    bids: bids.map((b) => adminBid(b, s, showJobs, cardsOn ? cards : null)),
    comments: auction ? await recentComments(env, auction.day) : [],
    live: await liveState(env),
    games: await gamesSetting(env, now),
    arena: await arenaSetting(env),
    chat: await recentChat(env),
    members: await listMembers(env),
    checks: await recentChecks(env),
    creators: await adminCreators(env),
    previous,
  };
}

// Owner: take a bid off the round that is open, whatever its state. Its hold, and the
// holds of anyone who added money to it, go back to the cards at once.
async function adminRemove(request, env, s, ctx, id, now) {
  const bid = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(id).first();
  if (!bid) return [404, { message: 'No such bid.' }];
  const a = await env.DB.prepare('SELECT * FROM auctions WHERE day = ?').bind(bid.day).first();
  if (!a || a.status !== 'open') return [409, { message: 'That round has closed. Use Pass on the winner instead.' }];
  if (!['held', 'qualified', 'card'].includes(bid.status)) return [409, { message: 'That bid is already off the board.' }];
  const before = await topBid(env, a.day);
  await env.DB.prepare("UPDATE bids SET status = 'refused', next_status = NULL, screened_by = 'owner', decided_at = ? WHERE id = ?").bind(now, id).run();
  const keys = cardKeys(env);
  if (keys) await releaseBidHolds(env, keys.secret, id, now);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM holds WHERE bid_id = ? AND state IN ('held', 'action')").bind(id).first();
  await env.DB.prepare("UPDATE pledges SET status = 'released' WHERE bid_id = ? AND status IN ('active', 'card')").bind(id).run();
  await settleStandings(request, env, s, ctx, a, before, now);
  return [200, { status: 'removed', released: !left.n, ...(left.n ? { message: 'The bid is off the board, but the card company did not confirm the hold was released. It is tried again when the round closes.' } : {}) }];
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
    const keys = cardKeys(env);
    if (keys) await releaseBidHolds(env, keys.secret, id, now); // a refused bid gets its hold back at once
    return [200, { status: 'refused' }];
  }
  if (body.decision !== 'approve') return [400, { message: 'Send decision: approve or refuse.' }];
  const minutes = Number(body.estMinutes);
  const approval = approveDuration(bid.amount_cents, minutes);
  if (!approval.ok) return [400, { message: approval.message }];
  const costCents = Number.isFinite(Number(body.costDollars)) ? Math.max(0, Math.round(Number(body.costDollars) * 100)) : null;
  if (costCents !== null && costCents > LIMITS.maxCostCents) {
    return [400, { message: `Costs can be at most ${money(LIMITS.maxCostCents)}. Check the figure: it is charged to the winner's card on top of the bid.` }];
  }
  const before = await topBid(env, a.day);
  await env.DB.prepare(
    "UPDATE bids SET status = 'qualified', screened_by = 'owner', decided_at = ?, est_minutes = ?, est_cost_cents = ?, min_cents = ?, cost_items = CASE WHEN ?3 IS est_cost_cents THEN cost_items ELSE NULL END WHERE id = ? AND status = 'held'",
  ).bind(now, approval.minutes, costCents, approval.minCents, id).run();
  await settleStandings(request, env, s, ctx, a, before, now);
  return [200, { status: 'qualified' }];
}

// The creator's own view of their page's round: the bids (with the jobs), which are
// waiting for them, and the last winner with the email to reach them at.
async function creatorRound(request, env, s, now) {
  const mine = await ownCreator(request, env, s, now);
  if (!mine.scope) return [mine.status, mine.body];
  const st = await adminState(env, mine.scope, now, true);
  return [200, { open: st.open, cards: st.cards, screen: st.screen, auction: st.auction, bids: st.bids, previous: st.previous, settings: st.settings }];
}

async function creatorDecide(request, env, s, ctx, id, now) {
  const mine = await ownCreator(request, env, s, now);
  if (!mine.scope) return [mine.status, mine.body];
  const bid = await env.DB.prepare('SELECT creator_id FROM bids WHERE id = ?').bind(id).first();
  if (!bid || bid.creator_id !== mine.scope.creatorId) return [404, { message: 'No such bid on your page.' }];
  return adminDecide(request, env, mine.scope, ctx, id, now);
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
  // Whatever put the header on may have added a "Bearer " in front; the key is what follows.
  const header = (name) => (request.headers.get(name) || '').replace(/^Bearer\s+/i, '').trim();
  const admin = header('X-Admin-Key');
  if (admin) {
    if (admin.length < 16) refused.push('admin key (use at least 16 characters)');
    // The length is reported so the owner can check it against their copy.
    else { await storeAdminKey(env, admin, now); stored.push(`admin key (${admin.length} characters)`); }
  }
  for (const [name, setting, label] of [['X-Mail-Key', 'mail_key', 'email key'], ['X-Ai-Key', 'ai_key', 'AI key']]) {
    const value = header(name);
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
  // Two ways in: the admin key, or being signed in as the owner's own account.
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const signedIn = await sessionUser(request, env, now);
  if (!(signedIn && isAdminEmail(env, signedIn.email))) {
    if (!(await adminKeyIsSet(env))) return [503, { message: 'The admin key has not been set yet.' }];
    if (!(await adminKeyMatches(env, given))) return [401, { message: 'Wrong or missing admin key.' }];
  }
  const url = new URL(request.url);
  let m;
  if (request.method === 'GET' && path === '/admin/api/report') return [200, await report(env, s, now, url.searchParams)];
  if (request.method === 'GET' && path === '/admin/api/now') return [200, await liveNow(env, now)];
  if (request.method === 'GET' && path === '/admin/api/state') return [200, await adminState(env, s, now, url.searchParams.get('jobs') === '1')];
  if (request.method === 'POST' && (m = /^\/admin\/api\/bids\/(\d+)\/decide$/.exec(path))) return adminDecide(request, env, s, ctx, Number(m[1]), now);
  if (request.method === 'POST' && (m = /^\/admin\/api\/bids\/(\d+)\/remove$/.exec(path))) return adminRemove(request, env, s, ctx, Number(m[1]), now);
  if (request.method === 'POST' && (m = /^\/admin\/api\/creators\/(\d+)\/(approve|pause)$/.exec(path))) return decideCreator(env, s, Number(m[1]), m[2], now);
  if (request.method === 'POST' && path === '/admin/api/overlay/test') return sendOverlayTest(env, s, now);
  if (request.method === 'POST' && path === '/admin/api/schedule') return adminSchedule(request, env, s, now);
  if (request.method === 'POST' && path === '/admin/api/games') return setGames(env, await request.json().catch(() => null), now);
  if (request.method === 'POST' && path === '/admin/api/arena') return setArena(env, await request.json().catch(() => null), now);
  if (request.method === 'POST' && path === '/admin/api/live') {
    const body = await request.json().catch(() => null);
    const [status, out] = await setLive(env, body, now);
    // "Close bidding in N minutes": the round's end is moved to a time he can say out loud on the stream.
    // Or "close bidding at 8:15": the owner page sends that moment as closeAt.
    const mins = Number(body?.closeInMinutes);
    const at = typeof body?.closeAt === 'string' ? Date.parse(body.closeAt) : NaN;
    if (status === 200 && body?.on === true && (Number.isFinite(at) || (Number.isFinite(mins) && mins > 0))) {
      if (!s.open) return [200, { ...out, note: 'Bidding is not open, so there was no round to set a closing time on.' }];
      if (Number.isFinite(at) ? (at < now + 60_000 || at > now + 24 * 3_600_000) : (mins < 1 || mins > 720)) {
        return [400, { message: 'Pick a closing time between a minute from now and 24 hours from now.' }];
      }
      const a = await currentAuction(env, s, now);
      const closesAt = Number.isFinite(at) ? at : now + Math.round(mins * 60_000);
      await env.DB.prepare("UPDATE auctions SET closes_at = ?, noticed = noticed & ~1 WHERE day = ? AND status = 'open'").bind(closesAt, a.day).run();
      return [200, { ...out, closesAt: new Date(closesAt).toISOString() }];
    }
    return [status, out];
  }
  if (request.method === 'POST' && (m = /^\/admin\/api\/chat\/(\d+)\/(remove|block)$/.exec(path))) return (m[2] === 'remove' ? removeChat : blockChatter)(env, Number(m[1]));
  if (request.method === 'POST' && (m = /^\/admin\/api\/comments\/(\d+)\/(remove|restore|block)$/.exec(path))) {
    return (m[2] === 'remove' ? removeComment : m[2] === 'restore' ? restoreComment : blockCommenter)(env, Number(m[1]));
  }
  if (request.method === 'POST' && (m = /^\/admin\/api\/auctions\/(\d{4}-\d{2}-\d{2})\/close$/.exec(path))) {
    if (!(await closeAuction(env, m[1], now))) return [409, { message: 'That round is not open.' }];
    // Charge the winner and release the other holds now, so the owner sees the result.
    const settled = await settleMoney(env, cardKeys(env)?.secret ?? null, m[1], now, chooseWinner);
    return [200, { status: 'closed', moneySettled: settled }];
  }
  if (request.method === 'POST' && (m = /^\/admin\/api\/auctions\/(\d{4}-\d{2}-\d{2})\/pass$/.exec(path))) {
    // The winner did not pay in time, or the owner declined the job: the next bid wins.
    const a = await env.DB.prepare("SELECT * FROM auctions WHERE day = ? AND status = 'closed'").bind(m[1]).first();
    if (!a || !a.winner_bid_id) return [409, { message: 'There is no winner to pass on.' }];
    // One at a time. A second press, or the timer settling this round, waits its turn:
    // two of these running together would refund one winner and charge two others.
    const claim = await env.DB.prepare(
      "UPDATE auctions SET money_state = 'settling', money_at = ? WHERE day = ? AND status = 'closed' AND (money_state IS NULL OR money_state = 'done' OR (money_state = 'settling' AND money_at < ?))",
    ).bind(now, a.day, now - SETTLE_RETRY_MS).run();
    if (!claim.meta.changes) return [409, { message: 'This round is being worked on right now. Give it a minute, then look again before pressing.' }];
    let after = a.money_state === 'done' ? 'done' : null; // what the round goes back to; null hands the rest to the timer
    try {
      const keys = cardKeys(env);
      const passed = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(a.winner_bid_id).first();
      // Whatever the passed-over winner was charged goes back to their card.
      const undone = keys ? await undoCharge(env, keys.secret, passed, now) : { back: 0, more: false };
      // A job with many backers is refunded a batch at a time: press again until it is all back.
      if (undone.more) return [200, { status: 'refunding', refundedCents: undone.back, message: 'Still refunding the backers. Press again in a moment.' }];
      await env.DB.prepare("UPDATE bids SET win_state = 'passed' WHERE id = ?").bind(a.winner_bid_id).run();
      const next = await chooseWinner(env, a.day);
      let payState = null;
      if (next && keys) {
        const row = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(next.id).first();
        payState = await chargeWinner(env, keys.secret, row, now);
        // The card company did not answer: the timer finishes the charge, nobody is charged twice.
        if (payState === 'wait') after = null;
        // Its backers are charged here and, if there are many, by the timer over the next minutes.
        else if (payState !== 'failed' && (await chargeBackers(env, keys.secret, row, now))) after = null;
      }
      return [200, { status: next ? 'next' : 'none-left', refundedCents: undone.back, payState, ...(payState === 'wait' ? { message: 'The card company did not answer. The charge is being tried again every minute; do not press again.' } : {}) }];
    } finally {
      await env.DB.prepare('UPDATE auctions SET money_state = ?, money_at = ? WHERE day = ?').bind(after, now, a.day).run();
    }
  }
  return [404, { message: 'Not found.' }];
}

// ---- entry ------------------------------------------------------------------------

const PUBLIC = new Set(['/overlay/test', '/overlay/state', '/board', '/live', '/chat', '/check', '/bids', '/bids/confirm', '/pledges', '/pledges/confirm', '/mine', '/auth/start', '/auth/finish', '/auth/end', '/auth/google', '/me', '/me/activity', '/me/seen', '/me/delete', '/push/sub', '/push/unsub', '/push/next', '/votes', '/comments', '/comments/report', '/a', '/games', '/games/pick', '/arena/join']);
// Signing in, votes and comments: [method, path] to handler. Each answers [status, body].
const SOCIAL = {
  'POST /auth/start': (request, env, s, now) => authStart(request, env, s, now),
  'POST /auth/finish': (request, env, s, now) => authFinish(request, env, now),
  'POST /auth/end': (request, env, s, now) => authEnd(request, env, now),
  'POST /auth/google': (request, env, s, now) => authGoogle(request, env, now),
  'GET /me': (request, env, s, now) => getMe(request, env, now),
  'POST /me': (request, env, s, now) => postMe(request, env, now),
  'GET /me/activity': (request, env, s, now) => getActivity(request, env, now),
  'POST /me/seen': (request, env, s, now) => postSeen(request, env, now),
  'POST /me/delete': (request, env, s, now) => deleteAccount(request, env, now),
  'POST /push/sub': async (request, env, s, now) => {
    const user = await sessionUser(request, env, now);
    return user ? pushSubscribe(env, user, await request.json().catch(() => null), now) : [401, { message: 'Sign in first.' }];
  },
  'POST /push/unsub': async (request, env) => pushUnsubscribe(env, await request.json().catch(() => null)),
  'POST /push/next': async (request, env) => pushNext(env, await request.json().catch(() => null)),
  'POST /votes': (request, env, s, now) => (s.open ? postVote(request, env, now) : [403, { message: 'Bidding is not open yet.' }]),
  'GET /live': (request, env) => getLive(env, new URL(request.url)),
  // The free games on the stream: the round on now, and a pick for it. No account is needed.
  'GET /games': async (request, env, s, now) => [200, await gamesState(env, now, player(await sessionUser(request, env, now), new URL(request.url).searchParams.get('g')))],
  // Hive Arena: a ticket to open the game's socket with. The bees the service flies take the day's bidders' names.
  'POST /arena/join': async (request, env, s, now) => {
    const body = await request.json().catch(() => null), user = await sessionUser(request, env, now);
    const board = await getBoard(env, s, now).catch(() => null);
    const bidders = [...new Set(((board && board.bids) || []).map((b) => b.name).filter(Boolean))].slice(0, 12);
    return arenaJoin(env, player(user, body?.g), Boolean(user && user.email && isAdminEmail(env, user.email)), bidders, request.headers.get('CF-Connecting-IP') || '');
  },
  'POST /games/pick': async (request, env, s, now) => {
    const body = await request.json().catch(() => null);
    return postPick(env, player(await sessionUser(request, env, now), body?.g), body, now);
  },
  'POST /chat': async (request, env, s, now) => {
    const body = await request.json().catch(() => null);
    const who = await namedUser(request, env, body?.name, now);
    return who.user ? postChat(env, who.user, body, now) : [who.status, who.body];
  },
  'GET /comments': (request, env) => getComments(env, new URL(request.url)),
  'POST /comments/report': (request, env, s, now) => reportComment(request, env, now),
  'POST /comments': (request, env, s, now) => (s.open ? postComment(request, env, now, s.siteUrl, s.apiUrl) : [403, { message: 'Bidding is not open yet.' }]),
};

// Everything the public can ask for. `s` is the site's own settings, or a creator's
// page scope: the same handlers, working on that page's round.
async function publicRoute(request, env, ctx, s, url, path, now, cors) {
    if (path === '/a' && request.method === 'POST') {
      await record(request, env, s, now);
      return new Response(null, { status: 204, headers: cors });
    }
    if (path === '/board' && request.method === 'GET') return json(await getBoard(env, s, now), 200, cors);
    if (path === '/overlay/test' && request.method === 'GET') return json({ test: await overlayTest(env, now) }, 200, cors);
    // Everything the stream overlay shows, in one answer: it asks once every few seconds, not three times.
    if (path === '/overlay/state' && request.method === 'GET') {
      const [, live] = await getLive(env, url);
      return json({ board: await getBoard(env, s, now), test: await overlayTest(env, now), live, games: await gamesState(env, now, null) }, 200, cors);
    }
    // Creator pages: the list, one page, following it, and a person's own page.
    let cm, dm;
    if (request.method !== 'OPTIONS' && (path === '/creators' || path === '/me/creator' || path.startsWith('/me/creator/') || (cm = /^\/creators\/([a-z0-9-]{3,24})(\/follow)?$/i.exec(path)))) {
      const out = path === '/creators' && request.method === 'GET' ? await listCreators(env)
        : path === '/me/creator' && request.method === 'GET' ? await myCreator(request, env, now)
        : path === '/me/creator' && request.method === 'POST' ? await saveCreator(request, env, s, now)
        : path === '/me/creator/payouts' && request.method === 'POST' ? await startPayouts(request, env, s, now)
        : path === '/me/creator/bidding' && request.method === 'POST' ? await setBidding(request, env, s, now)
        : path === '/me/creator/round' && request.method === 'GET' ? await creatorRound(request, env, s, now)
        : (dm = /^\/me\/creator\/bids\/(\d+)\/decide$/.exec(path)) && request.method === 'POST' ? await creatorDecide(request, env, s, ctx, Number(dm[1]), now)
        : cm && !cm[2] && request.method === 'GET' ? await getCreator(request, env, cm[1], now)
        : cm && cm[2] && request.method === 'POST' ? await followCreator(request, env, cm[1], now)
        : [405, { message: 'Method not allowed.' }];
      return json(out[1], out[0], cors);
    }
    const social = SOCIAL[request.method + ' ' + path];
    if (social) {
      const [status, body] = await social(request, env, s, now);
      return json(body, status, cors);
    }
    if (path === '/check' && request.method === 'POST') {
      const [status, body] = await postCheck(request, env, s, now);
      return json(body, status, cors);
    }
    if (path === '/bids' && request.method === 'POST') {
      const [status, body] = await postBid(request, env, s, ctx, now);
      return json(body, status, cors);
    }
    if (path === '/bids/confirm' && request.method === 'POST') {
      const [status, body] = await confirmBid(request, env, s, ctx, now);
      return json(body, status, cors);
    }
    if (path === '/pledges' && request.method === 'POST') {
      const [status, body] = await postPledge(request, env, s, ctx, now);
      return json(body, status, cors);
    }
    if (path === '/pledges/confirm' && request.method === 'POST') {
      const [status, body] = await confirmPledge(request, env, s, ctx, now);
      return json(body, status, cors);
    }
    if (path === '/mine' && request.method === 'POST') {
      const [status, body] = await postMine(request, env, s);
      return json(body, status, cors);
    }
    return json({ message: 'Method not allowed.' }, 405, cors);
}

export default {
  async fetch(request, env, ctx) {
    const s = settings(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const now = Date.now();
    const cors = corsHeaders(request, s);

    try {
      if (path === '/arena/ws') return arenaSocket(env, request);
      if (PUBLIC.has(path) || path === '/creators' || path.startsWith('/creators/') || path === '/me/creator' || path.startsWith('/me/creator/')) {
        if (request.method === 'OPTIONS') {
          return new Response(null, {
            status: 204,
            headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400' },
          });
        }
        // "?c=<name>" puts the request on that creator's page: its own round, open or not on its own.
        const onPage = request.method !== 'OPTIONS' ? url.searchParams.get('c') : null;
        if (onPage) {
          const scoped = await creatorScope(env, s, onPage);
          if (!scoped) return json({ verdict: 'invalid', message: 'There is no page at this address.' }, 404, cors);
          return publicRoute(request, env, ctx, scoped, url, path, now, cors);
        }
        return publicRoute(request, env, ctx, await applySchedule(env, s, now), url, path, now, cors);
      }
      if (path === '/stop' && request.method === 'GET') return stopEmails(env, url.searchParams.get('t'), url.searchParams.get('u'));
      if ((path === '/admin' || path === '/reports') && request.method === 'GET') {
        return new Response(path === '/reports' ? REPORTS_HTML : ADMIN_HTML, {
          headers: {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
          },
        });
      }
      if (path.startsWith('/admin/api/')) {
        const [status, body] = await adminRoute(request, env, await applySchedule(env, s, now), ctx, path, now);
        return json(body, status);
      }
      if (path === '/') return json({ service: 'dgf-bids', open: s.open });
      return json({ message: 'Not found.' }, 404);
    } catch (error) {
      console.error('[BIDS] unhandled', error && error.stack ? error.stack : String(error));
      return json({ message: 'Something went wrong on our side. Try again in a minute.' }, 500, cors);
    }
  },

  // Every minute: close a round that has run past its time, then charge the
  // winner's card and release every other hold. One round's money per run.
  async scheduled(event, env, ctx) {
    const now = Date.now();
    const s = settings(env);
    try {
      await settleDue(env, now);
      await applySchedule(env, s, now);
      const key = cardKeys(env)?.secret ?? null;
      for (const day of await unsettledDays(env, now)) await settleMoney(env, key, day, now, chooseWinner);
      if (key) await sweepStale(env, key, now);
      if (key) await sweepOwed(env, key, now); // refunds and releases that did not go through the first time
      if (key) await payCreators(env, key, now);
      await roundNotices(env, s, now, key);
      await sendNotices(env, s, now);
      if (new Date(now).getUTCMinutes() === 7) {
        await tidy(env, now); // hourly: old addresses cleared, old rows dropped
        await env.DB.prepare('DELETE FROM checks WHERE created_at < ?').bind(now - 30 * 86_400_000).run(); // what people asked for, kept a month for the owner
      }
    } catch (error) {
      console.error('[BIDS] timer', error && error.stack ? error.stack : String(error));
    }
  },
};
