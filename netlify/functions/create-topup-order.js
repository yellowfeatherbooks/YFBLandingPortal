const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// Top-up options: { slots, amount in paise (INR × 100) }
const TOPUP_OPTIONS = {
  5:  { slots: 5,  amount: 9900   }, // ₹99
  10: { slots: 10, amount: 19900  }, // ₹199
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const { slots, email } = JSON.parse(event.body || '{}');
    const option = TOPUP_OPTIONS[slots];
    if (!option) return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid top-up option' })
    };

    const KEY_ID     = process.env.RAZORPAY_KEY_ID;
    const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
    const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify({
        amount:   option.amount,
        currency: 'INR',
        notes:    { email, slots: String(slots), type: 'topup' }
      })
    });

    const order = await res.json();
    if (!order.id) return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: order.error || 'Failed to create order' })
    };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: order.id, amount: option.amount, slots: option.slots })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
