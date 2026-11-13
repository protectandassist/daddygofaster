import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money, minCentsFor, coveredMinutes, describeMinutes, validateBid, decide,
  localParts, zonedToUtc, dayShift, nominalAuction, extendedClose, pickWinner, applyScreen, LIMITS, REFUSALS, HELD_MESSAGE,
} from '../src/rules.js';

const TZ = 'America/Chicago';
const at = (iso) => new Date(iso).getTime();

test('the $200-an-hour maths matches the table on the site', () => {
  assert.equal(minCentsFor(60, 200), 20000);
  assert.equal(minCentsFor(15, 200), 5000);
  assert.equal(minCentsFor(3, 200), 1000);
  assert.equal(minCentsFor(50, 200), 16667); // $166.67, the example on the page
  assert.equal(coveredMinutes(2000, 200), 6);
  assert.equal(coveredMinutes(40000, 200), 120);
  assert.equal(money(16667), '$166.67');
  assert.equal(money(160000), '$1,600.00');
});

test('durations read naturally', () => {
  assert.equal(describeMinutes(0.3), 'under a minute');
  assert.equal(describeMinutes(1), 'about 1 minute');
  assert.equal(describeMinutes(50), 'about 50 minutes');
  assert.equal(describeMinutes(60), 'about 1 hour');
  assert.equal(describeMinutes(150), 'about 2 hours 30 minutes');
});

test('two dollars does not buy eight hours', () => {
  const r = decide({ amountCents: 200, estMinutes: 480, ratePerHour: 200 });
  assert.equal(r.status, 'short');
  assert.equal(r.minCents, 160000);
  assert.match(r.message, /needs \$1,600\.00/);
});

test('a bid that covers its job qualifies, and costs are called out', () => {
  const ok = decide({ amountCents: 20000, estMinutes: 50, estCostCents: 400, ratePerHour: 200 });
  assert.equal(ok.status, 'qualified');
  assert.match(ok.message, /Costs of about \$4\.00 are extra/);
  const exact = decide({ amountCents: 16667, estMinutes: 50, ratePerHour: 200 });
  assert.equal(exact.status, 'qualified');
  const oneShort = decide({ amountCents: 16666, estMinutes: 50, estCostCents: 400, ratePerHour: 200 });
  assert.equal(oneShort.status, 'short');
  assert.match(oneShort.message, /needs \$166\.67, plus about \$4\.00 in costs/);
});

test('bids are validated and tidied', () => {
  const good = validateBid({ task: '  Walk to work   instead of driving. ', name: ' mike_r ', email: ' Mike@Example.COM ', amountCents: 1 });
  assert.deepEqual(good, { ok: true, value: { task: 'Walk to work instead of driving.', name: 'mike_r', email: 'mike@example.com', amountCents: 1 } });
  const base = { task: 'Walk to work instead of driving.', name: 'mike_r', email: 'm@example.com', amountCents: 100 };
  assert.equal(validateBid({ ...base, task: 'too short' }).ok, false);
  assert.equal(validateBid({ ...base, task: 'x'.repeat(281) }).ok, false);
  assert.equal(validateBid({ ...base, name: 'a' }).ok, false);
  assert.equal(validateBid({ ...base, name: '<script>' }).ok, false);
  assert.equal(validateBid({ ...base, email: 'nope' }).ok, false);
  assert.equal(validateBid({ ...base, amountCents: 0 }).ok, false);
  assert.equal(validateBid({ ...base, amountCents: 1.5 }).ok, false);
  assert.equal(validateBid({ ...base, amountCents: '100' }).ok, false);
  assert.equal(validateBid({ ...base, amountCents: LIMITS.maxCents + 1 }).ok, false);
  assert.equal(validateBid(null).ok, false);
});

test('local time and the 8 p.m. close, in winter and summer', () => {
  assert.deepEqual(localParts(at('2026-11-13T18:30:00Z'), TZ), { y: 2026, m: 11, d: 13, h: 12, mi: 30, s: 0 });
  assert.equal(zonedToUtc(2026, 11, 13, 20, TZ), at('2026-11-14T02:00:00Z')); // CST, UTC-6
  assert.equal(zonedToUtc(2026, 7, 4, 20, TZ), at('2026-07-05T01:00:00Z')); // CDT, UTC-5
});

