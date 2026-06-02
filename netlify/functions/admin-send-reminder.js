// Sends a reminder email + WhatsApp to a member or author via n8n.
// POST { adminEmail, adminKey, to, toName, phone, subject, bodyText }
//
// Requires env var: N8N_REMINDER_URL
// Set this to your n8n webhook URL for the reminder workflow.
// n8n receives: { to, toName, phone, subject, bodyText, type }
// and handles both email and WhatsApp sending.

const crypto       = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

async function verifyAdmin(email, adminKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, to, toName, phone, subject, bodyText, type } = JSON.parse(event.body || '{}');

  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!to || !subject || !bodyText) return json({ success: false, error: 'to, subject and bodyText are required' }, 400);

  const webhookUrl = process.env.N8N_REMINDER_URL;
  if (!webhookUrl) return json({ success: false, error: 'N8N_REMINDER_URL not configured' }, 503);

  try {
    const n8nRes = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, toName, phone: phone || null, subject, bodyText, type: type || 'general' })
    });

    if (!n8nRes.ok) {
      const errText = await n8nRes.text();
      return json({ success: false, error: `n8n returned ${n8nRes.status}: ${errText}` });
    }

    const data = await n8nRes.json().catch(() => ({}));
    return json({ success: true, ...data });

  } catch(e) {
    return json({ success: false, error: e.message }, 500);
  }
};
