const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const SHOPIFY_DOMAIN   = process.env.SHOPIFY_DOMAIN  || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION      = '2025-04';
const GQL_URL          = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

// n8n may return numeric ID "123" or full GID "gid://shopify/Product/123"
// Always normalise to GID for GraphQL, and numeric string for REST.
function toGid(rawId) {
  if (!rawId) return null;
  const s = String(rawId);
  return s.startsWith('gid://') ? s : `gid://shopify/Product/${s}`;
}

async function setProductDraft(productGid) {
  const res = await fetch(GQL_URL, {
    method:  'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `
        mutation productUpdate($input: ProductInput!) {
          productUpdate(input: $input) {
            product { id status }
            userErrors { field message }
          }
        }`,
      variables: { input: { id: productGid, status: 'DRAFT' } }
    })
  });
  const json = await res.json();
  const errors = json?.data?.productUpdate?.userErrors || [];
  if (errors.length) console.warn('setProductDraft userErrors:', JSON.stringify(errors));
  else console.log('Product set to DRAFT:', productGid);
  return json;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { email, name, book, author, publisher, genre, shopifyTags, description, mrp, barcode, phone, cover, subscription_id } = JSON.parse(event.body || '{}');
  if (!email || !book || !author || !publisher || !genre || !mrp || !barcode) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'All fields are required' }) };
  }

  const webhookUrl = process.env.N8N_SUBMIT_BOOK_URL;
  if (!webhookUrl) {
    return { statusCode: 503, body: JSON.stringify({ success: false, error: 'Submission not configured' }) };
  }

  try {
    // Step 1 — Send to n8n to create Shopify product
    const n8nRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name, book, author, publisher, genre, shopifyTags: shopifyTags || [], description, mrp, barcode, phone, cover })
    });
    const data = await n8nRes.json();

    if (!data.success && data.status !== 'success') {
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    // Step 2 — Force product to DRAFT via GraphQL (works with both numeric ID and GID)
    const rawId     = data.shopifyId || data.shopify_Id || null;
    const productGid = toGid(rawId);
    let draftResult = {};

    if (productGid && SHOPIFY_TOKEN) {
      try {
        draftResult = await setProductDraft(productGid);
      } catch (draftErr) {
        console.error('setProductDraft failed:', draftErr.message);
        draftResult = { error: draftErr.message };
      }
    } else {
      console.warn('Cannot set draft — productGid:', productGid, 'SHOPIFY_TOKEN set:', !!SHOPIFY_TOKEN);
    }

    // Step 3 — Save submission record to Supabase
    const shopifyId = rawId;

    let sbDebug = {};
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      sbDebug = { error: 'SUPABASE_URL or SUPABASE_KEY env var not set' };
    } else {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/submissions`,
        {
          method: 'POST',
          headers: {
            'apikey':        SUPABASE_SVC_KEY,
            'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal'
          },
          body: JSON.stringify({
            title:          book,
            author,
            publisher,
            genre,
            mrp:            parseFloat(mrp),
            status:         'under_review',
            submitted_date: new Date().toISOString(),
            submitted_by:   email,
            shopify_id:     shopifyId,
          })
        }
      );

      const sbText = await sbRes.text();
      sbDebug = { status: sbRes.status, body: sbText || '(empty — success)' };
    }

    return { statusCode: 200, body: JSON.stringify({ ...data, _sb: sbDebug, _draft: draftResult }) };

  } catch (e) {
    console.error('submit-book: unexpected error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Submission failed. Please try again.' }) };
  }
};
