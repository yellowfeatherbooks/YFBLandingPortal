const crypto = require('crypto');

const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, email, name, password, phone } =
      JSON.parse(event.body || '{}');

    // 1 — Verify Razorpay signature
    const expected = crypto
      .createHmac('sha256', RZP_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) throw new Error('Payment verification failed.');

    // 2 — Save member to Supabase
    if (SUPABASE_URL && SUPABASE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/book_club_members`, {
        method:  'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          name,
          phone:      phone || null,
          payment_id: razorpay_payment_id,
          order_id:   razorpay_order_id,
          joined_at:  new Date().toISOString()
        })
      });
    }

    // 3 — Create Shopify customer account
    if (SHOPIFY_DOMAIN && SHOPIFY_TOKEN) {
      await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers.json`, {
        method:  'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type':           'application/json'
        },
        body: JSON.stringify({
          customer: {
            first_name:             name.split(' ')[0],
            last_name:              name.split(' ').slice(1).join(' ') || '',
            email,
            phone:                  phone || undefined,
            password,
            password_confirmation:  password,
            tags:                   'Book Club',
            send_email_welcome:     false
          }
        })
      });
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
