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
  return { ok: true, value: { task, name, email, amountCents } };
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
export function applyScreen(out, { amountCents, ratePerHour }) {
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
  return { ...decide({ amountCents, estMinutes, estCostCents: cost, ratePerHour }), estMinutes, estCostCents: cost };
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

// A bid in the last `extendMinutes` adds `extendMinutes` to the clock.
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
