const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_KEY         = process.env.SUPABASE_KEY;
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
    const { name, email, phone, book_title, author_name, publisher, year, notes } = JSON.parse(event.body || '{}');

    if (!email || !book_title) return {
      statusCode: 400,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Email and book title are required' })
    };

    // Notify via n8n (n8n handles Supabase insert)
    if (N8N_BOOK_REQUEST_URL) {
      await fetch(N8N_BOOK_REQUEST_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, email, phone, book_title, author_name, publisher, year, notes })
      }).catch(e => console.error('n8n book-request notify failed:', e.message));
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
