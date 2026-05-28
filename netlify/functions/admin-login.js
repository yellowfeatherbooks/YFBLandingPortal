// Admin login — verifies credentials against Supabase `admins` table.
// Returns a stateless adminKey (sha256 of email:passwordHash) used to
// authenticate all subsequent admin API calls.
//
// Supabase table required:
//   create table admins (
//     id uuid default gen_random_uuid() primary key,
//     email text unique not null,
//     name  text,
//     password_hash text not null,
//     salt          text not null,
//     created_at    timestamptz default now()
//   );

const crypto     = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
function makeAdminKey(email, passwordHash) {
  return crypto.createHash('sha256').update(email + ':' + passwordHash).digest('hex');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { email, password } = JSON.parse(event.body || '{}');
  if (!email || !password) return json({ success: false, error: 'Email and password required' }, 400);

  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=email,name,password_hash,salt&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const admin = Array.isArray(rows) && rows.length ? rows[0] : null;

    if (!admin || !admin.password_hash || !admin.salt) {
      return json({ success: false, error: 'Invalid email or password' });
    }

    const hash = hashPassword(password, admin.salt);
    if (hash !== admin.password_hash) {
      return json({ success: false, error: 'Invalid email or password' });
    }

    return json({
      success:  true,
      email:    admin.email,
      name:     admin.name || 'Admin',
      adminKey: makeAdminKey(email, admin.password_hash)
    });
  } catch (err) {
    return json({ success: false, error: 'Login failed. Please try again.' }, 500);
  }
};
