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
  return [200, { creators: results.map((c) => publicView(c)) }];
}

// GET /creators/<slug>: one page. Before it is approved, only its owner and the site's owner can see it.
export async function getCreator(request, env, slug, now) {
  const c = await env.DB.prepare(`${WITH_FOLLOWERS} WHERE c.slug = ?`).bind(String(slug).toLowerCase()).first();
  const user = await sessionUser(request, env, now);
  const mine = Boolean(c && user && c.user_id === user.id);
  if (!c || (c.status !== 'live' && !mine && !(user && isAdminEmail(env, user.email)))) return [404, { message: 'There is no page at this address.' }];
  const following = user ? Boolean(await env.DB.prepare('SELECT 1 FROM creator_follows WHERE creator_id = ? AND user_id = ?').bind(c.id, user.id).first()) : false;
  return [200, publicView(c, { status: c.status, mine, following })];
}

// GET /me/creator: the signed-in person's own page, or null.
export async function myCreator(request, env, now) {
  const user = await sessionUser(request, env, now);
  if (!user) return [401, { message: 'Sign in first.' }];
  const c = await env.DB.prepare(`${WITH_FOLLOWERS} WHERE c.user_id = ?`).bind(user.id).first();
  return [200, { creator: c ? publicView(c, { status: c.status }) : null }];
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
