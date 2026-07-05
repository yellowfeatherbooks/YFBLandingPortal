// Completes a STAFF self-service password reset (admins + sales_team).
// POST { token, password }
// Looks up the token in `admins` first, then `sales_team`; validates expiry;
// sets a new password_hash + salt and clears the token.

const crypto       = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

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

async function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey:         SUPABASE_KEY,
      Authorization:  `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

async function findByToken(token) {
  for (const table of ['admins', 'sales_team']) {
    const res  = await sbFetch(`${table}?reset_token=eq.${encodeURIComponent(token)}&select=email,reset_token_expiry&limit=1`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) return { table, ...rows[0] };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { token, password } = JSON.parse(event.body || '{}');
  if (!token || !password) return json({ success: false, error: 'Token and password are required' }, 400);
  if (password.length < 8)  return json({ success: false, error: 'Password must be at least 8 characters' }, 400);

  try {
    const staff = await findByToken(token);
    if (!staff) return json({ success: false, error: 'Reset link is invalid or has expired.' });
    if (new Date(staff.reset_token_expiry) < new Date()) {
      return json({ success: false, error: 'Reset link has expired. Please request a new one.' });
    }

    const salt          = crypto.randomBytes(32).toString('hex');
    const password_hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');

    await sbFetch(`${staff.table}?email=eq.${encodeURIComponent(staff.email)}`, {
      method: 'PATCH',
      body: JSON.stringify({ password_hash, salt, reset_token: null, reset_token_expiry: null })
    });

    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: 'Reset failed. Please try again.' }, 500);
  }
};
