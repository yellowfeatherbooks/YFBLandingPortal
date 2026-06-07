const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2025-04';
const GQL_URL         = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const GQL_HEADERS     = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

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
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

async function shopifyGql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST', headers: GQL_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

// Enable inventory tracking + set stock via REST (more reliable than GQL)
async function setupInventory(shopifyProductId, quantity = 1) {
  try {
    // 1 — Get variant (inventory_item_id is numeric in REST response)
    const varRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${shopifyProductId}/variants.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const varData = await varRes.json();
    const variant = varData?.variants?.[0];
    if (!variant) { console.warn('setupInventory: no variant found'); return; }
    const inventoryItemId = variant.inventory_item_id;
    console.log('inventoryItemId:', inventoryItemId);

    // 2 — Enable tracking via REST
    await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/inventory_items/${inventoryItemId}.json`,
      {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventory_item: { id: inventoryItemId, tracked: true } })
      }
    );

    // 3 — Get first location ID
    const locRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/locations.json?limit=1`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const locData = await locRes.json();
    const locationId = locData?.locations?.[0]?.id;
    if (!locationId) { console.warn('setupInventory: no location found'); return; }

    // 4 — Set quantity
    const setRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/inventory_levels/set.json`,
      {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: quantity })
      }
    );
    const setData = await setRes.json();
    console.log('Inventory set result:', JSON.stringify(setData?.inventory_level || setData));
  } catch (e) {
    console.warn('setupInventory error:', e.message);
  }
}

// Uncheck tax on the first variant via REST
async function setupVariantDefaults(shopifyProductId) {
  try {
    const varRes  = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${shopifyProductId}/variants.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const varData  = await varRes.json();
    const variantId = varData?.variants?.[0]?.id;
    if (!variantId) { console.warn('setupVariantDefaults: no variant found'); return; }
    const taxRes  = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/variants/${variantId}.json`,
      {
        method:  'PUT',
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ variant: { id: variantId, taxable: false } })
      }
    );
    const taxData = await taxRes.json();
    console.log('Tax disabled, taxable now:', taxData?.variant?.taxable);
  } catch (e) {
    console.warn('setupVariantDefaults error:', e.message);
  }
}

// Find the "Print Books" taxonomy category GID
async function getPrintBooksCategoryGid() {
  const data = await shopifyGql(`{
    taxonomy { categories(search: "Print Books", first: 5) {
      edges { node { id name fullName } }
    }}
  }`);
  const edges = data?.data?.taxonomy?.categories?.edges || [];
  const match = edges.find(e =>
    e.node.name === 'Print Books' || e.node.fullName?.includes('Print Books')
  );
  return match?.node?.id || null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const {
    adminEmail, adminKey,
    book, author, publisher, genre, shopifyTags,
    description, mrp, salePrice, barcode, phone, cover,
    initialStock,
    metafields   // { genreGids, bookCoverTypeGids, languageVersionGids, targetAudienceGids }
  } = JSON.parse(event.body || '{}');
  const stockQty = Math.max(1, parseInt(initialStock) || 1);

  if (!await verifyAdmin(adminEmail, adminKey)) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  if (!book || !author || !publisher || !genre || !mrp || !barcode) {
    return json({ success: false, error: 'All required fields must be filled' }, 400);
  }

  const webhookUrl = process.env.N8N_SUBMIT_BOOK_URL;
  if (!webhookUrl) {
    return json({ success: false, error: 'Submission webhook not configured' }, 503);
  }

  try {
    // Step 1 — Create product via n8n
    const n8nRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: adminEmail, name: 'Admin',
        book, author, publisher, genre,
        shopifyTags: shopifyTags || [],
        description, mrp, salePrice: salePrice || null,
        barcode, phone, cover,
        activate: true
      })
    });
    const data = await n8nRes.json();
    if (!data.success && data.status !== 'success') return json(data);

    const shopifyId = data.shopifyId || data.shopify_Id || null;

    // Step 2 — Set category + metafields + author on the product
    if (shopifyId && SHOPIFY_TOKEN) {
      const productGid = `gid://shopify/Product/${shopifyId}`;

      // 2a — Find Print Books category GID
      const categoryGid = await getPrintBooksCategoryGid();

      // 2b — Build metafields input (no `type` — definitions already exist in Shopify)
      const mfInput = [];
      const listVal = (gids) => JSON.stringify((gids || []).filter(Boolean));

      if (metafields?.genreGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'genre',            value: listVal(metafields.genreGids) });
      if (metafields?.bookCoverTypeGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'book-cover-type',  value: listVal(metafields.bookCoverTypeGids) });
      if (metafields?.languageVersionGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'language-version', value: listVal(metafields.languageVersionGids) });
      if (metafields?.targetAudienceGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'target-audience',  value: listVal(metafields.targetAudienceGids) });

      // Author is a plain text metafield
      if (author)
        mfInput.push({ namespace: 'custom', key: 'author', value: author });

      // 2c — Run productUpdate with category + metafields in one call
      const updateInput = { id: productGid };
      if (categoryGid) updateInput.category = categoryGid;
      if (mfInput.length) updateInput.metafields = mfInput;

      if (categoryGid || mfInput.length) {
        const updateRes = await shopifyGql(`
          mutation productUpdate($input: ProductInput!) {
            productUpdate(input: $input) {
              product { id category { name } }
              userErrors { field message }
            }
          }`, { input: updateInput });

        const errors = updateRes?.data?.productUpdate?.userErrors || [];
        if (errors.length) {
          console.warn('productUpdate warnings:', JSON.stringify(errors));
        }
      }

      // 2d — Enable inventory tracking and set stock (REST, uses numeric shopifyId)
      await setupInventory(shopifyId, stockQty);

      // 2e — Uncheck tax on variant
      await setupVariantDefaults(shopifyId);
    }

    // Step 3 — Save to Supabase as 'listed'
    let sbDebug = {};
    if (SUPABASE_URL && SUPABASE_KEY) {
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({
          title: book, author, publisher, genre,
          mrp:            parseFloat(mrp),
          status:         'listed',
          submitted_date: new Date().toISOString(),
          submitted_by:   adminEmail,
          shopify_id:     shopifyId,
        })
      });
      const sbText = await sbRes.text();
      sbDebug = { status: sbRes.status, body: sbText || '(empty — success)' };
    }

    return json({ ...data, _sb: sbDebug });

  } catch (e) {
    console.error('admin-submit-book error:', e.message);
    return json({ success: false, error: 'Submission failed. Please try again.' }, 500);
  }
};
