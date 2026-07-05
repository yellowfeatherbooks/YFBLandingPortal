// Verify a STAFF email OTP and return a login session.
// POST { email, otp }
// On success returns the SAME stateless key the password login returns
// (sha256(email:password_hash)) as adminKey or salesKey, plus the role, so the
// frontend logs the user in exactly as a password login would.

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
  // admins first, then sales_team
  for (const [table, role] of [['admins', 'admin'], ['sales_team', 'sales']]) {
    const res  = await sbFetch(`${table}?email=eq.${encodeURIComponent(email)}&select=email,name,password_hash&limit=1`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) return { table, role, ...rows[0] };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const { email, otp } = JSON.parse(event.body || '{}');
  if (!email || !otp) return json({ success: false, error: 'Email and OTP are required' }, 400);
  const normEmail  = email.toLowerCase().trim();
  const sessionKey = `staff:${normEmail}`;

  try {
    const sessRes  = await sbFetch(`otp_sessions?phone=eq.${encodeURIComponent(sessionKey)}&order=created_at.desc&limit=1`);
    const sessions = await sessRes.json();
    const session  = sessions?.[0];

    if (!session)                                       return json({ success: false, error: 'No OTP found. Please request a new one.' });
    if (session.used)                                   return json({ success: false, error: 'This OTP was already used. Request a new one.' });
    if (new Date(session.expires_at) < new Date())      return json({ success: false, error: 'OTP has expired. Request a new one.' });
    if (session.attempts >= 3)                          return json({ success: false, error: 'Too many failed attempts. Request a new OTP.' });

    const expectedHash = hashOTP(otp.trim(), sessionKey);
    if (expectedHash !== session.otp_hash) {
      const remaining = 2 - session.attempts;
      await sbFetch(`otp_sessions?id=eq.${session.id}`, { method: 'PATCH', body: JSON.stringify({ attempts: session.attempts + 1 }) });
      return json({ success: false, error: `Incorrect OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
    }

    await sbFetch(`otp_sessions?id=eq.${session.id}`, { method: 'PATCH', body: JSON.stringify({ used: true }) });

    const staff = await findStaff(normEmail);
    if (!staff || !staff.password_hash) return json({ success: false, error: 'Account not found.' }, 404);

    const key = crypto.createHash('sha256').update(staff.email + ':' + staff.password_hash).digest('hex');
    const out = { success: true, role: staff.role, email: staff.email, name: staff.name || (staff.role === 'admin' ? 'Admin' : 'Sales') };
    if (staff.role === 'admin') out.adminKey = key; else out.salesKey = key;
    return json(out);
  } catch (e) {
    return json({ success: false, error: 'Verification failed. Please try again.' }, 500);
  }
};
