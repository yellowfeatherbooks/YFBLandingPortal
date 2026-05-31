const crypto = require('crypto');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, email, slots } =
      JSON.parse(event.body || '{}');

    // Verify Razorpay signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: 'Payment verification failed' })
      };
    }

    // Fetch current extra_quota
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&select=extra_quota`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await getRes.json();
    const current = Array.isArray(rows) && rows.length > 0 ? (rows[0].extra_quota || 0) : 0;

    // Increment extra_quota
    await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ extra_quota: current + Number(slots) })
      }
    );

    // Trigger n8n top-up invoice workflow
    const n8nUrl = process.env.N8N_TOPUP_INVOICE_URL;
    if (n8nUrl) {
      try {
        await fetch(n8nUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            email,
            slots:              Number(slots),
            razorpay_order_id,
            razorpay_payment_id,
            extra_quota:        current + Number(slots)
          })
        });
      } catch (n8nErr) {
        console.error('n8n topup invoice webhook failed:', n8nErr.message);
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, extra_quota: current + Number(slots) })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
