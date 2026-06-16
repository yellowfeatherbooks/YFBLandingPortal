const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_KEY;
const SERVICE_KEY          = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_BOOK_REQUEST_URL = process.env.N8N_BOOK_REQUEST_URL;

const ALLOWED_ORIGINS = [
  'https://yellowfeather.netlify.app',
  'https://yellowfeatherbooks.com',
  'https://www.yellowfeatherbooks.com',
  'https://yellowfeathersbooks.com',
];

function getCors(event) {
  const origin  = event.headers?.origin || event.headers?.referer?.replace(/\/$/, '') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: getCors(event), body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: getCors(event), body: 'Method Not Allowed' };

  try {
    const { name, email, phone, book_title, author_name, publisher, year, notes, website } = JSON.parse(event.body || '{}');

    // Honeypot — bots fill this, humans don't
    if (website) return {
      statusCode: 200,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

    if (!email || !book_title) return {
      statusCode: 400,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Email and book title are required' })
    };

    // n8n owns the write AND the notification: its "Save to Supabase" node inserts
    // the book_requests row, and it emails the store team. We only trigger it here.
    // (This function previously ALSO inserted directly → two rows per request.)
    if (N8N_BOOK_REQUEST_URL) {
      await fetch(N8N_BOOK_REQUEST_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email, phone, book_title, author_name, publisher, year, notes })
      }).catch(e => console.error('n8n book-request trigger failed:', e.message));
    } else if (SUPABASE_URL && SERVICE_KEY) {
      // Fallback only when n8n isn't configured — so a request is never lost.
      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/book_requests`, {
        method:  'POST',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body:    JSON.stringify({ name, email, phone, book_title, author_name, publisher, year, notes, status: 'pending' })
      });
      if (!sbRes.ok) console.error('Supabase fallback insert failed:', sbRes.status, await sbRes.text());
    }

    return {
      statusCode: 200,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
