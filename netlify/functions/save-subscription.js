const crypto            = require('crypto');
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY  = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY; // service role bypasses RLS
const RZP_SECRET        = process.env.RAZORPAY_KEY_SECRET;
const SHOPIFY_DOMAIN    = process.env.SHOPIFY_DOMAIN    || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = '2024-01';
const STOREFRONT_TOKEN  = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';

const adminHeaders = {
  'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
  'Content-Type':           'application/json'
};

// ── Ensure every new club member has a Shopify account ──────────────────────

async function findShopifyCustomer(email) {
  try {
    const res  = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,tags&limit=1`,
      { headers: adminHeaders }
    );
    const data = await res.json();
    return data?.customers?.[0] || null;
  } catch { return null; }
}

// Create a password-less Shopify customer tagged club_member.
// No welcome email is sent here — we follow up with a password-set email.
async function createShopifyClubMember(email, name) {
  try {
    const firstName = (name || email).split(' ')[0];
    const lastName  = (name || '').split(' ').slice(1).join(' ') || '';
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers.json`,
      {
        method:  'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          customer: {
            first_name:         firstName,
            last_name:          lastName,
            email,
            verified_email:     true,
            tags:               'club_member',
            send_email_welcome: false
          }
        })
      }
    );
    const data = await res.json();
    if (res.ok) return { success: true, customerId: data.customer?.id };
    const errStr = JSON.stringify(data?.errors || {}).toLowerCase();
    return { success: false, emailTaken: errStr.includes('taken'), error: errStr };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Add club_member tag to an existing Shopify customer
