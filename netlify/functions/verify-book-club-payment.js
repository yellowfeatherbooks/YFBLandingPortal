const crypto = require('crypto');

const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN            = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN             = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_STOREFRONT_TOKEN  = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
const STOREFRONT_URL            = SHOPIFY_DOMAIN
  ? `https://${SHOPIFY_DOMAIN}/api/2024-01/graphql.json`
  : null;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// ── Helper: upsert club_member role into the shared users table ─────────────
// Preserves any existing roles (e.g. 'author') and adds 'club_member' if absent.
async function upsertClubMemberRole(email, name, phone) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    // Read existing record (if any)
    const readRes  = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=roles&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows         = await readRes.json();
    const existing     = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    const existingRoles = existing?.roles || [];

    if (existingRoles.includes('club_member')) return; // already set — nothing to do

    const newRoles = [...existingRoles, 'club_member'];

    if (existing) {
      // Update roles only (don't touch password fields of an existing author)
      await fetch(
        `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal'
          },
          body: JSON.stringify({ roles: newRoles })
        }
      );
    } else {
      // Brand-new user — create minimal record (no password; Shopify is their auth)
      await fetch(`${SUPABASE_URL}/rest/v1/users`, {
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
          phone:         phone || null,
          roles:         ['club_member'],
          registered_at: new Date().toISOString()
        })
      });
    }
  } catch(e) {
    console.warn('upsertClubMemberRole failed:', e.message);
  }
}

// Create a Storefront customer access token (lets the app auto-login after signup)
async function storefrontLogin(email, password) {
  if (!STOREFRONT_URL || !SHOPIFY_STOREFRONT_TOKEN) return null;
  try {
    const res = await fetch(STOREFRONT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN,
      },
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
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, email, name, password, phone, marketing_consent } =
      JSON.parse(event.body || '{}');

    // 1 — Verify Razorpay signature
    const expected = crypto
      .createHmac('sha256', RZP_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) throw new Error('Payment verification failed.');

    // 2 — Save member to Supabase book_club_members table
    if (SUPABASE_URL && SUPABASE_KEY) {
      await fetch(`${SUPABASE_URL}/rest/v1/book_club_members`, {
        method:  'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          name,
          phone:               phone || null,
          razorpay_payment_id,
          razorpay_order_id,
          plan:                'Annual Membership',
          marketing_consent:   marketing_consent !== undefined ? marketing_consent : true,
          joined_at:           new Date().toISOString(),
          valid_until:         new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        })
      });

      // 2b — Also record club_member role in the shared users table
      await upsertClubMemberRole(email, name, phone);
    }

    // 3 — Create or update Shopify customer account
    // If the email already exists (e.g. an existing author joining the club),
    // sync the password they entered so autoLogin() in the browser succeeds.
    if (SHOPIFY_DOMAIN && SHOPIFY_TOKEN) {
      const createRes = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers.json`, {
        method:  'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type':           'application/json'
        },
        body: JSON.stringify({
          customer: {
            first_name:             name.split(' ')[0],
            last_name:              name.split(' ').slice(1).join(' ') || '',
            email,
            phone:                  phone || undefined,
            password,
            password_confirmation:  password,
            verified_email:         true,
            tags:                   'Book Club',
            send_email_welcome:     false
          }
        })
      });

      if (!createRes.ok) {
        const createData = await createRes.json();
        const errStr     = JSON.stringify(createData?.errors || {}).toLowerCase();

        if (errStr.includes('taken') || errStr.includes('already been taken')) {
          // Email already exists — find the customer and update their tag + password.
          // We update the password because the user typed a new one in the club-signup
          // form and will try to log in with it after joining. Without this update
          // their Shopify password remains whatever it was before, causing login failure.
          // Note: Shopify password is separate from the author portal (Supabase) password,
          // so updating it here does not break author portal logins.
          try {
            const searchRes = await fetch(
              `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,tags`,
              { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
            );
            const searchData = await searchRes.json();
            const customer   = searchData?.customers?.[0];
            if (customer) {
              const existingTags = (customer.tags || '').split(',').map(t => t.trim()).filter(Boolean);
              const newTags = existingTags.includes('Book Club')
                ? existingTags.join(', ')
                : [...existingTags, 'Book Club'].join(', ');

              // Update tag + password together in one request.
              // Only update the password if it looks like a real user-chosen password
              // (not the auto-generated fallback used when the user was already logged in).
              const isAutoPassword = password === email + '_shopify';
              const updateBody = isAutoPassword
                ? { customer: { id: customer.id, tags: newTags } }
                : { customer: { id: customer.id, tags: newTags, password, password_confirmation: password } };

              await fetch(
                `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers/${customer.id}.json`,
                {
                  method:  'PUT',
                  headers: {
                    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                    'Content-Type':           'application/json'
                  },
                  body: JSON.stringify(updateBody)
                }
              );
            }
          } catch(syncErr) {
            console.warn('Shopify tag/password update failed:', syncErr.message);
          }
        }
      }
    }

    // 4 — Get a Storefront access token so the app can auto-login after signup.
    // Admin API-created passwords are not always usable via the Storefront API,
    // so we obtain a token server-side and return it to the app.
    // Only attempt if this was a real user-chosen password (not auto-generated).
    const isAutoPassword = password === email + '_shopify';
    let shopifyToken = null;
    if (!isAutoPassword) {
      shopifyToken = await storefrontLogin(email, password);
    }

    // 5 — Trigger n8n invoice workflow
    const n8nUrl = process.env.N8N_BOOK_CLUB_INVOICE_URL || 'https://yellowfeather.app.n8n.cloud/webhook/yfb-book-club-invoice';
    try {
      const n8nRes = await fetch(n8nUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, name, phone: phone || null, razorpay_payment_id, razorpay_order_id })
      });
      console.log('n8n invoice webhook status:', n8nRes.status);
    } catch(n8nErr) {
      console.error('n8n invoice webhook failed:', n8nErr.message);
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        // Return Shopify token so app can auto-login without re-entering password
        shopifyToken: shopifyToken?.accessToken ?? null,
        shopifyTokenExpiry: shopifyToken?.expiresAt ?? null,
      })
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
