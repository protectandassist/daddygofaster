// Our own visitor counts and the owner's Reports page. No cookies, no outside
// service, no ad trackers.
//
// The page reports a few moments: it was opened, how long it was looked at,
// a named button was tapped, someone started a bid, a bid went in, a card was
// declined, money was added to a job, a sign-in link was asked for. Each is
// stored with the day, phone or computer, where the visitor came from (host
// name only), roughly where they are (city, from the network edge), and a
// visitor mark: a hash of the network address, the day and a secret, so the
// same person on the same day is one visitor and the mark changes every day.
// The network address itself is kept for 30 days, to tell visits apart and to
// spot abuse, and then cleared. Rows are deleted after 400 days.
import { sha256 } from './store.js';
import { localParts, dayShift } from './rules.js';

const KINDS = new Set(['view', 'hide', 'tap', 'start', 'placed', 'declined', 'pledged', 'signup']);
// What a tap may be called. Fixed names only: nothing a visitor typed is ever stored.
const TAPS = new Set([
  'Practical tab', 'Entertaining tab', 'Used an idea', 'Picked a practical job', 'Next idea', 'Previous idea', 'Picked an idea picture',
  'Shuffled ideas', 'Chip in', 'Voted', 'Opened comments', 'Posted a comment', 'Open job chosen', 'Sound off', 'Sound on',
  'Notifications turned on', 'How it works', 'YouTube link', 'Place a bid button',
]);
const PER_VISITOR_PER_DAY = 300;
const ADDRESS_DAYS = 30;
const KEEP_DAYS = 400;
const VISIT_GAP_MS = 30 * 60_000; // quiet for this long and the next thing is a new visit
const MAX_ROWS = 20_000;
const BOT = /bot|crawl|spider|slurp|preview|monitor|headless|lighthouse|pingdom|uptime|facebookexternalhit|curl|wget|python|node-fetch|playwright|puppeteer/i;

export function today(now, tz) {
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

const clean = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

// POST /a  { e: kind, r: referrer, l: label, s: seconds, u: campaign }
// Sent as plain text so the browser needs no preflight. Always answered 204.
export async function record(request, env, s, now) {
  const agent = request.headers.get('User-Agent') || '';
  if (!agent || BOT.test(agent)) return;
  const text = await request.text();
  if (text.length > 700) return;
  let body;
  try { body = JSON.parse(text); } catch { return; }
  const kind = body && typeof body.e === 'string' ? body.e : '';
  if (!KINDS.has(kind)) return;
  const label = kind === 'tap' && TAPS.has(body.l) ? body.l : null;
  if (kind === 'tap' && !label) return;

  const day = today(now, s.tz);
  const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 45) || null;
  const visitor = (await sha256((ip || 'unknown') + '|' + day + '|' + (env.VAULT_KEY || 'stats'))).slice(0, 16);
  const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE day = ? AND visitor = ?').bind(day, visitor).first();
  if (seen.n >= PER_VISITOR_PER_DAY) return;

  let ref = kind === 'view' ? hostOf(body.r) : null;
  const own = hostOf(s.siteUrl);
  if (ref && (ref === own || ref.endsWith('.' + own))) ref = null; // moving around our own site is not a referral
  const cf = request.cf || {};
  const secs = kind === 'hide' && Number.isFinite(Number(body.s)) ? Math.max(0, Math.min(86_400, Math.round(Number(body.s)))) : null;
  const src = kind === 'view' && typeof body.u === 'string' && /^[\w .-]{1,40}$/.test(body.u) ? body.u : null;
  await env.DB.prepare(
    'INSERT INTO events (day, at, kind, visitor, ref, device, ip, country, region, city, label, secs, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    day, now, kind, visitor, ref, /Mobi|Android|iPhone|iPad/i.test(agent) ? 'phone' : 'computer',
    ip, clean(cf.country, 2), clean(cf.region, 60), clean(cf.city, 60), label, secs, src,
  ).run();
}

// Run by the timer: addresses go after 30 days, everything after 400.
export async function tidy(env, now) {
  await env.DB.batch([
    env.DB.prepare('UPDATE events SET ip = NULL WHERE ip IS NOT NULL AND at < ?').bind(now - ADDRESS_DAYS * 86_400_000),
    env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now - KEEP_DAYS * 86_400_000),
  ]);
}

// ---- the report -------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Which days the report covers: today, yesterday, the last N days, or two picked dates.
export function window_(query, now, tz) {
  const end = today(now, tz);
  const period = query.get('period');
  if (period === 'today') return { from: end, to: end, period: 'today' };
  if (period === 'yesterday') return { from: dayShift(end, -1), to: dayShift(end, -1), period: 'yesterday' };
  const from = query.get('from'), to = query.get('to');
  if (DAY.test(from || '') && DAY.test(to || '')) {
    const last = to > end ? end : to;
    const first = from > last ? last : from < dayShift(end, -KEEP_DAYS) ? dayShift(end, -KEEP_DAYS) : from;
    return { from: first, to: last, period: 'custom' };
  }
  const days = [7, 30, 90].includes(Number(query.get('days'))) ? Number(query.get('days')) : 30;
  return { from: dayShift(end, -(days - 1)), to: end, period: 'last', days };
}

