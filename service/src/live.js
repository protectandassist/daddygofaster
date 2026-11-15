// Going live. When the owner is streaming, the site shows the stream and a chat
// beside it, so someone sent to the site from YouTube or TikTok can watch and
// talk here without leaving.
//
// The owner switches it on from the owner page with the stream's link. The chat
// is open to anyone with an account while it is on, and goes through the same
// language filter as comments. The owner can remove a message or block a person.
import { getSetting, setSetting } from './store.js';
import { badLanguage, shouting, LANGUAGE_MESSAGES } from './language.js';

const CHAT_MAX = 200;
const CHAT_GAP_MS = 4_000; // one person cannot post faster than this
const CHAT_PER_HOUR = 120;
const CHAT_SHOWN = 60;

// The video id from any of the links YouTube hands out, or null.
export function youtubeId(link) {
  const text = String(link ?? '').trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  let url;
  try { url = new URL(text); } catch { return null; }
  const host = url.hostname.replace(/^(www|m)\./, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || (/^\/(?:live|embed|shorts)\/([\w-]{11})/.exec(url.pathname) || [])[1] || null;
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

// A TikTok link is only ever shown as a button: TikTok does not let a live stream be put on another site.
export function tiktokLink(link) {
  try {
    const url = new URL(String(link ?? '').trim());
    return url.protocol === 'https:' && /(^|\.)tiktok\.com$/.test(url.hostname) ? url.href.slice(0, 300) : null;
  } catch { return null; }
}

export async function liveState(env) {
  try {
    const live = JSON.parse((await getSetting(env, 'live')) || 'null');
    return live && live.on ? { on: true, youtube: live.youtube || null, tiktok: live.tiktok || null, since: live.since || null } : { on: false };
  } catch { return { on: false }; }
}

// Owner: POST /admin/api/live { on, youtube, tiktok }
export async function setLive(env, body, now) {
  if (!body || body.on !== true) {
    await setSetting(env, 'live', JSON.stringify({ on: false }), now);
    return [200, { on: false }];
  }
  const youtube = body.youtube ? youtubeId(body.youtube) : null;
  const tiktok = body.tiktok ? tiktokLink(body.tiktok) : null;
  if (body.youtube && !youtube) return [400, { message: 'That does not look like a YouTube link. Paste the link to the live video.' }];
  if (body.tiktok && !tiktok) return [400, { message: 'That does not look like a TikTok link.' }];
  if (!youtube && !tiktok) return [400, { message: 'Paste the YouTube link to the live video (a TikTok link can be added too).' }];
  await setSetting(env, 'live', JSON.stringify({ on: true, youtube, tiktok, since: now }), now);
  return [200, { on: true, youtube, tiktok }];
}

const line = (c) => ({ id: c.id, name: c.name, text: c.text, at: new Date(c.created_at).toISOString() });

// GET /live?after=<id>: whether he is live, and the chat (all of the recent lines, or only the ones after `after`).
export async function getLive(env, url) {
  const live = await liveState(env);
  if (!live.on) return [200, { on: false, chat: [] }];
  const after = Number(url.searchParams.get('after'));
  const { results } = Number.isInteger(after) && after > 0
    ? await env.DB.prepare("SELECT id, name, text, created_at FROM chat WHERE status = 'shown' AND id > ? AND created_at >= ? ORDER BY id LIMIT ?").bind(after, live.since || 0, CHAT_SHOWN).all()
    : await env.DB.prepare("SELECT * FROM (SELECT id, name, text, created_at FROM chat WHERE status = 'shown' AND created_at >= ? ORDER BY id DESC LIMIT ?) ORDER BY id").bind(live.since || 0, CHAT_SHOWN).all();
  // Lines the owner took down since the page last asked, so they leave the screen too.
  const { results: gone } = await env.DB.prepare("SELECT id FROM chat WHERE status = 'removed' AND created_at >= ? ORDER BY id DESC LIMIT 30").bind(live.since || 0).all();
  return [200, { ...live, chat: results.map(line), removed: gone.map((g) => g.id) }];
}

// POST /chat { text }: `user` is the signed-in person, with a username.
export async function postChat(env, user, body, now) {
  const live = await liveState(env);
  if (!live.on) return [409, { message: 'The chat is open while the stream is live.' }];
  if (user.blocked) return [403, { message: 'You can no longer chat here.' }];
  const text = String(body?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 1) return [400, { message: 'Write something first.' }];
  if (text.length > CHAT_MAX) return [400, { message: `Keep it to ${CHAT_MAX} characters.` }];
  if (/https?:\/\/|www\./i.test(text)) return [400, { message: 'Links are not allowed in the chat.' }];
  const trouble = badLanguage(text);
  if (trouble) return [400, { message: LANGUAGE_MESSAGES[trouble], rejected: trouble }];
  if (shouting(text)) return [400, { message: LANGUAGE_MESSAGES.shouting, rejected: 'shouting' }];
  const { results: mine } = await env.DB.prepare('SELECT text, created_at FROM chat WHERE user_id = ? ORDER BY id DESC LIMIT 3').bind(user.id).all();
  if (mine.length && now - mine[0].created_at < CHAT_GAP_MS) return [429, { message: 'Give it a moment before posting again.' }];
  if (mine.some((c) => c.text.toLowerCase() === text.toLowerCase())) return [400, { message: 'You already said that.' }];
  const hour = await env.DB.prepare('SELECT COUNT(*) AS n FROM chat WHERE user_id = ? AND created_at > ?').bind(user.id, now - 3_600_000).first();
  if (hour.n >= CHAT_PER_HOUR) return [429, { message: 'That is a lot of messages. Take a break and come back.' }];
  const made = await env.DB.prepare('INSERT INTO chat (user_id, name, text, created_at) VALUES (?, ?, ?, ?)').bind(user.id, user.name, text, now).run();
  return [200, { line: { id: made.meta.last_row_id, name: user.name, text, at: new Date(now).toISOString() } }];
}

// ---- owner ----------------------------------------------------------------------

export async function recentChat(env) {
  const { results } = await env.DB.prepare("SELECT id, name, text, created_at FROM chat WHERE status = 'shown' ORDER BY id DESC LIMIT 40").all();
  return results.map(line);
}

export async function removeChat(env, id) {
  const r = await env.DB.prepare("UPDATE chat SET status = 'removed' WHERE id = ? AND status = 'shown'").bind(id).run();
  return r.meta.changes ? [200, { status: 'removed' }] : [404, { message: 'No such message.' }];
}

// Stops whoever wrote a message from chatting or commenting again, and takes down their chat lines.
export async function blockChatter(env, id) {
  const c = await env.DB.prepare('SELECT user_id FROM chat WHERE id = ?').bind(id).first();
  if (!c) return [404, { message: 'No such message.' }];
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET blocked = 1 WHERE id = ?').bind(c.user_id),
    env.DB.prepare("UPDATE chat SET status = 'removed' WHERE user_id = ? AND status = 'shown'").bind(c.user_id),
  ]);
  return [200, { status: 'blocked' }];
}
