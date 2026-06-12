/**
 * verify-native-payment.js
 * Called by the Yellow Feather Books Android app after Razorpay payment succeeds.
 *
 * 1. Verifies Razorpay signature
 * 2. Completes Shopify Draft Order → creates real Shopify order marked as paid
 * 3. Fetches the real order to get its name (e.g. "#YFBS1241")
 * 4. Returns order name for confirmation screen
 */

const crypto = require('crypto');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN     || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const RZP_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const API_VERSION    = '2024-01';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  if (!SHOPIFY_TOKEN) return json({ error: 'Shopify not configured' }, 500);
  if (!RZP_SECRET)    return json({ error: 'Razorpay not configured' }, 500);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, draft_order_id } = body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return json({ error: 'Missing Razorpay payment details' }, 400);
  if (!draft_order_id)
    return json({ error: 'Missing draft_order_id' }, 400);

  try {
    // ── 1. Verify Razorpay signature ──────────────────────────────────────────
    const expected = crypto
      .createHmac('sha256', RZP_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      console.error('Razorpay signature mismatch');
      return json({ success: false, error: 'Payment verification failed — invalid signature' }, 400);
    }

    // ── 2. Update Draft Order note with payment ID ────────────────────────────
    await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/draft_orders/${draft_order_id}.json`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
        body: JSON.stringify({
          draft_order: {
            note: `Paid via Razorpay | payment_id: ${razorpay_payment_id} | order_id: ${razorpay_order_id}`,
          }
        }),
      }
    );

    // ── 3. Complete Draft Order → becomes a real Shopify order ────────────────
    const completeRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/draft_orders/${draft_order_id}/complete.json?payment_pending=false`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
        body: JSON.stringify({}),
      }
    );

    const completeData = await completeRes.json();

    if (completeData.errors) {
      console.error('Shopify complete error:', JSON.stringify(completeData.errors));
      return json({ success: false, error: 'Failed to complete order: ' + JSON.stringify(completeData.errors) }, 400);
    }

    const completedDraft = completeData.draft_order;
    if (!completedDraft?.order_id) {
      console.error('No order_id in complete response:', JSON.stringify(completeData));
      return json({ success: false, error: 'Order completion did not return order ID' }, 500);
    }

    // ── 4. Fetch the real Shopify order to get proper order name (#YFBS1241) ──
    const orderId = completedDraft.order_id;
    let orderName = `#${orderId}`;
    let orderNumber = orderId;

    try {
      const orderRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/orders/${orderId}.json?fields=id,name,order_number`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
      );
      const orderData = await orderRes.json();
      if (orderData.order?.name) {
        orderName   = orderData.order.name;        // e.g. "#YFBS1241"
        orderNumber = orderData.order.order_number; // e.g. 1241
      }
    } catch (fetchErr) {
      console.error('Failed to fetch order name (non-fatal):', fetchErr.message);
    }

    return json({
      success:      true,
      order_id:     String(orderId),
      order_number: orderNumber,
      order_name:   orderName,
    });

  } catch (err) {
    console.error('verify-native-payment error:', err);
    return json({ success: false, error: err.message || 'Internal server error' }, 500);
  }
};
