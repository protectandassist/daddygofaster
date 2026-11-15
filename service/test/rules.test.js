import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money, minCentsFor, coveredMinutes, timeAllowance, approveDuration, describeMinutes, validateBid, decide,
  checkReply, taskKey, localParts, zonedToUtc, dayShift, nominalAuction, extendedClose, pickWinner, applyScreen, raiseVerdict, resolveStandings, validateMax, validateRaise, LIMITS, REFUSALS, HELD_MESSAGE,
  holdTarget, extraHold, captureSlice, validatePledge,
} from '../src/rules.js';

const TZ = 'America/Chicago';
const at = (iso) => new Date(iso).getTime();

test('winning bids include the first hour and add whole hours at each $200 boundary', () => {
  for (const cents of [1, 1000, 19900, 19999]) assert.equal(coveredMinutes(cents), 60);
  for (const cents of [20000, 20500, 21000, 29900, 39900, 39999]) assert.equal(coveredMinutes(cents), 120);
  for (const cents of [40000, 40001, 59999]) assert.equal(coveredMinutes(cents), 180);
  assert.equal(coveredMinutes(60000), 240);
  for (const minutes of [0.1, 1, 50, 60]) assert.equal(minCentsFor(minutes), 1);
  for (const minutes of [60.01, 90, 120]) assert.equal(minCentsFor(minutes), 20000);
  for (const minutes of [120.01, 150, 180]) assert.equal(minCentsFor(minutes), 40000);
  assert.equal(timeAllowance(19900), 'Up to 1 hour');
  assert.equal(timeAllowance(21000), 'Up to 2 hours');
  assert.equal(money(21000), '$210.00');
});

test('the owner chooses duration within the current bid cap', () => {
  assert.equal(approveDuration(1000, 60).ok, true);
  assert.equal(approveDuration(19900, 60).ok, true);
  assert.equal(approveDuration(19900, 60.01).ok, false);
  for (const amount of [20000, 20500, 21000, 29900, 39900, 39999]) {
    assert.equal(approveDuration(amount, 90).ok, true);
    assert.equal(approveDuration(amount, 120).ok, true);
    assert.equal(approveDuration(amount, 120.01).ok, false);
  }
  assert.equal(approveDuration(40000, 180).ok, true);
  assert.equal(approveDuration(40000, 181).ok, false);
  for (const invalid of [0, -1, NaN, Infinity]) assert.equal(approveDuration(21000, invalid).ok, false);
});

test('durations read naturally', () => {
  assert.equal(describeMinutes(0.3), 'under a minute');
  assert.equal(describeMinutes(1), 'about 1 minute');
  assert.equal(describeMinutes(50), 'about 50 minutes');
  assert.equal(describeMinutes(60), 'about 1 hour');
  assert.equal(describeMinutes(150), 'about 2 hours 30 minutes');
});

test('a low bid cannot authorize a job above its one-hour cap', () => {
  const r = decide({ amountCents: 200, estMinutes: 480 });
  assert.equal(r.status, 'short');
  assert.equal(r.minCents, 140000);
  assert.match(r.message, /Up to 1 hour/);
  assert.match(r.message, /\$1,400\.00/);
});

test('one-hour jobs qualify at any bid; longer jobs require owner review and costs stay separate', () => {
  const ok = decide({ amountCents: 1, estMinutes: 50, estCostCents: 400 });
  assert.equal(ok.status, 'qualified');
  assert.equal(ok.minCents, 1);
  assert.match(ok.message, /costs of \$4\.00, with taxes and fees included\. They are added on top of your bid/);
  const review = decide({ amountCents: 21000, estMinutes: 120, estCostCents: 400 });
  assert.equal(review.status, 'held');
  assert.equal(review.minCents, 20000);
  assert.match(review.message, /actual time/);
  assert.match(review.message, /costs of \$4\.00, with taxes and fees included\. They are added on top of your bid/);
  const short = decide({ amountCents: 39999, estMinutes: 121 });
  assert.equal(short.status, 'short');
  assert.equal(short.minCents, 40000);
});

