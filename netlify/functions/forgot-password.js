const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const crypto = require('crypto');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { email } = JSON.parse(event.body || '{}');
  if (!email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Email is required' }) };
  }

  const token     = crypto.randomBytes(32).toString('hex');
  const expiry    = new Date(Date.now() + 3600000).toISOString(); // 1 hour
  const resetLink = `https://yellowfeather.netlify.app/author-portal.html#reset?token=${token}`;

  try {
    // Check user exists (always return success to prevent email enumeration)
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=email&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await checkRes.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // Save reset token to Supabase
    await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ reset_token: token, reset_token_expiry: expiry })
      }
    );

    // Send reset email via n8n
    const webhookUrl = process.env.N8N_FORGOT_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, reset_link: resetLink })
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to send reset email' }) };
  }
};
