// Admin-cancels an author's subscription.
// Cancels at Razorpay FIRST (immediately), then marks the DB 'cancelled' — and only
// if Razorpay confirms — so the DB and Razorpay can never drift out of sync.
// POST { adminEmail, adminKey, email }

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const AUTH_SB_URL  = process.env.AUTHOR_SUPABASE_URL  || process.env.SUPABASE_URL;
const AUTH_SB_KEY  = SERVICE_KEY;
const RZP_KEY_ID   = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET   = process.env.RAZORPAY_KEY_SECRET;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

async function verifyAdmin(email, adminKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

const INACTIVE = ['cancelled', 'completed', 'expired'];

// Cancel the subscription at Razorpay. Returns { ok, alreadyInactive, error }.
async function cancelAtRazorpay(subscriptionId) {
  if (!RZP_KEY_ID || !RZP_SECRET) return { ok: false, error: 'Razorpay keys not configured' };
  const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');

  // Immediate cancel (admin force-cancel) — stops all future billing now.
  const res  = await fetch(`https://api.razorpay.com/v1/subscriptions/${subscriptionId}/cancel`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
    body:    JSON.stringify({ cancel_at_cycle_end: 0 })
  });
  const data = await res.json();
  if (res.ok && data.id) return { ok: true };

  // Cancel failed — maybe it's already inactive at Razorpay. Verify before deciding,
  // so we don't desync (the whole point of this fix).
  try {
    const g = await fetch(`https://api.razorpay.com/v1/subscriptions/${subscriptionId}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    const gd = await g.json();
    if (gd.status && INACTIVE.includes(gd.status)) return { ok: true, alreadyInactive: true };
  } catch (_) { /* fall through to error */ }

  return { ok: false, error: (data.error && (data.error.description || data.error)) || 'Razorpay cancellation failed' };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, email } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!email) return json({ success: false, error: 'Missing email' }, 400);

  try {
    // 1. Find the subscription_id for this author (latest record).
    const lookup = await fetch(
      `${AUTH_SB_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1&select=subscription_id,status`,
      { headers: { 'apikey': AUTH_SB_KEY, 'Authorization': `Bearer ${AUTH_SB_KEY}` } }
    );
    const rows = await lookup.json();
    const sub  = Array.isArray(rows) && rows.length ? rows[0] : null;

    // 2. Cancel at Razorpay first. Only skip if there's no subscription_id on file
    //    (nothing to cancel there) — otherwise REQUIRE Razorpay to confirm.
    if (sub && sub.subscription_id) {
      const rzp = await cancelAtRazorpay(sub.subscription_id);
      if (!rzp.ok) {
        // Do NOT mark the DB cancelled if Razorpay still has it active — that's the
        // exact drift bug we're fixing. Surface the error so the admin can retry.
        return json({ success: false, error: `Could not cancel at Razorpay: ${rzp.error}. Subscription left unchanged to avoid billing drift.` });
      }
    }

    // 3. Razorpay confirmed (or nothing to cancel) → mark the DB cancelled.
    const res = await fetch(
      `${AUTH_SB_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        AUTH_SB_KEY,
          'Authorization': `Bearer ${AUTH_SB_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ status: 'cancelled', access_until: null })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      return json({ success: false, error: `Razorpay cancelled but DB update failed: ${err}` });
    }
    return json({ success: true, razorpay_cancelled: !!(sub && sub.subscription_id) });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
