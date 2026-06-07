// Approve or reject a book submission.
// Approve: updates Supabase status to 'listed' + publishes Shopify product (draft → active).
// Reject:  updates Supabase status to 'rejected'.
//
// POST { adminEmail, adminKey, submissionId, action: 'approve'|'reject', shopifyProductId? }

const crypto       = require('crypto');
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const AUTH_SB_URL    = process.env.AUTHOR_SUPABASE_URL  || process.env.SUPABASE_URL;
const AUTH_SB_KEY    = SERVICE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN  || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2025-04';

const GQL_URL     = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const GQL_HEADERS = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

async function shopifyGql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST', headers: GQL_HEADERS,
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function getPrintBooksCategoryGid() {
  // Try multiple search terms to find Print Books taxonomy category
  for (const term of ['Print Books', 'Books', 'print books']) {
    const data = await shopifyGql(`
      query($q: String!) {
        taxonomy { categories(search: $q, first: 10) {
          edges { node { id name fullName } }
        }}
      }`, { q: term });
    const edges = data?.data?.taxonomy?.categories?.edges || [];
    console.log(`Taxonomy search "${term}":`, JSON.stringify(edges.map(e => e.node)));
    const match = edges.find(e =>
      e.node.name === 'Print Books' ||
      e.node.fullName?.toLowerCase().includes('print books')
    );
    if (match) return match.node.id;
  }
  console.warn('getPrintBooksCategoryGid: no match found');
  return null;
}

// Get variant GID + inventory item GID in one query
async function getVariantInfo(productGid) {
  const data = await shopifyGql(`
    query($id: ID!) {
      product(id: $id) {
        variants(first: 1) {
          edges { node { id inventoryItem { id } } }
        }
      }
    }`, { id: productGid });
  const node = data?.data?.product?.variants?.edges?.[0]?.node;
  return {
    variantGid:       node?.id             || null,
    inventoryItemGid: node?.inventoryItem?.id || null,
  };
}

async function setupInventory(productGid, quantity = 1) {
  const { inventoryItemGid } = await getVariantInfo(productGid);
  if (!inventoryItemGid) { console.warn('setupInventory: no inventoryItem found'); return; }

  // Enable tracking + get location in parallel
  const [trackRes, locData] = await Promise.all([
    shopifyGql(`
      mutation($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) { userErrors { field message } }
      }`, { id: inventoryItemGid, input: { tracked: true } }),
    shopifyGql(`{ locations(first: 1) { edges { node { id name } } } }`)
  ]);

  const trackErrors = trackRes?.data?.inventoryItemUpdate?.userErrors || [];
  if (trackErrors.length) console.warn('inventoryItemUpdate errors:', JSON.stringify(trackErrors));

  const locationId = locData?.data?.locations?.edges?.[0]?.node?.id;
  if (!locationId) { console.warn('setupInventory: no location found'); return; }

  const qtyRes = await shopifyGql(`
    mutation($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) { userErrors { field message } }
    }`, {
    input: {
      name: 'available', reason: 'correction',
      ignoreCompareQuantity: true,
      quantities: [{ inventoryItemId: inventoryItemGid, locationId, quantity }]
    }
  });
  const qtyErrors = qtyRes?.data?.inventorySetQuantities?.userErrors || [];
  if (qtyErrors.length) console.warn('inventorySetQuantities errors:', JSON.stringify(qtyErrors));
  else console.log(`Stock set to ${quantity} at`, locationId);
}

