// Approve or reject a book submission.
// Approve: updates Supabase status to 'listed' + publishes Shopify product (draft → active).
// Reject:  updates Supabase status to 'rejected'.
//
// POST { adminEmail, adminKey, submissionId, action: 'approve'|'reject', shopifyProductId? }

const crypto       = require('crypto');
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const AUTH_SB_URL    = process.env.AUTHOR_SUPABASE_URL  || process.env.SUPABASE_URL;
const AUTH_SB_KEY    = SERVICE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN  || 'zgqk4e-1m.myshopify.com';
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

async function verifyAdmin(email, adminKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, submissionId, action, shopifyProductId } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!submissionId || !action)                 return json({ success: false, error: 'Missing submissionId or action' }, 400);

  const newStatus = action === 'approve' ? 'listed' : 'rejected';

  try {
    // 1 — Update Supabase submission status
    const sbRes = await fetch(
      `${AUTH_SB_URL}/rest/v1/submissions?id=eq.${encodeURIComponent(submissionId)}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        AUTH_SB_KEY,
          'Authorization': `Bearer ${AUTH_SB_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ status: newStatus })
      }
    );
    if (!sbRes.ok) {
      const err = await sbRes.text();
      return json({ success: false, error: `Supabase update failed: ${err}` });
    }

    // 2 — If approving and a Shopify product ID is provided, publish it to all sales channels
    if (action === 'approve' && shopifyProductId) {
      const adminGqlUrl = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
      const gqlHeaders  = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

      // Step 2a — Set product status to active via REST (fastest way to un-draft)
      const restRes = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/products/${shopifyProductId}.json`,
        {
          method:  'PUT',
          headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ product: { id: shopifyProductId, status: 'active' } })
        }
      );
      if (!restRes.ok) {
        const err = await restRes.text();
        return json({ success: true, warning: `Status updated but Shopify activation failed: ${err}` });
      }

      // Step 2b — Get all sales channel publication IDs
      const pubsRes  = await fetch(adminGqlUrl, {
        method:  'POST',
        headers: gqlHeaders,
        body:    JSON.stringify({ query: `{ publications(first: 20) { edges { node { id name } } } }` })
      });
      const pubsData = await pubsRes.json();
      const publications = (pubsData?.data?.publications?.edges || []).map(e => e.node);

      if (publications.length) {
        // Step 2c — Publish product to all channels (makes it visible via Storefront API)
        const productGid = `gid://shopify/Product/${shopifyProductId}`;
        const pubInput   = publications.map(p => ({ publicationId: p.id }));

        const publishRes  = await fetch(adminGqlUrl, {
          method:  'POST',
          headers: gqlHeaders,
          body:    JSON.stringify({
            query: `
              mutation productPublish($input: ProductPublishInput!) {
                productPublish(input: $input) {
                  product { id }
                  userErrors { field message }
                }
              }`,
            variables: { input: { id: productGid, productPublications: pubInput } }
          })
        });
        const publishData  = await publishRes.json();
        const publishErrors = publishData?.data?.productPublish?.userErrors || [];
        if (publishErrors.length) {
          console.warn('Shopify publish warnings:', JSON.stringify(publishErrors));
        }
      }
    }

    return json({ success: true, newStatus });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
