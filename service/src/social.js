// Signing in, voting and commenting.
//
// Sign-in is a link sent to the person's email. There are no passwords. The
// link's code and the browser's session key are random, and only their hashes
// are stored, so the database alone cannot be used to sign in as anyone.
//
// Votes show interest in an open job; they never decide who wins. Comments on
// an open job come only from people who have put money on it, so there is a
// card behind every commenter.
import { sha256, randomHex, providerKey } from './store.js';
import { sendEmail } from './mail.js';
import { LIMITS } from './rules.js';
import { badLanguage, shouting, LANGUAGE_MESSAGES } from './language.js';
import { verifyGoogle } from './google.js';
import { setEmailAlerts } from './alerts.js';

const LOGIN_MINUTES = 20;
const SESSION_DAYS = 60;
const LINKS_PER_EMAIL_PER_HOUR = 5;
const LINKS_PER_IP_PER_HOUR = 20;
const NAME_CHANGE_MS = 86_400_000; // a username can be changed once a day
const COMMENT_MAX = 280;
const COMMENTS_PER_DAY = 20;
const COMMENT_GAP_MS = 20_000; // one person cannot post faster than this
const REPORTS_TO_HIDE = 3; // this many different people reporting a comment hides it until the owner looks
const NAME_OK = /^[\p{L}\p{N} ._-]+$/u;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HEX32 = /^[0-9a-f]{64}$/; // 32 random bytes
const JOB = /^[0-9a-f]{12}$/;

const read = (request) => request.json().catch(() => null);

// Can people sign in at all? By emailed link (needs the email key), with Google (needs the client id), or both.
export async function emailLinksOn(env, s) {
  return Boolean(s.mailFrom && (await providerKey(env, 'RESEND_API_KEY', 'mail_key')));
}
export async function signInOn(env, s) {
  return Boolean(env.GOOGLE_CLIENT_ID) || (await emailLinksOn(env, s));
}

// The signed-in person for this request, or null.
export async function sessionUser(request, env, now) {
  const key = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!HEX32.test(key)) return null;
  return env.DB.prepare(
    'SELECT u.id, u.email, u.name, u.name_at, u.alerts, u.blocked, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.key_hash = ? AND s.expires_at > ?',
  ).bind(await sha256(key), now).first();
}

// ---- signing in ---------------------------------------------------------------

export async function authStart(request, env, s, now) {
  const mail = await providerKey(env, 'RESEND_API_KEY', 'mail_key');
  if (!mail || !s.mailFrom) return [503, { message: 'Signing in is not available yet.' }];
  const body = await read(request);
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (email.length > LIMITS.emailMax || !EMAIL_OK.test(email)) return [400, { message: 'Check the email address.' }];

  const ipHash = await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + '|signin');
  const [byEmail, byIp] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM logins WHERE email = ? AND created_at > ?').bind(email, now - 3_600_000),
    env.DB.prepare('SELECT COUNT(*) AS n FROM logins WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - 3_600_000),
  ]);
  if (byEmail.results[0].n >= LINKS_PER_EMAIL_PER_HOUR || byIp.results[0].n >= LINKS_PER_IP_PER_HOUR) {
    return [429, { message: 'Too many sign-in links for now. Try again in an hour.' }];
  }
  const code = randomHex(32);
  await env.DB.prepare('INSERT INTO logins (email, code_hash, ip_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(email, await sha256(code), ipHash, now, now + LOGIN_MINUTES * 60_000).run();
  const sent = await sendEmail(env, {
    key: mail, from: s.mailFrom, to: email,
    subject: 'Your sign-in link',
    text: [
      'Use this link to sign in to TorchHive:',
      '',
      `${s.siteUrl}/#signin=${code}`,
      '',
      `It works once and for ${LOGIN_MINUTES} minutes. Open it in the same browser you asked from.`,
      'If you did not ask for this, ignore this email. Nobody can sign in without the link.',
    ].join('\n'),
  });
  if (!sent) return [502, { message: 'The email could not be sent just now. Try again in a minute.' }];
  // The same answer whether or not the address has been here before.
  return [200, { message: 'Check your email for a sign-in link. It works for 20 minutes.' }];
}

