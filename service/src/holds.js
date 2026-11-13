// Card holds in the database, and the money side of closing a round.
//
// A bid's holds add up to at least what the bid could end up at. When the round
// closes, the winner's holds are charged for the winning amount and every other
// hold is released. Each step records what happened before moving on, and every
// charge carries an idempotency key, so a run that stops half way can be run again.
import { LIMITS, captureSlice } from './rules.js';
import { randomHex } from './store.js';
import { createHold, chargeSaved, readIntent, cancelIntent, captureIntent, refundIntent } from './cards.js';

export const MAX_CARD_FAILS = 5; // declined tries on one bid before it stops asking the bank
export const MAX_HOLDS = 8; // holds on one bid before they are swapped for a single one
const STALE_ACTION_MS = 30 * 60_000; // a bank check nobody finished
const SETTLE_RETRY_MS = 2 * 60_000; // a settling run older than this is taken to have stopped
const OPS_PER_RUN = 12; // card calls in one run, to stay inside the Worker's per-request limits

export async function heldSummary(env, bidId) {
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN state = 'held' THEN cents ELSE 0 END), 0) AS cents, " +
    "SUM(CASE WHEN state = 'held' THEN 1 ELSE 0 END) AS held, SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed " +
    'FROM holds WHERE bid_id = ?',
  ).bind(bidId).first();
  return { cents: r.cents || 0, held: r.held || 0, failed: r.failed || 0 };
}

