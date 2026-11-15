// Our own visitor counts. No cookies, no outside service, nothing that follows
// a person from one day to the next.
//
// The page reports a handful of moments: it was opened, someone started a bid,
// a bid went in, a card was declined, money was added to a job, a sign-in link
// was asked for. Each is stored with the day, the kind of device, the site the
// visitor came from (host name only), and a visitor mark that is a hash of the
// network address, the day and a secret. The mark changes every day and cannot
// be turned back into an address; the address itself is never stored.
import { sha256 } from './store.js';
import { localParts } from './rules.js';

const KINDS = new Set(['view', 'start', 'placed', 'declined', 'pledged', 'signup']);
const PER_VISITOR_PER_DAY = 150;
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|pingdom|uptime|facebookexternalhit|curl|wget|python|node-fetch/i;

function today(now, tz) {
  const p = localParts(now, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function hostOf(value) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]{3,80}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

// POST /a  { e: kind, r: referrer }  (sent as plain text so the browser needs no preflight)
export async function record(request, env, s, now) {
  const agent = request.headers.get('User-Agent') || '';
  if (!agent || BOT.test(agent)) return [204, null];
  const text = await request.text();
  if (text.length > 600) return [204, null];
  let body;
  try { body = JSON.parse(text); } catch { return [204, null]; }
  const kind = body && typeof body.e === 'string' ? body.e : '';
  if (!KINDS.has(kind)) return [204, null];

  const day = today(now, s.tz);
  const visitor = (await sha256((request.headers.get('CF-Connecting-IP') || 'unknown') + '|' + day + '|' + (env.VAULT_KEY || 'stats'))).slice(0, 16);
  const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE day = ? AND visitor = ?').bind(day, visitor).first();
  if (seen.n >= PER_VISITOR_PER_DAY) return [204, null];

  let ref = hostOf(body.r);
  const own = hostOf(s.siteUrl);
  if (ref && (ref === own || ref.endsWith('.' + own))) ref = null; // moving around our own site is not a referral
  const device = /Mobi|Android|iPhone|iPad/i.test(agent) ? 'phone' : 'computer';
  await env.DB.prepare('INSERT INTO events (day, at, kind, visitor, ref, device) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(day, now, kind, visitor, kind === 'view' ? ref : null, device).run();
  return [204, null];
}

// GET /admin/api/stats?days=14
export async function stats(env, s, now, days) {
  const span = Math.min(90, Math.max(1, Number(days) || 14));
  const since = today(now - (span - 1) * 86_400_000, s.tz);
  const [byDay, refs, devices] = await env.DB.batch([
    env.DB.prepare(
      `SELECT day,
              COUNT(DISTINCT CASE WHEN kind = 'view' THEN visitor END) AS visitors,
              SUM(kind = 'view') AS views, SUM(kind = 'start') AS starts, SUM(kind = 'placed') AS placed,
              SUM(kind = 'declined') AS declined, SUM(kind = 'pledged') AS pledged, SUM(kind = 'signup') AS signups
       FROM events WHERE day >= ? GROUP BY day ORDER BY day DESC`,
    ).bind(since),
    env.DB.prepare(
      "SELECT COALESCE(ref, '(typed in, or unknown)') AS ref, COUNT(DISTINCT visitor) AS visitors FROM events WHERE day >= ? AND kind = 'view' GROUP BY ref ORDER BY visitors DESC LIMIT 12",
    ).bind(since),
    env.DB.prepare("SELECT device, COUNT(DISTINCT visitor) AS visitors FROM events WHERE day >= ? AND kind = 'view' GROUP BY device").bind(since),
  ]);
  return {
    days: span,
    byDay: byDay.results,
    referrers: refs.results,
    devices: devices.results,
  };
}
