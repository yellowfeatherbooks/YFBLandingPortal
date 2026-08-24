/**
 * create-native-order.js
 * Called by the Yellow Feather Books Android app native checkout.
 *
 * POST body:
 * {
 *   items: [{ variantId: "gid://shopify/ProductVariant/XXX", quantity: 1, title: "...", price: "299.00" }],
 *   customer: { email, firstName, lastName, phone },
 *   address: { address1, address2, city, province, zip, country, countryCode },
 *   discountCode:    "CLUB10" | "FLASH5" | null,
 *   discountPercent: 10 | 5 | 0
 * }
 *
 * Response:
 * {
 *   key, razorpay_order_id, draft_order_id, draft_order_name,
 *   amount (paise), currency, subtotal, shipping, total
 * }
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN      || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const API_VERSION    = '2024-01';
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Shipping rules, admin-configurable via the "🚚 Shipping" admin screen
// (site_config key 'shipping', shared with admin-shipping-settings.js). Falls
// back to these defaults if Supabase is unreachable so checkout never breaks.
const SHIPPING_DEFAULT_SLABS = [
  { min: 0,       max: 1000, price: 80 },
  { min: 1000.01, max: null, price: 0 },
];
let _shippingCache = null; // { slabs, ts } — shared across warm Lambda instances
const SHIPPING_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getShippingSettings() {
  if (_shippingCache && (Date.now() - _shippingCache.ts) < SHIPPING_CACHE_TTL) return _shippingCache.slabs;
  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/site_config?key=eq.shipping&select=value&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const slabs = Array.isArray(rows?.[0]?.value?.slabs) ? rows[0].value.slabs : SHIPPING_DEFAULT_SLABS;
    _shippingCache = { slabs, ts: Date.now() };
    return slabs;
  } catch (e) {
    console.error('getShippingSettings error, using defaults:', e.message);
    return SHIPPING_DEFAULT_SLABS;
  }
}

// Picks the price for the slab whose [min, max] range contains subtotal.
// Falls back to the nearest slab below (or the first slab, if subtotal is below
// everything) so a misconfigured gap still produces a sane charge instead of NaN.
function computeShippingCharge(subtotal, slabs) {
  const sorted = [...slabs].sort((a, b) => a.min - b.min);
  let fallback = sorted[0];
  for (const s of sorted) {
    if (subtotal >= s.min && (s.max === null || s.max === undefined || subtotal <= s.max)) return s.price;
    if (s.min <= subtotal) fallback = s;
  }
  return fallback ? fallback.price : 0;
}

// Seasonal campaign (site_config key 'seasonal_discount', admin-seasonal-discount.js).
// Applied server-side and STACKED on top of any client-sent discount (CLUB10/FLASH5/
// AUTHOR10) — never trust the client for this one, it's the whole point of enforcing
// it here rather than as a client-hardcoded percent (see FLASH5's mismatch history).
const SEASONAL_DEFAULT = { enabled: false, label: '', percent: 0, startDate: null, endDate: null };
let _seasonalCache = null; // { seasonal, ts }
const SEASONAL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getSeasonalDiscount() {
  if (_seasonalCache && (Date.now() - _seasonalCache.ts) < SEASONAL_CACHE_TTL) return _seasonalCache.seasonal;
  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/site_config?key=eq.seasonal_discount&select=value&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const seasonal = rows?.[0]?.value || SEASONAL_DEFAULT;
    _seasonalCache = { seasonal, ts: Date.now() };
    return seasonal;
  } catch (e) {
    console.error('getSeasonalDiscount error, treating as inactive:', e.message);
    return SEASONAL_DEFAULT;
  }
}

function isSeasonalActive(seasonal) {
  if (!seasonal?.enabled || !seasonal.startDate || !seasonal.endDate) return false;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, date-only compare
  return today >= seasonal.startDate && today <= seasonal.endDate;
}

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

function gidToNumeric(gid) {
  if (!gid) return null;
  return String(gid).split('/').pop();
}

/** Look up Shopify customer numeric ID by email via Admin API */
async function findCustomerId(email) {
  try {
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&limit=1&fields=id`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const data = await res.json();
    if (data.customers && data.customers.length > 0) {
      return data.customers[0].id; // numeric ID
    }
  } catch (e) {
    console.error('findCustomerId error:', e.message);
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  if (!SHOPIFY_TOKEN) return json({ error: 'Shopify not configured'  }, 500);
  if (!RZP_KEY_ID)    return json({ error: 'Razorpay not configured' }, 500);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { items, customer, address, discountCode, discountPercent } = body;

  if (!items?.length)     return json({ error: 'No items provided' },         400);
  if (!customer?.email)   return json({ error: 'Customer email required' },   400);
  if (!address?.address1) return json({ error: 'Shipping address required' }, 400);

  try {
    // ── 1. Resolve Shopify customer numeric ID (needed for order to appear in My Orders) ──
    const customerId = await findCustomerId(customer.email);

    // ── 2. Calculate subtotal + discount + shipping ────────────────────────────
    const rawSubtotal = items.reduce((sum, item) => {
      return sum + parseFloat(item.price || '0') * (item.quantity || 1);
    }, 0);

    // Seasonal campaign stacks on top of whatever discount the client resolved
    // (CLUB10/FLASH5/AUTHOR10) — enforced server-side, client can't spoof or skip it.
    const seasonal        = await getSeasonalDiscount();
    const seasonalActive  = isSeasonalActive(seasonal);
    const seasonalPercent = seasonalActive ? Number(seasonal.percent) || 0 : 0;
    const clientPercent   = discountPercent > 0 ? Number(discountPercent) : 0;
    const combinedPercent = Math.min(clientPercent + seasonalPercent, 100);

    const discountAmt    = combinedPercent > 0 ? Math.round(rawSubtotal * combinedPercent / 100 * 100) / 100 : 0;
    const discountedSub  = rawSubtotal - discountAmt;
    const shippingSlabs  = await getShippingSettings();
    const shippingCharge = computeShippingCharge(discountedSub, shippingSlabs);

    // ── 3. Build Shopify Draft Order payload ──────────────────────────────────
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
        line_items:        lineItems,
        shipping_address:  shippingAddress,
        billing_address:   shippingAddress,
        email:             customer.email,
        send_receipt:      true,  // Shopify sends order confirmation email
        use_customer_default_address: false,
        note:  `Native app order | payment pending`,
        tags:  'app-order,android-native',
        // Add shipping line
        shipping_line: {
          title:  shippingCharge > 0 ? 'Standard Shipping' : 'Free Shipping',
          price:  shippingCharge.toFixed(2),
          custom: true,
        },
      }
    };

    // Link to existing customer account so order appears in My Orders
    if (customerId) {
      draftPayload.draft_order.customer = { id: customerId };
    } else {
      draftPayload.draft_order.customer = { email: customer.email };
    }

    // Apply discount(s) if any — a single combined percentage, since Shopify draft
    // orders only support one applied_discount. Label lists every discount that's stacked in.
    if (combinedPercent > 0) {
      const labels = [];
      if (clientPercent > 0) {
        labels.push(discountCode === 'CLUB10' ? 'Book Club Member Discount' : discountCode === 'AUTHOR10' ? 'Author Discount' : 'Flash Sale Discount');
      }
      if (seasonalActive) labels.push(seasonal.label || 'Seasonal Discount');
      draftPayload.draft_order.applied_discount = {
        description: labels.join(' + '),
        value_type:  'percentage',
        value:       String(combinedPercent),
        title:       [discountCode, seasonalActive ? 'SEASONAL' : null].filter(Boolean).join('+') || 'SEASONAL',
      };
    }

    // ── 4. Create Shopify Draft Order ─────────────────────────────────────────
    const shopifyRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/draft_orders.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type':           'application/json',
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

    // Use Shopify's calculated total (includes discount + shipping)
    const totalPrice  = parseFloat(draftOrder.total_price || '0');
    const amountPaise = Math.round(totalPrice * 100);

    // ── 5. Create Razorpay Order ──────────────────────────────────────────────
    const rzpAuth = Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64');

    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${rzpAuth}` },
      body: JSON.stringify({
        amount:   amountPaise,
        currency: 'INR',
        receipt:  `yfb_${draftOrder.id}`,
        notes: {
          draft_order_id:   String(draftOrder.id),
          draft_order_name: draftOrder.name,
          customer_email:   customer.email,
          discount_code:    discountCode || '',
          seasonal_applied: seasonalActive ? (seasonal.label || 'seasonal') : '',
        },
      }),
    });

    const rzpOrder = await rzpRes.json();
    if (rzpOrder.error) {
      console.error('Razorpay order error:', rzpOrder.error);
      return json({ error: rzpOrder.error.description || 'Razorpay order creation failed' }, 400);
    }

    return json({
      key:               RZP_KEY_ID,
      razorpay_order_id: rzpOrder.id,
      draft_order_id:    draftOrder.id,
      draft_order_name:  draftOrder.name,
      amount:            amountPaise,
      currency:          'INR',
      subtotal:          draftOrder.subtotal_price,
      shipping:          draftOrder.total_shipping_price_set?.shop_money?.amount || shippingCharge.toFixed(2),
      discount_amount:   draftOrder.applied_discount?.amount || '0',
      total:             draftOrder.total_price,
    });

  } catch (err) {
    console.error('create-native-order error:', err);
    return json({ error: err.message || 'Internal server error' }, 500);
  }
};
