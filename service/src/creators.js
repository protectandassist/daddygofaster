// Creator pages. Anyone with an account can ask for a page of their own at
// torchhive.com/<name>: a name, a few lines about them, and where they stream.
// The owner approves each one before it is public. People can follow a creator
// to be told when bidding opens on that page.
//
// This is the first part of creator pages: the page itself. Bidding rounds per
// creator, payouts to them, and the site's share of each winning bid come next.
import { sendEmail } from './mail.js';
import { providerKey } from './store.js';
import { badLanguage, posesAsSite } from './language.js';
import { sessionUser, isAdminEmail } from './social.js';
import { twitchChannel } from './live.js';
import { cardKeys, createPayoutAccount, payoutSetupLink, payoutsReady, sendToCreator, readIntent } from './cards.js';
import { payoutSplit } from './rules.js';

const SLUG_OK = /^[a-z0-9](?:[a-z0-9-]{1,22})[a-z0-9]$/;
// Addresses the site itself uses, or might.
const TAKEN = new Set(['admin', 'live', 'overlay', 'privacy', 'reports', 'c', 'creators', 'creator', 'assets', 'service', 'legacy', 'scripts', 'api', 'www', 'mail', 'sw', 'manifest',
  'robots', 'sitemap', 'index', 'about', 'help', 'terms', 'login', 'signin', 'signup', 'account', 'bid', 'bids', 'board', 'rules', 'sponsors', 'sponsor', 'demo', 'stats', 'analytics', 'owner', 'home', 'new', 'me']);
const NAME_MAX = 40;
const BIO_MAX = 300;

const read = (request) => request.json().catch(() => null);

function handle(value, host) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: true, value: null };
  let name = null;
  if (/^@?[A-Za-z0-9._-]{2,40}$/.test(text)) name = text.replace(/^@/, '');
  else {
    try {
      const url = new URL(text);
      if (new RegExp('(^|\\.)' + host.replace('.', '\\.') + '$').test(url.hostname)) {
        const first = url.pathname.split('/').filter(Boolean)[0] || '';
        if (/^@?[A-Za-z0-9._-]{2,40}$/.test(first)) name = first.replace(/^@/, '');
      }
    } catch { /* not a link */ }
  }
  return name ? { ok: true, value: name } : { ok: false };
}

function publicView(c, extra = {}) {
  return {
    slug: c.slug, name: c.name, bio: c.bio,
    youtube: c.youtube ? 'https://www.youtube.com/@' + c.youtube : null,
    tiktok: c.tiktok ? 'https://www.tiktok.com/@' + c.tiktok : null,
    twitch: c.twitch ? 'https://www.twitch.tv/' + c.twitch : null,
    followers: c.followers ?? 0,
    ...extra,
  };
}

const WITH_FOLLOWERS = 'SELECT c.*, (SELECT COUNT(*) FROM creator_follows f WHERE f.creator_id = c.id) AS followers FROM creators c';

// GET /creators: everyone whose page is public, most followed first.
export async function listCreators(env) {
  const { results } = await env.DB.prepare(`${WITH_FOLLOWERS} WHERE c.status = 'live' ORDER BY followers DESC, c.id ASC LIMIT 100`).all();
  return [200, { creators: results.map((c) => publicView(c)), bidding: creatorsOpen(env) }];
}

// GET /creators/<slug>: one page. Before it is approved, only its owner and the site's owner can see it.
export async function getCreator(request, env, slug, now) {
  const c = await env.DB.prepare(`${WITH_FOLLOWERS} WHERE c.slug = ?`).bind(String(slug).toLowerCase()).first();
  const user = await sessionUser(request, env, now);
  const mine = Boolean(c && user && c.user_id === user.id);
  if (!c || (c.status !== 'live' && !mine && !(user && isAdminEmail(env, user.email)))) return [404, { message: 'There is no page at this address.' }];
  const following = user ? Boolean(await env.DB.prepare('SELECT 1 FROM creator_follows WHERE creator_id = ? AND user_id = ?').bind(c.id, user.id).first()) : false;
  return [200, publicView(c, { status: c.status, mine, following, bidding: creatorsOpen(env) && c.bidding === 1 && c.payouts_ready === 1 })];
}

// GET /me/creator: the signed-in person's own page, or null.
export async function myCreator(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in first.' }];
  const c = await env.DB.prepare(`${WITH_FOLLOWERS} WHERE c.user_id = ?`).bind(user.id).first();
  if (!c) return [200, { creator: null }];
  const ready = await refreshPayouts(env, c);
  const paid = await env.DB.prepare('SELECT COALESCE(SUM(paid_cents), 0) AS cents FROM payouts WHERE creator_id = ?').bind(c.id).first();
  return [200, { creator: publicView(c, {
    status: c.status, payouts: ready ? 'ready' : c.stripe_account ? 'started' : 'none', bidding: c.bidding === 1, biddingAllowed: creatorsOpen(env), paidCents: paid.cents,
  }) }];
}

