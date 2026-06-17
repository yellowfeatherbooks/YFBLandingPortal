// razorpay-webhook.js
// Receives Razorpay subscription events and keeps the `subscriptions` table in
// sync automatically — so the DB always mirrors Razorpay (renewals, cancellations,
// failed payments) without relying on a user logging in.
//
// Setup:
//   1. Razorpay Dashboard → Settings → Webhooks → Add:
//        URL:    https://yellowfeatherbooks.com/.netlify/functions/razorpay-webhook
//        Secret: <pick a strong secret>
//        Events: subscription.charged, subscription.cancelled, subscription.halted,
//                subscription.paused, subscription.resumed, subscription.completed,
//                subscription.activated, subscription.authenticated
//   2. Netlify env (Production): RAZORPAY_WEBHOOK_SECRET = <same secret>
//
// Env: RAZORPAY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY)

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// event → how to update the subscription row
function patchForEvent(evt, accessUntil) {
  switch (evt) {
    case 'subscription.charged':                                   // renewal paid
    case 'subscription.activated':
    case 'subscription.authenticated':
    case 'subscription.resumed':
      return { status: 'active', access_until: accessUntil };
    case 'subscription.cancelled':
      return { status: 'cancelled', access_until: null };
    case 'subscription.halted':                                    // retries exhausted
      return { status: 'halted' };
    case 'subscription.paused':
      return { status: 'paused' };
    case 'subscription.completed':                                 // ran its full term
      return { status: 'completed' };
    default:
      return null;                                                 // ignore everything else
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!WEBHOOK_SECRET || !SUPABASE_URL || !SERVICE_KEY) {
    console.error('razorpay-webhook: missing env (WEBHOOK_SECRET/SUPABASE)');
    return { statusCode: 500, body: 'not configured' };
  }

  // Raw body is required for signature verification — never use the parsed object.
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  // 1. Verify the signature (HMAC-SHA256 of the raw body with the webhook secret).
  const signature = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'] || '';
  const expected  = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { statusCode: 400, body: 'invalid signature' };
  }

  // 2. Parse + locate the subscription entity.
  let body;
  try { body = JSON.parse(raw); } catch { return { statusCode: 400, body: 'bad json' }; }

  const evt = body.event || '';
  const sub = body.payload && body.payload.subscription && body.payload.subscription.entity;
  if (!sub || !sub.id) return { statusCode: 200, body: 'ignored (no subscription entity)' };

  const accessUntil = sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
  const patch = patchForEvent(evt, accessUntil);
  if (!patch) return { statusCode: 200, body: `ignored (${evt})` };

  // 3. Apply to the DB (idempotent — PATCH by subscription_id). Return 5xx on a real
  //    failure so Razorpay retries; 200 otherwise (incl. "no matching row").
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?subscription_id=eq.${encodeURIComponent(sub.id)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
      }
    );
    if (!res.ok) {
      console.error('razorpay-webhook: DB patch failed', res.status, await res.text());
      return { statusCode: 502, body: 'db error' };   // let Razorpay retry
    }
    return { statusCode: 200, body: `ok: ${evt} -> ${patch.status}` };
  } catch (e) {
    console.error('razorpay-webhook error:', e.message);
    return { statusCode: 502, body: 'error' };          // let Razorpay retry
  }
};
