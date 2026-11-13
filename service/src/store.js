// Things the service keeps for itself in the `settings` table: the admin key
// (as a salted hash, so the key itself is never stored), provider keys (sealed
// with the Worker's VAULT_KEY secret, so the database holds only ciphertext),
// and the one-time setup code.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteCount) {
  return hex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

// Compares two strings without leaking where they differ.
export function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function getSetting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(env, key, value, now) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).bind(key, value, now).run();
}

export async function deleteSetting(env, key) {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

// ---- the vault ----------------------------------------------------------------

async function vaultKey(env) {
  if (!env.VAULT_KEY) return null;
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(env.VAULT_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function b64(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// Returns ciphertext for the database, or null when the vault has no key.
export async function seal(env, text) {
  const key = await vaultKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return b64(iv) + '.' + b64(body);
}

export async function unseal(env, sealed) {
  const key = await vaultKey(env);
  if (!key || !sealed || !sealed.includes('.')) return null;
  try {
    const [iv, body] = sealed.split('.');
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(body)));
  } catch {
    return null;
  }
}

// A provider key: the Worker secret if there is one, otherwise the sealed copy.
export async function providerKey(env, secretName, settingName) {
  if (env[secretName]) return env[secretName];
  return unseal(env, await getSetting(env, settingName));
}

// ---- the admin key ------------------------------------------------------------

export async function storeAdminKey(env, key, now) {
  const salt = randomHex(16);
  await setSetting(env, 'admin_key', salt + ':' + (await sha256(salt + key)), now);
}

export async function adminKeyIsSet(env) {
  return Boolean(env.ADMIN_KEY) || Boolean(await getSetting(env, 'admin_key'));
}

export async function adminKeyMatches(env, given) {
  if (!given) return false;
  if (env.ADMIN_KEY) return sameText(await sha256(given), await sha256(env.ADMIN_KEY));
  const stored = await getSetting(env, 'admin_key');
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return sameText(await sha256(salt + given), hash);
}