// POST /me/creator { slug, name, bio, youtube, tiktok, twitch }: ask for a page, or change one.
export async function saveCreator(request, env, s, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in first.' }];
  if (user.blocked) return [403, { message: 'This account cannot have a page.' }];
  const body = await read(request);
  const owner = isAdminEmail(env, user.email);
  const existing = await env.DB.prepare('SELECT * FROM creators WHERE user_id = ?').bind(user.id).first();

  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > NAME_MAX) return [400, { message: `Use a name of 2 to ${NAME_MAX} characters.`, field: 'name' }];
  if (badLanguage(name)) return [400, { message: 'Pick a different name.', field: 'name' }];
  if (posesAsSite(name) && !owner) return [400, { message: 'That name is reserved. Pick another.', field: 'name' }];

  const bio = String(body?.bio ?? '').replace(/\s+/g, ' ').trim();
  if (bio.length > BIO_MAX) return [400, { message: `Keep the description to ${BIO_MAX} characters.`, field: 'bio' }];
  if (/https?:\/\/|www\./i.test(bio)) return [400, { message: 'Put links in the boxes for them, not in the description.', field: 'bio' }];
  if (badLanguage(bio)) return [400, { message: 'That description has language that is not allowed here.', field: 'bio' }];

  const youtube = handle(body?.youtube, 'youtube.com');
  if (!youtube.ok) return [400, { message: 'That does not look like a YouTube channel. Use the @handle or the channel link.', field: 'youtube' }];
  const tiktok = handle(body?.tiktok, 'tiktok.com');
  if (!tiktok.ok) return [400, { message: 'That does not look like a TikTok account. Use the @handle or the profile link.', field: 'tiktok' }];
  const twitch = body?.twitch ? twitchChannel(body.twitch) : null;
  if (body?.twitch && !twitch) return [400, { message: 'That does not look like a Twitch channel.', field: 'twitch' }];
  if (!youtube.value && !tiktok.value && !twitch) return [400, { message: 'Add at least one place you post or stream: YouTube, TikTok or Twitch.', field: 'youtube' }];

  // The address is chosen once. Changing it would break every link already shared.
  let slug = existing ? existing.slug : String(body?.slug ?? '').trim().toLowerCase();
  if (!existing) {
    if (!SLUG_OK.test(slug)) return [400, { message: 'The address can be 3 to 24 letters, numbers and dashes.', field: 'slug' }];
    if (TAKEN.has(slug) || badLanguage(slug) || (posesAsSite(slug) && !owner)) return [400, { message: 'That address is not available. Pick another.', field: 'slug' }];
    if (await env.DB.prepare('SELECT 1 FROM creators WHERE slug = ?').bind(slug).first()) return [400, { message: 'Someone already has that address. Pick another.', field: 'slug' }];
    try {
      await env.DB.prepare('INSERT INTO creators (user_id, slug, name, bio, youtube, tiktok, twitch, status, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(user.id, slug, name, bio, youtube.value, tiktok.value, twitch, owner ? 'live' : 'pending', now, owner ? now : null).run();
    } catch { return [400, { message: 'Someone already has that address. Pick another.', field: 'slug' }]; }
    // Tell the owner there is a page to look at.
    const to = String(env.ADMIN_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean)[0];
    const key = await providerKey(env, 'RESEND_API_KEY', 'mail_key');
    if (!owner && to && key && s.mailFrom) {
      await sendEmail(env, { key, from: s.mailFrom, to, subject: `${name} asked for a TorchHive page`, text: [
        `${name} asked for a creator page at ${s.siteUrl}/${slug}.`, '',
        bio || '(no description)', '',
        'It is not public until you approve it on the owner page, under Creators.',
      ].join('\n') });
    }
  } else {
    await env.DB.prepare('UPDATE creators SET name = ?, bio = ?, youtube = ?, tiktok = ?, twitch = ? WHERE id = ?')
      .bind(name, bio, youtube.value, tiktok.value, twitch, existing.id).run();
  }
  const c = await env.DB.prepare(`${WITH_FOLLOWERS} WHERE c.user_id = ?`).bind(user.id).first();
  return [200, { creator: publicView(c, { status: c.status }), created: !existing }];
}

