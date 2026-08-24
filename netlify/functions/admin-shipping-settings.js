// GET  → returns current shipping settings (public, no auth) — used by the checkout estimate
// POST { adminEmail, adminKey, slabs } → saves shipping settings (admin auth required)
//
// slabs: [{ min, max, price }, ...] — order-amount tiers, ascending by min, no overlaps.
// max is null only on the last slab ("no limit"). A slab with price 0 gives free shipping
// for that range (replaces the old separate freeThreshold field).

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const DEFAULT_SLABS = [
  { min: 0,       max: 1000, price: 80 },
  { min: 1000.01, max: null, price: 0 },
];

// ── Server-side in-memory cache (shared across warm Lambda instances) ─────────
let _cache = null; // { slabs, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached() {
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL) return _cache.slabs;
  return null;
}
function setCache(slabs) {
  _cache = { slabs, ts: Date.now() };
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

// Returns an error string, or null if the slabs are valid.
function validateSlabs(slabs) {
  if (!Array.isArray(slabs) || !slabs.length) return 'At least one slab is required.';
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    const n = i + 1;
    if (!Number.isFinite(s.min) || s.min < 0) return `Slab ${n}: min must be a non-negative number.`;
    if (!Number.isFinite(s.price) || s.price < 0) return `Slab ${n}: price must be a non-negative number.`;
    const isLast = i === slabs.length - 1;
    if (s.max === null || s.max === undefined) {
      if (!isLast) return `Slab ${n}: only the last slab may have no upper limit.`;
    } else {
      if (!Number.isFinite(s.max) || s.max <= s.min) return `Slab ${n}: max must be greater than min.`;
    }
    if (i > 0) {
      const prev = slabs[i - 1];
      if (s.min <= prev.min) return `Slab ${n}: min must be greater than the previous slab's min.`;
      if (prev.max !== null && prev.max !== undefined && s.min <= prev.max) {
        return `Slab ${n}: overlaps the previous slab — min must be greater than the previous slab's max.`;
      }
    }
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  // ── GET: public read (cached) ─────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const cached = getCached();
    if (cached) return json({ slabs: cached });
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/site_config?key=eq.shipping&select=value&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      const slabs = Array.isArray(rows?.[0]?.value?.slabs) ? rows[0].value.slabs : DEFAULT_SLABS;
      setCache(slabs);
      return json({ slabs });
    } catch (e) {
      return json({ slabs: DEFAULT_SLABS }); // graceful fallback
    }
  }

  // ── POST: admin save ──────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, slabs } = JSON.parse(event.body || '{}');
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ error: 'Unauthorized' }, 401);

    const normalized = (slabs || []).map(s => ({
      min:   Number(s.min),
      max:   (s.max === null || s.max === undefined || s.max === '') ? null : Number(s.max),
      price: Number(s.price),
    }));
    const err = validateSlabs(normalized);
    if (err) return json({ error: err }, 400);

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
        key:        'shipping',
        value:      { slabs: normalized },
        updated_at: new Date().toISOString()
      })
    });

    return json({ success: true, slabs: normalized });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
