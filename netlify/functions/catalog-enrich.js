// catalog-enrich.js
// Admin helper for the Stock Sync → "List on Shopify" flow.
// POST { adminEmail, adminKey, title }
//   → EXACT title lookup in the catalog (lookup_catalog_book RPC, private schema)
//   → returns the matched book's author / publisher / category / ISBN so the
//     Add Book form can pre-fill the fields MyBillBook doesn't have.
//
// Exact match only (case/space/punctuation-insensitive) — never a fuzzy guess.
// Read-only metadata lookup; admin-gated like the other admin endpoints.
// Env: SUPABASE_URL, SUPABASE_KEY, SUPABASE_SERVICE_KEY.

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;

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
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, title } = JSON.parse(event.body || '{}');
    if (!title || !title.trim())  return json({ found: false });
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ error: 'Unauthorized' }, 401);
    if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: 'Enrichment not configured.' }, 500);

    // Exact (normalized) title lookup in the private catalog.
    const rr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/lookup_catalog_book`, {
      method:  'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ p_title: title.trim() }),
    });
    if (!rr.ok) return json({ found: false });
    const rows = await rr.json();
    if (!Array.isArray(rows) || !rows.length) return json({ found: false });

    const m = rows[0];
    return json({
      found:        true,
      matchedTitle: m.title,
      author:       m.author    || '',
      publisher:    m.publisher || '',
      genre:        m.category  || '',   // catalog "category" maps to the Add Book "Genre"
      isbn:         m.isbn      || '',
      score:        typeof m.score === 'number' ? m.score : null,
    });
  } catch (err) {
    console.error('catalog-enrich error:', err.message);
    return json({ found: false, error: err.message });
  }
};
