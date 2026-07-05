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
const odoo         = require('./lib/odoo');           // Razorpay charge -> Odoo GST invoice
const shopify      = require('./lib/shopify-customer'); // author state -> GST place-of-supply
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

// Look up the author's email / name / plan for this subscription from Supabase
// (the charge payload only carries Razorpay ids, not the author's email).
async function lookupSubscriber(subscriptionId) {
  const base = `${SUPABASE_URL}/rest/v1/subscriptions?subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`;
  const hdr  = { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } };
  // Try including the checkout `state`; fall back if that column doesn't exist yet
  // (so a missing column degrades the GST split instead of dropping the invoice).
  // Note: the subscriptions table has no `name` column — the invoice uses email.
  let res = await fetch(`${base}&select=email,plan_name,state`, hdr);
  if (!res.ok) res = await fetch(`${base}&select=email,plan_name`, hdr);
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// On subscription.charged, raise the GST tax invoice in Odoo (the subscription is
// a taxable service; books are exempt). Idempotent by Razorpay payment id.
// Best-effort by default: a failure here never blocks the DB sync — set
// ODOO_INVOICE_REQUIRED=true to instead 5xx so Razorpay retries.
// Returns null on success/skip, or an error string when the caller should retry.
async function invoiceOnCharge(sub, body) {
  if (!odoo.isConfigured()) return null;                  // Odoo not wired up -> skip silently

  const pay = body.payload && body.payload.payment && body.payload.payment.entity;
  const amountPaise = pay && pay.amount;
  if (!amountPaise) { console.warn('razorpay-webhook: charged event without payment amount; skipping Odoo invoice'); return null; }

  const subscriber = await lookupSubscriber(sub.id);
  if (!subscriber || !subscriber.email) {
    console.warn(`razorpay-webhook: no Supabase email for ${sub.id}; skipping Odoo invoice`);
    return null;
  }

  // State for the GST split: prefer the one captured at checkout (stored on the
  // subscription), else the author's Shopify address (null -> intra default).
  const stateName = subscriber.state || await shopify.getCustomerStateByEmail(subscriber.email);

  try {
    const r = await odoo.createSubscriptionInvoice({
      email:          subscriber.email,
      name:           subscriber.name,
      planName:       subscriber.plan_name,
      stateName,
      amountPaise,
      currency:       (pay.currency) || 'INR',
      paymentId:      pay.id,
      subscriptionId: sub.id,
      chargedAt:      pay.created_at ? new Date(pay.created_at * 1000).toISOString() : undefined,
    });
    console.log(`razorpay-webhook: Odoo invoice ${r.number} (${r.created ? 'created' : 'existing'}) total ₹${r.total} for ${subscriber.email}`);
    return null;
  } catch (e) {
    console.error('razorpay-webhook: Odoo invoice failed:', e.message);
    return process.env.ODOO_INVOICE_REQUIRED === 'true' ? e.message : null;
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

    // On a renewal/charge, mirror it into Odoo as a GST invoice (idempotent).
    if (evt === 'subscription.charged') {
      const odooErr = await invoiceOnCharge(sub, body);
      if (odooErr) return { statusCode: 502, body: `odoo invoice error: ${odooErr}` }; // retry (idempotent)
    }

    return { statusCode: 200, body: `ok: ${evt} -> ${patch.status}` };
  } catch (e) {
    console.error('razorpay-webhook error:', e.message);
    return { statusCode: 502, body: 'error' };          // let Razorpay retry
  }
};