export async function authFinish(request, env, now) {
  const body = await read(request);
  const code = typeof body?.code === 'string' ? body.code : '';
  if (!HEX32.test(code)) return [400, { message: 'That sign-in link is not valid.' }];
  const hash = await sha256(code);
  // Used up in the same statement that checks it, so a link works once.
  const used = await env.DB.prepare('UPDATE logins SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').bind(now, hash, now).run();
  if (!used.meta.changes) return [400, { message: 'That sign-in link has been used or has run out. Ask for a new one.' }];
  const login = await env.DB.prepare('SELECT email FROM logins WHERE code_hash = ?').bind(hash).first();
  return [200, await startSession(env, login.email, now)];
}

// Makes the account on the first visit, and signs this browser in.
async function startSession(env, email, now, googleSub = null) {
  await env.DB.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(email, now).run();
  if (googleSub) await env.DB.prepare('UPDATE users SET google_sub = ? WHERE email = ? AND google_sub IS NULL').bind(googleSub, email).run();
  const user = await env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(email).first();
  const key = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (user_id, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(user.id, await sha256(key), now, now + SESSION_DAYS * 86_400_000).run();
  return { session: key, email: user.email, name: user.name ?? null };
}

// POST /auth/google { credential }: the signed note Google's button hands the page.
export async function authGoogle(request, env, now) {
  if (!env.GOOGLE_CLIENT_ID) return [503, { message: 'Signing in with Google is not available yet.' }];
  const body = await read(request);
  const who = await verifyGoogle(env, body?.credential, now);
  if (!who || who.email.length > LIMITS.emailMax) return [400, { message: 'Google sign-in did not work. Try again, or use an emailed link.' }];
  // Someone whose Google address has changed keeps the account their Google id made.
  const known = await env.DB.prepare('SELECT email FROM users WHERE google_sub = ?').bind(who.sub).first();
  return [200, await startSession(env, known ? known.email : who.email, now, who.sub)];
}

export async function authEnd(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (user) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(user.session_id).run();
  return [200, { message: 'Signed out.' }];
}

// ---- who am I, what have I voted for, where can I comment --------------------------

// Open jobs this person has money on: ones they posted, and ones they added to.
async function backedJobs(env, email) {
  const { results } = await env.DB.prepare(
    `SELECT b.pid FROM bids b WHERE b.email = ?1 AND b.shared = 1 AND b.status = 'qualified'
     UNION
     SELECT b.pid FROM pledges p JOIN bids b ON b.id = p.bid_id WHERE p.email = ?1 AND p.status IN ('active', 'paid') AND b.shared = 1`,
  ).bind(email).all();
  return results.map((r) => r.pid).filter(Boolean);
}

export async function getMe(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in first.' }];
  const { results } = await env.DB.prepare(
    "SELECT b.pid FROM votes v JOIN bids b ON b.id = v.bid_id JOIN auctions a ON a.day = b.day WHERE v.user_id = ? AND a.status = 'open'",
  ).bind(user.id).all();
  return [200, {
    email: user.email, name: user.name ?? null, emailAlerts: user.alerts === 1,
    votes: results.map((r) => r.pid), canComment: await backedJobs(env, user.email),
  }];
}

function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  return name.length >= LIMITS.nameMin && name.length <= LIMITS.nameMax && NAME_OK.test(name) ? name : null;
}

