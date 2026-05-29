const crypto = require('crypto');

const RZP_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN;
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;

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
          // Email already exists (e.g. an existing author joining the club).
          // Only add the 'Book Club' tag — do NOT change their password, as
          // that would break their existing author portal login.
          try {
            const searchRes = await fetch(
              `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,tags`,
              { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
            );
            const searchData = await searchRes.json();
            const customer   = searchData?.customers?.[0];
            if (customer) {
              const existingTags = (customer.tags || '').split(',').map(t => t.trim()).filter(Boolean);
              if (!existingTags.includes('Book Club')) {
                const newTags = [...existingTags, 'Book Club'].join(', ');
                await fetch(
                  `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers/${customer.id}.json`,
                  {
                    method:  'PUT',
                    headers: {
                      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
                      'Content-Type':           'application/json'
                    },
                    body: JSON.stringify({
                      customer: { id: customer.id, tags: newTags }
                    })
                  }
                );
              }
            }
          } catch(syncErr) {
            console.warn('Shopify tag update failed:', syncErr.message);
          }
        }
      }
    }

    // 4 — Trigger n8n invoice workflow
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
      body: JSON.stringify({ success: true })
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
