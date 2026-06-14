// Returns the server-stored cart_id and wishlist for a logged-in member.
// This allows cross-device sync — the same member on laptop and mobile sees
// the same cart and wishlist.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const empty = { cart_id: null, wishlist: [] };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email) return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify(empty)
    };

    const res  = await fetch(
      `${SUPABASE_URL}/rest/v1/member_sessions?email=eq.${encodeURIComponent(email.toLowerCase())}&select=cart_id,wishlist&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const row  = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    console.log('[ms] GET email=', email, '→ cart_id=', row?.cart_id, 'ua=', (event.headers['user-agent']||'').slice(0,40));

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cart_id:  row?.cart_id  || null,
        wishlist: row?.wishlist || []
      })
    };
  } catch (err) {
    // Graceful degradation — client falls back to localStorage
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...empty, error: err.message })
    };
  }
};