// Two usernames are the same when they match with capitals, spaces and punctuation
// taken out, so "Mike R" and "mike_r" cannot both exist.
export function nameKey(name) {
  return String(name).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Sets or changes the signed-in person's username. Answers { name } or { message }.
async function setName(env, user, value, now) {
  const name = cleanName(value);
  if (!name) return { message: `Use a username of ${LIMITS.nameMin} to ${LIMITS.nameMax} letters or numbers.` };
  if (name === user.name) return { name };
  const key = nameKey(name);
  if (key.length < LIMITS.nameMin) return { message: 'Use a username with at least two letters or numbers in it.' };
  if (badLanguage(name)) return { message: 'Pick a different username.' };
  if (user.name && user.name_at && now - user.name_at < NAME_CHANGE_MS) return { message: 'You changed your username today. You can change it again tomorrow.' };
  const taken = await env.DB.prepare('SELECT id FROM users WHERE name_key = ? AND id <> ?').bind(key, user.id).first();
  if (taken) return { message: 'Someone already has that username. Try another.' };
  try {
    await env.DB.prepare('UPDATE users SET name = ?, name_key = ?, name_at = ? WHERE id = ?').bind(name, key, now, user.id).run();
  } catch { // two people asked for it in the same moment
    return { message: 'Someone already has that username. Try another.' };
  }
  return { name };
}

// POST /me { name?, emailAlerts? }: the account's own settings.
export async function postMe(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in first.' }];
  const body = await read(request);
  let name = user.name ?? null;
  if (body?.name !== undefined) {
    const set = await setName(env, user, body.name, now);
    if (!set.name) return [400, { message: set.message, field: 'name' }];
    name = set.name;
  }
  if (typeof body?.emailAlerts === 'boolean') await setEmailAlerts(env, user, body.emailAlerts);
  return [200, { name, emailAlerts: typeof body?.emailAlerts === 'boolean' ? body.emailAlerts : user.alerts === 1 }];
}

// ---- votes ----------------------------------------------------------------------

// Sends { job, on }: on true to vote, false to take it back.
export async function postVote(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in to vote.' }];
  const body = await read(request);
  const pid = typeof body?.job === 'string' && JOB.test(body.job) ? body.job : '';
  const job = pid && await env.DB.prepare(
    "SELECT b.id FROM bids b JOIN auctions a ON a.day = b.day WHERE b.pid = ? AND b.shared = 1 AND b.status = 'qualified' AND a.status = 'open' AND a.closes_at > ?",
  ).bind(pid, now).first();
  if (!job) return [404, { message: 'That job is not open for votes.' }];
  if (body.on === false) await env.DB.prepare('DELETE FROM votes WHERE user_id = ? AND bid_id = ?').bind(user.id, job.id).run();
  else await env.DB.prepare('INSERT OR IGNORE INTO votes (user_id, bid_id, created_at) VALUES (?, ?, ?)').bind(user.id, job.id, now).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM votes WHERE bid_id = ?').bind(job.id).first();
  return [200, { job: pid, voted: body.on !== false, votes: count.n }];
}

// ---- comments -------------------------------------------------------------------

async function openJob(env, pid) {
  if (!JOB.test(pid || '')) return null;
  return env.DB.prepare("SELECT id, day, win_state FROM bids WHERE pid = ? AND shared = 1 AND status = 'qualified'").bind(pid).first();
}

export async function getComments(env, url) {
  const job = await openJob(env, url.searchParams.get('job'));
  if (!job) return [404, { message: 'No such job.' }];
  const { results } = await env.DB.prepare(
    "SELECT id, name, text, created_at FROM comments WHERE bid_id = ? AND status = 'shown' ORDER BY created_at DESC, id DESC LIMIT 50",
  ).bind(job.id).all();
  // Name, words and time. Never an email.
  return [200, { comments: results.reverse().map((c) => ({ id: c.id, name: c.name, text: c.text, at: new Date(c.created_at).toISOString() })) }];
}

export async function postComment(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in to comment.' }];
  if (user.blocked) return [403, { message: 'You can no longer comment here.' }];
  const body = await read(request);
  const job = await openJob(env, body?.job);
  if (!job) return [404, { message: 'That job is not open for comments.' }];
  const round = await env.DB.prepare('SELECT status FROM auctions WHERE day = ?').bind(job.day).first();
  if (round.status !== 'open' && job.win_state !== 'won') return [409, { message: 'Comments on that job are closed.' }];
  if (!(await backedJobs(env, user.email)).includes(body.job)) {
    return [403, { message: 'Add money to this job to comment on it. Use the same email you signed in with.' }];
  }
  const text = String(body?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 2) return [400, { message: 'Write a comment first.' }];
  if (text.length > COMMENT_MAX) return [400, { message: `Keep it to ${COMMENT_MAX} characters.` }];
  if (/https?:\/\/|www\./i.test(text)) return [400, { message: 'Links are not allowed in comments.' }];
  // Swearing, slurs, attacks on a person and shouting are turned away before anyone sees them.
  const trouble = badLanguage(text);
  if (trouble) return [400, { message: LANGUAGE_MESSAGES[trouble], rejected: trouble }];
  if (shouting(text)) return [400, { message: LANGUAGE_MESSAGES.shouting, rejected: 'shouting' }];
  let name = user.name;
  if (!name) {
    const set = await setName(env, user, body?.name, now);
    if (!set.name) return [400, { message: body?.name ? set.message : 'Pick a username to show beside your comment.', needName: true }];
    name = set.name;
  }
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?').bind(user.id, now - 86_400_000).first();
  if (today.n >= COMMENTS_PER_DAY) return [429, { message: 'That is a lot of comments for one day. Try again tomorrow.' }];
  // No storms: a pause between comments, and the same words cannot be posted again.
  const { results: mine } = await env.DB.prepare('SELECT text, created_at FROM comments WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').bind(user.id).all();
  if (mine.length && now - mine[0].created_at < COMMENT_GAP_MS) return [429, { message: 'Give it a moment before posting again.' }];
  if (mine.some((c) => c.text.toLowerCase() === text.toLowerCase())) return [400, { message: 'You already said that.' }];
  const made = await env.DB.prepare('INSERT INTO comments (bid_id, user_id, name, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(job.id, user.id, name, text, now).run();
  return [200, { comment: { id: made.meta.last_row_id, name, text, at: new Date(now).toISOString() }, name }];
}

// Anyone signed in can report a comment. One report each; enough of them hide it
// until the owner has looked.
export async function reportComment(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in to report a comment.' }];
  const body = await read(request);
  const id = Number(body?.id);
  const c = Number.isInteger(id) ? await env.DB.prepare("SELECT id, user_id FROM comments WHERE id = ? AND status = 'shown'").bind(id).first() : null;
  if (!c) return [404, { message: 'That comment is not there any more.' }];
  if (c.user_id === user.id) return [400, { message: 'That is your own comment.' }];
  await env.DB.prepare('INSERT OR IGNORE INTO comment_reports (comment_id, user_id, created_at) VALUES (?, ?, ?)').bind(id, user.id, now).run();
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id = ?').bind(id).first();
  if (count.n >= REPORTS_TO_HIDE) await env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE id = ? AND status = 'shown'").bind(id).run();
  return [200, { message: 'Thanks. It has been reported.', hidden: count.n >= REPORTS_TO_HIDE }];
}

// ---- owner ----------------------------------------------------------------------

// Reported comments first, then the newest. Hidden ones are included: they wait here for the owner.
export async function recentComments(env, day) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.text, c.status, c.created_at, b.name AS job_name,
            (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) AS reports
     FROM comments c JOIN bids b ON b.id = c.bid_id
     WHERE b.day = ? AND c.status IN ('shown', 'hidden') ORDER BY reports DESC, c.created_at DESC LIMIT 60`,
  ).bind(day).all();
  return results.map((c) => ({ id: c.id, name: c.name, text: c.text, on: c.job_name, hidden: c.status === 'hidden', reports: c.reports, at: new Date(c.created_at).toISOString() }));
}

export async function removeComment(env, id) {
  const r = await env.DB.prepare("UPDATE comments SET status = 'removed' WHERE id = ? AND status IN ('shown', 'hidden')").bind(id).run();
  return r.meta.changes ? [200, { status: 'removed' }] : [404, { message: 'No such comment.' }];
}

// A reported comment the owner is happy with goes back up, with its reports cleared.
export async function restoreComment(env, id) {
  const r = await env.DB.prepare("UPDATE comments SET status = 'shown' WHERE id = ? AND status = 'hidden'").bind(id).run();
  if (!r.meta.changes) return [404, { message: 'That comment is not hidden.' }];
  await env.DB.prepare('DELETE FROM comment_reports WHERE comment_id = ?').bind(id).run();
  return [200, { status: 'shown' }];
}

// Stops whoever wrote a comment from commenting again, and takes down everything they wrote.
export async function blockCommenter(env, id) {
  const c = await env.DB.prepare('SELECT user_id FROM comments WHERE id = ?').bind(id).first();
  if (!c) return [404, { message: 'No such comment.' }];
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET blocked = 1 WHERE id = ?').bind(c.user_id),
    env.DB.prepare("UPDATE comments SET status = 'removed' WHERE user_id = ? AND status IN ('shown', 'hidden')").bind(c.user_id),
  ]);
  return [200, { status: 'blocked' }];
}
