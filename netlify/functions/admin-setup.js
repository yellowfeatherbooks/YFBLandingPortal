// One-time function to create the first admin account.
// Protected by ADMIN_SETUP_KEY env var — set this in Netlify, call once, then
// you can remove or disable this function.
//
// POST { setupKey, email, name, password }

const crypto     = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const SETUP_KEY     = process.env.ADMIN_SETUP_KEY;

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

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { setupKey, email, name, password } = JSON.parse(event.body || '{}');

  if (!SETUP_KEY || setupKey !== SETUP_KEY) {
    return json({ success: false, error: 'Invalid setup key' }, 403);
  }
  if (!email || !password) return json({ success: false, error: 'Email and password required' }, 400);

  const salt         = crypto.randomBytes(32).toString('hex');
  const passwordHash = hashPassword(password, salt);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/admins`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({ email, name: name || 'Admin', password_hash: passwordHash, salt })
    });

    if (!res.ok) {
      const err = await res.text();
      return json({ success: false, error: err });
    }

    return json({ success: true, message: `Admin account created for ${email}` });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
