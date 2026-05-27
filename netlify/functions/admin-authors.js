// Returns all authors from Supabase `users` table, joined with their
// latest subscription record.
// POST { adminEmail, adminKey }

const crypto     = require('crypto');
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

  const { adminEmail, adminKey } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    // Fetch all authors (Publisher Portal users)
    const [usersRes, subsRes] = await Promise.all([
      fetch(`${AUTH_SB_URL}/rest/v1/users?select=email,name,created_at&order=created_at.desc&limit=500`,
        { headers: { 'apikey': AUTH_SB_KEY, 'Authorization': `Bearer ${AUTH_SB_KEY}` } }),
      fetch(`${AUTH_SB_URL}/rest/v1/subscriptions?select=email,plan_name,status,access_until,subscription_id,created_at&order=created_at.desc&limit=500`,
        { headers: { 'apikey': AUTH_SB_KEY, 'Authorization': `Bearer ${AUTH_SB_KEY}` } })
    ]);

    const users = await usersRes.json();
    const subs  = await subsRes.json();

    // Build a map of email → latest subscription
    const subMap = {};
    (Array.isArray(subs) ? subs : []).forEach(s => {
      if (!subMap[s.email]) subMap[s.email] = s;
    });

    const authors = (Array.isArray(users) ? users : []).map(u => ({
      email:      u.email,
      name:       u.name || '',
      joined:     u.created_at,
      plan:         subMap[u.email]?.plan_name    || '—',
      sub_status:   subMap[u.email]?.status       || '—',
      access_until: subMap[u.email]?.access_until || null,
      sub_id:       subMap[u.email]?.subscription_id || '—'
    }));

    return json({ success: true, authors });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
