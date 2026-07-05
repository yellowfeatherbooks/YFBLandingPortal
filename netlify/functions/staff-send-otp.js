// Send an email OTP for STAFF login (admins + sales_team).
// POST { email }
// Reuses the otp_sessions table with a namespaced session key ("staff:<email>")
// so it never collides with reader/member OTPs, and the existing n8n OTP email
// workflow (N8N_OTP_URL).

const crypto       = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_OTP_URL   = process.env.N8N_OTP_URL;

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

function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function hashOTP(otp, key) { return crypto.createHash('sha256').update(`${otp}:${key}:yfb-otp-2026`).digest('hex'); }

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
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const { email } = JSON.parse(event.body || '{}');
  if (!email) return json({ success: false, error: 'Email address is required' }, 400);
  const normEmail = email.toLowerCase().trim();

  const staff = await findStaff(normEmail);
  if (!staff) return json({ success: false, error: 'No admin or sales account found with this email.' }, 404);

  const sessionKey = `staff:${normEmail}`;

  // Rate limit: max 3 OTPs per 10 minutes
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentRes = await sbFetch(`otp_sessions?phone=eq.${encodeURIComponent(sessionKey)}&created_at=gte.${encodeURIComponent(tenMinAgo)}&select=id`);
  const recent    = await recentRes.json();
  if (Array.isArray(recent) && recent.length >= 3) {
    return json({ success: false, error: 'Too many OTP requests. Please wait 10 minutes.' }, 429);
  }

  // Clear old unused OTPs for this staff session
  await sbFetch(`otp_sessions?phone=eq.${encodeURIComponent(sessionKey)}&used=eq.false`, { method: 'DELETE' });

  const otp       = generateOTP();
  const otpHash   = hashOTP(otp, sessionKey);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await sbFetch('otp_sessions', {
    method: 'POST',
    body: JSON.stringify({ phone: sessionKey, otp_hash: otpHash, expires_at: expiresAt })
  });

  if (!N8N_OTP_URL) return json({ success: false, error: 'Email service not configured.' });

  const name = staff.name || normEmail.split('@')[0];
  const n8nRes = await fetch(N8N_OTP_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: normEmail, toName: name, otp })
  });
  if (!n8nRes.ok) return json({ success: false, error: 'Failed to send OTP email. Please try again.' });

  return json({ success: true, message: `OTP sent to ${normEmail} — valid for 5 minutes.` });
};
