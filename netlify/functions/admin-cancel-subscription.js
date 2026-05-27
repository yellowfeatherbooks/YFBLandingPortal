// Cancels an author's subscription by setting status to 'cancelled'.
// POST { adminEmail, adminKey, email }

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const AUTH_SB_URL  = process.env.AUTHOR_SUPABASE_URL  || process.env.SUPABASE_URL;
const AUTH_SB_KEY  = SERVICE_KEY;

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

  const { adminEmail, adminKey, email } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!email) return json({ success: false, error: 'Missing email' }, 400);

  try {
    const res = await fetch(
      `${AUTH_SB_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        AUTH_SB_KEY,
          'Authorization': `Bearer ${AUTH_SB_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ status: 'cancelled' })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      return json({ success: false, error: `Cancel failed: ${err}` });
    }
    return json({ success: true });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
