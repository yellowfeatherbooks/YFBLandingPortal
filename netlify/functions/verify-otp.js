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

const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';
const STOREFRONT_URL = `https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`;

// Check if a Shopify customer exists for this email
async function shopifyCustomerExists(email) {
  if (!SHOPIFY_ADMIN_TOKEN || !email) return false;
  try {
    const res  = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id&limit=1`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
    );
    const data = await res.json();
    return !!(data?.customers?.[0]?.id);
  } catch { return false; }
}

// Create a Shopify customer via Storefront API (password-compatible login)
async function storefrontCreateCustomer(name, email) {
  if (!SHOPIFY_STOREFRONT_TOKEN) return false;
  // Use a secure random temp password — user will reset via Shopify email
  const tempPassword = email + '_yfb_' + Date.now();
  try {
    const res = await fetch(STOREFRONT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN },
      body: JSON.stringify({
        query: `mutation customerCreate($input: CustomerCreateInput!) {
          customerCreate(input: $input) {
            customer { id }
            customerUserErrors { code message }
          }
        }`,
        variables: {
          input: {
            firstName: name.split(' ')[0] || name,
            lastName:  name.split(' ').slice(1).join(' ') || '',
            email,
            password:  tempPassword,
          }
        }
      })
    });
    const data = await res.json();
    return !!data?.data?.customerCreate?.customer;
  } catch { return false; }
}

// Get a Storefront customer access token (for Shopify cart/checkout/login)
async function storefrontGetToken(email, password) {
  if (!SHOPIFY_STOREFRONT_TOKEN) return null;
  try {
    const res = await fetch(STOREFRONT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN },
      body: JSON.stringify({
        query: `mutation {
          customerAccessTokenCreate(input: { email: "${email}", password: "${password.replace(/"/g, '\\"')}" }) {
            customerAccessToken { accessToken expiresAt }
            customerUserErrors { message }
          }
        }`
      })
    });
    const data = await res.json();
    return data?.data?.customerAccessTokenCreate?.customerAccessToken ?? null;
  } catch { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const { email, otp, purpose = 'member' } = JSON.parse(event.body || '{}');
  if (!email || !otp) return json({ success: false, error: 'Email and OTP are required' }, 400);

  try {
  // Look up user by email — check both tables since club members may only be in book_club_members
  const userRes2 = await sbFetch(`users?email=eq.${encodeURIComponent(email.toLowerCase().trim())}&select=email,name,phone,roles&limit=1`);
  const users2   = await userRes2.json();
  let user2      = users2?.[0] ?? null;

  if (!user2) {
    // Fallback: check book_club_members
    const memberRes  = await sbFetch(`book_club_members?email=eq.${encodeURIComponent(email.toLowerCase().trim())}&select=email,name,phone&limit=1`);
    const members2   = await memberRes.json();
    const member2    = members2?.[0];
    if (member2) {
      user2 = { email: member2.email, name: member2.name, phone: member2.phone, roles: ['club_member'] };
    }
  }

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
  const userName = user2.name || user2.email;

  // ── Ensure Shopify account exists and get a Storefront token ──────────────
  // Without a Shopify token, the user can't add to cart or checkout.
  // For old club members who have no Shopify account, create one now.
  let shopifyToken    = null;
  let shopifyExpiry   = null;
  const exists = await shopifyCustomerExists(rawEmail);
  if (!exists && isMember) {
    // Create Shopify account via Storefront API — this sets a Storefront-
    // compatible password so they can eventually use password login too.
    await storefrontCreateCustomer(userName, rawEmail);
    // Add Book Club tag via Admin API
    try {
      const searchRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(rawEmail)}&fields=id,tags&limit=1`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
      );
      const searchData = await searchRes.json();
      const cust = searchData?.customers?.[0];
      if (cust) {
        const tags = (cust.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        if (!tags.includes('Book Club')) {
          await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${cust.id}.json`, {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer: { id: cust.id, tags: [...tags, 'Book Club'].join(', ') } })
          });
        }
        // Send Shopify account activation email so user can set their own password
        await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${cust.id}/send_invite.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      }
    } catch(e) { console.warn('Shopify tag/invite failed:', e.message); }
  }

  return json({
    success:      true,
    name:         userName,
    email:        user2.email,
    phone:        user2.phone,
    roles,
    isMember,
    loginMethod:  'otp',
    shopifyToken,
    shopifyExpiry,
  });

  } catch(e) {
    console.error('verify-otp error:', e.message);
    return json({ success: false, error: 'Verification failed. Please try again.' });
  }
};
