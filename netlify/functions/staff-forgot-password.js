// Self-service password reset for STAFF (admins + sales_team).
// POST { email }
// Finds the email in `admins` first, then `sales_team`; stores a reset token and
// emails a reset link via the existing n8n forgot-password workflow.
// Always returns success (no account enumeration). Reset link points back to the
// same host that served the request → works on prod and on preview aliases.
//
// DB prereq: admins + sales_team each need columns:
//   reset_token text, reset_token_expiry timestamptz

const crypto       = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_FORGOT_URL = process.env.N8N_FORGOT_URL;

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

async function findStaff(email) {
  for (const table of ['admins', 'sales_team']) {
    const res  = await sbFetch(`${table}?email=eq.${encodeURIComponent(email)}&select=email,name&limit=1`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) return { table, ...rows[0] };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { email } = JSON.parse(event.body || '{}');
  if (!email) return json({ success: false, error: 'Email is required' }, 400);
  const normEmail = email.toLowerCase().trim();

  try {
    const staff = await findStaff(normEmail);
    // Always return success to avoid revealing whether the account exists.
    if (!staff) return json({ success: true });

    const token  = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    await sbFetch(`${staff.table}?email=eq.${encodeURIComponent(normEmail)}`, {
      method: 'PATCH',
      body: JSON.stringify({ reset_token: token, reset_token_expiry: expiry })
    });

    const host    = event.headers['x-forwarded-host'] || event.headers.host;
    const base     = process.env.PORTAL_BASE_URL || (host ? `https://${host}` : 'https://yellowfeather.netlify.app');
    const resetLink = `${base}/#staff-reset?token=${token}`;

    if (N8N_FORGOT_URL) {
      await fetch(N8N_FORGOT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: normEmail, name: staff.name || 'Team', reset_link: resetLink })
      });
    }

    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: 'Failed to send reset email' }, 500);
  }
};