test('before the close you are bidding on tomorrow; after it, on the day after', () => {
  const before = nominalAuction(at('2026-11-13T18:30:00Z'), TZ, 20); // 12:30 p.m. on the 13th
  assert.deepEqual(before, { day: '2026-11-14', closesAt: at('2026-11-14T02:00:00Z') });
  const after = nominalAuction(at('2026-11-14T02:00:00Z'), TZ, 20); // 8:00 p.m. exactly
  assert.deepEqual(after, { day: '2026-11-15', closesAt: at('2026-11-15T02:00:00Z') });
  const lateNight = nominalAuction(at('2026-11-14T05:30:00Z'), TZ, 20); // 11:30 p.m. on the 13th
  assert.deepEqual(lateNight, { day: '2026-11-15', closesAt: at('2026-11-15T02:00:00Z') });
});

test('the close stays at 8 p.m. local across both clock changes', () => {
  // Clocks go back on 2026-11-01 and forward on 2026-03-08.
  const fall = nominalAuction(at('2026-11-01T15:00:00Z'), TZ, 20);
  assert.deepEqual(localParts(fall.closesAt, TZ), { y: 2026, m: 11, d: 1, h: 20, mi: 0, s: 0 });
  const spring = nominalAuction(at('2026-03-08T15:00:00Z'), TZ, 20);
  assert.deepEqual(localParts(spring.closesAt, TZ), { y: 2026, m: 3, d: 8, h: 20, mi: 0, s: 0 });
  assert.equal(spring.day, '2026-03-09');
});

test('days shift across months and years', () => {
  assert.equal(dayShift('2026-11-14', -6), '2026-11-08');
  assert.equal(dayShift('2026-12-31', 1), '2027-01-01');
  assert.equal(dayShift('2026-03-01', -1), '2026-02-28');
});

test('a bid in the last five minutes adds five minutes', () => {
  const close = at('2026-11-14T02:00:00Z');
  assert.equal(extendedClose(close, close - 6 * 60_000, 5), close);
  assert.equal(extendedClose(close, close - 5 * 60_000, 5), close + 5 * 60_000);
  assert.equal(extendedClose(close, close - 1000, 5), close + 5 * 60_000);
});

test('highest bid wins, earlier bid wins a tie, and last week\'s winner sits out', () => {
  const bids = [
    { id: 1, email: 'a@x.com', amount_cents: 3500, created_at: 10 },
    { id: 2, email: 'b@x.com', amount_cents: 4200, created_at: 30 },
    { id: 3, email: 'c@x.com', amount_cents: 4200, created_at: 20 },
  ];
  assert.equal(pickWinner(bids).id, 3);
  assert.equal(pickWinner(bids, new Set(['c@x.com'])).id, 2);
  assert.equal(pickWinner(bids, new Set(['c@x.com', 'b@x.com'])).id, 1);
  assert.equal(pickWinner([]), null);
  assert.equal(pickWinner(bids, new Set(['a@x.com', 'b@x.com', 'c@x.com'])), null);
});

test('the screen\'s answer becomes a verdict, and doubt goes to a person', () => {
  const ctx = { amountCents: 2000, ratePerHour: 200 };
  const allow = { decision: 'allow', category: 'none', name_ok: true, est_minutes: 5, est_cost_dollars: 0, needs_quote: false, reason: '' };
  assert.equal(applyScreen(allow, ctx).status, 'qualified'); // $20 covers 6 minutes
  assert.equal(applyScreen({ ...allow, est_minutes: 50, est_cost_dollars: 4 }, ctx).status, 'short');
  assert.equal(applyScreen({ ...allow, est_minutes: 5.2 }, ctx).estMinutes, 6); // rounded up, on the high side
  assert.deepEqual(applyScreen({ ...allow, decision: 'refuse', category: 'appearance' }, ctx),
    { status: 'refused', category: 'appearance', message: REFUSALS.appearance });
  assert.equal(applyScreen({ ...allow, decision: 'refuse', category: 'made-up' }, ctx).category, 'other');
  assert.equal(applyScreen({ ...allow, name_ok: false }, ctx).category, 'name');
  for (const doubtful of [
    { ...allow, decision: 'unsure' }, { ...allow, needs_quote: true }, { ...allow, est_minutes: 0 },
    { ...allow, est_minutes: -3 }, { ...allow, est_minutes: 'lots' }, { ...allow, est_cost_dollars: -1 },
    { ...allow, est_minutes: 1e9 }, null, 'nope',
  ]) assert.deepEqual(applyScreen(doubtful, ctx), { status: 'held', message: HELD_MESSAGE });
});

test('a one-cent bid can win a job that takes seconds, and nothing bigger', () => {
  const wave = { decision: 'allow', category: 'none', name_ok: true, est_minutes: 0.1, est_cost_dollars: 0, needs_quote: false, reason: '' };
  assert.equal(applyScreen(wave, { amountCents: 1, ratePerHour: 200 }).status, 'qualified');
  assert.equal(applyScreen({ ...wave, est_minutes: 1 }, { amountCents: 1, ratePerHour: 200 }).status, 'short');
});