test('bids are validated and tidied', () => {
  const good = validateBid({ task: '  Walk to work   instead of driving. ', name: ' mike_r ', email: ' Mike@Example.COM ', amountCents: 50 });
  assert.deepEqual(good, { ok: true, value: { task: 'Walk to work instead of driving.', name: 'mike_r', email: 'mike@example.com', amountCents: 50, maxCents: null, notify: false } });
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
  const ctx = { amountCents: 2000,  };
  const allow = { decision: 'allow', category: 'none', name_ok: true, est_minutes: 5, est_cost_dollars: 0, needs_quote: false, reason: '' };
  assert.equal(applyScreen(allow, ctx).status, 'qualified'); // any bid includes up to 60 minutes
  assert.equal(applyScreen({ ...allow, est_minutes: 50, est_cost_dollars: 4 }, ctx).status, 'qualified');
  assert.equal(applyScreen({ ...allow, est_minutes: 90 }, ctx).status, 'short');
  // costs: the list is the total, labels are cut down to plain words, and the bidder is told
  const priced = applyScreen({ ...allow, est_minutes: 50, est_cost_dollars: 99, cost_items: [
    { item: 'Bus fare', dollars: 5 }, { item: 'Poster board <b>& markers</b>', dollars: 7.58 }, { item: '', dollars: 3 }, { item: 'Free thing', dollars: 0 },
  ] }, ctx);
  assert.equal(priced.estCostCents, 1258);
  assert.deepEqual(priced.costItems, [{ item: 'Bus fare', cents: 500 }, { item: 'Poster board b & markers b', cents: 758 }]);
  assert.match(priced.message, /costs of \$12\.58 \(Bus fare \$5\.00, Poster board b & markers b \$7\.58\), with taxes and fees included\. They are added on top of your bid if you win\./);
  assert.equal(applyScreen({ ...allow, est_minutes: 50, est_cost_dollars: 4 }, ctx).estCostCents, 400); // a bare total still counts
  assert.equal(applyScreen({ ...allow, est_minutes: 50, cost_items: [] }, ctx).message.includes('costs'), false);
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

test('a one-cent bid can qualify through exactly sixty minutes', () => {
  const job = { decision: 'allow', category: 'none', name_ok: true, est_cost_dollars: 0, needs_quote: false, reason: '' };
  for (const minutes of [0.1, 1, 30, 59.9, 60]) {
    const r = applyScreen({ ...job, est_minutes: minutes }, { amountCents: 1 });
    assert.equal(r.status, 'qualified');
    assert.equal(r.minCents, 1);
  }
  assert.equal(applyScreen({ ...job, est_minutes: 60.01 }, { amountCents: 1 }).status, 'short');
  assert.equal(applyScreen({ ...job, est_minutes: 120 }, { amountCents: 21000 }).status, 'held');
});

test('raises preserve owner approval and apply the new caps instead of stale hourly prices', () => {
  const qualified = { amount_cents: 4200, status: 'qualified', est_minutes: 5, est_cost_cents: 0, min_cents: 1667 };
  assert.equal(raiseVerdict(qualified, 4200).ok, false);
  assert.equal(raiseVerdict(qualified, 100).ok, false);
  assert.equal(raiseVerdict(qualified, 5000).status, 'qualified');
  const oldShort = { amount_cents: 2000, status: 'short', est_minutes: 50, est_cost_cents: 400, min_cents: 16667 };
  const reevaluated = raiseVerdict(oldShort, 2100);
  assert.equal(reevaluated.status, 'qualified');
  assert.equal(reevaluated.minCents, 1);
  const long = { amount_cents: 19900, status: 'short', est_minutes: 120, est_cost_cents: 0, min_cents: 20000 };
  assert.equal(raiseVerdict(long, 21000).status, 'held');
  const approved = { ...long, amount_cents: 21000, status: 'qualified', screened_by: 'owner' };
  assert.equal(raiseVerdict(approved, 22000).status, 'qualified');
  assert.match(raiseVerdict(approved, 22000).message, /agreed time stays the same/);
  const held = { amount_cents: 900, status: 'held', est_minutes: null, min_cents: null };
  assert.equal(raiseVerdict(held, 1500).status, 'held');
  const legacyOwner = { ...held, status: 'qualified', screened_by: 'owner' };
  assert.equal(raiseVerdict(legacyOwner, 1500).status, 'qualified');
});

test('a maximum is optional, at least the bid, and never below it', () => {
  assert.deepEqual(validateMax(undefined, 500), { ok: true, value: null });
  assert.deepEqual(validateMax(8000, 500), { ok: true, value: 8000 });
  assert.deepEqual(validateMax(500, 500), { ok: true, value: null }); // same as the bid: no auto-bid
  assert.equal(validateMax(400, 500).ok, false);
  assert.equal(validateMax('80', 500).ok, false);
  assert.equal(validateMax(LIMITS.maxCents + 1, 500).ok, false);
  assert.deepEqual(validateRaise({ amountCents: 600, maxCents: 900 }), { ok: true, value: { amountCents: 600, maxCents: 900 } });
  assert.equal(validateRaise({ amountCents: 0 }).ok, false);
  const base = { task: 'Walk to work instead of driving.', name: 'mike_r', email: 'm@example.com', amountCents: 100 };
  assert.equal(validateBid({ ...base, maxCents: 50 }).ok, false);
  assert.deepEqual(validateBid({ ...base, maxCents: 900, notify: true }).value, { ...base, maxCents: 900, notify: true });
});

test('raising can lift the bid, the maximum, or both, and neither comes down', () => {
  const mine = { amount_cents: 4200, max_cents: 6000, status: 'qualified', est_minutes: 5, est_cost_cents: 0, min_cents: 1667 };
  assert.equal(raiseVerdict(mine, 4200, 6000).ok, false); // nothing went up
  assert.equal(raiseVerdict(mine, 3000, 5000).ok, false);
  const higherMax = raiseVerdict(mine, 4200, 9000);
  assert.deepEqual([higherMax.amountCents, higherMax.maxCents, higherMax.status], [4200, 9000, 'qualified']);
  const higherBid = raiseVerdict(mine, 5000);
  assert.deepEqual([higherBid.amountCents, higherBid.maxCents], [5000, 6000]); // the old maximum still stands
  const past = raiseVerdict(mine, 7000);
  assert.deepEqual([past.amountCents, past.maxCents], [7000, null]); // bid went past the maximum
  const lowTyped = raiseVerdict(mine, 100, 8000);
  assert.deepEqual([lowTyped.amountCents, lowTyped.maxCents], [4200, 8000]); // the bid never drops
});

test('auto-bids answer each other: highest maximum leads at one cent over the next', () => {
  const at = (id, amount, max, t) => ({ id, amount_cents: amount, max_cents: max, created_at: t });
  const amounts = (bids) => { const r = resolveStandings(bids); return [r.leaderId, r.highCents, Object.fromEntries(r.amounts)]; };

  assert.deepEqual(amounts([]), [null, 0, {}]);
  assert.deepEqual(amounts([at(1, 4200, null, 1)]), [1, 4200, { 1: 4200 }]);                 // alone: nothing moves
  assert.deepEqual(amounts([at(1, 1000, 8000, 1)]), [1, 1000, { 1: 1000 }]);                 // a maximum alone does not raise the bid
  assert.deepEqual(amounts([at(1, 1000, 8000, 1), at(2, 2000, null, 2)]), [1, 2001, { 1: 2001, 2: 2000 }]); // defends at one cent over
  assert.deepEqual(amounts([at(1, 1000, 8000, 1), at(2, 2000, 5000, 2)]), [1, 5001, { 1: 5001, 2: 5000 }]); // two maximums
  assert.deepEqual(amounts([at(1, 1000, 8000, 1), at(2, 9000, null, 2)]), [2, 9000, { 1: 8000, 2: 9000 }]); // beaten: sits at its maximum
  assert.deepEqual(amounts([at(1, 1000, 8000, 1), at(2, 1000, 8000, 2)]), [1, 8000, { 1: 8000, 2: 8000 }]); // tie: first one in leads
  assert.deepEqual(amounts([at(1, 1000, 8000, 1), at(2, 7999, null, 2)]), [1, 8000, { 1: 8000, 2: 7999 }]); // capped at its own maximum
  assert.deepEqual(amounts([at(1, 500, null, 1), at(2, 300, null, 2), at(3, 100, 400, 3)]), [1, 500, { 1: 500, 2: 300, 3: 400 }]);
});

test('auto-bids can reach a time tier but never bypass owner duration approval', () => {
  const job = { decision: 'allow', category: 'none', name_ok: true, est_minutes: 90, est_cost_dollars: 0, needs_quote: false, reason: '' };
  const lifted = applyScreen(job, { amountCents: 2000, maxCents: 30000 });
  assert.deepEqual([lifted.status, lifted.amountCents, lifted.minCents], ['held', 20000, 20000]);
  assert.match(lifted.message, /actual time before approving/);
  const tooLow = applyScreen(job, { amountCents: 2000, maxCents: 19999 });
  assert.deepEqual([tooLow.status, tooLow.amountCents], ['short', 2000]);
  assert.equal(applyScreen(job, { amountCents: 21000 }).status, 'held');
  const included = applyScreen({ ...job, est_minutes: 60 }, { amountCents: 1, maxCents: 30000 });
  assert.deepEqual([included.status, included.amountCents, included.minCents], ['qualified', 1, 1]);
  const short = { amount_cents: 2000, max_cents: null, status: 'short', est_minutes: 90, est_cost_cents: 0, min_cents: 20000 };
  const raised = raiseVerdict(short, 2000, 30000);
  assert.deepEqual([raised.status, raised.amountCents, raised.maxCents], ['held', 20000, 30000]);
  assert.equal(raiseVerdict(short, 2000, 19999).status, 'short');
  const thirdHour = applyScreen({ ...job, est_minutes: 121 }, { amountCents: 21000, maxCents: 40000 });
  assert.deepEqual([thirdHour.status, thirdHour.amountCents, thirdHour.minCents], ['held', 40000, 40000]);
});

test('a hold covers the most a bid could reach, and never less than the card minimum', () => {
  assert.equal(holdTarget(1000), 1000);
  assert.equal(holdTarget(1000, 3000), 3000); // the hidden maximum is what is held
  assert.equal(holdTarget(1), 50); // cards cannot hold one cent
  assert.equal(holdTarget(1, 20), 50);
});

test('a raise holds only the difference', () => {
  assert.equal(extraHold(3000, 3000), 0);
  assert.equal(extraHold(2000, 3000), 0); // already held more than it needs
  assert.equal(extraHold(4000, 1000), 3000);
  assert.equal(extraHold(1001, 1000), 50); // a one-cent raise still has to hold the card minimum
  assert.equal(extraHold(1000, 0), 1000);
});

test('the winner is charged the winning amount, not everything held', () => {
  assert.equal(captureSlice(3000, 2001), 2001); // held the $30 maximum, won at $20.01
  assert.equal(captureSlice(1000, 4000), 1000); // this hold is only part of it
  assert.equal(captureSlice(50, 10), 0); // ten cents left over is let go
  assert.equal(captureSlice(1000, 0), 0);
  assert.equal(captureSlice(1000, -5), 0);
});

test('money added to an open job: a real name and email, and at least $2', () => {
  const ok = { name: 'Bea', email: 'Bea@Example.com', amountCents: 500 };
  assert.deepEqual(validatePledge(ok), { ok: true, value: { name: 'Bea', email: 'bea@example.com', amountCents: 500 } });
  assert.equal(validatePledge({ ...ok, amountCents: 199 }).ok, false); // under the minimum the card fee eats it
  assert.equal(validatePledge({ ...ok, amountCents: 200 }).ok, true);
  assert.equal(validatePledge({ ...ok, amountCents: 12.5 }).ok, false);
  assert.equal(validatePledge({ ...ok, amountCents: LIMITS.maxCents + 1 }).ok, false);
  assert.equal(validatePledge({ ...ok, email: 'nope' }).ok, false);
  assert.equal(validatePledge({ ...ok, name: 'x' }).ok, false);
  assert.equal(validatePledge(null).ok, false);
});

import { badLanguage, shouting, posesAsSite } from '../src/language.js';

test('ordinary comments get through, including words that only look rude', () => {
  for (const fine of [
    'Do it in the rain, no umbrella.', 'In for $5. He has to keep the stickers on.', 'Grape harvest in Scunthorpe?', 'Push it harder next time',
    'A cocktail on the cockpit, classic', 'Assess the class before you pass', 'Damn, that hill is hell', 'Document the torpedo run', 'Title it "bass night"',
    'Two miles is nothing. Make it uphill.', 'I would die laughing', 'No way he finishes it',
  ]) assert.equal(badLanguage(fine), null, fine);
});

test('swearing and slurs are caught, however they are dressed up', () => {
  for (const bad of ['fuck this', 'What the FUCK', 'sh1t idea', 'b!tch please', 'fuuuuuck', 'f u c k that', 'F.U.C.K', 'you a$$hole', 'total bullshit', 'what a d1ckhead', 'f4ggot', 'stfu']) {
    assert.equal(badLanguage(bad), 'language', bad);
  }
});

test('an attack on a person is caught as a threat', () => {
  for (const bad of ['kill yourself', 'Just go die already', 'I hope you die', 'i know where you live']) assert.equal(badLanguage(bad), 'threat', bad);
});

test('shouting is long and mostly capitals; short capitals are fine', () => {
  assert.equal(shouting('THIS IS THE WORST IDEA EVER POSTED'), true);
  assert.equal(shouting('OK'), false);
  assert.equal(shouting('NASA and the FBI walk into a bar'), false);
  assert.equal(shouting('Make it uphill, please.'), false);
});

test('a rude name cannot go on the board', () => {
  const bid = { task: 'Walk to the hardware store instead of driving.', email: 'a@b.co', amountCents: 500 };
  assert.equal(validateBid({ ...bid, name: 'sh1thead' }).ok, false);
  assert.equal(validateBid({ ...bid, name: 'Sandra' }).ok, true);
});

test('symbols standing in for letters, or hiding them, do not get swearing through', () => {
  for (const bad of ['Duk$fu¢k', 'fu*k', 'sh*t', 'f**k', 'c*nt', 'fu_ck', 'b*tch', 'f#ck you', '@sshole', 'b!t¢h', 'sh**', 'd*ckhead', 'mother f***er',
    'F_U_C_K', 'phu¢k', 'f***ing great', 'bull$h!t', 'a55hole', 'fµck', 'fμck', 'sh%t', 'fuсk']) {
    assert.equal(badLanguage(bad), 'language', bad);
  }
});

test('ordinary punctuation is not mistaken for a hidden letter', () => {
  for (const fine of ['mother-in-law says hi', 'one-hit wonder', 'dish-towel', 'well-known fact', "it's a co-op", 'U.S.A. all the way', '50/50 chance', '$5 says he quits',
    'rock&roll night', '5 stars *****', 'a** kicker maybe', 'snake_case name', 'save 50% today', '#1 fan', 'he said *wow*', 'wait—what', 'café olé']) {
    assert.equal(badLanguage(fine), null, fine);
  }
});

test('a job checked before bidding: allowed, needs a person, too long for the bid, or not allowed', () => {
  const allow = { decision: 'allow', category: 'none', name_ok: true, est_minutes: 30, est_cost_dollars: 0, cost_items: [], needs_quote: false, reason: '' };
  const ctx = { amountCents: 500, maxCents: null };
  const free = checkReply(applyScreen(allow, ctx));
  assert.deepEqual([free.verdict, free.costCents, free.costItems], ['ok', null, null]);
  assert.match(free.message, /allowed, and there is nothing extra to pay for/);
  const priced = checkReply(applyScreen({ ...allow, cost_items: [{ item: 'Bus fare', dollars: 5 }] }, ctx));
  assert.deepEqual([priced.verdict, priced.costCents, priced.costItems], ['ok', 500, [{ item: 'Bus fare', cents: 500 }]]);
  assert.match(priced.message, /This job is allowed\. It has costs of \$5\.00 \(Bus fare \$5\.00\), with taxes and fees included\. They are added on top of your bid, and charged only if you win\./);
  assert.equal(checkReply(null).verdict, 'review'); // no screen, or it could not answer
  assert.equal(checkReply(applyScreen({ ...allow, decision: 'unsure' }, ctx)).verdict, 'review');
  assert.equal(checkReply(applyScreen({ ...allow, needs_quote: true }, ctx)).verdict, 'review');
  const short = checkReply(applyScreen({ ...allow, est_minutes: 90, cost_items: [{ item: 'Bus fare', dollars: 5 }] }, ctx));
  assert.equal(short.verdict, 'short');
  assert.equal((short.message.match(/costs of/g) || []).length, 1);
  const no = checkReply(applyScreen({ ...allow, decision: 'refuse', category: 'humiliating' }, ctx));
  assert.deepEqual([no.verdict, no.message, no.costCents], ['refused', REFUSALS.humiliating, null]);
  assert.equal(taskKey('  Walk   FIVE miles '), 'walk five miles');
});

test('nobody can take a name that passes them off as the site or its staff', () => {
  for (const name of ['TorchHive', 'torch hive', 'T0rchH1ve', 'Torch_Hive_Official', 'TorchHive Support', 'torchive', 'Admin', 'admin', 'ADMIN', 'adm1n', '@dmin', 'Admin2',
    'admin_trevor', 'SiteAdmin', 'The Admin', 'Administrator', 'Moderator', 'mod', 'Mod Mike', 'Staff', 'TH Staff', 'Support', 'support team', 'Owner', 'the owner',
    'Official Mike', 'System', 'Help Desk', 'DaddyGoFaster', 'Protect and Assist', 'Billing', 'Team', 'Host', 'TorchHlve', 'Tоrchhive']) {
    assert.equal(posesAsSite(name), true, name);
  }
  for (const name of ['Mike R', 'mike_r', 'sarahk', 'Badminton Bob', 'Modesto', 'Model T', 'Helper Hank', 'Homeowner Joe', 'Teamster', 'Hostess', 'Torch', 'Hive Five',
    'Rooter', 'Team Rocket', 'Help Wanted', 'Staffordshire', 'Supportive Sue', 'Sam Owners', 'Gary2', 'tj88', 'lena_p', 'Coach D', 'Systematic']) {
    assert.equal(posesAsSite(name), false, name);
  }
  assert.equal(validateBid({ task: 'Walk to the store and back', name: 'TorchHive Admin', email: 'a@example.com', amountCents: 500 }).ok, false);
});

test('the reserve is fifty cents, so every winner can be charged', () => {
  const base = { task: 'Walk to work instead of driving.', name: 'mike_r', email: 'mike@example.com' };
  assert.deepEqual(validateBid({ ...base, amountCents: 49 }), { ok: false, error: 'The reserve is $0.50. Enter a bid of at least that.' });
  assert.equal(validateBid({ ...base, amountCents: 1 }).ok, false);
  assert.equal(validateBid({ ...base, amountCents: 50 }).ok, true);
  assert.equal(validateRaise({ amountCents: 49 }).ok, false);
  assert.equal(validateRaise({ amountCents: 50 }).ok, true);
});
