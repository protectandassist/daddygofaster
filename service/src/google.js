// Sign in with Google. The page gets a signed note from Google saying who the
// person is; this checks Google's signature on it, that it was written for this
// site, that it has not run out, and that Google has verified the email. No
// Google password or secret ever reaches this service.

const CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const dec = new TextDecoder();
let cache = { at: 0, keys: [] };

function unb64url(text) {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function googleKeys(env, now, fresh) {
  if (!fresh && cache.keys.length && now - cache.at < 3_600_000) return cache.keys;
  const res = await fetch(env.GOOGLE_CERTS_URL || CERTS);
  if (!res.ok) throw new Error('google certs ' + res.status);
  cache = { at: now, keys: (await res.json()).keys || [] };
  return cache.keys;
}

// Returns { sub, email, name } for a good note, or null.
export async function verifyGoogle(env, credential, now) {
  if (!env.GOOGLE_CLIENT_ID || typeof credential !== 'string' || credential.length > 4096) return null;
  const parts = credential.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(dec.decode(unb64url(parts[0])));
    claims = JSON.parse(dec.decode(unb64url(parts[1])));
  } catch { return null; }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  try {
    let jwk = (await googleKeys(env, now, false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await googleKeys(env, now, true)).find((k) => k.kid === header.kid); // Google changes its keys now and then
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!good) return null;
  } catch (error) {
    console.error('[GOOGLE] check failed', String(error));
    return null;
  }
  if (!ISSUERS.has(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!(Number(claims.exp) * 1000 > now) || Number(claims.iat) * 1000 > now + 300_000) return null;
  if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || !claims.sub) return null;
  return { sub: String(claims.sub), email };
}
