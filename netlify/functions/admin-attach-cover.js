// Attaches a cover image to a Shopify product — either a URL (Shopify fetches
// and hosts it itself) or a base64-encoded upload (admin's own file, already
// cropped/composited client-side before it reaches here).
// POST { adminEmail, adminKey, productId, imageUrl } OR { ..., productId, imageBase64 }

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

// Callers pass either a plain REST numeric id (from Missing Covers, which lists
// via the REST Admin API) or a GraphQL GID like "gid://shopify/Product/12345"
// (from Stock Summary, which lists via GraphQL) — REST endpoints need the bare
// numeric id, so normalise either shape down to just the trailing digits.
function toRestId(id) {
  const m = String(id || '').match(/(\d+)$/);
  return m ? m[1] : String(id || '');
}

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

  let payload;
  try {
    // Large bodies (a base64 image upload) can arrive base64-encoded at the
    // transport layer — decode before JSON-parsing, or a plain image upload
    // throws an uncaught exception here (outside any try/catch further down).
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    payload = JSON.parse(rawBody || '{}');
  } catch (err) {
    return json({ success: false, error: 'Invalid request body: ' + err.message }, 400);
  }
  const { adminEmail, adminKey, productId, imageUrl, imageBase64 } = payload;
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!productId || (!imageUrl && !imageBase64)) {
    return json({ success: false, error: 'Missing productId and imageUrl/imageBase64' }, 400);
  }

  try {
    const image = imageBase64 ? { attachment: imageBase64 } : { src: imageUrl };
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${toRestId(productId)}/images.json`,
      {
        method:  'POST',
        headers: REST_HEADERS,
        body:    JSON.stringify({ image })
      }
    );
    // Read as text first — Shopify can return an empty/non-JSON body on some
    // error paths (e.g. a rejected oversized attachment), and calling res.json()
    // directly on that throws "Unexpected end of JSON input", masking the real
    // Shopify status/response. Parsing text ourselves lets us surface both.
    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : {}; } catch (e) { /* leave data null, handled below */ }

    if (!res.ok || data === null) {
      console.error('Shopify attach-cover failed:', res.status, rawText.slice(0, 1000));
      const detail = data?.errors ? JSON.stringify(data.errors)
        : rawText ? rawText.slice(0, 300)
        : '(empty response body)';
      return json({ success: false, error: `Shopify error ${res.status}: ${detail}` }, 500);
    }
    return json({ success: true, imageUrl: data?.image?.src || imageUrl });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
