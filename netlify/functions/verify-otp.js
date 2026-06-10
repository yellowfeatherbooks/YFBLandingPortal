// Verify WhatsApp OTP and return user session
// POST { phone, otp, purpose }  -- purpose: 'member' | 'author'

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = '2024-01';

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

function normalizePhone(raw) {
  const digits = raw.replace(/[^0-9]/g, '').replace(/^0+/, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.startsWith('91') && digits.length === 12) return digits;
  return digits;
}

function hashOTP(otp, phone) {
  return crypto.createHash('sha256').update(`${otp}:${phone}:yfb-otp-2026`).digest('hex');
}

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

// Get or create Shopify customer token for cart/checkout
async function getShopifyToken(email) {
  if (!SHOPIFY_ADMIN_TOKEN || !email) return null;
  try {
    const res  = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,email`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
    );
    const data = await res.json();
    return data?.customers?.[0]?.id ? data.customers[0] : null;
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const { email, otp, purpose = 'member' } = JSON.parse(event.body || '{}');
  if (!email || !otp) return json({ success: false, error: 'Email and OTP are required' }, 400);

  try {
  // Look up user by email
  const userRes2 = await sbFetch(`users?email=eq.${encodeURIComponent(email.toLowerCase().trim())}&select=email,name,phone,roles&limit=1`);
  const users2   = await userRes2.json();
  const user2    = users2?.[0];
  if (!user2) return json({ success: false, error: 'Account not found.' }, 404);

  const waPhone = encodeURIComponent(email.toLowerCase().trim()); // URL-encoded session key

  // ── Fetch OTP session ────────────────────────────────────────────────────
  const sessionRes  = await sbFetch(`otp_sessions?phone=eq.${waPhone}&order=created_at.desc&limit=1`);
  const sessions    = await sessionRes.json();
  const session     = sessions?.[0];

  if (!session) return json({ success: false, error: 'No OTP found for this number. Please request a new one.' });
  if (session.used) return json({ success: false, error: 'This OTP has already been used. Please request a new one.' });
  if (new Date(session.expires_at) < new Date()) return json({ success: false, error: 'OTP has expired. Please request a new one.' });
  if (session.attempts >= 3) return json({ success: false, error: 'Too many failed attempts. Please request a new OTP.' });

  // ── Verify OTP — hash must use raw (unencoded) email as salt ────────────
  const rawEmail     = email.toLowerCase().trim();
  const expectedHash = hashOTP(otp.trim(), rawEmail);
  if (expectedHash !== session.otp_hash) {
    const remaining = 2 - session.attempts;
    await sbFetch(`otp_sessions?id=eq.${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ attempts: session.attempts + 1 })
    });
    return json({ success: false, error: `Incorrect OTP. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` });
  }

  // ── OTP correct — mark used ──────────────────────────────────────────────
  await sbFetch(`otp_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ used: true })
  });

  const roles    = user2.roles || [];

  if (purpose === 'author' && !roles.includes('author')) {
    return json({ success: false, error: 'This email is not registered as an Author.' });
  }

  const isMember = roles.includes('club_member') || roles.includes('member');

  return json({
    success:     true,
    name:        user2.name  || user2.email,
    email:       user2.email,
    phone:       user2.phone,
    roles,
    isMember,
    loginMethod: 'otp'
  });

  } catch(e) {
    console.error('verify-otp error:', e.message);
    return json({ success: false, error: 'Verification failed. Please try again.' });
  }
};
