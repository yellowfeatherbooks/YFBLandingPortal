const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const RZP_KEY_ID   = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET   = process.env.RAZORPAY_KEY_SECRET;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email) return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false })
    };

    // 1 - Look up active or cancelling subscription in Supabase
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&status=in.(active,cancelling)&order=created_at.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    const rows       = await res.json();
    const subscriber = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (!subscriber) return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false })
    };

    // If cancelling, check whether the paid period has expired
    if (subscriber.status === 'cancelling' && subscriber.access_until) {
      const now = new Date();
      const accessUntil = new Date(subscriber.access_until);
      if (now > accessUntil) {
        // Grace period over — mark as cancelled and deny access
        await fetch(
          `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey':        SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type':  'application/json'
            },
            body: JSON.stringify({ status: 'cancelled' })
          }
        );
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ found: false })
        };
      }
    }

    // 2 - Verify with Razorpay only if keys are available
    if (RZP_KEY_ID && RZP_SECRET) {
      try {
        const auth   = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');
        const rzpRes = await fetch(`https://api.razorpay.com/v1/subscriptions/${subscriber.subscription_id}`, {
          headers: { 'Authorization': `Basic ${auth}` }
        });
        const rzpData = await rzpRes.json();

        // Only mark cancelled if Razorpay confirms inactive AND grace period has passed
        const inactiveStatuses = ['cancelled', 'completed', 'expired'];
        const gracePeriodOver = !subscriber.access_until || new Date() > new Date(subscriber.access_until);
        if (rzpData.status && inactiveStatuses.includes(rzpData.status) && gracePeriodOver) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
            {
              method: 'PATCH',
              headers: {
                'apikey':        SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type':  'application/json'
              },
              body: JSON.stringify({ status: 'cancelled' })
            }
          );
          return {
            statusCode: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({ found: false })
          };
        }
      } catch (rzpErr) {
        // Razorpay check failed - trust Supabase record
        console.warn('Razorpay verification failed:', rzpErr.message);
      }
    }

    const nameQuotaMap = { Starter: 1, Growth: 3, Publisher: 10 };
    const baseQuota    = nameQuotaMap[subscriber.plan_name] || 1;
    const extraQuota   = subscriber.extra_quota || 0;
    const quota        = baseQuota + extraQuota;

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found:           true,
        plan_name:       subscriber.plan_name,
        sub_status:      subscriber.status,
        access_until:    subscriber.access_until || null,
        quota,
        extra_quota:     extraQuota,
        subscription_id: subscriber.subscription_id
      })
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, error: err.message })
    };
  }
};
