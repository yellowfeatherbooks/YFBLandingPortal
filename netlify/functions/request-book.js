const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_KEY        = process.env.SUPABASE_KEY;
const N8N_BOOK_REQUEST_URL = process.env.N8N_BOOK_REQUEST_URL;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { name, email, book_title, author_name, publisher, year, notes } = JSON.parse(event.body || '{}');

    if (!email || !book_title) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Email and book title are required' })
    };

    // 1 — Save to Supabase (optional)
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/book_requests`, {
          method: 'POST',
          headers: {
            'apikey':        SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type':  'application/json',
            'Prefer':        'return=minimal'
          },
          body: JSON.stringify({
            name, email, book_title, author_name, publisher, year, notes,
            requested_at: new Date().toISOString()
          })
        });
        if (!sbRes.ok) {
          const sbErr = await sbRes.text();
          console.error('Supabase save failed:', sbRes.status, sbErr);
        }
      } catch(e) { console.error('Supabase save error:', e.message); }
    }

    // 2 — Notify via n8n
    if (N8N_BOOK_REQUEST_URL) {
      await fetch(N8N_BOOK_REQUEST_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email, book_title, author_name, publisher, year, notes })
      }).catch(e => console.error('n8n book-request notify failed:', e.message));
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