// Asks the bank to hold `cents` for this bid and records the answer. `bid` needs
// id, email, day, customer_id and card_id. `pending` is what to do with the bid
// if the bank first wants the cardholder to confirm.
export async function takeHold(env, key, bid, cents, now, pending = null) {
  const r = await createHold(env, key, {
    customerId: bid.customer_id, email: bid.email, cardId: bid.card_id, cents, day: bid.day, bidId: bid.id,
  });
  if (r.customerId && r.customerId !== bid.customer_id) {
    await env.DB.prepare('UPDATE bids SET customer_id = ? WHERE id = ?').bind(r.customerId, bid.id).run();
  }
  const state = r.outcome === 'held' ? 'held' : r.outcome === 'action' ? 'action' : 'failed';
  if (r.outcome !== 'error') {
    const made = await env.DB.prepare(
      'INSERT INTO holds (bid_id, intent_id, cents, state, pending, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(bid.id, r.intentId || 'none_' + randomHex(8), cents, state, state === 'action' && pending ? JSON.stringify(pending) : null, now).run();
    r.holdId = made.meta.last_row_id;
  }
  return r;
}

// Gives a hold back to the card. True when it is gone (or was never there).
export async function releaseHold(env, key, hold, now) {
  if (hold.intent_id.startsWith('none_')) return mark(env, hold.id, 'released', now);
  const r = await cancelIntent(env, key, hold.intent_id);
  if (r.ok) return mark(env, hold.id, 'released', now);
  const seen = await readIntent(env, key, hold.intent_id);
  if (seen.ok && seen.data.status === 'canceled') return mark(env, hold.id, 'released', now);
  if (seen.ok && seen.data.status === 'succeeded') await mark(env, hold.id, 'captured', now, seen.data.amount_received);
  return false; // left as it is; the next run tries again
}

async function mark(env, holdId, state, now, capturedCents = null) {
  await env.DB.prepare('UPDATE holds SET state = ?, settled_at = ?, captured_cents = COALESCE(?, captured_cents) WHERE id = ?')
    .bind(state, now, capturedCents, holdId).run();
  return true;
}

export async function releaseBidHolds(env, key, bidId, now, exceptHoldId = 0) {
  const { results } = await env.DB.prepare("SELECT * FROM holds WHERE bid_id = ? AND state IN ('held', 'action') AND id <> ?")
    .bind(bidId, exceptHoldId).all();
  for (const h of results) await releaseHold(env, key, h, now);
}

async function captureHold(env, key, hold, cents, now) {
  const r = await captureIntent(env, key, hold.intent_id, cents, 'dgf-cap-' + hold.id);
  if (r.ok && r.data.status === 'succeeded') {
    await mark(env, hold.id, 'captured', now, r.data.amount_received ?? cents);
    return r.data.amount_received ?? cents;
  }
  const seen = await readIntent(env, key, hold.intent_id);
  if (seen.ok && seen.data.status === 'succeeded') {
    await mark(env, hold.id, 'captured', now, seen.data.amount_received);
    return seen.data.amount_received;
  }
  await mark(env, hold.id, 'failed', now);
  return 0;
}

// Gives back whatever a bid was charged and releases what it still holds.
// Returns how many cents went back.
export async function undoCharge(env, key, bid, now) {
  const { results } = await env.DB.prepare("SELECT * FROM holds WHERE bid_id = ? AND state IN ('held', 'action', 'captured')").bind(bid.id).all();
  let back = 0;
  for (const h of results) {
    if (h.state !== 'captured') { await releaseHold(env, key, h, now); continue; }
    const r = await refundIntent(env, key, h.intent_id, 'dgf-ref-' + h.id);
    if (r.ok) { await mark(env, h.id, 'refunded', now); back += h.captured_cents || 0; }
  }
  if (back) await env.DB.prepare("UPDATE bids SET pay_state = 'refunded' WHERE id = ?").bind(bid.id).run();
  return back;
}

// Collects the winning bid. Charges its holds for the winning amount, releases
// what is left over, and falls back to charging the saved card if the holds are
// gone. Sets bids.pay_state and returns it:
//   paid    charged in full (a last slice under 50 cents is let go)
//   free    the winning bid is under 50 cents
//   manual  this bid never had a card, so the owner collects
//   failed  the card did not go through; anything charged was given back
export async function chargeWinner(env, key, bid, now) {
  const { results } = await env.DB.prepare("SELECT * FROM holds WHERE bid_id = ? AND state IN ('held', 'action', 'captured') ORDER BY cents DESC, id ASC")
    .bind(bid.id).all();
  const done = async (state, paid) => {
    await env.DB.prepare('UPDATE bids SET pay_state = ?, paid_cents = ? WHERE id = ?').bind(state, paid, bid.id).run();
    return state;
  };
  if (!results.length && !(bid.customer_id && bid.card_id)) return done('manual', null);

  let paid = results.filter((h) => h.state === 'captured').reduce((n, h) => n + (h.captured_cents || 0), 0);
  const free = bid.amount_cents < LIMITS.freeUnderCents;
  for (const h of results) {
    if (h.state === 'captured') continue;
    const take = free || h.state !== 'held' ? 0 : captureSlice(h.cents, bid.amount_cents - paid);
    if (take) paid += await captureHold(env, key, h, take, now);
    else await releaseHold(env, key, h, now);
  }
  if (free) return done('free', 0);

  let due = bid.amount_cents - paid;
  if (due >= LIMITS.freeUnderCents && bid.customer_id && bid.card_id) {
    const r = await chargeSaved(env, key, { customerId: bid.customer_id, cardId: bid.card_id, email: bid.email, cents: due, day: bid.day, bidId: bid.id });
    if (r.ok) {
      await env.DB.prepare("INSERT OR IGNORE INTO holds (bid_id, intent_id, cents, state, captured_cents, created_at, settled_at) VALUES (?, ?, ?, 'captured', ?, ?, ?)")
        .bind(bid.id, r.intentId, due, r.cents, now, now).run();
      paid += r.cents;
      due = bid.amount_cents - paid;
    }
  }
  if (due < LIMITS.freeUnderCents) return done('paid', paid);
  await undoCharge(env, key, bid, now);
  return done('failed', 0);
}

// The money for a closed round: charge the winner, pass to the next bid if that
// card fails, release everyone else. Does a bounded amount of work per run and
// returns true once the round is fully settled.
export async function settleMoney(env, key, day, now, chooseWinner) {
  const claim = await env.DB.prepare(
    "UPDATE auctions SET money_state = 'settling', money_at = ? WHERE day = ? AND status = 'closed' " +
    "AND (money_state IS NULL OR (money_state = 'settling' AND money_at < ?))",
  ).bind(now, day, now - SETTLE_RETRY_MS).run();
  if (!claim.meta.changes) return false;
  const finish = async (state) => {
    await env.DB.prepare('UPDATE auctions SET money_state = ?, money_at = ? WHERE day = ?').bind(state, now, day).run();
    return state === 'done';
  };

  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM holds h JOIN bids b ON b.id = h.bid_id WHERE b.day = ? AND h.state IN ('held', 'action')",
  ).bind(day).first();
  if (open.n && !key) return finish(null); // holds to deal with and no card key: wait for the key

  let winnerId = null;
  for (let tries = 0; tries < 2; tries++) {
    const a = await env.DB.prepare('SELECT winner_bid_id FROM auctions WHERE day = ?').bind(day).first();
    winnerId = a.winner_bid_id;
    if (!winnerId) break;
    const w = await env.DB.prepare('SELECT * FROM bids WHERE id = ?').bind(winnerId).first();
    if (w.pay_state && w.pay_state !== 'failed') break;
    const state = w.pay_state || (key ? await chargeWinner(env, key, w, now) : 'manual');
    if (state !== 'failed') break;
    // That card did not go through: the next highest bid wins, while its hold is still there.
    await env.DB.prepare("UPDATE bids SET win_state = 'passed' WHERE id = ?").bind(w.id).run();
    const next = await chooseWinner(env, day);
    winnerId = next ? next.id : null;
    if (tries === 1 && next) return finish(null); // more winners to try: carry on next run
  }

  const { results: rest } = await env.DB.prepare(
    "SELECT h.* FROM holds h JOIN bids b ON b.id = h.bid_id WHERE b.day = ? AND h.state IN ('held', 'action') AND b.id <> ? ORDER BY h.id LIMIT ?",
  ).bind(day, winnerId || 0, OPS_PER_RUN).all();
  let stuck = 0;
  for (const h of rest) if (!(await releaseHold(env, key, h, now))) stuck++;
  await env.DB.prepare("UPDATE bids SET status = 'nocard', next_status = NULL WHERE day = ? AND status = 'card'").bind(day).run();
  return finish(stuck || rest.length === OPS_PER_RUN ? null : 'done');
}

// Closed rounds whose money is not settled yet.
export async function unsettledDays(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT day FROM auctions WHERE status = 'closed' AND (money_state IS NULL OR (money_state = 'settling' AND money_at < ?)) ORDER BY closed_at LIMIT 1",
  ).bind(now - SETTLE_RETRY_MS).all();
  return results.map((r) => r.day);
}

// Bank checks that nobody finished: release the hold and drop the bid.
export async function sweepStale(env, key, now) {
  const { results } = await env.DB.prepare("SELECT * FROM holds WHERE state = 'action' AND created_at < ? ORDER BY id LIMIT 3")
    .bind(now - STALE_ACTION_MS).all();
  for (const h of results) {
    if (!(await releaseHold(env, key, h, now))) continue;
    await env.DB.prepare("UPDATE bids SET status = 'nocard', next_status = NULL WHERE id = ? AND status = 'card'").bind(h.bid_id).run();
  }
}
