// Outbid emails, sent through Resend. Nothing is sent unless a mail key is set.
import { money } from './rules.js';

export const MAX_OUTBID_EMAILS = 3; // per bid, per round
export const OUTBID_EMAIL_GAP_MS = 10 * 60_000; // and not more often than this

export function shouldEmail(bid, now) {
  return bid.notify === 1 && bid.notified < MAX_OUTBID_EMAILS && (!bid.notified_at || now - bid.notified_at >= OUTBID_EMAIL_GAP_MS);
}

export function outbidEmail({ amountCents, highCents, siteUrl, stopUrl }) {
  return {
    subject: 'You have been outbid',
    text: [
      'Someone has outbid you on DaddyGoFaster.',
      '',
      `Your bid: ${money(amountCents)}`,
      `High bid now: ${money(highCents)}`,
      '',
      `Bidding is still open. To raise your bid, go to ${siteUrl}/#bid and send the same job with a higher amount.`,
      '',
      'You are getting this because you asked for an email if you were outbid.',
      `To stop emails about this bid: ${stopUrl}`,
    ].join('\n'),
  };
}

// Returns true when the provider accepted the message.
export async function sendEmail(env, { key, from, to, subject, text }) {
  try {
    const res = await fetch((env.MAIL_API_URL || 'https://api.resend.com') + '/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    if (!res.ok) console.error('[MAIL] provider answered', res.status);
    return res.ok;
  } catch (error) {
    console.error('[MAIL] failed', String(error));
    return false;
  }
}
