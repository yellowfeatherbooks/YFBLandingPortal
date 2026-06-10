// POST { adminEmail, adminKey, action, rows }
//
// action: "preview"  → match CSV rows to Shopify products, return matches/misses
// action: "sync"     → apply price + inventory updates to matched products
//
// Each row: { name, sellingPrice, stockQty, mrp }
// Matching: exact title match (case-insensitive, normalized)

const crypto           = require('crypto');
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN    = process.env.SHOPIFY_DOMAIN    || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN     = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION       = '2025-04';
const GQL_URL           = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const GQL_HEADERS       = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
const REST_HEADERS      = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// ── Auth ─────────────────────────────────────────────────────────────────────

async function verifyAdmin(email, adminKey) {
  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
    return expected === adminKey;
  } catch { return false; }
}

// ── Shopify helpers ───────────────────────────────────────────────────────────

async function shopifyGql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST', headers: GQL_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

// Fix common UTF-8 mojibake from BillBook CSV exports
function fixEncoding(str) {
  return (str || '')
    .replace(/â€"/g, '–')   // em dash
    .replace(/â€˜/g, ''')   // left single quote
    .replace(/â€™/g, ''')   // right single quote
    .replace(/â€œ/g, '"')   // left double quote
    .replace(/â€/g,  '"')   // right double quote
    .replace(/â€¦/g, '…')   // ellipsis
    .replace(/Ã©/g,  'é')   // é
    .replace(/Ã /g,  'à')   // à
    .replace(/Ã¨/g,  'è');  // è
}

// Normalize title for fuzzy matching: lowercase, remove punctuation/extra spaces
function normalize(str) {
  return fixEncoding(str || '')
    .toLowerCase()
    .replace(/[''"".,\-–—:;!?()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Search Shopify for a product by title (exact then fuzzy)
async function findShopifyProduct(title) {
  // Search using Shopify's product search
  const query = `title:${JSON.stringify(title)}`;
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products.json?title=${encodeURIComponent(title)}&fields=id,title,variants,status&limit=5`,
    { headers: REST_HEADERS }
  );
  const data = await res.json();
  const products = data?.products || [];

  const normTarget = normalize(title);

  // Exact normalized match first
  let match = products.find(p => normalize(p.title) === normTarget);

  // Partial match fallback (target starts with product title or vice versa)
  if (!match) {
    match = products.find(p => {
      const normP = normalize(p.title);
      return normP.includes(normTarget) || normTarget.includes(normP);
    });
  }

  if (!match) return null;

  const variant = match.variants?.[0];
  return {
    productId:   match.id,
    productTitle: match.title,
    variantId:   variant?.id,
    inventoryItemId: variant?.inventory_item_id,
    currentPrice:    variant?.price,
    currentCompare:  variant?.compare_at_price,
    status:          match.status
  };
}

// Get Shopify location ID (primary fulfillment location)
let _locationId = null;
async function getLocationId() {
  if (_locationId) return _locationId;
  const res  = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/locations.json?limit=1`,
    { headers: REST_HEADERS }
  );
  const data = await res.json();
  _locationId = data?.locations?.[0]?.id || null;
  return _locationId;
}

// Update variant price + compare_at_price
async function updatePrice(variantId, price, compareAtPrice) {
  const body = {
    variant: {
      id:               variantId,
      price:            parseFloat(price).toFixed(2),
      compare_at_price: compareAtPrice ? parseFloat(compareAtPrice).toFixed(2) : null
    }
  };
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/variants/${variantId}.json`,
    { method: 'PUT', headers: REST_HEADERS, body: JSON.stringify(body) }
  );
  return res.ok;
}

// Set inventory quantity at primary location
async function setInventory(inventoryItemId, qty) {
  const locationId = await getLocationId();
  if (!locationId) return false;
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/inventory_levels/set.json`,
    {
      method: 'POST',
      headers: REST_HEADERS,
      body: JSON.stringify({
        location_id:        locationId,
        inventory_item_id:  inventoryItemId,
        available:          Math.round(qty)
      })
    }
  );
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, action, rows } = JSON.parse(event.body || '{}');

    if (!adminEmail || !adminKey || !await verifyAdmin(adminEmail, adminKey))
      return json({ error: 'Unauthorized' }, 401);

    if (!Array.isArray(rows) || !rows.length)
      return json({ error: 'No rows provided' }, 400);

    if (!['preview', 'sync'].includes(action))
      return json({ error: 'action must be "preview" or "sync"' }, 400);

    const results = [];

    for (const row of rows) {
      const { name, sellingPrice, stockQty, mrp } = row;
      if (!name) continue;

      // Small delay to avoid Shopify rate limits
      if (results.length > 0 && results.length % 5 === 0) {
        await new Promise(r => setTimeout(r, 500));
      }

      let shopify = null;
      try { shopify = await findShopifyProduct(name); } catch (e) {}

      if (!shopify) {
        results.push({ name, sellingPrice, stockQty, mrp, status: 'not_found' });
        continue;
      }

      const result = {
        name,
        shopifyTitle:   shopify.productTitle,
        productId:      shopify.productId,
        variantId:      shopify.variantId,
        sellingPrice,
        mrp,
        stockQty,
        currentPrice:   shopify.currentPrice,
        currentCompare: shopify.currentCompare,
        status:         'matched'
      };

      if (action === 'sync') {
        let priceOk = true, stockOk = true, errors = [];

        // Update price + MRP
        try {
          priceOk = await updatePrice(shopify.variantId, sellingPrice, mrp);
        } catch (e) { priceOk = false; errors.push('price: ' + e.message); }

        // Update inventory
        try {
          stockOk = await setInventory(shopify.inventoryItemId, stockQty);
        } catch (e) { stockOk = false; errors.push('stock: ' + e.message); }

        result.status = (priceOk && stockOk) ? 'synced'
                      : (!priceOk && !stockOk) ? 'failed'
                      : priceOk ? 'stock_failed' : 'price_failed';
        if (errors.length) result.error = errors.join('; ');
      }

      results.push(result);
    }

    const summary = {
      total:     results.length,
      matched:   results.filter(r => r.status === 'matched').length,
      synced:    results.filter(r => r.status === 'synced').length,
      not_found: results.filter(r => r.status === 'not_found').length,
      failed:    results.filter(r => ['failed','stock_failed','price_failed'].includes(r.status)).length,
    };

    return json({ success: true, summary, results });

  } catch (e) {
    console.error('sync-billbook-stock error:', e.message);
    return json({ error: e.message }, 500);
  }
};
