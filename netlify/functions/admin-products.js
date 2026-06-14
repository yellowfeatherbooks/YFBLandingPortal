// Admin Stock Summary — list all products and update price/MRP/stock/status/type/collections.
// POST { adminEmail, adminKey, action, ...params }
//   action: "list"   → { success, products[], collections[] }
//   action: "update" → { productId, variantId, inventoryItemId, salePrice?, mrp?, stock?,
//                         status?, productType?, addCollectionIds?, removeCollectionIds? }

const crypto         = require('crypto');
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2025-04';
const GQL_URL        = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const GQL_HEADERS    = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
const REST           = (p) => `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/${p}`;
const REST_HEADERS   = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

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

async function verifyAdmin(email, adminKey) {
  if (!email || !adminKey) return false;
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

async function shopifyGql(query, variables = {}) {
  const res = await fetch(GQL_URL, { method: 'POST', headers: GQL_HEADERS, body: JSON.stringify({ query, variables }) });
  return res.json();
}

const numId = (gid) => (gid ? String(gid).split('/').pop() : null);

// ── action: list ────────────────────────────────────────────────────────────
async function listProducts() {
  const products = [];
  let cursor = null;
  let lastErrors = null;
  for (let page = 0; page < 12; page++) { // cap ~3000 products
    const data = await shopifyGql(`
      query ListProducts($cursor: String) {
        products(first: 250, after: $cursor, sortKey: TITLE) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title status productType vendor
            featuredImage { url }
            authorMf: metafield(namespace: "custom", key: "author") { value }
            variants(first: 1) { nodes { id price compareAtPrice inventoryQuantity inventoryItem { id requiresShipping } } }
            collections(first: 15) { nodes { id title handle ruleSet { appliedDisjunctively } } }
          }
        }
      }`, { cursor });

    if (data?.errors) lastErrors = data.errors;
    const conn = data?.data?.products;
    if (!conn) { console.warn('listProducts: bad response', JSON.stringify(data).slice(0, 400)); break; }

    for (const p of conn.nodes) {
      const v = p.variants?.nodes?.[0] || {};
      products.push({
        id:              p.id,
        title:           p.title,
        status:          p.status,                       // ACTIVE / DRAFT / ARCHIVED
        productType:     p.productType || '',
        author:          p.authorMf?.value || p.vendor || '',
        image:           p.featuredImage?.url || '',
        variantId:       v.id || null,
        inventoryItemId: v.inventoryItem?.id || null,
        price:           v.price ?? null,
        compareAtPrice:  v.compareAtPrice ?? null,
        requiresShipping: (v.inventoryItem && v.inventoryItem.requiresShipping) !== false,   // true = Physical, false = Digital
        stock:           (v.inventoryQuantity != null ? v.inventoryQuantity : 0),
        collections:     (p.collections?.nodes || []).map(c => ({ id: c.id, title: c.title, handle: c.handle, isSmart: !!c.ruleSet })),
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  if (!products.length && lastErrors) {
    return json({ success: false, error: 'Shopify query error: ' + JSON.stringify(lastErrors).slice(0, 400) });
  }

  const cdata = await shopifyGql(`{ collections(first: 100, sortKey: TITLE) { nodes { id title handle ruleSet { appliedDisjunctively } } } }`);
  const collections = (cdata?.data?.collections?.nodes || []).map(c => ({ id: c.id, title: c.title, handle: c.handle, isSmart: !!c.ruleSet }));

  return json({ success: true, products, collections });
}

// ── action: update ───────────────────────────────────────────────────────────
async function updateProduct(body) {
  const { productId, variantId, inventoryItemId,
          salePrice, mrp, stock, status, productType, requiresShipping, title,
          addCollectionIds = [], removeCollectionIds = [] } = body;

  if (!productId) return json({ success: false, error: 'productId required' }, 400);
  const errors = [];

  // 1 — Variant fields (sale price / MRP / requires_shipping) via REST
  const wantShip = (requiresShipping !== undefined);
  if ((salePrice !== undefined && salePrice !== '') || mrp !== undefined || wantShip) {
    const vNum = numId(variantId);
    if (vNum) {
      const variant = { id: Number(vNum) };
      if (salePrice !== undefined && salePrice !== '' && salePrice !== null) variant.price = String(salePrice);
      if (mrp !== undefined) variant.compare_at_price = (mrp === '' || mrp === null) ? null : String(mrp);
      if (wantShip) variant.requires_shipping = !!requiresShipping;
      try {
        const r = await fetch(REST(`variants/${vNum}.json`), { method: 'PUT', headers: REST_HEADERS, body: JSON.stringify({ variant }) });
        if (!r.ok) errors.push('variant: ' + (await r.text()).slice(0, 200));
      } catch (e) { errors.push('variant: ' + e.message); }
    } else { errors.push('No variant id for variant update'); }
  }

  // 2 — Stock via inventory_levels/set at the first location
  if (stock !== undefined && stock !== '' && stock !== null) {
    const invNum = numId(inventoryItemId);
    if (invNum) {
      try {
        const locRes = await fetch(REST('locations.json?limit=1'), { headers: REST_HEADERS });
        const locId  = (await locRes.json())?.locations?.[0]?.id;
        if (locId) {
          const setR = await fetch(REST('inventory_levels/set.json'), {
            method: 'POST', headers: REST_HEADERS,
            body: JSON.stringify({ location_id: locId, inventory_item_id: Number(invNum), available: parseInt(stock, 10) })
          });
          if (!setR.ok) errors.push('stock: ' + (await setR.text()).slice(0, 200));
        } else { errors.push('stock: no location found'); }
      } catch (e) { errors.push('stock: ' + e.message); }
    } else { errors.push('No inventory item id for stock update'); }
  }

  // 3 — Status + product type via productUpdate
  const pInput = { id: productId };
  let needProductUpdate = false;
  if (status !== undefined && status) { pInput.status = String(status).toUpperCase(); needProductUpdate = true; }
  if (productType !== undefined)      { pInput.productType = productType || '';        needProductUpdate = true; }
  if (title !== undefined && String(title).trim()) { pInput.title = String(title).trim(); needProductUpdate = true; }
  if (needProductUpdate) {
    try {
      const r = await shopifyGql(`
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) { product { id } userErrors { field message } }
        }`, { input: pInput });
      const ue = r?.data?.productUpdate?.userErrors || [];
      if (ue.length)  errors.push('product: ' + JSON.stringify(ue));
      if (r?.errors)  errors.push('product: ' + JSON.stringify(r.errors));
    } catch (e) { errors.push('product: ' + e.message); }
  }

  // 4 — Collection membership (manual collections only)
  for (const cid of addCollectionIds) {
    try {
      const r = await shopifyGql(`
        mutation AddToCollection($id: ID!, $pids: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $pids) { userErrors { field message } }
        }`, { id: cid, pids: [productId] });
      const ue = r?.data?.collectionAddProducts?.userErrors || [];
      if (ue.length) errors.push('collection add: ' + JSON.stringify(ue));
    } catch (e) { errors.push('collection add: ' + e.message); }
  }
  for (const cid of removeCollectionIds) {
    try {
      const r = await shopifyGql(`
        mutation RemoveFromCollection($id: ID!, $pids: [ID!]!) {
          collectionRemoveProducts(id: $id, productIds: $pids) { job { id } userErrors { field message } }
        }`, { id: cid, pids: [productId] });
      const ue = r?.data?.collectionRemoveProducts?.userErrors || [];
      if (ue.length) errors.push('collection remove: ' + JSON.stringify(ue));
    } catch (e) { errors.push('collection remove: ' + e.message); }
  }

  return json({ success: errors.length === 0, errors });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json({ success: false, error: 'Bad JSON' }, 400); }

  if (!await verifyAdmin(body.adminEmail, body.adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    if (body.action === 'list')   return await listProducts();
    if (body.action === 'update') return await updateProduct(body);
    return json({ success: false, error: 'Unknown action' }, 400);
  } catch (e) {
    console.error('admin-products error:', e.message);
    return json({ success: false, error: e.message }, 500);
  }
};
