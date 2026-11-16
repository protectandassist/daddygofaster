import { badLanguage, posesAsSite } from './language.js';

// The house rules as plain functions. Nothing in this file talks to a database,
// the network or a clock, so every rule here is unit-tested (test/rules.test.js).

export const LIMITS = {
  taskMin: 10,
  taskMax: 280,
  nameMin: 2,
  nameMax: 24,
  emailMax: 254,
  maxCents: 10_000_000, // $100,000
  minBidCents: 50, // the reserve: a bid has to meet it to count. It is the least a card can be charged, so every winner pays
  freeUnderCents: 50, // card minimum: a win below this is free
  maxCostCents: 100_000, // $1,000: the most a job's costs can add to a bid. More than that needs a conversation, not a card charge
  minPledgeCents: 200, // least someone can add to an open job; below this the card fee eats it
};

export const TIME_POLICY = { includedMinutes: 60, additionalHourCents: 20000 };

// ---- money and time ---------------------------------------------------------

export function money(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// This threshold opens a longer job for review; it does not buy hours.
export function minCentsFor(minutes) {
  return Math.max(1, (Math.ceil(minutes / 60) - 1) * TIME_POLICY.additionalHourCents);
}

export function coveredMinutes(cents) {
  return (1 + Math.floor(cents / TIME_POLICY.additionalHourCents)) * 60;
}

export function timeAllowance(cents) {
  const hours = coveredMinutes(cents) / 60;
  return `Up to ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function approveDuration(amountCents, minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, message: 'Enter the time you agree to spend, in minutes.' };
  }
  if (minutes > coveredMinutes(amountCents)) {
    return { ok: false, message: `This bid is capped at ${coveredMinutes(amountCents)} minutes. Approve time within that cap.` };
  }
  return { ok: true, minutes, minCents: minCentsFor(minutes) };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function describeMinutes(minutes) {
  if (minutes < 1) return 'under a minute';
  const whole = Math.round(minutes);
  if (whole < 60) return 'about ' + plural(whole, 'minute');
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return 'about ' + plural(h, 'hour') + (m ? ' ' + plural(m, 'minute') : '');
}

// ---- what a bidder may send -------------------------------------------------

const NAME_OK = /^[\p{L}\p{N} ._-]+$/u;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Returns { ok: true, value } or { ok: false, error } with a message for the bidder.
export function validateBid(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send a job, a name, an email and a bid.' };
  const task = String(body.task ?? '').replace(/\s+/g, ' ').trim();
  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const amountCents = body.amountCents;

  if (task.length < LIMITS.taskMin) return { ok: false, error: 'Describe the job in a few more words.' };
  if (task.length > LIMITS.taskMax) return { ok: false, error: `Keep the job to ${LIMITS.taskMax} characters.` };
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax || !NAME_OK.test(name)) {
    return { ok: false, error: `Use a name of ${LIMITS.nameMin} to ${LIMITS.nameMax} letters or numbers.` };
  }
  if (badLanguage(name)) return { ok: false, error: 'Pick a different name for the board.' };
  if (posesAsSite(name)) return { ok: false, error: 'That name is reserved. Pick a different name for the board.' };
  if (email.length > LIMITS.emailMax || !EMAIL_OK.test(email)) return { ok: false, error: 'Check the email address.' };
  if (!Number.isInteger(amountCents) || amountCents < LIMITS.minBidCents) return { ok: false, error: `The reserve is ${money(LIMITS.minBidCents)}. Enter a bid of at least that.` };
  if (amountCents > LIMITS.maxCents) return { ok: false, error: `The most you can bid here is ${money(LIMITS.maxCents)}.` };
  const max = validateMax(body.maxCents, amountCents);
  if (!max.ok) return max;
  return { ok: true, value: { task, name, email, amountCents, maxCents: max.value, notify: body.notify === true } };
}

// Money added to someone else's open job. Returns { ok, value } or { ok: false, error }.
export function validatePledge(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Send a name, an email and an amount.' };
  const name = String(body.name ?? '').replace(/\s+/g, ' ').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const amountCents = body.amountCents;
  if (name.length < LIMITS.nameMin || name.length > LIMITS.nameMax || !NAME_OK.test(name)) {
    return { ok: false, error: `Use a name of ${LIMITS.nameMin} to ${LIMITS.nameMax} letters or numbers.` };
  }
  if (email.length > LIMITS.emailMax || !EMAIL_OK.test(email)) return { ok: false, error: 'Check the email address.' };
  if (!Number.isInteger(amountCents) || amountCents < LIMITS.minPledgeCents) {
    return { ok: false, error: `The least you can add is ${money(LIMITS.minPledgeCents)}.` };
  }
  if (amountCents > LIMITS.maxCents) return { ok: false, error: `The most you can add here is ${money(LIMITS.maxCents)}.` };
  return { ok: true, value: { name, email, amountCents } };
}

// The optional auto-bid maximum. Returns null when none was given.
export function validateMax(maxCents, amountCents) {
  if (maxCents === undefined || maxCents === null || maxCents === '') return { ok: true, value: null };
  if (!Number.isInteger(maxCents) || maxCents < 1) return { ok: false, error: 'Enter the maximum in dollars and cents.' };
  if (maxCents > LIMITS.maxCents) return { ok: false, error: `The most you can bid here is ${money(LIMITS.maxCents)}.` };
  if (maxCents < amountCents) return { ok: false, error: 'Your maximum has to be at least your bid.' };
  return { ok: true, value: maxCents === amountCents ? null : maxCents };
}

// A raise sent with the bidder's private handle: only the money is checked.
export function validateRaise(body) {
  const amountCents = body?.amountCents;
  if (!Number.isInteger(amountCents) || amountCents < LIMITS.minBidCents) return { ok: false, error: `The reserve is ${money(LIMITS.minBidCents)}. Enter a bid of at least that.` };
  if (amountCents > LIMITS.maxCents) return { ok: false, error: `The most you can bid here is ${money(LIMITS.maxCents)}.` };
  const max = validateMax(body.maxCents, amountCents);
  if (!max.ok) return max;
  return { ok: true, value: { amountCents, maxCents: max.value } };
}

// ---- what a job costs to do ---------------------------------------------------
// The screen lists what the owner would have to buy. Its labels end up in front
// of the bidder, so they are cut down to plain words here, and the total is the
// sum of the list rather than a second number that could disagree with it.
export function cleanCostItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list.slice(0, 8)) {
    const cents = Math.round(Number(entry && entry.dollars) * 100);
    const item = String((entry && entry.item) ?? '').replace(/[^\p{L}\p{N} ,&'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!item || !Number.isFinite(cents) || cents <= 0) continue;
    out.push({ item, cents });
  }
  return out;
}

function costList(items) {
  return items && items.length ? ' (' + items.map((c) => `${c.item} ${money(c.cents)}`).join(', ') + ')' : '';
}

// ---- time allowance and owner review ----------------------------------------
// Estimates include travel. Only the owner can approve more than one hour.
export function decide({ amountCents, estMinutes, estCostCents = 0, costItems = null }) {
  const minCents = minCentsFor(estMinutes);
  const costNote = estCostCents > 0
    ? ` This job has costs of ${money(estCostCents)}${costList(costItems)}, with taxes and fees included. They are added on top of your bid if you win.`
    : '';
  if (estMinutes <= TIME_POLICY.includedMinutes) {
    return {
      status: 'qualified',
      minCents,
      message: 'Your bid is in. Any winning bid includes up to one hour of my time.' + costNote,
    };
  }
  if (amountCents >= minCents) {
    return { status: 'held', minCents,
      message: `Your bid is in for review. ${timeAllowance(amountCents)} is the limit at this bid. I will set the actual time before approving the job.` + costNote };
  }
  return {
    status: 'short', minCents,
    message: `${timeAllowance(amountCents)} is the limit at this bid. This job looks longer. Limit the job to that time or bid at least ${money(minCents)} for me to review the longer duration.` + costNote,
  };
}

// The stored list, or null.
export function readCostItems(text) {
  if (!text) return null;
  try { const list = JSON.parse(text); return Array.isArray(list) && list.length ? list : null; } catch { return null; }
}

// The same person sending the same job again is raising their bid, not placing a
// new one. `existing` is their current row for that job. The job was already
// screened, so the only question is whether the new amount covers it. A raise
// can lift the bid, the auto-bid maximum, or both. Neither can come down.
export function raiseVerdict(existing, amountCents, maxCents = null) {
  const oldCeiling = Math.max(existing.amount_cents, existing.max_cents ?? 0);
  const newCeiling = Math.max(amountCents, maxCents ?? 0);
  if (amountCents <= existing.amount_cents && newCeiling <= oldCeiling) {
    return {
      ok: false,
      message:
        `Your bid on this job is already ${money(existing.amount_cents)}` +
        (existing.max_cents ? `, with a maximum of ${money(existing.max_cents)}` : '') +
        '. Enter a higher amount or a higher maximum to raise it.',
    };
  }
  const amount = Math.max(existing.amount_cents, amountCents);
  const ceiling = Math.max(oldCeiling, newCeiling);
  const next = { ok: true, amountCents: amount, maxCents: ceiling > amount ? ceiling : null };
  const now = `Your bid is now ${money(amount)}`;
  if (existing.status === 'held') return { ...next, status: 'held', message: `${now}. It is still waiting for a person to check it.` };
  if (existing.screened_by === 'owner' && existing.status === 'qualified' &&
      (existing.est_minutes == null || approveDuration(amount, existing.est_minutes).ok)) {
    return { ...next, status: 'qualified', message: `${now}. The agreed time stays the same.` };
  }
  if (!Number.isFinite(existing.est_minutes) || existing.est_minutes <= 0) {
    return { ...next, status: 'held', minCents: null, message: `${now}. The time needs owner review.` };
  }
  const decision = decide({ amountCents: amount, estMinutes: existing.est_minutes, estCostCents: existing.est_cost_cents || 0, costItems: readCostItems(existing.cost_items) });
  const verdict = liftForReview(decision, amount, ceiling);
  return { ...next, ...verdict, maxCents: ceiling > verdict.amountCents ? ceiling : null,
    message: verdict.status === 'qualified' ? `${now}. Any winning bid includes up to one hour.` : verdict.message };
}

// ---- card holds ---------------------------------------------------------------

// What has to be held on the card for a bid: the most it could end up at, which
// is its auto-bid maximum when it has one. Cards cannot hold less than 50 cents.
export function holdTarget(amountCents, maxCents = null) {
  return Math.max(amountCents, maxCents ?? 0, LIMITS.freeUnderCents);
}

// How much more to hold when `heldCents` is already held. Zero when that covers it.
export function extraHold(targetCents, heldCents) {
  const more = targetCents - heldCents;
  return more <= 0 ? 0 : Math.max(more, LIMITS.freeUnderCents);
}

// How much of one hold to charge when `dueCents` is still owed. Zero means
// release the hold: either nothing is owed, or what is left is under the card
// minimum and is let go.
export function captureSlice(holdCents, dueCents) {
  return dueCents < LIMITS.freeUnderCents ? 0 : Math.min(holdCents, dueCents);
}

// ---- auto-bidding -------------------------------------------------------------

// Each qualifying bid has an amount and, optionally, a hidden maximum it may rise
// to. This returns where every bid stands once the auto-bids have answered each
// other: the bid with the highest ceiling leads, at one step over the next
// ceiling (never above its own), and every bid behind it has gone as far as it
// can. Equal ceilings go to whoever set theirs first.
export function resolveStandings(bids, step = 1) {
  const ceiling = (b) => Math.max(b.amount_cents, b.max_cents ?? 0);
  const order = [...bids].sort((a, b) => ceiling(b) - ceiling(a) || a.created_at - b.created_at || a.id - b.id);
  const amounts = new Map();
  if (!order.length) return { leaderId: null, highCents: 0, amounts };
  const [lead, second] = order;
  for (const b of order.slice(1)) amounts.set(b.id, ceiling(b));
  const high = second ? Math.max(lead.amount_cents, Math.min(ceiling(lead), ceiling(second) + step)) : lead.amount_cents;
  amounts.set(lead.id, high);
  return { leaderId: lead.id, highCents: high, amounts };
}

// What a bidder is told when a job breaks a rule. Fixed wording: the screen
// picks a category, it never writes the reply.
export const REFUSALS = {
  unsafe: 'That job is not allowed: nothing illegal, dangerous or sexual.',
  appearance: 'That job is not allowed: no costumes or anything that changes how I look.',
  scripted: 'That job is not allowed: you choose what I do, not what I say.',
  politics_religion_promo: 'That job is not allowed: no politics, religion or promoting a product.',
  targets_person_or_address: 'That job is not allowed: nothing aimed at a specific person or a private address.',
  public_disturbance: 'That job is not allowed: no causing a scene or bothering people who are at work.',
  family_or_nonconsenting: 'That job is not allowed: nothing involving my family or people who have not agreed to it.',
  live_location: 'That job is not allowed: I choose the time, and nothing is live.',
  humiliating: 'That job is not allowed: hard is fine, humiliating is not.',
  vague: 'Be more specific: say exactly what to do, where, and for how long.',
  name: 'Pick a different name for the board.',
  other: 'That job is not allowed under the house rules.',
};

// What someone is told when their job is checked before they bid. `verdict` is
// what applyScreen made of the screen's answer, or null when a person has to look.
//   ok       allowed: go on to place the bid
//   review   a person will look after the bid is placed: go on
//   short    allowed, but this bid is too low for a job that long
//   refused  not allowed: the bid cannot be placed
export function checkReply(verdict) {
  const costs = verdict && verdict.estCostCents > 0
    ? ` It has costs of ${money(verdict.estCostCents)}${costList(verdict.costItems)}, with taxes and fees included. They are added on top of your bid, and charged only if you win.`
    : '';
  const extra = verdict && verdict.estCostCents > 0 ? { costCents: verdict.estCostCents, costItems: verdict.costItems && verdict.costItems.length ? verdict.costItems : null } : { costCents: null, costItems: null };
  if (!verdict || (verdict.status === 'held' && verdict.message === HELD_MESSAGE)) {
    return { verdict: 'review', ...extra, message: 'This job needs a person to look at it before it can go on the board. You can place your bid now; it waits until it is approved.' };
  }
  if (verdict.status === 'refused') return { verdict: 'refused', costCents: null, costItems: null, message: verdict.message };
  if (verdict.status === 'short') return { verdict: 'short', ...extra, message: verdict.message.replace(/ This job has costs of .*$/, '') + costs };
  if (verdict.status === 'held') return { verdict: 'review', ...extra, message: 'This job is allowed. It looks longer than an hour, so I will set the time before approving it.' + costs };
  return { verdict: 'ok', ...extra, message: (costs ? 'This job is allowed.' + costs : 'This job is allowed, and there is nothing extra to pay for.') + ' Add your details to place the bid.' };
}

// A round's key: the date for the site's own page, the date and "~<creator id>" for a creator's.
export function roundKey(date, creatorId) {
  return creatorId ? `${date}~${creatorId}` : date;
}
export function roundDate(key) {
  return String(key).slice(0, 10);
}
export function roundCreator(key) {
  const at = String(key).indexOf('~');
  return at < 0 ? 0 : Number(String(key).slice(at + 1)) || 0;
}

// What a creator is sent for one charge on a winning job: the charge, less the card
// processing fee (2.9% + 30 cents), less the site's share.
export const SITE_SHARE = 0.05;
export function payoutSplit(chargedCents) {
  const fee = Math.round(chargedCents * 0.029) + 30;
  const cut = Math.round(chargedCents * SITE_SHARE);
  return { fee, cut, pay: Math.max(0, chargedCents - fee - cut) };
}

// The job's words, the way they are compared: trimmed, single-spaced, lower-cased.
export function taskKey(task) {
  return String(task ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export const HELD_MESSAGE =
  'Your bid is in and waiting for a person to check it. It goes on the board once it is approved.';

// Turns the screen's answer into what happens to the bid. `out` is the object
// the screen returns (see src/screen.js). Anything doubtful is held for a person.
export function applyScreen(out, { amountCents, maxCents = null }) {
  if (!out || typeof out !== 'object') return { status: 'held', message: HELD_MESSAGE };
  if (out.name_ok === false) return { status: 'refused', category: 'name', message: REFUSALS.name };
  if (out.decision === 'refuse') {
    const category = Object.hasOwn(REFUSALS, out.category) && out.category !== 'name' ? out.category : 'other';
    return { status: 'refused', category, message: REFUSALS[category] };
  }
  const minutes = Number(out.est_minutes);
  const costItems = cleanCostItems(out.cost_items);
  // The list is the cost. A bare total with no list (an older answer) still counts.
  const cost = costItems.length ? costItems.reduce((n, c) => n + c.cents, 0) : Math.round(Number(out.est_cost_dollars) * 100);
  const sane = Number.isFinite(minutes) && minutes > 0 && minutes <= coveredMinutes(LIMITS.maxCents) && Number.isFinite(cost) && cost >= 0 && cost <= LIMITS.maxCostCents;
  if (out.decision !== 'allow' || out.needs_quote || !sane) return { status: 'held', message: HELD_MESSAGE };

  const estMinutes = minutes < 1 ? minutes : Math.ceil(minutes);
  const verdict = { ...decide({ amountCents, estMinutes, estCostCents: cost, costItems }), estMinutes, estCostCents: cost, costItems };
  return liftForReview(verdict, amountCents, maxCents);
}

// An auto-bid maximum is permission to go that high. If the bid starts below
// what the job needs and the maximum reaches it, the bid goes up to exactly
// what the job needs, and no further.
function liftForReview(verdict, amountCents, maxCents) {
  if (verdict.status !== 'short' || !maxCents || maxCents < verdict.minCents) return { ...verdict, amountCents };
  return {
    ...verdict,
    status: 'held',
    amountCents: verdict.minCents,
    message: `Your auto-bid raised it to ${money(verdict.minCents)} for a longer job to be considered. ${timeAllowance(verdict.minCents)} is the cap. I will set the actual time before approving it.`,
  };
}

// ---- the auction clock ------------------------------------------------------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

// Wall-clock date and time in `tz` at the instant `ms`.
export function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// The instant at which the wall clock in `tz` reads y-m-d h:00.
export function zonedToUtc(y, m, d, h, tz) {
  const want = Date.UTC(y, m - 1, d, h);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const diff = want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

function shift(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function ymd({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 'YYYY-MM-DD' moved by n days.
export function dayShift(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return ymd(shift(y, m, d, n));
}

// Bidding for a job day closes at `closeHour` local time the evening before.
// Returns the auction that is open at `nowMs` when nothing has been extended.
export function nominalAuction(nowMs, tz, closeHour) {
  const p = localParts(nowMs, tz);
  let closesAt = zonedToUtc(p.y, p.m, p.d, closeHour, tz);
  let job = shift(p.y, p.m, p.d, 1);
  if (nowMs >= closesAt) {
    const t = shift(p.y, p.m, p.d, 1);
    closesAt = zonedToUtc(t.y, t.m, t.d, closeHour, tz);
    job = shift(p.y, p.m, p.d, 2);
  }
  return { day: ymd(job), closesAt };
}

// The owner's weekly schedule: bidding is online on the chosen weekdays (0 is Sunday), from
// `open` to `close`, both minutes after local midnight. Returns the window that `nowMs` is in,
// or the next one to come: { on, opensAt, closesAt, day } where `day` is the job day, the
// day after the close. Null when no weekday is chosen.
export function scheduleWindow(nowMs, tz, sch) {
  const p = localParts(nowMs, tz);
  const at = (o, mins) => zonedToUtc(o.y, o.m, o.d, Math.floor(mins / 60), tz) + (mins % 60) * 60_000;
  for (let i = 0; i <= 7; i++) {
    const o = shift(p.y, p.m, p.d, i);
    if (!sch.days.includes(new Date(Date.UTC(o.y, o.m - 1, o.d)).getUTCDay())) continue;
    const closesAt = at(o, sch.close);
    if (nowMs >= closesAt) continue;
    const opensAt = at(o, sch.open);
    return { on: nowMs >= opensAt, opensAt, closesAt, day: ymd(shift(o.y, o.m, o.d, 1)) };
  }
  return null;
}

// What the owner sent for the schedule, checked: { days, open, close } or null for "every day".
export function readSchedule(body) {
  const days = [...new Set((Array.isArray(body?.days) ? body.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) return null;
  const mins = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '')); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const open = mins(body.open), close = mins(body.close);
  if (!Number.isFinite(open) || !Number.isFinite(close)) return { error: 'Give both times, like 8:00 AM and 8:00 PM.' };
  if (close - open < 10) return { error: 'The closing time has to be at least ten minutes after the opening time, on the same day.' };
  return { days, open, close };
}

// A new high bid in the last `extendMinutes` adds `extendMinutes` to the clock.
// There is no cap: while people keep outbidding each other, the round runs on.
export function extendedClose(closesAt, nowMs, extendMinutes) {
  const window = extendMinutes * 60_000;
  return closesAt - nowMs <= window ? closesAt + window : closesAt;
}

// ---- who wins ---------------------------------------------------------------

// Highest qualifying bid wins; the earlier bid wins a tie. Anyone who already
// won in the past week is skipped (one win per person per week).
export function pickWinner(bids, recentWinnerEmails = new Set()) {
  const order = bids
    .filter((b) => !recentWinnerEmails.has(b.email))
    .sort((a, b) => b.amount_cents - a.amount_cents || a.created_at - b.created_at || a.id - b.id);
  return order[0] ?? null;
}
