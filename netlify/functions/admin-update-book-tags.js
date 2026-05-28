/**
 * admin-update-book-tags
 *
 * action = 'search'  — search products by title fragment
 *   POST { adminEmail, adminKey, action: 'search', query: 'word...' }
 *   Returns: { products: [{ id, title, handle, tags, imageUrl }] }
 *
 * action = 'update'  — replace tags array on a product
 *   POST { adminEmail, adminKey, action: 'update', productId: 'gid://...', tags: [...] }
 *   Returns: { product: { id, title, tags } }
 */

const crypto         = require('crypto');
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN     || 'zgqk4e-1m.myshopify.com';
const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
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

async function adminGQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ADMIN_TOKEN },
      body:    JSON.stringify({ query, variables }),
    }
  );
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  const body = JSON.parse(event.body || '{}');
  const { adminEmail, adminKey, action } = body;

  if (!await verifyAdmin(adminEmail, adminKey))
    return json({ error: 'Unauthorized' }, 401);

  if (!ADMIN_TOKEN)
    return json({ error: 'SHOPIFY_ADMIN_TOKEN not configured' }, 500);

  try {
    // ── Search ──────────────────────────────────────────────────────────────
    if (action === 'search') {
      const q = (body.query || '').trim();
      if (!q) return json({ products: [] });

      const data = await adminGQL(`{
        products(first: 15, query: "title:*${q.replace(/"/g, '')}* OR title:${q.replace(/"/g, '')}") {
          edges {
            node {
              id title handle tags
              featuredImage { url }
            }
          }
        }
      }`);
      const products = (data.products?.edges || []).map(e => ({
        id:       e.node.id,
        title:    e.node.title,
        handle:   e.node.handle,
        tags:     e.node.tags,
        imageUrl: e.node.featuredImage?.url || null,
      }));
      return json({ products });
    }

    // ── Update tags ──────────────────────────────────────────────────────────
    if (action === 'update') {
      const { productId, tags } = body;
      if (!productId || !Array.isArray(tags))
        return json({ error: 'productId and tags[] required' }, 400);

      const data = await adminGQL(`
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id title tags }
            userErrors { field message }
          }
        }
      `, { input: { id: productId, tags } });

      const errs = data.productUpdate?.userErrors || [];
      if (errs.length) return json({ error: errs.map(e => e.message).join('; ') }, 400);

      return json({ product: data.productUpdate.product });
    }

    return json({ error: 'Unknown action. Use "search" or "update".' }, 400);

  } catch (err) {
    console.error('admin-update-book-tags:', err.message);
    return json({ error: err.message }, 500);
  }
};
