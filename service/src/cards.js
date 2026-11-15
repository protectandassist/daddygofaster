// Card holds, through Stripe. Nothing here touches the database, and no card
// number ever reaches this service: the bidder's browser hands the card to
// Stripe and sends back only Stripe's id for it.
//
// Card holds are on when both keys are set as Worker secrets:
//   STRIPE_SECRET_KEY        used here, never sent to a browser
//   STRIPE_PUBLISHABLE_KEY   handed to the site's page so it can show the card box

// Added after the company name on the bidder's card statement, so the charge is recognised.
export const STATEMENT_TAG = 'TORCHHIVE';

export const CARD_TROUBLE = 'The card could not be checked just now. Nothing was held. Try again in a minute.';
export const CARD_DECLINED = 'That card was not approved. Nothing was held. Try a different card.';

export function cardKeys(env) {
  const secret = env.STRIPE_SECRET_KEY || '';
  const publishable = env.STRIPE_PUBLISHABLE_KEY || '';
  return secret && publishable ? { secret, publishable } : null;
}

const CALL_TIMEOUT_MS = 15_000;

// True when a call's answer says nothing about the card: Stripe could not be
// reached, timed out, had trouble of its own, or turned the request away for a
// reason that is ours (the key, a lock, too many calls). The money may or may
// not have moved, so the caller must neither give up on it nor charge again
// some other way: it tries the same call again later, with the same key.
export function unsure(r) {
  return !r.ok && (r.status === 0 || r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 409 || r.status === 429);
}

