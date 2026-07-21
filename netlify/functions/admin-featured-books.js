// GET  → returns current featured books (public, no auth)
// POST { adminEmail, adminKey, books } → saves featured books (admin auth required)

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const MAX_BOOKS = 20;

// ── Server-side in-memory cache (shared across warm Lambda instances) ─────────
let _cache = null; // { books, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached() {
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL) return _cache.books;
  return null;
}
function setCache(books) {
  _cache = { books, ts: Date.now() };
}
function bustCache() {
  _cache = null;
}

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

  // ── GET: public read (cached) ─────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const cached = getCached();
    if (cached) return json({ books: cached, fromCache: true });
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/site_config?key=eq.featured_books&select=value&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      const books = rows?.[0]?.value?.books || [];
      setCache(books);
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
    if (books.length > MAX_BOOKS)  return json({ error: `Maximum ${MAX_BOOKS} books allowed` }, 400);

    bustCache(); // invalidate cache so next GET fetches fresh data immediately

    await fetch(`${SUPABASE_URL}/rest/v1/site_config`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        key:        'featured_books',
        value:      { books },
        updated_at: new Date().toISOString()
      })
    });

    return json({ success: true });
  } catch(e) {
    return json({ error: e.message }, 500);
  }
};