// POST /creators/<slug>/follow { on }: be told when bidding opens on that page.
export async function followCreator(request, env, slug, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in to follow.' }];
  const c = await env.DB.prepare("SELECT id FROM creators WHERE slug = ? AND status = 'live'").bind(String(slug).toLowerCase()).first();
  if (!c) return [404, { message: 'There is no page at this address.' }];
  const body = await read(request);
  if (body?.on === false) await env.DB.prepare('DELETE FROM creator_follows WHERE creator_id = ? AND user_id = ?').bind(c.id, user.id).run();
  else await env.DB.prepare('INSERT OR IGNORE INTO creator_follows (creator_id, user_id, created_at) VALUES (?, ?, ?)').bind(c.id, user.id, now).run();
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM creator_follows WHERE creator_id = ?').bind(c.id).first();
  return [200, { following: body?.on !== false, followers: n.n }];
}

// ---- owner ----------------------------------------------------------------------

export async function adminCreators(env) {
  const { results } = await env.DB.prepare(
    `SELECT c.*, u.email, (SELECT COUNT(*) FROM creator_follows f WHERE f.creator_id = c.id) AS followers
     FROM creators c JOIN users u ON u.id = c.user_id ORDER BY c.status = 'pending' DESC, c.id DESC LIMIT 200`,
  ).all();
  return results.map((c) => ({ id: c.id, ...publicView(c), status: c.status, email: c.email, asked: new Date(c.created_at).toISOString() }));
}

// POST /admin/api/creators/<id>/(approve|pause): make a page public, or take it down.
export async function decideCreator(env, s, id, action, now) {
  const c = await env.DB.prepare('SELECT c.*, u.email FROM creators c JOIN users u ON u.id = c.user_id WHERE c.id = ?').bind(id).first();
  if (!c) return [404, { message: 'No such page.' }];
  const status = action === 'approve' ? 'live' : 'paused';
  await env.DB.prepare('UPDATE creators SET status = ?, approved_at = CASE WHEN ? = \'live\' THEN ? ELSE approved_at END WHERE id = ?').bind(status, status, now, id).run();
  if (status === 'live' && c.status !== 'live') {
    const key = await providerKey(env, 'RESEND_API_KEY', 'mail_key');
    if (key && s.mailFrom) {
      await sendEmail(env, { key, from: s.mailFrom, to: c.email, subject: 'Your TorchHive page is live', text: [
        `Your page is public: ${s.siteUrl}/${c.slug}`, '',
        'Share that link. People who follow you there are told when bidding opens on your page.',
      ].join('\n') });
    }
  }
  return [200, { status }];
}

// ---- bidding on a creator's page --------------------------------------------------

// Creator pages can take bids only when the site says so (CREATORS_OPEN), cards are on,
// the creator can be paid, and the creator has opened bidding.
export function creatorsOpen(env) {
  return env.CREATORS_OPEN === 'true' && Boolean(cardKeys(env));
}

function scopeFor(env, s, c) {
  return {
    ...s,
    open: creatorsOpen(env) && c.bidding === 1 && c.payouts_ready === 1,
    creatorId: c.id,
    creator: { slug: c.slug, name: c.name, bio: c.bio, youtube: c.youtube ? 'https://www.youtube.com/@' + c.youtube : null },
  };
}

// The settings a request works with when it is about a creator's page: that page's
// own round, open or not on its own. Null when there is no such public page.
export async function creatorScope(env, s, slug) {
  const c = await env.DB.prepare("SELECT * FROM creators WHERE slug = ? AND status = 'live'").bind(String(slug).toLowerCase()).first();
  return c ? scopeFor(env, s, c) : null;
}

// The signed-in person's own page, as a scope. Answers { scope, row, user } or { status, body }.
export async function ownCreator(request, env, s, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return { status: 401, body: { message: 'Sign in first.' } };
  const c = await env.DB.prepare('SELECT * FROM creators WHERE user_id = ?').bind(user.id).first();
  if (!c) return { status: 404, body: { message: 'You do not have a page yet.' } };
  return { scope: scopeFor(env, s, c), row: c, user };
}

// POST /me/creator/payouts: start, or carry on with, getting set up to be paid. Answers
// with a link to Stripe's own pages, where the creator gives Stripe their details.
export async function startPayouts(request, env, s, now) {
  const mine = await ownCreator(request, env, s, now);
  if (!mine.scope) return [mine.status, mine.body];
  const keys = cardKeys(env);
  if (!keys) return [503, { message: 'Payouts are not available yet.' }];
  const c = mine.row;
  if (c.status !== 'live') return [409, { message: 'Your page has to be approved before you set up payouts.' }];
  let account = c.stripe_account;
  if (!account) {
    account = await createPayoutAccount(env, keys.secret, { email: mine.user.email, slug: c.slug });
    if (!account) return [502, { message: 'Stripe could not start that just now. Try again in a minute.' }];
    await env.DB.prepare('UPDATE creators SET stripe_account = ? WHERE id = ? AND stripe_account IS NULL').bind(account, c.id).run();
  }
  if (await payoutsReady(env, keys.secret, account)) {
    await env.DB.prepare('UPDATE creators SET payouts_ready = 1 WHERE id = ?').bind(c.id).run();
    return [200, { ready: true }];
  }
  const url = await payoutSetupLink(env, keys.secret, account, `${s.siteUrl}/creators/?payouts=back#start`);
  return url ? [200, { ready: false, url }] : [502, { message: 'Stripe could not start that just now. Try again in a minute.' }];
}

