// Update status/resolution of a customer care ticket.
// POST { adminEmail, adminKey, id, status: 'open'|'in_progress'|'resolved'|'closed', resolution? }

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_COMPLAINT_RESOLVED_URL = process.env.N8N_COMPLAINT_RESOLVED_URL;

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

const ALLOWED_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, id, status, resolution } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  if (!id)                                 return json({ success: false, error: 'Missing id' }, 400);
  if (!ALLOWED_STATUSES.includes(status))  return json({ success: false, error: 'Invalid status' }, 400);
  if (status === 'resolved' && !resolution?.trim()) {
    return json({ success: false, error: 'A resolution note is required to resolve a ticket.' }, 400);
  }

  try {
    const curRes  = await fetch(
      `${SUPABASE_URL}/rest/v1/complaints?id=eq.${encodeURIComponent(id)}&select=status,email,name,subject`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const curRows = await curRes.json();
    const current = Array.isArray(curRows) && curRows.length ? curRows[0] : null;
    if (!current) return json({ success: false, error: 'Ticket not found' }, 404);

    const patchBody = { status, updated_at: new Date().toISOString() };
    if (typeof resolution === 'string') patchBody.resolution = resolution;
    if (status === 'resolved') {
      patchBody.resolved_by = adminEmail;
      patchBody.resolved_at = new Date().toISOString();
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/complaints?id=eq.${encodeURIComponent(id)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SERVICE_KEY,
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify(patchBody)
      }
    );
    if (!res.ok) {
      const err = await res.text();
      return json({ success: false, error: `Supabase update failed: ${err}` });
    }

    if (current.status !== 'resolved' && status === 'resolved' && N8N_COMPLAINT_RESOLVED_URL) {
      fetch(N8N_COMPLAINT_RESOLVED_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id, email: current.email, name: current.name, subject: current.subject, resolution })
      }).catch(e => console.error('n8n complaint-resolved trigger failed:', e.message));
    }

    return json({ success: true, status });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
