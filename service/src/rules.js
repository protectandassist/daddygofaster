// The house rules as plain functions. Nothing in this file talks to a database,
// the network or a clock, so every rule here is unit-tested (test/rules.test.js).

export const LIMITS = {
  taskMin: 10,
  taskMax: 280,
  nameMin: 2,
  nameMax: 24,
  emailMax: 254,
  maxCents: 10_000_000, // $100,000
  freeUnderCents: 50, // card minimum: a win below this is free
};

// ---- money and time ---------------------------------------------------------

export function money(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Smallest bid that covers a job of `minutes` at `ratePerHour` dollars.
export function minCentsFor(minutes, ratePerHour) {
  return Math.ceil((minutes / 60) * ratePerHour * 100);
}

// How many minutes of work a bid covers.
export function coveredMinutes(cents, ratePerHour) {
  return (cents / 100 / ratePerHour) * 60;
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
  if (email.length > LIMITS.emailMax || !EMAIL_OK.test(email)) return { ok: false, error: 'Check the email address.' };
  if (!Number.isInteger(amountCents) || amountCents < 1) return { ok: false, error: 'Enter a bid of at least $0.01.' };
  if (amountCents > LIMITS.maxCents) return { ok: false, error: `The most you can bid here is ${money(LIMITS.maxCents)}.` };
  const max = validateMax(body.maxCents, amountCents);
  if (!max.ok) return max;
  return { ok: true, value: { task, name, email, amountCents, maxCents: max.value, notify: body.notify === true } };
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
  if (!Number.isInteger(amountCents) || amountCents < 1) return { ok: false, error: 'Enter a bid of at least $0.01.' };
  if (amountCents > LIMITS.maxCents) return { ok: false, error: `The most you can bid here is ${money(LIMITS.maxCents)}.` };
  const max = validateMax(body.maxCents, amountCents);
  if (!max.ok) return max;
  return { ok: true, value: { amountCents, maxCents: max.value } };
}

// ---- does the bid cover the job? --------------------------------------------

// The $200-an-hour sense check. `estMinutes` already includes travel both ways.
export function decide({ amountCents, estMinutes, estCostCents = 0, ratePerHour }) {
  const minCents = minCentsFor(estMinutes, ratePerHour);
  const size = describeMinutes(estMinutes);
  const costs = estCostCents > 0 ? money(estCostCents) : null;
  if (amountCents >= minCents) {
    return {
      status: 'qualified',
      minCents,
      message:
        `Your bid is in. It covers the job, which is ${size} of my time.` +
        (costs ? ` Costs of about ${costs} are extra and are paid before the job if you win.` : ''),
    };
  }
  return {
    status: 'short',
    minCents,
    message:
      `That is ${size} including travel, so it needs ${money(minCents)}` +
      (costs ? `, plus about ${costs} in costs` : '') +
      `. Your ${money(amountCents)} covers ${describeMinutes(coveredMinutes(amountCents, ratePerHour))}.` +
      ' Raise the bid or pick a smaller job.',
  };
}

// The same person sending the same job again is raising their bid, not placing a
// new one. `existing` is their current row for that job. The job was already
// screened, so the only question is whether the new amount covers it. A raise
// can lift the bid, the auto-bid maximum, or both. Neither can come down.
export function raiseVerdict(existing, amountCents, ratePerHour, maxCents = null) {
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
  if (existing.min_cents == null || amount >= existing.min_cents) {
    return { ...next, status: 'qualified', message: existing.status === 'short' ? `${now}, which covers the job.` : `${now}.` };
  }
  if (ceiling >= existing.min_cents) {
    return {
      ok: true, amountCents: existing.min_cents, maxCents: ceiling > existing.min_cents ? ceiling : null, status: 'qualified',
      message: `Your auto-bid raised your bid to ${money(existing.min_cents)} to cover the job.`,
    };
  }
  const short = decide({ amountCents: amount, estMinutes: existing.est_minutes, estCostCents: existing.est_cost_cents || 0, ratePerHour });
  return { ...next, status: 'short', message: short.message };
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

export const HELD_MESSAGE =
  'Your bid is in and waiting for a person to check it. It goes on the board once it is approved.';

// Turns the screen's answer into what happens to the bid. `out` is the object
// the screen returns (see src/screen.js). Anything doubtful is held for a person.
export function applyScreen(out, { amountCents, maxCents = null, ratePerHour }) {
  if (!out || typeof out !== 'object') return { status: 'held', message: HELD_MESSAGE };
  if (out.name_ok === false) return { status: 'refused', category: 'name', message: REFUSALS.name };
  if (out.decision === 'refuse') {
    const category = Object.hasOwn(REFUSALS, out.category) && out.category !== 'name' ? out.category : 'other';
    return { status: 'refused', category, message: REFUSALS[category] };
  }
  const minutes = Number(out.est_minutes);
  const cost = Math.round(Number(out.est_cost_dollars) * 100);
  const sane = Number.isFinite(minutes) && minutes > 0 && minutes <= 14 * 24 * 60 && Number.isFinite(cost) && cost >= 0;
  if (out.decision !== 'allow' || out.needs_quote || !sane) return { status: 'held', message: HELD_MESSAGE };

  // A job that takes seconds (a wave, a thumbs-up) is covered by any bid. This
  // is what lets a one-cent bid win something.
  if (minutes < 1) {
    return { status: 'qualified', minCents: 1, estMinutes: minutes, estCostCents: cost, message: 'Your bid is in. It is a quick job, so any bid covers it.' };
  }
  const estMinutes = Math.ceil(minutes);
  const verdict = { ...decide({ amountCents, estMinutes, estCostCents: cost, ratePerHour }), estMinutes, estCostCents: cost };
  return liftToCover(verdict, amountCents, maxCents);
}

// An auto-bid maximum is permission to go that high. If the bid starts below
// what the job needs and the maximum reaches it, the bid goes up to exactly
// what the job needs, and no further.
function liftToCover(verdict, amountCents, maxCents) {
  if (verdict.status !== 'short' || !maxCents || maxCents < verdict.minCents) return { ...verdict, amountCents };
  return {
    ...verdict,
    status: 'qualified',
    amountCents: verdict.minCents,
    message: `Your bid is in. Your auto-bid raised it to ${money(verdict.minCents)} to cover the job.`,
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
