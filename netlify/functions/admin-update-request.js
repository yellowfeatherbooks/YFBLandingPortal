// Update status of a book request or signed copy request.
// POST { adminEmail, adminKey, table: 'book_requests'|'signed_copy_requests', id, status: 'pending'|'completed'|'rejected' }

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

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

const ALLOWED_TABLES  = ['book_requests', 'signed_copy_requests'];
const ALLOWED_STATUSES = ['pending', 'completed', 'rejected'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, table, id, status } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  if (!ALLOWED_TABLES.includes(table))   return json({ success: false, error: 'Invalid table' }, 400);
  if (!ALLOWED_STATUSES.includes(status)) return json({ success: false, error: 'Invalid status' }, 400);
  if (!id)                                return json({ success: false, error: 'Missing id' }, 400);

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ status })
      }
    );
    if (!res.ok) {
      const err = await res.text();
      return json({ success: false, error: `Supabase update failed: ${err}` });
    }
    return json({ success: true, status });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
