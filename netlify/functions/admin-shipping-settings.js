// GET  → returns current shipping settings (public, no auth) — used by the checkout estimate
// POST { adminEmail, adminKey, charge, freeThreshold } → saves shipping settings (admin auth required)

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const DEFAULTS = { charge: 80, freeThreshold: 1000 };

// ── Server-side in-memory cache (shared across warm Lambda instances) ─────────
let _cache = null; // { settings, ts }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached() {
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL) return _cache.settings;
  return null;
}
function setCache(settings) {
  _cache = { settings, ts: Date.now() };
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
    if (cached) return json(cached);
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/site_config?key=eq.shipping&select=value&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      const settings = {
        charge:        rows?.[0]?.value?.charge        ?? DEFAULTS.charge,
        freeThreshold: rows?.[0]?.value?.freeThreshold ?? DEFAULTS.freeThreshold,
      };
      setCache(settings);
      return json(settings);
    } catch (e) {
      return json(DEFAULTS); // graceful fallback
    }
  }

  // ── POST: admin save ──────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, charge, freeThreshold } = JSON.parse(event.body || '{}');
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ error: 'Unauthorized' }, 401);

    const chargeNum = Number(charge);
    const thresholdNum = Number(freeThreshold);
    if (!Number.isFinite(chargeNum) || chargeNum < 0)        return json({ error: 'charge must be a non-negative number' }, 400);
    if (!Number.isFinite(thresholdNum) || thresholdNum < 0)  return json({ error: 'freeThreshold must be a non-negative number' }, 400);

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
        value:      { charge: chargeNum, freeThreshold: thresholdNum },
        updated_at: new Date().toISOString()
      })
    });

    return json({ success: true, charge: chargeNum, freeThreshold: thresholdNum });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
