// Adds the 'book-club-member' tag to a Shopify customer so they qualify for
// member-only discount segments ("customer_tags CONTAINS 'book-club-member'").
// Called fire-and-forget after a successful Book Club login or registration.
//
// Flow:
//   1. Resolve customer GID from Storefront API (using their access token)
//   2. GET current tags via Admin API
//   3. PUT merged tag list back — idempotent, safe to call multiple times

const SHOPIFY_DOMAIN   = process.env.SHOPIFY_DOMAIN        || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || 'e96eabff01d76720a4ee74d13ba533d3';
const API_VERSION      = '2024-01';

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  try {
    const { customerAccessToken } = JSON.parse(event.body || '{}');
    if (!customerAccessToken) return json({ success: false, error: 'Missing customerAccessToken' }, 400);

    // ── Step 1: Resolve customer GID via Storefront API ──────────────────────
    const sfRes  = await fetch(`https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type':                      'application/json',
        'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
      },
      body: JSON.stringify({
        query: `{ customer(customerAccessToken: "${customerAccessToken}") { id } }`
      })
    });
    const sfData = await sfRes.json();
    const gid    = sfData?.data?.customer?.id;
    if (!gid) return json({ success: false, error: 'Customer not found for that token' }, 400);

    const numericId = gid.split('/').pop();
    const adminUrl  = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/${numericId}.json`;
    const adminHeaders = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };

    // ── Step 2: GET existing tags so we don't overwrite them ─────────────────
    const getRes  = await fetch(`${adminUrl}?fields=id,tags`, { headers: adminHeaders });
    const getData = await getRes.json();
    const existing = (getData?.customer?.tags || '')
      .split(',').map(t => t.trim()).filter(Boolean);

    // Already tagged — nothing to do
    if (existing.includes('book-club-member')) return json({ success: true, alreadyTagged: true });

    // ── Step 3: PUT merged tag list ───────────────────────────────────────────
    const putRes = await fetch(adminUrl, {
      method:  'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ customer: { id: numericId, tags: [...existing, 'book-club-member'].join(', ') } })
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      return json({ success: false, error: errText });
    }

    return json({ success: true });

  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
