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

const LOGIN_MINUTES = 20;
const SESSION_DAYS = 60;
const LINKS_PER_EMAIL_PER_HOUR = 5;
const LINKS_PER_IP_PER_HOUR = 20;
const COMMENT_MAX = 280;
const COMMENTS_PER_DAY = 20;
const NAME_OK = /^[\p{L}\p{N} ._-]+$/u;
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HEX32 = /^[0-9a-f]{64}$/; // 32 random bytes
const JOB = /^[0-9a-f]{12}$/;

const read = (request) => request.json().catch(() => null);

export async function signInOn(env, s) {
  return Boolean(s.mailFrom && (await providerKey(env, 'RESEND_API_KEY', 'mail_key')));
}

// The signed-in person for this request, or null.
export async function sessionUser(request, env, now) {
  const key = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!HEX32.test(key)) return null;
  return env.DB.prepare(
    'SELECT u.id, u.email, u.name, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.key_hash = ? AND s.expires_at > ?',
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
      'Use this link to sign in to DaddyGoFaster:',
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
  await env.DB.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(login.email, now).run();
  const user = await env.DB.prepare('SELECT id, email, name FROM users WHERE email = ?').bind(login.email).first();
  const key = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (user_id, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(user.id, await sha256(key), now, now + SESSION_DAYS * 86_400_000).run();
  return [200, { session: key, email: user.email, name: user.name ?? null }];
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
  return [200, { email: user.email, name: user.name ?? null, votes: results.map((r) => r.pid), canComment: await backedJobs(env, user.email) }];
}

function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  return name.length >= LIMITS.nameMin && name.length <= LIMITS.nameMax && NAME_OK.test(name) ? name : null;
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
  let name = user.name;
  if (!name) {
    name = cleanName(body?.name);
    if (!name) return [400, { message: `Add a name of ${LIMITS.nameMin} to ${LIMITS.nameMax} letters or numbers to show beside your comment.`, needName: true }];
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ? AND name IS NULL').bind(name, user.id).run();
  }
  const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND created_at > ?').bind(user.id, now - 86_400_000).first();
  if (today.n >= COMMENTS_PER_DAY) return [429, { message: 'That is a lot of comments for one day. Try again tomorrow.' }];
  const made = await env.DB.prepare('INSERT INTO comments (bid_id, user_id, name, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(job.id, user.id, name, text, now).run();
  return [200, { comment: { id: made.meta.last_row_id, name, text, at: new Date(now).toISOString() }, name }];
}

// ---- owner ----------------------------------------------------------------------

export async function recentComments(env, day) {
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.name, c.text, c.created_at, b.name AS job_name FROM comments c JOIN bids b ON b.id = c.bid_id WHERE b.day = ? AND c.status = 'shown' ORDER BY c.created_at DESC LIMIT 50",
  ).bind(day).all();
  return results.map((c) => ({ id: c.id, name: c.name, text: c.text, on: c.job_name, at: new Date(c.created_at).toISOString() }));
}

export async function removeComment(env, id) {
  const r = await env.DB.prepare("UPDATE comments SET status = 'removed' WHERE id = ? AND status = 'shown'").bind(id).run();
  return r.meta.changes ? [200, { status: 'removed' }] : [404, { message: 'No such comment.' }];
}