const SOURCES = [
  [/(^|\.)youtube\.com$|^youtu\.be$/, 'YouTube'], [/(^|\.)google\./, 'Google search'], [/(^|\.)bing\.com$/, 'Bing search'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo search'], [/(^|\.)facebook\.com$|^fb\.me$|^l\.facebook\.com$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'], [/(^|\.)tiktok\.com$/, 'TikTok'], [/^t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/, 'X (Twitter)'],
  [/(^|\.)reddit\.com$/, 'Reddit'], [/(^|\.)etsy\.com$/, 'Etsy'], [/(^|\.)daddygofaster\.com$/, 'The old daddygofaster.com address'],
];
function sourceName(ref, src) {
  if (src) return 'Tagged link: ' + src;
  if (!ref) return 'Typed in, a saved link, or an app';
  for (const [test, name] of SOURCES) if (test.test(ref)) return name;
  return ref;
}

const placeName = (r) => [r.city, r.region, r.country].filter(Boolean).join(', ') || 'Unknown';
const WHAT = { view: 'Opened the site', start: 'Started a bid', placed: 'Placed a bid', declined: 'Card was declined', pledged: 'Added money to a job', signup: 'Asked for a sign-in link' };

function tally(map, key, visitor) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(visitor);
}
const ranked = (map, limit = 15) => [...map].map(([name, set]) => ({ name, visitors: set.size })).sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name)).slice(0, limit);

// GET /admin/api/report?period=today | yesterday,  ?days=7|30|90,  ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function report(env, s, now, query) {
  const w = window_(query, now, s.tz);
  const { results: rows } = await env.DB.prepare(
    'SELECT day, at, kind, visitor, ref, device, ip, country, region, city, label, secs, src FROM events WHERE day >= ? AND day <= ? ORDER BY at LIMIT ?',
  ).bind(w.from, w.to, MAX_ROWS + 1).all();
  const partial = rows.length > MAX_ROWS;
  if (partial) rows.length = MAX_ROWS;

  // Visits: one visitor's moments, split wherever they went quiet for half an hour.
  const byVisitor = new Map();
  for (const r of rows) {
    if (!byVisitor.has(r.visitor)) byVisitor.set(r.visitor, []);
    byVisitor.get(r.visitor).push(r);
  }
  const visits = [];
  for (const list of byVisitor.values()) {
    let visit = null;
    for (const r of list) {
      if (!visit || r.at - visit.last > VISIT_GAP_MS) {
        visit = { visitor: r.visitor, day: r.day, start: r.at, last: r.at, rows: [] };
        visits.push(visit);
      }
      visit.rows.push(r); visit.last = r.at;
    }
  }

  const days = new Map();
  for (let d = w.from; d <= w.to; d = dayShift(d, 1)) days.set(d, { day: d, visitors: new Set(), visits: 0, views: 0, starts: 0, placed: 0, declined: 0, pledged: 0, signups: 0 });
  const sources = new Map(), places = new Map(), devices = new Map(), taps = new Map();
  const reached = { view: new Set(), start: new Set(), placed: new Set() };
  const list = [], people = new Set();
  for (const v of visits) {
    const first = v.rows.find((r) => r.kind === 'view');
    if (!first) continue; // a stray moment with no page open is not a visit
    const d = days.get(v.day);
    if (!d) continue;
    d.visits++; d.visitors.add(v.visitor); people.add(v.day + '|' + v.visitor);
    let looked = 0;
    for (const r of v.rows) {
      if (r.kind === 'view') d.views++;
      else if (r.kind === 'start') d.starts++;
      else if (r.kind === 'placed') d.placed++;
      else if (r.kind === 'declined') d.declined++;
      else if (r.kind === 'pledged') d.pledged++;
      else if (r.kind === 'signup') d.signups++;
      else if (r.kind === 'tap') tally(taps, r.label, v.visitor);
      else if (r.kind === 'hide') looked = Math.max(looked, r.secs || 0);
      if (reached[r.kind]) reached[r.kind].add(v.visitor);
    }
    const source = sourceName(first.ref, first.src), place = placeName(first);
    tally(sources, source, v.visitor); tally(places, place, v.visitor); tally(devices, first.device || 'unknown', v.visitor);
    list.push({
      at: new Date(v.start).toISOString(), day: v.day, visitor: v.visitor.slice(0, 6), place, source, device: first.device,
      address: first.ip || null, // null once it is 30 days old
      seconds: looked || (v.last - v.start >= 3000 ? Math.round((v.last - v.start) / 1000) : null), // null means not known, never "0"
      trail: v.rows.filter((r) => r.kind !== 'hide').map((r) => ({ at: new Date(r.at).toISOString(), what: r.kind === 'tap' ? r.label : WHAT[r.kind] })),
    });
  }
  list.sort((a, b) => (a.at < b.at ? 1 : -1));

  const byDay = [...days.values()].map((d) => ({ ...d, visitors: d.visitors.size })).reverse();
  const totals = byDay.reduce((t, d) => {
    for (const k of ['visits', 'views', 'starts', 'placed', 'declined', 'pledged', 'signups']) t[k] += d[k];
    return t;
  }, { visitors: people.size, visits: 0, views: 0, starts: 0, placed: 0, declined: 0, pledged: 0, signups: 0 });
  return {
    from: w.from, to: w.to, period: w.period, days: w.days ?? null, partial,
    totals, byDay,
    funnel: [
      { step: 'Opened the site', visitors: reached.view.size },
      { step: 'Started a bid', visitors: reached.start.size },
      { step: 'Placed a bid', visitors: reached.placed.size },
    ],
    sources: ranked(sources), places: ranked(places), devices: ranked(devices), taps: ranked(taps, 25),
    visits: list.slice(0, 300), moreVisits: Math.max(0, list.length - 300),
  };
}
