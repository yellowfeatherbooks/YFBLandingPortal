const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN      = process.env.SHOPIFY_DOMAIN      || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION         = '2024-01';
const crypto              = require('crypto');

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// ── Sync the new author password to the existing Shopify account ─────────────
// Called when a club member upgrades to author so both portals immediately
// share the same credential without waiting for the first Author's Space login.
async function syncShopifyPassword(email, password) {
  if (!SHOPIFY_ADMIN_TOKEN) return;
  try {
    // Find the existing customer by email
    const searchRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
    );
    const searchData = await searchRes.json();
    const customerId = searchData?.customers?.[0]?.id;
    if (!customerId) return;

    // Update the Shopify customer's password to match the new author password
    await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      {
        method:  'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type':           'application/json'
        },
        body: JSON.stringify({
          customer: {
            id:                    customerId,
            password,
            password_confirmation: password
          }
        })
      }
    );
  } catch(e) {
    // Non-fatal — login-user.js will sync on first login if this fails
    console.warn('syncShopifyPassword failed:', e.message);
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const { name, email, phone, password, marketing_consent } = JSON.parse(event.body || '{}');
  if (!name || !email || !password) {
    return {
      statusCode: 200, headers: cors,
      body: JSON.stringify({ error: 'Name, email and password are required' })
    };
  }

  const salt          = generateSalt();
  const password_hash = hashPassword(password, salt);

  try {
    // ── Check for existing user record ──────────────────────────────────────
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=email,name,phone,roles&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const existing     = await checkRes.json();
    const existingUser = Array.isArray(existing) && existing.length > 0 ? existing[0] : null;

    if (existingUser) {
      const existingRoles = existingUser.roles || [];

      // Already a fully registered author
      if (existingRoles.includes('author')) {
        return {
          statusCode: 200, headers: cors,
          body: JSON.stringify({ error: 'An author account with this email already exists. Please log in instead.' })
        };
      }

      // ── Club member upgrading to author ─────────────────────────────────
      // 1. Add 'author' role + set Supabase password
      const newRoles  = [...existingRoles, 'author'];
      const updateRes = await fetch(
        `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal'
          },
          body: JSON.stringify({
            name,
            phone:              phone || existingUser.phone || null,
            password_hash,
            salt,
            roles:              newRoles,
            marketing_consent:  marketing_consent !== undefined ? marketing_consent : true,
            registered_at:      new Date().toISOString()
          })
        }
      );

      if (!updateRes.ok) {
        const errText = await updateRes.text();
        console.error('Role upgrade PATCH failed:', errText);
        return {
          statusCode: 200, headers: cors,
          body: JSON.stringify({ error: 'Registration failed. Please try again.' })
        };
      }

      // 2. Immediately sync new password to existing Shopify account so
      //    both Author's Space and Book Club login use the same credential
      //    from this point forward (fire-and-forget — login-user.js is
      //    the safety net if this fails).
      syncShopifyPassword(email, password).catch(() => {});

      return {
        statusCode: 200, headers: cors,
        body: JSON.stringify({
          success:  true,
          upgraded: true,
          message:  "Author role added to your Book Club account. You can now log in to Author's Space with your new password."
        })
      };
    }

    // ── New user — create with 'author' role ────────────────────────────────
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({
        email,
        name,
        phone:              phone || null,
        password_hash,
        salt,
        roles:              ['author'],
        marketing_consent:  marketing_consent !== undefined ? marketing_consent : true,
        registered_at:      new Date().toISOString()
      })
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      console.error('User insert failed:', errText);
      return {
        statusCode: 200, headers: cors,
        body: JSON.stringify({ error: 'Registration failed. Please try again.' })
      };
    }

    return {
      statusCode: 200, headers: cors,
      body: JSON.stringify({ success: true })
    };

  } catch(e) {
    console.error('register-user exception:', e.message);
    return {
      statusCode: 500, headers: cors,
      body: JSON.stringify({ error: 'Registration failed' })
    };
  }
};
