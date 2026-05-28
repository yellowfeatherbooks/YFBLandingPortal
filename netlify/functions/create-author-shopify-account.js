// Creates a Shopify customer account for an existing Publisher Portal author
// who authenticated via Supabase but has no Shopify account yet.
// If the account already exists (e.g. they're also a Book Club member), the
// Shopify password is synced to match their Publisher Portal password so both
// portals share one credential going forward.
//
// Input:  { email, name, password }
// Output: { success: true } | { success: false, error }

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN    || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';

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

const adminHeaders = {
  'X-Shopify-Access-Token': SHOPIFY_TOKEN,
  'Content-Type':           'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  try {
    const { email, name, password } = JSON.parse(event.body || '{}');
    if (!email || !password) return json({ success: false, error: 'Missing email or password' }, 400);

    const firstName = (name || email).split(' ')[0];
    const lastName  = (name || '').split(' ').slice(1).join(' ') || '';

    // ── Attempt to create the Shopify account ────────────────────────────────
    const createRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers.json`,
      {
        method:  'POST',
        headers: adminHeaders,
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

    if (createRes.ok) return json({ success: true });

    const createData  = await createRes.json();
    const errString   = JSON.stringify(createData?.errors || {}).toLowerCase();
    const isEmailTaken = errString.includes('taken');

    if (!isEmailTaken) return json({ success: false, error: errString });

    // ── Account already exists — sync password so Publisher Portal credential works ──
    // Find the customer by email
    const searchRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json?query=email:${encodeURIComponent(email)}&fields=id`,
      { headers: adminHeaders }
    );
    const searchData = await searchRes.json();
    const customerId = searchData?.customers?.[0]?.id;
    if (!customerId) return json({ success: false, error: 'Could not locate existing customer' });

    // Update password to match Publisher Portal credentials
    const updateRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      {
        method:  'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          customer: {
            id:                    customerId,
            password,
            password_confirmation: password
          }
        })
      }
    );

    if (!updateRes.ok) {
      const updateErr = await updateRes.text();
      return json({ success: false, error: updateErr });
    }

    return json({ success: true, passwordSynced: true });

  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
