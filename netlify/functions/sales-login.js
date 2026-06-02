// Sales team login — verifies credentials against Supabase `sales_team` table.
// Returns a stateless salesKey (sha256 of email:passwordHash).
//
// Supabase table required:
//   create table sales_team (
//     id uuid default gen_random_uuid() primary key,
//     email text unique not null,
//     name  text,
//     password_hash text not null,
//     salt          text not null,
//     created_at    timestamptz default now()
//   );

const crypto       = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { email, password } = JSON.parse(event.body || '{}');
  if (!email || !password) return json({ success: false, error: 'Email and password required' }, 400);

  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/sales_team?email=eq.${encodeURIComponent(email)}&select=email,name,password_hash,salt&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const user = Array.isArray(rows) && rows.length ? rows[0] : null;

    if (!user || !user.password_hash || !user.salt) {
      return json({ success: false, error: 'Invalid email or password' });
    }

    const hash = crypto.pbkdf2Sync(password, user.salt, 100000, 64, 'sha512').toString('hex');
    if (hash !== user.password_hash) {
      return json({ success: false, error: 'Invalid email or password' });
    }

    const salesKey = crypto.createHash('sha256').update(email + ':' + user.password_hash).digest('hex');
    return json({ success: true, email: user.email, name: user.name || 'Sales', salesKey });
  } catch (err) {
    return json({ success: false, error: 'Login failed. Please try again.' }, 500);
  }
};