// Has Stripe finished checking them? Asked when the creator looks at their own page.
async function refreshPayouts(env, c) {
  const keys = cardKeys(env);
  if (c.payouts_ready === 1) return true;
  if (!keys || !c.stripe_account) return false;
  const ready = await payoutsReady(env, keys.secret, c.stripe_account);
  if (ready) await env.DB.prepare('UPDATE creators SET payouts_ready = 1 WHERE id = ?').bind(c.id).run();
  return ready;
}

// POST /me/creator/bidding { on }: the creator opens or closes bidding on their page.
// Opening tells everyone who follows the page.
export async function setBidding(request, env, s, now) {
  const mine = await ownCreator(request, env, s, now);
  if (!mine.scope) return [mine.status, mine.body];
  const c = mine.row;
  const body = await read(request);
  if (body?.on !== true) {
    await env.DB.prepare('UPDATE creators SET bidding = 0 WHERE id = ?').bind(c.id).run();
    return [200, { bidding: false, message: 'Bidding is closed on your page. A round that is already running finishes at its closing time.' }];
  }
  if (c.status !== 'live') return [409, { message: 'Your page has to be approved first.' }];
  if (!creatorsOpen(env)) return [409, { message: 'Bidding on creator pages is not open yet. You will be told when it is.' }];
  if (!(await refreshPayouts(env, c))) return [409, { message: 'Set up payouts first, so there is somewhere to send your money.' }];
  await env.DB.prepare('UPDATE creators SET bidding = 1 WHERE id = ?').bind(c.id).run();
  // Followers are told, once a day at most.
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notices (user_id, kind, ref, subject, short, body, created_at)
     SELECT u.id, 'creator-open', ?1, ?2, ?3, ?4, ?5 FROM users u JOIN creator_follows f ON f.user_id = u.id
     WHERE f.creator_id = ?6 AND (u.alerts = 1 OR EXISTS (SELECT 1 FROM push_subs ps WHERE ps.user_id = u.id))`,
  ).bind(`${c.id}:${day}`, `${c.name} has opened bidding`, 'Bid on what they do next.', [
    `${c.name} has opened bidding on TorchHive.`, '',
    `Bid on what they do next: ${s.siteUrl}/?c=${c.slug}#bid`, '',
    `You are getting this because you follow ${c.name} and turned on alerts in your TorchHive account.`,
    `To stop them: ${s.apiUrl}/stop?u={stop}`,
  ].join('\n'), now, c.id).run();
  return [200, { bidding: true, message: 'Bidding is open on your page. Your followers are being told.' }];
}

// Run by the timer: sends each creator their share of the charges on their winning
// jobs, once a round's money is settled. A few charges per run; each charge is paid once.
export async function payCreators(env, key, now) {
  const { results } = await env.DB.prepare(
    `SELECT h.id AS hold_id, h.intent_id, h.captured_cents, b.id AS bid_id, b.day, c.id AS creator_id, c.stripe_account
     FROM holds h JOIN bids b ON b.id = h.bid_id JOIN auctions a ON a.day = b.day JOIN creators c ON c.id = b.creator_id
     WHERE b.creator_id > 0 AND b.win_state = 'won' AND h.state = 'captured' AND h.captured_cents > 0 AND a.money_state = 'done'
       AND c.stripe_account IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.hold_id = h.id)
     ORDER BY h.id LIMIT 6`,
  ).all();
  for (const h of results) {
    const split = payoutSplit(h.captured_cents);
    let transfer = null;
    if (split.pay > 0) {
      const seen = await readIntent(env, key, h.intent_id);
      const charge = seen.ok ? seen.data.latest_charge : null;
      if (!charge) continue; // try again next run
      transfer = await sendToCreator(env, key, { cents: split.pay, accountId: h.stripe_account, chargeId: charge, group: h.day, idempotencyKey: 'dgf-pay-' + h.intent_id });
      if (!transfer) continue; // not sent: nothing is recorded, so the next run tries again
    }
    await env.DB.prepare('INSERT OR IGNORE INTO payouts (hold_id, bid_id, creator_id, charged_cents, fee_cents, cut_cents, paid_cents, transfer_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(h.hold_id, h.bid_id, h.creator_id, h.captured_cents, split.fee, split.cut, split.pay, transfer, now).run();
  }
}
