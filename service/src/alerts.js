// Alerts for people with an account: by email if they asked for emails, and on
// each device they turned notifications on for, even with the site closed.
//
// Every alert is first written to the `notices` table, one row per person per
// event, so the same thing is never told twice. Sending takes a row by marking
// it sent in the same statement that checks it, so two runs cannot both send it.
//
// What is told:
//   launch   bidding has opened (once, ever)
//   outbid   your bid, or a job you put money on, lost the lead
//   ending   a round you have money in closes within the hour
//   result   that round is over: you won, or you did not and nothing was charged
import { randomHex, getSetting, setSetting, providerKey } from './store.js';
import { sendEmail } from './mail.js';
import { money, roundCreator } from './rules.js';

const PER_RUN = 12; // notices sent per timer run: each is one email and up to three pushes
const PUSHES_PER_PERSON = 3;
const OUTBID_PER_BID = 3; // per round, like the outbid emails
const OUTBID_GAP_MS = 10 * 60_000;
const ENDING_MS = 60 * 60_000;
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (text) => {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// ---- device notifications (Web Push, no payload) ----------------------------------
// The push carries no words. It wakes the site's worker on the device, which asks
// POST /push/next for what to show. That keeps the message off the push services.

export function pushKey(env) {
  return env.VAPID_PUBLIC && env.VAPID_PRIVATE ? env.VAPID_PUBLIC : null;
}

function allowedEndpoint(env, endpoint) {
  try {
    const u = new URL(endpoint);
    if (env.PUSH_TEST_HOST && u.host === env.PUSH_TEST_HOST) return true; // local tests only
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
  } catch { return false; }
}

async function pushAuth(env, endpoint, now) {
  const pub = unb64url(env.VAPID_PUBLIC);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'mailto:hello@torchhive.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims));
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${env.VAPID_PUBLIC}`;
}

async function sendPush(env, sub, message, now) {
  try {
    await env.DB.prepare('UPDATE push_subs SET pending = ? WHERE id = ?').bind(JSON.stringify(message), sub.id).run();
    const res = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: await pushAuth(env, sub.endpoint, now) } });
    // The device has gone, or took notifications away: forget it.
    if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subs WHERE id = ?').bind(sub.id).run();
    else if (!res.ok) console.error('[PUSH] service answered', res.status);
    return res.ok;
  } catch (error) {
    console.error('[PUSH] failed', String(error));
    return false;
  }
}

// POST /push/sub { endpoint }: this device wants notifications for the signed-in person.
export async function pushSubscribe(env, user, body, now) {
  if (!pushKey(env)) return [503, { message: 'Notifications are not available yet.' }];
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  if (endpoint.length > 1000 || !allowedEndpoint(env, endpoint)) return [400, { message: 'This browser cannot get notifications from here.' }];
  await env.DB.prepare(
    'INSERT INTO push_subs (user_id, endpoint, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id',
  ).bind(user.id, endpoint, now).run();
  // Keep the newest few devices per person.
  await env.DB.prepare(
    'DELETE FROM push_subs WHERE user_id = ?1 AND id NOT IN (SELECT id FROM push_subs WHERE user_id = ?1 ORDER BY id DESC LIMIT 5)',
  ).bind(user.id).run();
  return [200, { message: 'Notifications are on for this device.' }];
}

// POST /push/unsub { endpoint }. Knowing the address is enough: it is the device's own secret.
export async function pushUnsubscribe(env, body) {
  if (typeof body?.endpoint === 'string') await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(body.endpoint).run();
  return [200, { message: 'Notifications are off for this device.' }];
}

// POST /push/next { endpoint }: the device collects the words for the push it just got.
export async function pushNext(env, body) {
  const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
  const sub = endpoint ? await env.DB.prepare('SELECT id, pending FROM push_subs WHERE endpoint = ?').bind(endpoint).first() : null;
  if (!sub || !sub.pending) return [200, { title: 'TorchHive', body: 'There is news on your bid.' }];
  await env.DB.prepare('UPDATE push_subs SET pending = NULL WHERE id = ?').bind(sub.id).run();
  try { return [200, JSON.parse(sub.pending)]; } catch { return [200, { title: 'TorchHive', body: 'There is news on your bid.' }]; }
}

// The page a round belongs to: the site's own, or a creator's. Ends where "#bid" can follow.
export async function pageUrl(env, s, dayKey) {
  const id = roundCreator(dayKey);
  const c = id ? await env.DB.prepare('SELECT slug FROM creators WHERE id = ?').bind(id).first() : null;
  return c ? `${s.siteUrl}/?c=${c.slug}` : `${s.siteUrl}/`;
}

// ---- writing notices ------------------------------------------------------------

// People who can be told anything: they asked for emails, or a device of theirs has notifications on.
const REACHABLE = '(u.alerts = 1 OR EXISTS (SELECT 1 FROM push_subs ps WHERE ps.user_id = u.id))';
// People with money in a round: they posted a job in it, or added to one.
const IN_ROUND = `(u.email IN (SELECT email FROM bids WHERE day = ?1 AND status = 'qualified')
  OR u.email IN (SELECT p.email FROM pledges p JOIN bids b ON b.id = p.bid_id WHERE b.day = ?1 AND p.status IN ('active', 'paid', 'released')))`;

function footer(s) {
  return ['', 'You are getting this because you turned on alerts in your TorchHive account.', `To stop them: ${s.apiUrl}/stop?u={stop}`];
}

// Whoever was leading and is not any more: the job's poster and everyone who added
// to it. Returns true when the poster will be emailed here, so the older per-bid
// outbid email is not sent as well.
export async function outbidNotices(env, s, bid, highCents, now) {
  const slot = Math.floor(now / OUTBID_GAP_MS);
  const told = await env.DB.prepare("SELECT COUNT(DISTINCT ref) AS n FROM notices WHERE kind = 'outbid' AND ref LIKE ?").bind(bid.id + ':%').first();
  if (told.n >= OUTBID_PER_BID) return false;
  const subject = 'You have been outbid';
  const short = `The high bid is now ${money(highCents)}. Open TorchHive to raise yours.`;
  const body = [
    'Someone has taken the lead on TorchHive.', '',
    `High bid now: ${money(highCents)}`, '',
    `Bidding is still open. To get back in front, go to ${await pageUrl(env, s, bid.day)}#bid.`,
    ...footer(s),
  ].join('\n');
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notices (user_id, kind, ref, subject, short, body, created_at)
     SELECT u.id, 'outbid', ?2, ?3, ?4, ?5, ?6 FROM users u
     WHERE ${REACHABLE} AND (u.email = ?7 OR u.email IN (SELECT email FROM pledges WHERE bid_id = ?1 AND status = 'active')) LIMIT 200`,
  ).bind(bid.id, `${bid.id}:${slot}`, subject, short, body, now, bid.email).run();
  const poster = await env.DB.prepare('SELECT alerts FROM users WHERE email = ?').bind(bid.email).first();
  return Boolean(poster && poster.alerts === 1);
}

// Run by the timer: the alerts that come from the clock rather than from a bid.
export async function roundNotices(env, s, now, cardSecret) {
  // Bidding has opened: once, ever, to everyone who asked. Never while the cards are in test mode.
  if (s.open && !/^sk_test_/.test(cardSecret || '') && !(await getSetting(env, 'launch_told'))) {
    await setSetting(env, 'launch_told', String(now), now);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO notices (user_id, kind, ref, subject, short, body, created_at)
       SELECT u.id, 'launch', 'first', ?1, ?2, ?3, ?4 FROM users u WHERE ${REACHABLE}`,
    ).bind('Bidding is open on TorchHive', 'The first round is open. Come and place your bid.', [
      'Bidding is open on TorchHive.', '',
      `The first round is running now: ${s.siteUrl}/#bid`, '',
      'You asked to be told when it opened.',
      ...footer(s),
    ].join('\n'), now).run();
  }

  // Closing within the hour.
  const { results: closing } = await env.DB.prepare(
    "SELECT day, closes_at FROM auctions WHERE status = 'open' AND closes_at > ? AND closes_at <= ? AND (noticed & 1) = 0",
  ).bind(now + 5 * 60_000, now + ENDING_MS).all();
  for (const a of closing) {
    const claim = await env.DB.prepare('UPDATE auctions SET noticed = noticed | 1 WHERE day = ? AND (noticed & 1) = 0').bind(a.day).run();
    if (!claim.meta.changes) continue;
    const top = await env.DB.prepare("SELECT MAX(amount_cents) AS c FROM bids WHERE day = ? AND status = 'qualified'").bind(a.day).first();
    const mins = Math.max(1, Math.round((a.closes_at - now) / 60_000));
    await env.DB.prepare(
      `INSERT OR IGNORE INTO notices (user_id, kind, ref, subject, short, body, created_at)
       SELECT u.id, 'ending', ?1, ?2, ?3, ?4, ?5 FROM users u WHERE ${REACHABLE} AND ${IN_ROUND}`,
    ).bind(a.day, 'Bidding closes soon', `About ${mins} minutes left. The high bid is ${money(top.c || 0)}.`, [
      `The round you have money in closes in about ${mins} minutes.`, '',
      `High bid now: ${money(top.c || 0)}`, '',
      `See where you stand: ${await pageUrl(env, s, a.day)}#board`,
      'A bid in the last few minutes moves the close back, so the time can run on.',
      ...footer(s),
    ].join('\n'), now).run();
  }

  // The result, once the money is dealt with, so what it says about cards is true.
  const { results: over } = await env.DB.prepare(
    "SELECT day, winner_bid_id FROM auctions WHERE status = 'closed' AND money_state = 'done' AND (noticed & 2) = 0 ORDER BY closed_at LIMIT 2",
  ).all();
  for (const a of over) {
    const claim = await env.DB.prepare('UPDATE auctions SET noticed = noticed | 2 WHERE day = ? AND (noticed & 2) = 0').bind(a.day).run();
    if (!claim.meta.changes) continue;
    const w = a.winner_bid_id ? await env.DB.prepare('SELECT id, email, amount_cents, pay_state FROM bids WHERE id = ?').bind(a.winner_bid_id).first() : null;
    const add = (who, binds, subject, short, lines) => env.DB.prepare(
      `INSERT OR IGNORE INTO notices (user_id, kind, ref, subject, short, body, created_at)
       SELECT u.id, 'result', ?1, ?2, ?3, ?4, ?5 FROM users u WHERE ${REACHABLE} AND ${who}`,
    ).bind(a.day, subject, short, [...lines, ...footer(s)].join('\n'), now, ...binds).run();
    if (w && w.pay_state !== 'failed') {
      await add('u.email = ?6', [w.email], 'You won the round', `Your job won at ${money(w.amount_cents)}.`, [
        `Your job won the round at ${money(w.amount_cents)}.`, '',
        'We will reach you at this email address about what happens next.',
      ]);
      await add("u.email IN (SELECT email FROM pledges WHERE bid_id = ?6 AND status IN ('active', 'paid'))", [w.id],
        'The job you backed won', `It won the round at ${money(w.amount_cents)}.`, [
          `The job you put money on won the round at ${money(w.amount_cents)}.`, '',
          `Watch for it on TorchHive: ${s.siteUrl}`,
        ]);
    }
    // Everyone else with money in the round. The winners above already have a row, so this one is ignored for them.
    await add(IN_ROUND, [], 'The round is over', 'Your bid did not win. You were not charged.', [
      'The round you had money in is over, and your bid did not win.', '',
      'You were not charged, and any hold on your card has been released.', '',
      `The next round is open now: ${await pageUrl(env, s, a.day)}#bid`,
    ]);
  }
}

