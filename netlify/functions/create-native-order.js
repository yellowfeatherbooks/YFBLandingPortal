/**
 * create-native-order.js
 * Called by the Yellow Feather Books Android app native checkout.
 *
 * Receives cart items + customer + shipping address + optional discount
 * → Creates a Shopify Draft Order via Admin API
 * → Creates a Razorpay Order for the exact total
 * → Returns Razorpay checkout params to the app
 *
 * POST body:
 * {
 *   items: [{ variantId: "gid://shopify/ProductVariant/XXX", quantity: 1, title: "...", price: "299.00" }],
 *   customer: { email, firstName, lastName, phone },
 *   address: { address1, address2, city, province, zip, country: "India", countryCode: "IN" },
 *   discountCode:    "CLUB10" | "FLASH5" | null,
 *   discountPercent: 10 | 5 | 0
 * }
 *
 * Response:
 * {
 *   key: "rzp_...",
 *   razorpay_order_id: "order_...",
 *   draft_order_id: 123456,
 *   amount: 26910,   // paise
 *   currency: "INR",
 *   order_name: "D#123"
 * }
 */

const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN        || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const RZP_KEY_ID      = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET      = process.env.RAZORPAY_KEY_SECRET;
const API_VERSION     = '2024-01';

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

/** Extract numeric Shopify ID from a GID string */
function gidToNumeric(gid) {
  if (!gid) return null;
  const parts = String(gid).split('/');
  return parts[parts.length - 1];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  if (!SHOPIFY_TOKEN)  return json({ error: 'Shopify not configured'  }, 500);
  if (!RZP_KEY_ID)     return json({ error: 'Razorpay not configured' }, 500);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { items, customer, address, discountCode, discountPercent } = body;

  if (!items?.length)     return json({ error: 'No items provided' },    400);
  if (!customer?.email)   return json({ error: 'Customer email required' }, 400);
  if (!address?.address1) return json({ error: 'Shipping address required' }, 400);

  try {
    // ── 1. Build Shopify Draft Order payload ──────────────────────────────────
    const lineItems = items.map((item) => ({
      variant_id: gidToNumeric(item.variantId),
      quantity:   item.quantity || 1,
    }));

    const shippingAddress = {
      first_name: customer.firstName || customer.name?.split(' ')[0] || '',
      last_name:  customer.lastName  || customer.name?.split(' ').slice(1).join(' ') || '',
      address1:   address.address1,
      address2:   address.address2 || '',
      city:       address.city,
      province:   address.province,
      zip:        address.zip,
      country:    address.country     || 'India',
      phone:      customer.phone      || '',
    };

    const draftPayload = {
      draft_order: {
        line_items:       lineItems,
        customer:         { email: customer.email },
        shipping_address: shippingAddress,
        billing_address:  shippingAddress,
        email:            customer.email,
        use_customer_default_address: false,
        note: `Native app order | Razorpay payment pending`,
        tags: 'app-order,android-native',
      }
    };

    // Apply discount if provided
    if (discountCode && discountPercent > 0) {
      draftPayload.draft_order.applied_discount = {
        description: discountCode === 'CLUB10'
          ? 'Book Club Member Discount'
          : 'Flash Sale Discount',
        value_type:  'percentage',
        value:       String(discountPercent),
        title:       discountCode,
      };
    }

    // ── 2. Create Shopify Draft Order ─────────────────────────────────────────
    const shopifyRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/draft_orders.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type':         'application/json',
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        },
        body: JSON.stringify(draftPayload),
      }
    );

    const shopifyData = await shopifyRes.json();

    if (shopifyData.errors) {
      console.error('Shopify draft order error:', JSON.stringify(shopifyData.errors));
      return json({ error: 'Failed to create order: ' + JSON.stringify(shopifyData.errors) }, 400);
    }

    const draftOrder = shopifyData.draft_order;
    if (!draftOrder?.id) return json({ error: 'Shopify did not return draft order' }, 500);

    // total_price is a string like "299.00"
    const totalPrice   = parseFloat(draftOrder.total_price || '0');
    const amountPaise  = Math.round(totalPrice * 100); // Razorpay uses paise

    // ── 3. Create Razorpay Order ──────────────────────────────────────────────
    const rzpAuth = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');

    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${rzpAuth}`,
      },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `yfb_${draftOrder.id}`,
        notes: {
          draft_order_id:   String(draftOrder.id),
          draft_order_name: draftOrder.name,
          customer_email:   customer.email,
          discount_code:    discountCode || '',
        },
      }),
    });

    const rzpOrder = await rzpRes.json();

    if (rzpOrder.error) {
      console.error('Razorpay order error:', rzpOrder.error);
      return json({ error: rzpOrder.error.description || 'Razorpay order creation failed' }, 400);
    }

    return json({
      key:              RZP_KEY_ID,
      razorpay_order_id: rzpOrder.id,
      draft_order_id:    draftOrder.id,
      draft_order_name:  draftOrder.name,
      amount:            amountPaise,
      currency:          'INR',
      subtotal:          draftOrder.subtotal_price,
      total:             draftOrder.total_price,
      discount_amount:   draftOrder.applied_discount?.amount || '0',
    });

  } catch (err) {
    console.error('create-native-order error:', err);
    return json({ error: err.message || 'Internal server error' }, 500);
  }
};
