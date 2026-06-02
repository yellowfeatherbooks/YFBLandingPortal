// Admin endpoint to create / list / delete sales team accounts.
// POST { adminEmail, adminKey, action: 'create' | 'list' | 'delete', ... }

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;

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

  const { adminEmail, adminKey, action, email, name, password, id } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    if (action === 'list') {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/sales_team?select=id,email,name,created_at&order=created_at.desc`,
        { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
      );
      const rows = await res.json();
      return json({ success: true, members: Array.isArray(rows) ? rows : [] });
    }

    if (action === 'create') {
      if (!email || !password) return json({ success: false, error: 'Email and password are required' }, 400);
      const salt         = crypto.randomBytes(32).toString('hex');
      const passwordHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      const res = await fetch(`${SUPABASE_URL}/rest/v1/sales_team`, {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify({ email, name: name || 'Sales', password_hash: passwordHash, salt })
      });
      if (!res.ok) {
        const err = await res.text();
        return json({ success: false, error: err.includes('duplicate') ? 'Email already exists' : err });
      }
      return json({ success: true, message: `Sales account created for ${email}` });
    }

    if (action === 'reset-password') {
      if (!email || !password) return json({ success: false, error: 'Email and new password required' }, 400);
      const salt         = crypto.randomBytes(32).toString('hex');
      const passwordHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/sales_team?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_SVC_KEY,
            'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ password_hash: passwordHash, salt })
        }
      );
      if (!res.ok) return json({ success: false, error: await res.text() });
      return json({ success: true, message: `Password reset for ${email}` });
    }

    if (action === 'delete') {
      if (!id) return json({ success: false, error: 'ID required' }, 400);
      await fetch(
        `${SUPABASE_URL}/rest/v1/sales_team?id=eq.${id}`,
        { method: 'DELETE', headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
      );
      return json({ success: true });
    }

    return json({ success: false, error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ success: false, error: e.message }, 500);
  }
};