async function setupVariantDefaults(shopifyProductId) {
  // Use REST API — more reliable than GQL for variant tax field on draft products
  try {
    const varRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${shopifyProductId}/variants.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const varData  = await varRes.json();
    const variantId = varData?.variants?.[0]?.id;
    if (!variantId) { console.warn('setupVariantDefaults: no variant found'); return; }

    const taxRes = await fetch(
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, submissionId, action, shopifyProductId } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!submissionId || !action)                 return json({ success: false, error: 'Missing submissionId or action' }, 400);

  const newStatus = action === 'approve' ? 'listed' : 'rejected';

  try {
    // 1 — Update Supabase submission status
    const sbRes = await fetch(
      `${AUTH_SB_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        AUTH_SB_KEY,
          'Authorization': `Bearer ${AUTH_SB_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ status: newStatus })
      }
    );
    if (!sbRes.ok) {
      const err = await sbRes.text();
      return json({ success: false, error: `Supabase update failed: ${err}` });
    }

    // 2 — If approving and a Shopify product ID is provided, publish it to all sales channels
    if (action === 'approve' && shopifyProductId) {
      const adminGqlUrl = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
      const gqlHeaders  = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
      const productGid  = `gid://shopify/Product/${shopifyProductId}`;

      // Read submission record: initial_stock + author for metafields
      let initialStock = 1;
      let submissionAuthor = null;
      try {
        const sbRow = await fetch(
          `${AUTH_SB_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}&select=initial_stock,author&limit=1`,
          { headers: { 'apikey': AUTH_SB_KEY, 'Authorization': `Bearer ${AUTH_SB_KEY}` } }
        );
        const rows = await sbRow.json();
        if (Array.isArray(rows) && rows[0]) {
          if (rows[0].initial_stock) initialStock = parseInt(rows[0].initial_stock) || 1;
          if (rows[0].author)        submissionAuthor = rows[0].author;
        }
        console.log('Submission record:', { initialStock, submissionAuthor });
      } catch (e) { console.warn('Could not read submission record:', e.message); }

      // Step 2a — Set Print Books category
      try {
        const categoryGid = await getPrintBooksCategoryGid();
        console.log('categoryGid resolved:', categoryGid);
        if (categoryGid) {
          const catRes = await shopifyGql(`
            mutation productUpdate($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id category { name } }
                userErrors { field message }
              }
            }`, { input: { id: productGid, category: categoryGid } });
          const catErrors = catRes?.data?.productUpdate?.userErrors || [];
          if (catErrors.length) console.warn('Category update errors:', JSON.stringify(catErrors));
          else console.log('Category set:', catRes?.data?.productUpdate?.product?.category?.name);
        }
      } catch (e) { console.warn('Category setup error:', e.message); }

      // Step 2b — Enable inventory tracking + set stock to initialStock
      try { await setupInventory(productGid, initialStock); }
      catch (e) { console.warn('Inventory setup error:', e.message); }

      // Step 2b2 — Set author metafield from submission record
      if (submissionAuthor) {
        try {
          const mfRes = await shopifyGql(`
            mutation productUpdate($input: ProductInput!) {
              productUpdate(input: $input) {
                product { id }
                userErrors { field message }
              }
            }`, {
            input: {
              id: productGid,
              metafields: [{ namespace: 'custom', key: 'author', value: submissionAuthor }]
            }
          });
          const mfErrors = mfRes?.data?.productUpdate?.userErrors || [];
          if (mfErrors.length) console.warn('Author metafield errors:', JSON.stringify(mfErrors));
          else console.log('Author metafield set:', submissionAuthor);
        } catch (e) { console.warn('Author metafield error:', e.message); }
      }

      // Step 2c — Uncheck tax on variant (uses REST with numeric shopifyProductId)
      try { await setupVariantDefaults(shopifyProductId); }
      catch (e) { console.warn('Variant defaults error:', e.message); }

      // Step 2d — Set product status to active via REST (fastest way to un-draft)
      const restRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${shopifyProductId}.json`,
        {
          method:  'PUT',
          headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ product: { id: shopifyProductId, status: 'active' } })
        }
      );
      if (!restRes.ok) {
        const err = await restRes.text();
        return json({ success: true, warning: `Status updated but Shopify activation failed: ${err}` });
      }

      // Step 2c — Get all sales channel publication IDs
      const pubsRes  = await fetch(adminGqlUrl, {
        method:  'POST',
        headers: gqlHeaders,
        body:    JSON.stringify({ query: `{ publications(first: 20) { edges { node { id name } } } }` })
      });
      const pubsData = await pubsRes.json();
      const publications = (pubsData?.data?.publications?.edges || []).map(e => e.node);

      if (publications.length) {
        // Step 2d — Publish product to all channels (makes it visible via Storefront API)
        const pubInput = publications.map(p => ({ publicationId: p.id }));

        const publishRes  = await fetch(adminGqlUrl, {
          method:  'POST',
          headers: gqlHeaders,
          body:    JSON.stringify({
            query: `
              mutation productPublish($input: ProductPublishInput!) {
                productPublish(input: $input) {
                  product { id }
                  userErrors { field message }
                }
              }`,
            variables: { input: { id: productGid, productPublications: pubInput } }
          })
        });
        const publishData  = await publishRes.json();
        const publishErrors = publishData?.data?.productPublish?.userErrors || [];
        if (publishErrors.length) {
          console.warn('Shopify publish warnings:', JSON.stringify(publishErrors));
        }
      }
    }

    return json({ success: true, newStatus });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
