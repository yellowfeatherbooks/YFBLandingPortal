// Manage books available for signed copy pre-booking
// POST { adminEmail, adminKey, action, ...params }
// Actions: list | add | remove

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';

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
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

async function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {})
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const body = JSON.parse(event.body || '{}');
  const { adminEmail, adminKey, action } = body;

  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  // ── List available books ──
  if (action === 'list') {
    const res  = await sbFetch('signed_copy_available?order=added_at.desc');
    const rows = await res.json();
    return json({ success: true, books: rows || [] });
  }

  // ── Search Shopify for a book to add (GraphQL for partial matching) ──
  if (action === 'search') {
    const { query } = body;
    if (!query) return json({ success: false, error: 'query required' }, 400);
    try {
      const gqlRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
        {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query SearchBooks($q: String!) {
              products(first: 12, query: $q) {
                edges { node {
                  id title vendor handle
                  images(first: 1) { edges { node { url } } }
                  variants(first: 1) { edges { node { price } } }
                }}
              }
            }`,
            variables: { q: `title:*${query}*` }
          })
        }
      );
      const gqlData = await gqlRes.json();
      const edges   = gqlData?.data?.products?.edges || [];
      const products = edges.map(({ node: p }) => ({
        shopify_id:  p.id.replace('gid://shopify/Product/', ''),
        title:       p.title,
        author_name: p.vendor || '',
        image_url:   p.images?.edges?.[0]?.node?.url || '',
        handle:      p.handle,
        price:       p.variants?.edges?.[0]?.node?.price || ''
      }));
      return json({ success: true, products });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Add a book ──
  if (action === 'add') {
    const { shopify_id, title, author_name, image_url, handle, price } = body;
    if (!title) return json({ success: false, error: 'title required' }, 400);
    const res = await sbFetch('signed_copy_available', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ shopify_id, title, author_name, image_url, handle, price, added_by: adminEmail })
    });
    if (res.ok) return json({ success: true });
    const err = await res.json();
    return json({ success: false, error: JSON.stringify(err) });
  }

  // ── Remove a book ──
  if (action === 'remove') {
    const { id } = body;
    if (!id) return json({ success: false, error: 'id required' }, 400);
    await sbFetch(`signed_copy_available?id=eq.${id}`, { method: 'DELETE' });
    return json({ success: true });
  }

  return json({ success: false, error: 'Unknown action' }, 400);
};
