// Public, no-auth ticket lookup — trusts a bare email, same trust level as get-submissions.js.
// POST { email } -> { success: true, tickets: [...] }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

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

  const { email } = JSON.parse(event.body || '{}');
  const jsonHeaders = { ...getCors(event), 'Content-Type': 'application/json' };

  if (!email) return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ success: true, tickets: [] }) };

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/complaints?email=eq.${encodeURIComponent(email)}&select=id,category,subject,status,resolution,created_at,updated_at&order=created_at.desc&limit=100`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const rows = await res.json();
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ success: true, tickets: Array.isArray(rows) ? rows : [] }) };
  } catch (err) {
    return { statusCode: 200, headers: jsonHeaders, body: JSON.stringify({ success: true, tickets: [] }) };
  }
};
