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
    const { subscription_id, email } = JSON.parse(event.body || '{}');
    const KEY_ID     = process.env.RAZORPAY_KEY_ID;
    const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
    const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

    // Cancel in Razorpay at end of current billing cycle
    const res = await fetch(
      `https://api.razorpay.com/v1/subscriptions/${subscription_id}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
        body: JSON.stringify({ cancel_at_cycle_end: 1 })
      }
    );
    const data = await res.json();

    // Razorpay returns status 'active' when cancel_at_cycle_end=1 (cancels at period end)
    // current_end is the Unix timestamp of when the current paid period ends
    if (data.id) {
      const accessUntil = data.current_end
        ? new Date(data.current_end * 1000).toISOString()
        : null;

      await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_SVC_KEY,
            'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ status: 'cancelling', access_until: accessUntil })
        }
      );

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, access_until: accessUntil })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: data.error || 'Cancellation failed' })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
