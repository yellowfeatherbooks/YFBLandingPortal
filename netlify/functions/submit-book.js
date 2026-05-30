const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY; // service role bypasses RLS

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

    // Step 2 — Save submission record to Supabase
    const shopifyId = data.shopifyId || data.shopify_Id || null;

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

    return { statusCode: 200, body: JSON.stringify({ ...data, _sb: sbDebug }) };

  } catch (e) {
    console.error('submit-book: unexpected error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Submission failed. Please try again.' }) };
  }
};