// One call to Stripe. Always resolves: { ok, status, data, error }.
export async function stripeCall(env, key, method, path, params, idempotencyKey) {
  const headers = { Authorization: 'Bearer ' + key };
  let body;
  if (params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params).toString();
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  try {
    // A call that hangs is cut off, so one slow answer cannot hold a round's settlement open.
    const res = await fetch((env.STRIPE_API_URL || 'https://api.stripe.com') + '/v1' + path, { method, headers, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, data, error: null };
    const error = (data && data.error) || {};
    console.error('[CARDS]', method, path.split('/').map((part) => (part.includes('_') && part !== 'payment_intents' ? part.slice(0, 3) + '(id)' : part)).join('/'), 'answered', res.status, error.type || '', error.code || '');
    return { ok: false, status: res.status, data: null, error };
  } catch (error) {
    console.error('[CARDS] failed', method, String(error));
    return { ok: false, status: 0, data: null, error: { type: 'network' } };
  }
}

// What the bidder is told when the bank says no. Stripe's own wording for a
// card error is written for the cardholder, so it is passed on.
function declineMessage(error) {
  const said = error && error.type === 'card_error' && typeof error.message === 'string' ? error.message.trim() : '';
  return said ? `${said} Nothing was held. Try a different card.` : CARD_DECLINED;
}

// Holds `cents` on a card without charging it. Makes the Stripe customer the
// first time. Returns { outcome, intentId, clientSecret, customerId, message }:
//   held      the money is held
//   action    the bank wants the cardholder to confirm; the page finishes it with clientSecret
//   declined  the bank said no
//   error     Stripe could not be reached, or refused the request
export async function createHold(env, key, { customerId, email, cardId, cents, day, bidId }) {
  let customer = customerId || null;
  if (!customer) {
    const made = await stripeCall(env, key, 'POST', '/customers', { email, 'metadata[bid_id]': String(bidId) });
    if (!made.ok) return { outcome: 'error', intentId: null, customerId: null, message: CARD_TROUBLE };
    customer = made.data.id;
  }
  // The same key on a second try returns the first try's hold instead of making another,
  // so a lost answer cannot leave a hold on the card that the database never hears about.
  const holdKey = 'dgf-hold-' + bidId + '-' + crypto.randomUUID();
  const params = {
    amount: String(cents),
    currency: 'usd',
    customer,
    payment_method: cardId,
    'payment_method_types[]': 'card',
    capture_method: 'manual', // a hold: nothing is charged until it is captured
    confirm: 'true',
    setup_future_usage: 'off_session', // so a raise can hold more on the same card
    description: `TorchHive bid for ${day}`,
    receipt_email: email,
    statement_descriptor_suffix: STATEMENT_TAG, // so the card statement says TorchHive beside the company name
    'metadata[bid_id]': String(bidId),
    'metadata[day]': day,
  };
  let r = await stripeCall(env, key, 'POST', '/payment_intents', params, holdKey);
  if (unsure(r)) r = await stripeCall(env, key, 'POST', '/payment_intents', params, holdKey);
  if (r.ok) {
    const pi = r.data;
    if (pi.status === 'requires_capture') return { outcome: 'held', intentId: pi.id, customerId: customer };
    if (pi.status === 'requires_action') return { outcome: 'action', intentId: pi.id, clientSecret: pi.client_secret, customerId: customer };
    await cancelIntent(env, key, pi.id);
    return { outcome: 'declined', intentId: pi.id, customerId: customer, message: CARD_DECLINED };
  }
  const left = r.error.payment_intent;
  if (left && left.id) await cancelIntent(env, key, left.id);
  const declined = r.error.type === 'card_error';
  return {
    outcome: declined ? 'declined' : 'error',
    intentId: left && left.id ? left.id : null,
    customerId: customer,
    message: declined ? declineMessage(r.error) : CARD_TROUBLE,
  };
}

// Charges a saved card now, with the cardholder away. Used when a win passes to
// the next bid after that bid's hold was already released.
export async function chargeSaved(env, key, { customerId, cardId, email, cents, day, bidId, idempotencyKey }) {
  const r = await stripeCall(env, key, 'POST', '/payment_intents', {
    amount: String(cents),
    currency: 'usd',
    customer: customerId,
    payment_method: cardId,
    'payment_method_types[]': 'card',
    confirm: 'true',
    off_session: 'true',
    description: `TorchHive winning bid for ${day}`,
    receipt_email: email,
    statement_descriptor_suffix: STATEMENT_TAG, // so the card statement says TorchHive beside the company name
    'metadata[bid_id]': String(bidId),
    'metadata[day]': day,
  }, idempotencyKey || `dgf-win-${bidId}-${customerId}-${cents}`); // per bid: the same person winning the same amount another day is a new charge
  if (r.ok && r.data.status === 'succeeded') return { ok: true, intentId: r.data.id, cents: r.data.amount_received ?? cents };
  if (unsure(r)) return { ok: false, unsure: true, intentId: null }; // unknown: the caller tries again later with the same key
  const left = r.ok ? r.data : r.error.payment_intent;
  if (left && left.id) await cancelIntent(env, key, left.id);
  return { ok: false, intentId: null };
}

export function readIntent(env, key, intentId) {
  return stripeCall(env, key, 'GET', '/payment_intents/' + intentId);
}

export function cancelIntent(env, key, intentId) {
  return stripeCall(env, key, 'POST', '/payment_intents/' + intentId + '/cancel', {});
}

// Charges `cents` of a hold. Anything held beyond that goes back to the card.
export function captureIntent(env, key, intentId, cents, idempotencyKey) {
  return stripeCall(env, key, 'POST', '/payment_intents/' + intentId + '/capture', { amount_to_capture: String(cents) }, idempotencyKey);
}

export function refundIntent(env, key, intentId, idempotencyKey) {
  return stripeCall(env, key, 'POST', '/refunds', { payment_intent: intentId }, idempotencyKey);
}

// ---- paying creators (Stripe Connect) ---------------------------------------------
// A creator gets an account with Stripe that the site can send money to. Stripe
// collects their identity and bank details on its own pages; none of it comes here.

export async function createPayoutAccount(env, key, { email, slug }) {
  const r = await stripeCall(env, key, 'POST', '/accounts', {
    country: 'US', email,
    'controller[fees][payer]': 'application',          // the site pays Stripe's fees and keeps its share
    'controller[losses][payments]': 'application',
    'controller[stripe_dashboard][type]': 'express',
    'capabilities[transfers][requested]': 'true',
    'business_profile[url]': `https://torchhive.com/${slug}`,
    'metadata[creator]': slug,
  }, `dgf-acct-${slug}`);
  return r.ok ? r.data.id : null;
}

// The link to Stripe's own sign-up pages for that account. It works once and for a few minutes.
export async function payoutSetupLink(env, key, accountId, backTo) {
  const r = await stripeCall(env, key, 'POST', '/account_links', { account: accountId, type: 'account_onboarding', refresh_url: backTo, return_url: backTo });
  return r.ok ? r.data.url : null;
}

// Can money be sent to this account yet?
export async function payoutsReady(env, key, accountId) {
  const r = await stripeCall(env, key, 'GET', '/accounts/' + accountId);
  return Boolean(r.ok && r.data.capabilities && r.data.capabilities.transfers === 'active');
}

// Sends part of one charge on to a creator. Tied to the charge, so it can go as soon as the charge is made.
export async function sendToCreator(env, key, { cents, accountId, chargeId, group, idempotencyKey }) {
  const r = await stripeCall(env, key, 'POST', '/transfers', {
    amount: String(cents), currency: 'usd', destination: accountId, source_transaction: chargeId, transfer_group: group,
  }, idempotencyKey);
  return r.ok ? r.data.id : null;
}
