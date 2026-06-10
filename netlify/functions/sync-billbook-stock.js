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

let _productPages = 0; // track pages loaded for debugging

async function loadAllProducts() {
  if (_productCache) return _productCache;
  _productCache = {};
  _productPages = 0;
  let pageInfo  = null; // cursor for next page
  const BASE    = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products.json`;

  while (true) {
    _productPages++;
    // IMPORTANT: When using page_info cursor, Shopify forbids other params (including fields).
    // Only limit + page_info allowed on page 2+.
    const qs  = pageInfo
      ? `limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `limit=250&fields=id,title,variants,status`;
    const res  = await fetch(`${BASE}?${qs}`, { headers: REST_HEADERS });
    const data = await res.json();
    const products = data?.products || [];

    for (const p of products) {
      _productCache[normalize(p.title)]           = p;
      _productCache[p.title.toLowerCase().trim()] = p;
    }

    // Extract next page cursor from Link header
    // Try all possible header name casings
    let linkHeader = '';
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase() === 'link') { linkHeader = v; break; }
    }
    const nextMatch = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
    pageInfo = nextMatch ? decodeURIComponent(nextMatch[1]) : null;

    if (!pageInfo || products.length === 0 || _productPages >= 25) break;
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

// Find Shopify product by exact title match only (normalized or plain lowercase).
// No fuzzy matching — Malayalam titles share too many common words.
// Unmatched books should be fixed by correcting the title in Shopify.
async function findShopifyProduct(title) {
  const cache = await loadAllProducts();
  // Try normalized first (handles punctuation/dash differences)
  const normTarget = normalize(title);
  if (cache[normTarget]) return toResult(cache[normTarget]);
  // Fallback: plain lowercase trim (catches cases where normalize changes something unexpectedly)
  const plainTarget = title.toLowerCase().trim();
  if (cache[plainTarget]) return toResult(cache[plainTarget]);
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

  // Reset caches on every request so preview always reflects current Shopify state.
  // Netlify may reuse warm function instances, causing stale cached data after a sync.
  _productCache   = null;
  _inventoryCache = null;

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

    // Unique product count (each product stored under 2 keys, but may overlap if normalize == lowercase)
    const uniqueKeys = _productCache ? Object.keys(_productCache).length : 0;
    const cacheSize  = { keys: uniqueKeys, pages: _productPages };
    return json({ success: true, summary, results, cacheSize });

  } catch (e) {
    console.error('sync-billbook-stock error:', e.message);
    return json({ error: e.message }, 500);
  }
};