// ---- sending --------------------------------------------------------------------

// Sends waiting notices, oldest first.
export async function sendNotices(env, s, now, limit = PER_RUN) {
  const mail = await providerKey(env, 'RESEND_API_KEY', 'mail_key');
  const { results } = await env.DB.prepare(
    `SELECT n.id, n.subject, n.short, n.body, u.id AS user_id, u.email, u.alerts, u.alerts_token
     FROM notices n JOIN users u ON u.id = n.user_id WHERE n.sent_at IS NULL AND n.created_at > ? ORDER BY n.id LIMIT ?`,
  ).bind(now - 6 * 3_600_000, limit).all(); // older than six hours is stale news: left unsent
  let sent = 0;
  for (const n of results) {
    const claim = await env.DB.prepare('UPDATE notices SET sent_at = ? WHERE id = ? AND sent_at IS NULL').bind(now, n.id).run();
    if (!claim.meta.changes) continue;
    if (n.alerts === 1 && mail && s.mailFrom) {
      await sendEmail(env, { key: mail, from: s.mailFrom, to: n.email, subject: n.subject, text: n.body.replace('{stop}', n.alerts_token || '') });
    }
    if (pushKey(env)) {
      const { results: subs } = await env.DB.prepare('SELECT id, endpoint FROM push_subs WHERE user_id = ? ORDER BY id DESC LIMIT ?').bind(n.user_id, PUSHES_PER_PERSON).all();
      for (const sub of subs) await sendPush(env, sub, { title: n.subject, body: n.short }, now);
    }
    sent++;
  }
  return sent;
}

// ---- the account's email switch ---------------------------------------------------

export async function setEmailAlerts(env, user, on) {
  if (on) {
    await env.DB.prepare('UPDATE users SET alerts = 1, alerts_token = COALESCE(alerts_token, ?) WHERE id = ?').bind(randomHex(16), user.id).run();
  } else {
    await env.DB.prepare('UPDATE users SET alerts = 0 WHERE id = ?').bind(user.id).run();
  }
}

// GET /stop?u=...: the link at the foot of every alert email.
export async function stopAlerts(env, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return false;
  const r = await env.DB.prepare('UPDATE users SET alerts = 0 WHERE alerts_token = ?').bind(token).run();
  return Boolean(r.meta.changes);
}
