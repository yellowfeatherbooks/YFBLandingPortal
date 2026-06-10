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
    .replace(/â€"/g,  '–')  // en dash
    .replace(/â€"/g,  '—')  // em dash
    .replace(/â€˜/g,  '‘')  // left single quote
    .replace(/â€™/g,  '’')  // right single quote
    .replace(/â€œ/g,  '“')  // left double quote
    .replace(/â€\x9D/g, '”') // right double quote
    .replace(/â€¦/g,  '…')  // ellipsis
    .replace(/Ã©/g,   'é')  // é
    .replace(/Ã /g,   'à')  // à
    .replace(/Ã¨/g,   'è'); // è
}

// Normalize title for fuzzy matching: lowercase, remove punctuation/extra spaces
function normalize(str) {
  return fixEncoding(str || '')
    .toLowerCase()
    .replace(/[''"".,\-–—:;!?()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Bulk product cache ────────────────────────────────────────────────────────
// Fetch ALL Shopify products once and build a normalized-title lookup map.
// This avoids 1233 individual REST calls and enables better fuzzy matching.

let _productCache   = null; // { normTitle → shopifyProduct }
let _inventoryCache = null; // { inventoryItemId → available qty }

async function loadAllProducts() {
  if (_productCache) return _productCache;
  _productCache = {};
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products.json?fields=id,title,variants,status&limit=250`;
  while (url) {
    const res  = await fetch(url, { headers: REST_HEADERS });
    const data = await res.json();
    const products = data?.products || [];
    for (const p of products) {
      _productCache[normalize(p.title)] = p;
    }
    const link = res.headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return _productCache;
}

// Bulk-fetch inventory levels for all known inventory item IDs (50 per request)
async function loadAllInventory() {
  if (_inventoryCache) return _inventoryCache;
  _inventoryCache = {};
  const locationId = await getLocationId();
  if (!locationId) return _inventoryCache;

  // Collect all inventory item IDs from product cache
  const allItems = Object.values(_productCache || {})
    .map(p => p.variants?.[0]?.inventory_item_id)
    .filter(Boolean);

  // Fetch in chunks of 50 (Shopify limit for inventory_levels)
  for (let i = 0; i < allItems.length; i += 50) {
    const chunk = allItems.slice(i, i + 50);
    const res   = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/inventory_levels.json` +
      `?inventory_item_ids=${chunk.join(',')}&location_ids=${locationId}&limit=50`,
      { headers: REST_HEADERS }
    );
    const data = await res.json();
    for (const lvl of (data?.inventory_levels || [])) {
      _inventoryCache[lvl.inventory_item_id] = lvl.available ?? 0;
    }
  }
  return _inventoryCache;
}

// Word-overlap score: fraction of CSV words found in Shopify title words
function wordOverlap(a, b) {
  const wa = a.split(' ').filter(Boolean);
  const wb = new Set(b.split(' ').filter(Boolean));
  if (!wa.length) return 0;
  return wa.filter(w => wb.has(w)).length / wa.length;
}

// Find best-matching Shopify product for a CSV title
async function findShopifyProduct(title) {
  const cache = await loadAllProducts();
  const normTarget = normalize(title);

  // 1. Exact normalized match
  if (cache[normTarget]) return toResult(cache[normTarget]);

  // 2. One side contains the other (handles extra subtitle words)
  for (const [normKey, p] of Object.entries(cache)) {
    if (normKey.includes(normTarget) || normTarget.includes(normKey)) {
      return toResult(p);
    }
  }

  // 3. High word-overlap (≥ 0.80) — handles minor spelling diffs / extra articles
  let best = null, bestScore = 0;
  for (const [normKey, p] of Object.entries(cache)) {
    const score = wordOverlap(normTarget, normKey);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (bestScore >= 0.80) return toResult(best);

  return null;
}

function toResult(p) {
  const variant = p.variants?.[0];
  const invId   = variant?.inventory_item_id;
  const currentStock = (_inventoryCache && invId != null && _inventoryCache[invId] !== undefined)
    ? _inventoryCache[invId]
    : null; // null = not yet loaded
  return {
    productId:       p.id,
    productTitle:    p.title,
    variantId:       variant?.id,
    inventoryItemId: invId,
    currentPrice:    variant?.price,
    currentCompare:  variant?.compare_at_price,
    currentStock,
    status:          p.status
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

    // For preview: pre-load all products + inventory so toResult() has currentStock
    if (action === 'preview') {
      await loadAllProducts();
      await loadAllInventory();
    }

    const results = [];

    for (const row of rows) {
      const { name, sellingPrice, stockQty, mrp } = row;
      if (!name) continue;

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
        // Small delay every 10 writes to respect Shopify rate limits
        if (results.filter(r => r.status === 'synced').length % 10 === 0) {
          await new Promise(r => setTimeout(r, 300));
        }
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
