// Sends a reminder email to a member or author via Resend API.
// POST { adminEmail, adminKey, to, toName, subject, html }
//
// Requires env var: RESEND_API_KEY
// Get a free key at https://resend.com — free tier: 3000 emails/month
// Also requires: RESEND_FROM_EMAIL  e.g. "team@yellowfeatherbooks.in"

const crypto       = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const RESEND_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL || 'team@yellowfeatherbooks.in';
const FROM_NAME     = 'Team Yellow Feather Books';

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

  const { adminEmail, adminKey, to, toName, subject, bodyText } = JSON.parse(event.body || '{}');

  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!to || !subject || !bodyText) return json({ success: false, error: 'to, subject and bodyText are required' }, 400);
  if (!RESEND_KEY) return json({ success: false, error: 'RESEND_API_KEY not configured' }, 503);

  // Convert plain text to simple HTML (preserve line breaks)
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e;line-height:1.7;">
      <div style="background:#0B0E1A;padding:1.2rem 1.5rem;border-radius:8px 8px 0 0;">
        <img src="https://yellowfeather.netlify.app/assets/logo.png" alt="Yellow Feather Books" height="36"
          onerror="this.style.display='none'" style="display:block;" />
      </div>
      <div style="background:#ffffff;padding:1.8rem 1.5rem;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;">
        ${bodyText.split('\n').map(line => line.trim() ? `<p style="margin:0 0 0.9rem;">${line}</p>` : '<br/>').join('')}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0;" />
        <p style="font-size:0.78rem;color:#6b7280;margin:0;">
          Yellow Feather Books &nbsp;·&nbsp;
          <a href="https://yellowfeather.netlify.app" style="color:#C9922A;">yellowfeather.netlify.app</a>
          &nbsp;·&nbsp; +91 9400446565
        </p>
      </div>
    </div>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${FROM_NAME} <${FROM_EMAIL}>`,
        to:      [to],
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) return json({ success: false, error: data.message || JSON.stringify(data) });
    return json({ success: true, id: data.id });
  } catch(e) {
    return json({ success: false, error: e.message }, 500);
  }
};
