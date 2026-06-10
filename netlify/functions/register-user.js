// Author registration — Shopify is the single source of truth for auth.
// New authors get a Shopify account (tags: author, club_member) + free 1-year
// club membership + a Supabase users record with NO password stored here.
//
// Upgrade path (club member → author): verifies existing Shopify password,
// then adds the author tag and author role — no new password needed.

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN      = process.env.SHOPIFY_DOMAIN      || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const STOREFRONT_TOKEN    = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';
const API_VERSION         = '2024-01';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const ok  = body => ({ statusCode: 200, headers: cors, body: JSON.stringify(body) });
const err = msg  => ok({ success: false, error: msg });

const adminHeaders = {
  'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
  'Content-Type':           'application/json'
};

// ── Shopify helpers ──────────────────────────────────────────────────────────

// Find Shopify customer by email — returns { id, tags } or null
async function findShopifyCustomer(email) {
  try {
    const res  = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,tags&limit=1`,
      { headers: adminHeaders }
    );
    const data = await res.json();
    return data?.customers?.[0] || null;
  } catch { return null; }
}

// Create brand-new Shopify customer with author + club_member tags
async function createShopifyCustomer(email, name, password) {
  const firstName = (name || email).split(' ')[0];
  const lastName  = (name || '').split(' ').slice(1).join(' ') || '';
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers.json`,
    {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        customer: {
          first_name:            firstName,
          last_name:             lastName,
          email,
          password,
          password_confirmation: password,
          verified_email:        true,
          tags:                  'author, club_member',
          send_email_welcome:    false
        }
      })
    }
  );
  const data = await res.json();
  if (res.ok) return { success: true, customerId: data.customer?.id };
  const errStr = JSON.stringify(data?.errors || {}).toLowerCase();
  return { success: false, emailTaken: errStr.includes('taken'), error: errStr };
}

// Add author tag to an existing Shopify customer (club_member added after plan subscription)
async function addAuthorTags(customerId, existingTagsStr) {
  const existing = (existingTagsStr || '').split(',').map(t => t.trim()).filter(Boolean);
  const merged   = [...new Set([...existing, 'author'])].join(', ');
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${customerId}.json`,
    {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ customer: { id: customerId, tags: merged } })
    }
  );
  return res.ok;
}

// Verify password against Shopify Storefront (used for upgrade path)
async function verifyShopifyPassword(email, password) {
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
          query: `mutation CustomerAccessTokenCreate($input: CustomerAccessTokenCreateInput!) {
            customerAccessTokenCreate(input: $input) {
              customerAccessToken { accessToken }
              customerUserErrors  { code message }
            }
          }`,
          variables: { input: { email, password } }
        })
      }
    );
    const data  = await res.json();
    const token = data?.data?.customerAccessTokenCreate?.customerAccessToken?.accessToken;
    return !!token;
  } catch { return false; }
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function getSupabaseUser(email) {
  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=email,name,phone,roles&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch { return null; }
}

// Upsert to Supabase users — password_hash/salt left empty (Shopify is the auth source).
// Empty strings are falsy so login-user.js Path A is skipped → falls to Path B (Shopify auth).
async function upsertSupabaseUser(email, name, phone, roles, isNew) {
  const payload = {
    name,
    phone:             phone || null,
    roles,
    marketing_consent: true,
    registered_at:     new Date().toISOString(),
    // Empty sentinel values satisfy NOT NULL constraints while signalling
    // "no local password" — login-user.js Path A checks truthiness and skips.
    password_hash:     '',
    salt:              ''
  };
  if (isNew) payload.email = email;

  const url    = isNew
    ? `${SUPABASE_URL}/rest/v1/users`
    : `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`;
  const method = isNew ? 'POST' : 'PATCH';

  const res = await fetch(url, {
    method,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('upsertSupabaseUser failed:', res.status, errText);
  }
  return res.ok;
}

// Add free 1-year club membership to book_club_members
async function addFreeClubMembership(email, name) {
  const now       = new Date();
  const oneYearOn = new Date(now);
  oneYearOn.setFullYear(oneYearOn.getFullYear() + 1);

  // Upsert so re-registrations don't fail
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/book_club_members?on_conflict=email`,
    {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        email,
        name,
        joined_at: now.toISOString()
      })
    }
  );
  return res.ok;
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const { name, email, phone, password, marketing_consent } = JSON.parse(event.body || '{}');
  if (!name || !email || !password)
    return err('Name, email and password are required');

  try {
    const existingUser     = await getSupabaseUser(email);
    const existingRoles    = existingUser?.roles || [];
    const isAlreadyAuthor  = existingRoles.includes('author');

    // ── Already an author ────────────────────────────────────────────────────
    if (isAlreadyAuthor) {
      return err('An author account with this email already exists. Please log in instead.');
    }

    const shopifyCustomer = await findShopifyCustomer(email);

    // ── Club member upgrading to author ──────────────────────────────────────
    if (existingUser && existingRoles.includes('club_member')) {

      // Verify they know their existing Shopify password before upgrading
      if (shopifyCustomer) {
        const valid = await verifyShopifyPassword(email, password);
        if (!valid) return err('Incorrect password. Please use your existing Book Club password to upgrade to Author.');
        // Add author tag to existing Shopify account
        await addAuthorTags(shopifyCustomer.id, shopifyCustomer.tags);
      }

      // Update Supabase roles — club_member added after plan subscription
      const newRoles = [...new Set([...existingRoles, 'author'])];
      await upsertSupabaseUser(email, name, phone || existingUser.phone, newRoles, false);

      return ok({
        success:  true,
        upgraded: true,
        message:  "Author role added to your account. Subscribe to a plan to activate your free Book Club membership."
      });
    }

    // ── Brand-new author ─────────────────────────────────────────────────────

    if (shopifyCustomer) {
      // Shopify account exists (e.g. purchased a book before) — add author tag only
      await addAuthorTags(shopifyCustomer.id, shopifyCustomer.tags);
    } else {
      // Create fresh Shopify account with author tag only (club_member added after plan subscribe)
      const created = await createShopifyCustomer(email, name, password);
      if (!created.success) {
        if (created.emailTaken) {
          // Race condition: re-fetch and add tags
          const found = await findShopifyCustomer(email);
          if (found) await addAuthorTags(found.id, found.tags);
        } else {
          console.error('createShopifyCustomer failed:', created.error);
          return err('Could not create account. Please try again.');
        }
      }
    }
    console.log('Shopify author account ready for:', email);

    // NOTE: Free club membership is granted in save-subscription.js
    // when the author subscribes to a plan — not at registration time.

    // Save to Supabase — NO password stored, Shopify is the auth source
    const saved = await upsertSupabaseUser(
      email, name, phone || null,
      ['author'],     // club_member role added after plan subscription
      !existingUser   // isNew
    );

    if (!saved) return err('Registration failed. Please try again.');

    return ok({ success: true });

  } catch (e) {
    console.error('register-user exception:', e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Registration failed' }) };
  }
};
