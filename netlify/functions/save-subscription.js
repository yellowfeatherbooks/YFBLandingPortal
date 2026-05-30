const crypto            = require('crypto');
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY; // service role bypasses RLS
const RZP_SECRET        = process.env.RAZORPAY_KEY_SECRET;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const { email, name, plan_name, plan_id, amount, subscription_id, payment_id, razorpay_signature } = JSON.parse(event.body || '{}');
    if (!email || !plan_name || !subscription_id) return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Missing required fields' })
    };

    // ── Verify Razorpay payment signature ──────────────────────────────────
    // Formula: HMAC-SHA256(subscription_id + "|" + payment_id, secret)
    if (RZP_SECRET && payment_id && razorpay_signature) {
      const expected = crypto
        .createHmac('sha256', RZP_SECRET)
        .update(`${subscription_id}|${payment_id}`)
        .digest('hex');
      if (expected !== razorpay_signature) {
        console.error('Subscription payment signature mismatch');
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Payment verification failed.' })
        };
      }
    }

    // Check for an existing active subscription and cancel it in Razorpay
    // to avoid double-billing when upgrading plans
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&select=subscription_id,status`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const existing = await existingRes.json();
    const old = Array.isArray(existing) && existing.length > 0 ? existing[0] : null;

    if (old && old.subscription_id && old.subscription_id !== subscription_id &&
        ['active', 'cancelling'].includes(old.status)) {
      try {
        const KEY_ID     = process.env.RAZORPAY_KEY_ID;
        const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
        await fetch(
          `https://api.razorpay.com/v1/subscriptions/${old.subscription_id}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }) // immediate cancel on upgrade
          }
        );
      } catch (rzpErr) {
        console.warn('Could not cancel old Razorpay subscription:', rzpErr.message);
      }
    }

    // Upsert — insert if new email, update if existing
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=email`,
      {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          plan_name,
          subscription_id,
          status:          'active',
          access_until:    null,        // clear stale cancellation date on renewal
          subscribed_date: new Date().toISOString()
        })
      }
    );

    if (!res.ok) {
      const err = await res.text();
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: err })
      };
    }

    // Trigger n8n invoice + notification (fire and forget)
    const n8nUrl = process.env.N8N_NEW_SUB_NOTIFY_URL;
    if (n8nUrl) {
      fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || email.split('@')[0], plan_name, amount: amount || 0, subscription_id, payment_id: payment_id || '' })
      }).catch(e => console.error('n8n new-sub notify failed:', e.message));
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
