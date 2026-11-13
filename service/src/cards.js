// Card holds, through Stripe. Nothing here touches the database, and no card
// number ever reaches this service: the bidder's browser hands the card to
// Stripe and sends back only Stripe's id for it.
//
// Card holds are on when both keys are set as Worker secrets:
//   STRIPE_SECRET_KEY        used here, never sent to a browser
//   STRIPE_PUBLISHABLE_KEY   handed to the site's page so it can show the card box

export const CARD_TROUBLE = 'The card could not be checked just now. Nothing was held. Try again in a minute.';
export const CARD_DECLINED = 'That card was not approved. Nothing was held. Try a different card.';

export function cardKeys(env) {
  const secret = env.STRIPE_SECRET_KEY || '';
  const publishable = env.STRIPE_PUBLISHABLE_KEY || '';
  return secret && publishable ? { secret, publishable } : null;
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
    const res = await fetch((env.STRIPE_API_URL || 'https://api.stripe.com') + '/v1' + path, { method, headers, body });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, data, error: null };
    const error = (data && data.error) || {};
    console.error('[CARDS]', method, path.replace(/(pi|cus|pm)_[A-Za-z0-9]+/g, '$1_…'), 'answered', res.status, error.type || '', error.code || '');
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
  const r = await stripeCall(env, key, 'POST', '/payment_intents', {
    amount: String(cents),
    currency: 'usd',
    customer,
    payment_method: cardId,
    'payment_method_types[]': 'card',
    capture_method: 'manual', // a hold: nothing is charged until it is captured
    confirm: 'true',
    setup_future_usage: 'off_session', // so a raise can hold more on the same card
    description: `DaddyGoFaster bid for ${day}`,
    receipt_email: email,
    'metadata[bid_id]': String(bidId),
    'metadata[day]': day,
  });
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
export async function chargeSaved(env, key, { customerId, cardId, email, cents, day, bidId }) {
  const r = await stripeCall(env, key, 'POST', '/payment_intents', {
    amount: String(cents),
    currency: 'usd',
    customer: customerId,
    payment_method: cardId,
    'payment_method_types[]': 'card',
    confirm: 'true',
    off_session: 'true',
    description: `DaddyGoFaster winning bid for ${day}`,
    receipt_email: email,
    'metadata[bid_id]': String(bidId),
    'metadata[day]': day,
  }, `dgf-win-${bidId}-${cents}`);
  if (r.ok && r.data.status === 'succeeded') return { ok: true, intentId: r.data.id, cents: r.data.amount_received ?? cents };
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
