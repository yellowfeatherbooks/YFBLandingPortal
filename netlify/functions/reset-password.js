const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const crypto = require('crypto');

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { token, password } = JSON.parse(event.body || '{}');
  if (!token || !password) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Token and password are required' }) };
  }

  try {
    // Find user by reset token
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/users?reset_token=eq.${encodeURIComponent(token)}&select=email,reset_token_expiry&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    const user = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (!user) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Reset link is invalid or has expired.' }) };
    }

    // Check token expiry
    if (new Date(user.reset_token_expiry) < new Date()) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'Reset link has expired. Please request a new one.' }) };
    }

    // Hash new password
    const salt          = generateSalt();
    const password_hash = hashPassword(password, salt);

    // Update password and clear reset token
    await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(user.email)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({ password_hash, salt, reset_token: null, reset_token_expiry: null })
      }
    );

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Reset failed. Please try again.' }) };
  }
};
