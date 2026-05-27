const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;
const SERVICE_KEY         = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_SIGNED_COPY_URL = process.env.N8N_SIGNED_COPY_URL;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { member_email, member_name, book_title, author_name, notes } = JSON.parse(event.body || '{}');

    if (!member_email || !book_title) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Email and book title are required' })
    };

    // 1 — Save to Supabase
    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/signed_copy_requests`, {
      method:  'POST',
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      },
      body: JSON.stringify({ member_email, member_name, book_title, author_name, notes, status: 'pending' })
    });
    if (!sbRes.ok) console.error('Supabase signed-copy insert failed:', sbRes.status, await sbRes.text());

    // 2 — Notify via n8n
    if (N8N_SIGNED_COPY_URL) {
      await fetch(N8N_SIGNED_COPY_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ member_email, member_name, book_title, author_name, notes })
      });
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    console.error('request-signed-copy error:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
