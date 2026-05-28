const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN     = process.env.SHOPIFY_DOMAIN     || 'zgqk4e-1m.myshopify.com';
const STOREFRONT_TOKEN   = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION        = '2024-01';
const crypto             = require('crypto');

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const ok  = body => ({ statusCode: 200, headers: cors, body: JSON.stringify(body) });
const err = msg  => ok({ success: false, error: msg });

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

// ── Shopify Storefront: authenticate and return token + name ────────────────
async function tryShopifyAuth(email, password) {
  try {
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type':                      'application/json',
          'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `
            mutation CustomerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
              customerAccessTokenCreate(input: $input) {
                customerAccessToken { accessToken }
                customerUserErrors  { code message }
              }
            }`,
          variables: { input: { email, password } }
        })
      }
    );
    const data   = await res.json();
    const token  = data?.data?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
    const errors = data?.data?.customerAccessTokenCreate?.customerUserErrors || [];
    if (!token || errors.length) return null;

    // Fetch customer display name
    const custRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type':                      'application/json',
          'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `query GetCustomer($token: String!) {
            customer(customerAccessToken: $token) { firstName lastName }
          }`,
          variables: { token }
        })
      }
    );
    const custData = await custRes.json();
    const cust     = custData?.data?.customer;
    const name     = [cust?.firstName, cust?.lastName].filter(Boolean).join(' ') || email;
    return { shopifyToken: token, name };
  } catch(e) {
    return null;
  }
}

// ── Shopify Admin: create or sync customer account for Supabase-only authors ─
async function ensureShopifyAccount(email, name, password) {
  if (!SHOPIFY_ADMIN_TOKEN) return false;
  try {
    const firstName = (name || email).split(' ')[0];
    const lastName  = (name || '').split(' ').slice(1).join(' ') || '';

    const createRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers.json`,
      {
        method:  'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type':           'application/json'
        },
        body: JSON.stringify({
          customer: {
            first_name:            firstName,
            last_name:             lastName,
            email,
            password,
            password_confirmation: password,
            verified_email:        true,
            tags:                  'author',
            send_email_welcome:    false
          }
        })
      }
    );

    if (createRes.ok) return true;

    const createData  = await createRes.json();
    const errStr      = JSON.stringify(createData?.errors || {}).toLowerCase();
    if (!errStr.includes('taken')) return false;

    // Account exists — sync password so Storefront auth works with this credential
    const searchRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
    );
    const searchData = await searchRes.json();
    const customerId = searchData?.customers?.[0]?.id;
    if (!customerId) return false;

    const updateRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      {
        method:  'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
          'Content-Type':           'application/json'
        },
        body: JSON.stringify({
          customer: { id: customerId, password, password_confirmation: password }
        })
      }
    );
    return updateRes.ok;
  } catch(e) {
    return false;
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const { email, password } = JSON.parse(event.body || '{}');
  if (!email || !password)
    return err('Email and password are required');

  try {
    // ── 1. Look up user in Supabase (includes roles) ────────────────────────
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=email,name,password_hash,salt,roles&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    // ── Path A: Supabase user with a password (registered author) ──────────
    if (user && user.password_hash && user.salt) {
      const hash = hashPassword(password, user.salt);
      if (hash !== user.password_hash) {
        return err('Invalid email or password');
      }

      // Role check — must have 'author' role to access Author's Space
      const roles = user.roles || [];
      if (!roles.includes('author')) {
        return err(
          "Your account is registered as a Book Club member only. " +
          "Please register as an author to access Author's Space."
        );
      }

      // Auth OK + has author role — get Shopify token for cart/checkout
      let shopifyToken = null;
      const shopResult = await tryShopifyAuth(email, password);
      if (shopResult) {
        shopifyToken = shopResult.shopifyToken;
      } else {
        // No Shopify account yet (Supabase-only author) — create one silently
        await ensureShopifyAccount(email, user.name || email, password);
        const retryResult = await tryShopifyAuth(email, password);
        if (retryResult) shopifyToken = retryResult.shopifyToken;
      }

      return ok({ success: true, name: user.name || email, email, roles, shopifyToken });
    }

    // ── Path B: Supabase record exists but no password (club_member role only) ──
    if (user && (!user.password_hash || !user.salt)) {
      // Verify via Shopify (their real credential)
      const shopResult = await tryShopifyAuth(email, password);
      if (!shopResult) return err('Invalid email or password');

      const roles = user.roles || [];
      if (!roles.includes('author')) {
        return err(
          "Your account is registered as a Book Club member only. " +
          "Please register as an author to access Author's Space."
        );
      }

      // Has both roles — club member who also registered as author
      return ok({
        success: true,
        name: user.name || shopResult.name,
        email,
        roles,
        shopifyToken: shopResult.shopifyToken
      });
    }

    // ── Path C: No Supabase record — try Shopify ────────────────────────────
    const shopResult = await tryShopifyAuth(email, password);
    if (!shopResult) return err('Invalid email or password');

    // Valid Shopify account but zero Supabase record → not an author
    return err(
      "No Author's Space account found for this email. " +
      "Please register as an author or check your login details."
    );

  } catch(e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ success: false, error: 'Login failed. Please try again.' }) };
  }
};
