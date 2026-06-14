// Upserts cart_id and/or wishlist for a member (cross-device sync).
// Only the fields present in the request body are updated — the other column
// is left untouched (Supabase merge-duplicates upsert behaviour).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { email, cart_id, wishlist } = JSON.parse(event.body || '{}');
    console.log('[ms] SAVE email=', email, 'cart_id=', cart_id, 'ua=', (event.headers['user-agent']||'').slice(0,40));
    if (!email) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Email required' })
    };

    // Build payload — only include fields that were provided
    const payload = {
      email:      email.toLowerCase(),
      updated_at: new Date().toISOString()
    };
    if (cart_id  !== undefined) payload.cart_id  = cart_id;
    if (wishlist !== undefined) payload.wishlist  = wishlist;

    // Upsert: INSERT … ON CONFLICT (email) DO UPDATE SET only the provided columns
    const res = await fetch(`${SUPABASE_URL}/rest/v1/member_sessions`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(text);
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
