// GET  → returns current flash sale books (public, no auth)
// POST { adminEmail, adminKey, books } → saves flash sale books (admin auth required)

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
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

  // ── GET: public read ──────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/site_config?key=eq.flash_sale&select=value&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      const books = rows?.[0]?.value?.books || [];
      return json({ books });
    } catch(e) {
      return json({ books: [] }); // graceful fallback
    }
  }

  // ── POST: admin save ──────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, books } = JSON.parse(event.body || '{}');
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ error: 'Unauthorized' }, 401);
    if (!Array.isArray(books))      return json({ error: 'books must be an array' }, 400);
    if (books.length > 10)         return json({ error: 'Maximum 10 books allowed' }, 400);

    await fetch(`${SUPABASE_URL}/rest/v1/site_config`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key:        'flash_sale',
        value:      { books },
        updated_at: new Date().toISOString()
      })
    });

    return json({ success: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
};
