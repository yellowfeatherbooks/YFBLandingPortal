const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2025-04';

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

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const {
    adminEmail, adminKey,
    book, author, publisher, genre, shopifyTags,
    description, mrp, salePrice, barcode, phone, cover,
    metafields   // { genreGid, bookCoverTypeGid, languageVersionGid, targetAudienceGid }
  } = JSON.parse(event.body || '{}');

  if (!await verifyAdmin(adminEmail, adminKey)) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  if (!book || !author || !publisher || !genre || !mrp || !barcode) {
    return json({ success: false, error: 'All required fields must be filled' }, 400);
  }

  const webhookUrl = process.env.N8N_SUBMIT_BOOK_URL;
  if (!webhookUrl) {
    return json({ success: false, error: 'Submission webhook not configured' }, 503);
  }

  try {
    // Step 1 — Send to n8n to create Shopify product, activated immediately
    const n8nRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: adminEmail,
        name: 'Admin',
        book, author, publisher, genre,
        shopifyTags: shopifyTags || [],
        description, mrp, salePrice: salePrice || null,
        barcode, phone, cover,
        activate: true   // admin submissions go live immediately
      })
    });
    const data = await n8nRes.json();

    if (!data.success && data.status !== 'success') {
      return json(data);
    }

    const shopifyId = data.shopifyId || data.shopify_Id || null;

    // Step 2 — Set category metafields on the Shopify product
    if (shopifyId && metafields && SHOPIFY_DOMAIN && SHOPIFY_TOKEN) {
      const productGid = `gid://shopify/Product/${shopifyId}`;
      const mfInput = [];

      // Helper: wrap a GID array as a JSON-encoded list for list.metaobject_reference
      const listVal = (gids) => JSON.stringify(gids.filter(Boolean));

      if (metafields.genreGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'genre',            type: 'list.metaobject_reference', value: listVal(metafields.genreGids) });
      if (metafields.bookCoverTypeGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'book-cover-type',  type: 'list.metaobject_reference', value: listVal(metafields.bookCoverTypeGids) });
      if (metafields.languageVersionGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'language-version', type: 'list.metaobject_reference', value: listVal(metafields.languageVersionGids) });
      if (metafields.targetAudienceGids?.length)
        mfInput.push({ namespace: 'shopify', key: 'target-audience',  type: 'list.metaobject_reference', value: listVal(metafields.targetAudienceGids) });

      if (mfInput.length) {
        const mfRes = await fetch(
          `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
          {
            method:  'POST',
            headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `
                mutation productUpdate($input: ProductInput!) {
                  productUpdate(input: $input) {
                    product { id }
                    userErrors { field message }
                  }
                }`,
              variables: { input: { id: productGid, metafields: mfInput } }
            })
          }
        );
        const mfData = await mfRes.json();
        const mfErrors = mfData?.data?.productUpdate?.userErrors || [];
        if (mfErrors.length) {
          console.warn('Metafield set warnings:', JSON.stringify(mfErrors));
        }
      }
    }

    // Step 3 — Save to Supabase with status 'listed' directly
    let sbDebug = {};
    if (SUPABASE_URL && SUPABASE_KEY) {
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
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
          status:         'listed',
          submitted_date: new Date().toISOString(),
          submitted_by:   adminEmail,
          shopify_id:     shopifyId,
        })
      });
      const sbText = await sbRes.text();
      sbDebug = { status: sbRes.status, body: sbText || '(empty — success)' };
    }

    return json({ ...data, _sb: sbDebug });

  } catch (e) {
    console.error('admin-submit-book: unexpected error:', e.message);
    return json({ success: false, error: 'Submission failed. Please try again.' }, 500);
  }
};
