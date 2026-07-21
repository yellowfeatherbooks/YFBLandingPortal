// Lists active Shopify products that have no cover image.
// POST { adminEmail, adminKey }

const crypto         = require('crypto');
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';
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

  const { adminEmail, adminKey } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    const BASE = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products.json`;
    let sinceId = 0;
    let pages   = 0;
    const missing = [];

    while (true) {
      pages++;
      const qs  = `limit=250&status=active&fields=id,title,vendor,handle,image&since_id=${sinceId}`;
      let products = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch(`${BASE}?${qs}`, { headers: REST_HEADERS });
        if (res.status === 429 || res.status >= 500) {
          await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
          continue;
        }
        const data = await res.json();
        products = data?.products || [];
        break;
      }

      if (!products || !products.length) break;

      for (const p of products) {
        if (!p.image) missing.push({ id: p.id, title: p.title, vendor: p.vendor || '', handle: p.handle });
      }

      sinceId = products[products.length - 1].id;
      if (products.length < 250 || pages >= 10) break;
    }

    return json({ success: true, products: missing });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
