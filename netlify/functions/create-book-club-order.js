const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    if (!RZP_KEY_ID || !RZP_SECRET) throw new Error('Payment service not configured.');

    const { email, name } = JSON.parse(event.body || '{}');
    if (!email || !name) throw new Error('Email and name are required.');

    const auth = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');

    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        amount:   9900,
        currency: 'INR',
        receipt:  `yfb_club_${Date.now()}`,
        notes:    { email, name }
      })
    });

    const order = await rzpRes.json();
    if (order.error) throw new Error(order.error.description || 'Failed to create order.');

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: RZP_KEY_ID, order_id: order.id, amount: order.amount })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
