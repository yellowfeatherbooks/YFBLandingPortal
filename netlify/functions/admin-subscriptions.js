// Returns all author subscriptions from Supabase, cross-validated against Razorpay
// for active/cancelling rows.
// POST { adminEmail, adminKey, status? }

const crypto     = require('crypto');
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

// Call Razorpay API for a single subscription_id
async function fetchRazorpayStatus(subscriptionId) {
  try {
    const auth   = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');
    const res    = await fetch(`https://api.razorpay.com/v1/subscriptions/${subscriptionId}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    const data   = await res.json();
    return data.status || null;   // e.g. 'active', 'cancelled', 'completed', 'expired', 'pending'
  } catch (e) {
    return null;  // network/API error — return null so we don't clobber Supabase
  }
}

// Patch Supabase subscription status for a given email
async function patchSubStatus(email, newStatus) {
  try {
    await fetch(
      `${AUTH_SB_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        AUTH_SB_KEY,
          'Authorization': `Bearer ${AUTH_SB_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ status: newStatus })
      }
    );
  } catch (e) {
    console.warn('patchSubStatus failed for', email, e.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, status } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    // 1 ── Fetch from Supabase ──────────────────────────────────────────────
    let url = `${AUTH_SB_URL}/rest/v1/subscriptions?select=email,plan_name,status,subscription_id,access_until,extra_quota,created_at&order=created_at.desc&limit=500`;
    if (status && status !== 'all') url += `&status=eq.${encodeURIComponent(status)}`;

    const res  = await fetch(url, {
      headers: { 'apikey': AUTH_SB_KEY, 'Authorization': `Bearer ${AUTH_SB_KEY}` }
    });
    const rows = await res.json();
    if (!Array.isArray(rows)) return json({ success: true, subscriptions: [] });

    // 2 ── Cross-validate against Razorpay (parallel, only for live rows) ──
    const rzpInactive = ['cancelled', 'completed', 'expired'];
    const needsCheck  = RZP_KEY_ID && RZP_SECRET;

    const enriched = await Promise.all(rows.map(async (row) => {
      // Only call Razorpay for rows that look active and have a subscription_id
      const looksLive = ['active', 'cancelling'].includes(row.status) && row.subscription_id;
      if (!needsCheck || !looksLive) {
        return { ...row, rzp_status: null };
      }

      const rzpStatus = await fetchRazorpayStatus(row.subscription_id);

      // Determine if grace period has passed for cancelling subs
      const gracePassed = !row.access_until || new Date() > new Date(row.access_until);

      // Auto-sync: if Razorpay says it's done and grace has passed, update Supabase
      if (rzpStatus && rzpInactive.includes(rzpStatus) && gracePassed) {
        await patchSubStatus(row.email, 'cancelled');
        return { ...row, status: 'cancelled', rzp_status: rzpStatus, rzp_synced: true };
      }

      return { ...row, rzp_status: rzpStatus };
    }));

    return json({ success: true, subscriptions: enriched });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