async function addClubMemberTag(customerId, existingTagsStr) {
  try {
    const existing = (existingTagsStr || '').split(',').map(t => t.trim()).filter(Boolean);
    const merged   = [...new Set([...existing, 'club_member'])].join(', ');
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/${customerId}.json`,
      {
        method:  'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ customer: { id: customerId, tags: merged } })
      }
    );
    return res.ok;
  } catch { return false; }
}

// Send a "set your password" email via Shopify Storefront customerRecover.
// The member receives a password-reset link so they can log in with a password.
async function sendPasswordSetEmail(email) {
  try {
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type':                      'application/json',
          'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `mutation customerRecover($email: String!) {
            customerRecover(email: $email) {
              customerUserErrors { code message }
            }
          }`,
          variables: { email }
        })
      }
    );
    const data   = await res.json();
    const errors = data?.data?.customerRecover?.customerUserErrors;
    if (errors?.length) console.warn('customerRecover errors:', errors);
    else console.log('Password-set email sent to new club member:', email);
  } catch (e) {
    console.warn('sendPasswordSetEmail failed (non-fatal):', e.message);
  }
}

// Ensure a Shopify account exists for this club member and email them a
// password-set link if we just created the account.
async function ensureShopifyClubAccount(email, name) {
  if (!SHOPIFY_ADMIN_TOKEN) return;
  try {
    const existing = await findShopifyCustomer(email);
    if (existing) {
      // Account exists — make sure club_member tag is present
      if (!(existing.tags || '').toLowerCase().includes('club_member')) {
        await addClubMemberTag(existing.id, existing.tags);
      }
      return; // don't send another password email to an existing account
    }

    // Brand-new member — create Shopify account
    const created = await createShopifyClubMember(email, name);
    if (!created.success) {
      if (created.emailTaken) {
        // Race condition — account was just created; add tag
        const found = await findShopifyCustomer(email);
        if (found) await addClubMemberTag(found.id, found.tags);
      } else {
        console.error('createShopifyClubMember failed:', created.error);
      }
      return;
    }

    console.log('Shopify club_member account created for:', email);
    // Send password-set email so the member can log in with a password
    await sendPasswordSetEmail(email);
  } catch (e) {
    console.warn('ensureShopifyClubAccount failed (non-fatal):', e.message);
  }
}

// ── Grant free 1-year Book Club membership to authors on first plan subscription ──
async function grantAuthorClubMembership(email, name) {
  try {
    // 1 — Check if this email belongs to an author in Supabase users table
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=roles,name&limit=1`,
      { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
    );
    const users = await userRes.json();
    const user  = Array.isArray(users) && users.length ? users[0] : null;
    if (!user) return; // not a registered author
    const roles = user.roles || [];
    if (!roles.includes('author')) return; // only for authors
    if (roles.includes('club_member')) return; // already has club membership

    const displayName = name || user.name || email.split('@')[0];

    // 2 — Add to book_club_members (free 1-year) using only known columns
    const now = new Date();
    const mbRes = await fetch(`${SUPABASE_URL}/rest/v1/book_club_members?on_conflict=email`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SVC_KEY,
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        email,
        name:      displayName,
        joined_at: now.toISOString()
      })
    });
    if (!mbRes.ok) {
      const mbErr = await mbRes.text();
      console.error('book_club_members insert failed:', mbRes.status, mbErr);
      return; // abort — don't mark roles without membership record
    }

    // 3 — Update Supabase user roles to include club_member
    await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: {
        'apikey':        SUPABASE_SVC_KEY,
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({ roles: [...new Set([...roles, 'club_member'])] })
    });

    // 4 — Add club_member tag to Shopify customer
    if (SHOPIFY_ADMIN_TOKEN) {
      const searchRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,tags&limit=1`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
      );
      const searchData = await searchRes.json();
      const customer   = searchData?.customers?.[0];
      if (customer) {
        const existingTags = (customer.tags || '').split(',').map(t => t.trim()).filter(Boolean);
        const newTags      = [...new Set([...existingTags, 'club_member'])].join(', ');
        await fetch(
          `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/${customer.id}.json`,
          {
            method: 'PUT',
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer: { id: customer.id, tags: newTags } })
          }
        );
      }
    }

    console.log(`Free club membership granted to author: ${email}`);
  } catch (e) {
    console.warn('grantAuthorClubMembership failed (non-fatal):', e.message);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const { email, name, plan_name, plan_id, amount, subscription_id, payment_id, razorpay_signature, state } = JSON.parse(event.body || '{}');
    if (!email || !plan_name || !subscription_id) return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Missing required fields' })
    };

    // ── Verify Razorpay payment signature ──────────────────────────────────
    // Formula: HMAC-SHA256(subscription_id + "|" + payment_id, secret)
    if (RZP_SECRET && payment_id && razorpay_signature) {
      // Razorpay subscription signature format: payment_id + "|" + subscription_id
      const expected = crypto
        .createHmac('sha256', RZP_SECRET)
        .update(`${payment_id}|${subscription_id}`)
        .digest('hex');
      if (expected !== razorpay_signature) {
        console.error('Subscription payment signature mismatch');
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: false, error: 'Payment verification failed.' })
        };
      }
    }

    // Check for an existing active subscription and cancel it in Razorpay
    // to avoid double-billing when upgrading plans
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}&select=subscription_id,status`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const existing = await existingRes.json();
    const old = Array.isArray(existing) && existing.length > 0 ? existing[0] : null;

    if (old && old.subscription_id && old.subscription_id !== subscription_id &&
        ['active', 'cancelling'].includes(old.status)) {
      try {
        const KEY_ID     = process.env.RAZORPAY_KEY_ID;
        const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
        const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
        await fetch(
          `https://api.razorpay.com/v1/subscriptions/${old.subscription_id}/cancel`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
            body: JSON.stringify({ cancel_at_cycle_end: 0 }) // immediate cancel on upgrade
          }
        );
      } catch (rzpErr) {
        console.warn('Could not cancel old Razorpay subscription:', rzpErr.message);
      }
    }

    // Upsert — insert if new email, update if existing
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?on_conflict=email`,
      {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          email,
          plan_name,
          subscription_id,
          status:          'active',
          subscribed_date: new Date().toISOString()
        })
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error('Supabase upsert failed:', res.status, err);
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: false, error: `Supabase ${res.status}: ${err}` })
      };
    }

    // Clear stale cancellation date — separate PATCH so a NOT NULL constraint
    // on access_until can never break the main upsert above
    fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ access_until: null })
      }
    ).catch(e => console.warn('access_until clear failed:', e.message));

    // Persist the GST place-of-supply state (best-effort, separate PATCH so a
    // missing `state` column can never break the subscription upsert above —
    // add a `state text` column to `subscriptions` to enable accurate CGST/SGST
    // vs IGST on the Odoo invoice).
    if (state) {
      fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?email=eq.${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey':        SUPABASE_SVC_KEY,
            'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
            'Content-Type':  'application/json'
          },
          body: JSON.stringify({ state })
        }
      ).then(r => { if (!r.ok) console.warn('subscription state save failed (add a `state` column?):', r.status); })
       .catch(e => console.warn('subscription state save failed:', e.message));
    }

    // Ensure every paying club member has a Shopify account (so they can log in
    // with a password in the app and portal). New accounts get a password-set email.
    await ensureShopifyClubAccount(email, name);

    // Grant free club membership if this is an author's first subscription
    await grantAuthorClubMembership(email, name);

    // Trigger n8n invoice + notification (fire and forget)
    const n8nUrl = process.env.N8N_NEW_SUB_NOTIFY_URL;
    if (n8nUrl) {
      fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || email.split('@')[0], plan_name, amount: amount || 0, subscription_id, payment_id: payment_id || '' })
      }).catch(e => console.error('n8n new-sub notify failed:', e.message));
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
