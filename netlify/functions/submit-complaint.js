const SUPABASE_URL          = process.env.SUPABASE_URL;
const SERVICE_KEY           = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const N8N_COMPLAINT_NEW_URL = process.env.N8N_COMPLAINT_NEW_URL;

const ALLOWED_ORIGINS = [
  'https://yellowfeather.netlify.app',
  'https://yellowfeatherbooks.com',
  'https://www.yellowfeatherbooks.com',
  'https://yellowfeathersbooks.com',
];

const CATEGORIES = ['Order Issue', 'Delivery', 'Payment', 'Product Quality', 'Subscription', 'Other'];

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
    const { name, email, phone, order_number, category, subject, message, website } = JSON.parse(event.body || '{}');

    // Honeypot — bots fill this, humans don't
    if (website) return {
      statusCode: 200,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

    if (!name || !email || !subject || !message) return {
      statusCode: 400,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Name, email, subject and message are required' })
    };

    const safeCategory = CATEGORIES.includes(category) ? category : 'Other';

    const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/complaints`, {
      method:  'POST',
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation'
      },
      body: JSON.stringify({
        name, email, phone, order_number,
        category: safeCategory, subject, message, status: 'open'
      })
    });

    if (!sbRes.ok) {
      const err = await sbRes.text();
      console.error('Supabase complaint insert failed:', sbRes.status, err);
      return {
        statusCode: 500,
        headers: { ...getCors(event), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Could not save your complaint. Please try again.' })
      };
    }

    const rows   = await sbRes.json();
    const ticket = Array.isArray(rows) && rows.length ? rows[0] : null;

    if (N8N_COMPLAINT_NEW_URL) {
      fetch(N8N_COMPLAINT_NEW_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: ticket?.id, name, email, phone, order_number, category: safeCategory, subject, message })
      }).catch(e => console.error('n8n complaint-new trigger failed:', e.message));
    }

    return {
      statusCode: 200,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, id: ticket?.id })
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
