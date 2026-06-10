// Admin utility — backfill Shopify accounts for existing club members who
// paid before the ensureShopifyClubAccount fix was deployed.
//
// Call via:  POST /.netlify/functions/backfill-shopify-members
// Body (JSON):
//   { "adminEmail": "...", "adminKey": "...", "email": "someone@example.com" }
//   { "adminEmail": "...", "adminKey": "..." }   → process ALL members
//
// Auth: same verifyAdmin pattern as all other admin functions (adminKey is a
// SHA-256 derived token stored in the admin session, not a plain secret).
//
// Returns a JSON summary of what was created / skipped / failed.

const crypto             = require('crypto');
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_KEY       = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY   = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const SHOPIFY_DOMAIN     = process.env.SHOPIFY_DOMAIN     || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_ADMIN_TOKEN= process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION= '2024-01';
const STOREFRONT_TOKEN   = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';

async function verifyAdmin(email, adminKey) {
  try {
    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) return false;
    const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
    return expected === adminKey;
  } catch { return false; }
}

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const adminHeaders = {
  'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
  'Content-Type':           'application/json'
};

// ── Shopify helpers ──────────────────────────────────────────────────────────

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

async function createShopifyCustomer(email, name) {
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
}

async function addClubMemberTag(customerId, existingTagsStr) {
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
}

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
    if (errors?.length) return { sent: false, error: errors[0].message };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// ── Supabase helpers ─────────────────────────────────────────────────────────

async function fetchAllMembers() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/book_club_members?select=email,name&order=joined_at.asc`,
    { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
  );
  return res.ok ? (await res.json()) : [];
}

async function fetchMember(email) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/book_club_members?email=eq.${encodeURIComponent(email)}&select=email,name&limit=1`,
    { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
  );
  const rows = res.ok ? await res.json() : [];
  return rows[0] || null;
}

// ── Process one member ───────────────────────────────────────────────────────

async function processMember(email, name) {
  const existing = await findShopifyCustomer(email);

  if (existing) {
    const hasTag = (existing.tags || '').toLowerCase().includes('club_member');
    if (!hasTag) {
      await addClubMemberTag(existing.id, existing.tags);
      return { email, status: 'tag_added', note: 'Account existed, club_member tag added' };
    }
    return { email, status: 'skipped', note: 'Account already exists with club_member tag' };
  }

  // Create new account
  const created = await createShopifyCustomer(email, name);

  if (!created.success) {
    if (created.emailTaken) {
      // Race — try to find and tag
      const found = await findShopifyCustomer(email);
      if (found) {
        await addClubMemberTag(found.id, found.tags);
        return { email, status: 'tag_added', note: 'Account found on retry, club_member tag added' };
      }
    }
    return { email, status: 'failed', note: `createShopifyCustomer: ${created.error}` };
  }

  // Send password-set email
  const emailResult = await sendPasswordSetEmail(email);
  return {
    email,
    status:    'created',
    note:      emailResult.sent
      ? 'Shopify account created, password-set email sent'
      : `Shopify account created, email failed: ${emailResult.error}`
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  if (!SHOPIFY_ADMIN_TOKEN) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'SHOPIFY_ADMIN_TOKEN not set' }) };
  }

  try {
    const body          = JSON.parse(event.body || '{}');
    const { adminEmail, adminKey, email: emailParam } = body;

    // Auth check — same pattern as all other admin functions
    if (!adminEmail || !adminKey || !await verifyAdmin(adminEmail, adminKey)) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const singleEmail   = emailParam?.trim().toLowerCase();

    let members;
    if (singleEmail) {
      const m = await fetchMember(singleEmail);
      if (!m) return {
        statusCode: 200, headers: cors,
        body: JSON.stringify({ error: `No club member found for ${singleEmail}` })
      };
      members = [m];
    } else {
      members = await fetchAllMembers();
    }

    if (!members.length) return {
      statusCode: 200, headers: cors,
      body: JSON.stringify({ message: 'No members found', results: [] })
    };

    const results = [];
    for (const m of members) {
      // Small delay to avoid Shopify rate limits when processing many members
      if (results.length > 0) await new Promise(r => setTimeout(r, 300));
      const result = await processMember(m.email, m.name);
      results.push(result);
      console.log(`[backfill] ${result.status} — ${result.email}: ${result.note}`);
    }

    const summary = {
      total:    results.length,
      created:  results.filter(r => r.status === 'created').length,
      tag_added:results.filter(r => r.status === 'tag_added').length,
      skipped:  results.filter(r => r.status === 'skipped').length,
      failed:   results.filter(r => r.status === 'failed').length,
    };

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, results })
    };

  } catch (e) {
    console.error('backfill-shopify-members error:', e.message);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: e.message })
    };
  }
};
