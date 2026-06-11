// Send WhatsApp OTP for member/author login
// POST { phone, purpose }  -- purpose: 'member' | 'author'

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_OTP_URL  = process.env.N8N_OTP_URL; // dedicated OTP email workflow

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

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashOTP(otp, phone) {
  return crypto.createHash('sha256').update(`${otp}:${phone}:yfb-otp-2026`).digest('hex');
}

async function sbFetch(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey:        SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const { email, purpose = 'member' } = JSON.parse(event.body || '{}');
  if (!email) return json({ success: false, error: 'Email address is required' }, 400);

  console.log('OTP request: email =', email, 'purpose =', purpose);

  const normEmail = email.toLowerCase().trim();

  // Look up user — check both tables since club members may only be in book_club_members
  const userRes = await sbFetch(`users?email=eq.${encodeURIComponent(normEmail)}&select=email,name,phone,roles&limit=1`);
  const users   = await userRes.json();
  console.log('User lookup result:', JSON.stringify(users));
  let user = users?.[0] ?? null;

  if (!user) {
    // Fallback: check book_club_members (covers members who joined before users record was created)
    const memberRes  = await sbFetch(`book_club_members?email=eq.${encodeURIComponent(normEmail)}&select=email,name,phone&limit=1`);
    const members    = await memberRes.json();
    const member     = members?.[0];
    if (member) {
      user = { email: member.email, name: member.name, phone: member.phone, roles: ['club_member'] };
    }
  }

  if (!user) {
    return json({ success: false, error: 'No account found with this email. Please use your registered email address.' }, 404);
  }

  if (purpose === 'author') {
    const roles = user.roles || [];
    if (!roles.includes('author')) {
      return json({ success: false, error: 'This email is not registered as an Author.' }, 403);
    }
  }

  // Use email as OTP session key
  const waPhone = email.toLowerCase().trim(); // use email as session identifier

  // Rate limit: max 3 OTPs per 10 minutes
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentRes = await sbFetch(`otp_sessions?phone=eq.${encodeURIComponent(waPhone)}&created_at=gte.${encodeURIComponent(tenMinAgo)}&select=id`);
  const recent    = await recentRes.json();
  if (Array.isArray(recent) && recent.length >= 3) {
    return json({ success: false, error: 'Too many OTP requests. Please wait 10 minutes before trying again.' }, 429);
  }

  // Delete old unused OTPs for this email
  await sbFetch(`otp_sessions?phone=eq.${encodeURIComponent(waPhone)}&used=eq.false`, { method: 'DELETE' });

  // Generate and store OTP
  const otp       = generateOTP();
  const otpHash   = hashOTP(otp, waPhone);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await sbFetch('otp_sessions', {
    method: 'POST',
    body: JSON.stringify({ phone: waPhone, otp_hash: otpHash, expires_at: expiresAt })
  });

  // Send via WhatsApp template
  // Send OTP via email using existing n8n reminder workflow
  console.log('Sending OTP to email:', email);
  const name      = user.name || email.split('@')[0];
  const firstName = name.split(' ')[0];
  const bodyText  = `Hello ${firstName},\n\nYour Yellow Feather Books login verification code is:\n\n${otp}\n\nThis code expires in 5 minutes. Do not share it with anyone.\n\nIf you did not request this, please ignore this email.\n\nRegards\nTeam Yellow Feather Books`;

  if (!N8N_OTP_URL) {
    console.error('N8N_OTP_URL not set');
    return json({ success: false, error: 'Email service not configured. Please contact support.' });
  }

  console.log('Sending OTP email to:', email);
  const n8nRes = await fetch(N8N_OTP_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email, toName: name, otp })
  });
  if (!n8nRes.ok) {
    console.error('n8n OTP email failed:', n8nRes.status);
    return json({ success: false, error: 'Failed to send OTP email. Please try again.' });
  }

  return json({
    success: true,
    message: `OTP sent to ${email}. Check your inbox — valid for 5 minutes.`
  });
};
