// Drafts a customer-support resolution reply for a complaint using Claude.
// POST { adminEmail, adminKey, subject, category, message, customerName, orderNumber }

const crypto      = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CLAUDE_KEY   = (process.env.ANTHROPIC_API_KEY || '').trim();

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

  const { adminEmail, adminKey, subject, category, message, customerName, orderNumber } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  if (!CLAUDE_KEY) return json({ success: false, error: 'AI drafting is not configured.' }, 500);
  if (!message)    return json({ success: false, error: 'Missing complaint message' }, 400);

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role:    'user',
          content: `You are a customer support agent for Yellow Feather Books, a Malayalam bookstore. Draft a short, polite, professional reply resolving this customer's complaint.

Customer: ${customerName || 'Valued Customer'}
Order #: ${orderNumber || 'not provided'}
Category: ${category || 'Other'}
Subject: ${subject || '(no subject)'}
Message: ${message}

Rules:
- Under 120 words.
- Acknowledge the specific issue they raised.
- Describe next steps in general terms (the store admin will fill in specifics like exact dates/refund amounts before sending) — do not invent specific dates, amounts, or tracking numbers.
- Warm but professional tone. No greeting/sign-off boilerplate like "Dear X" or "Best regards" — just the body text, since the admin will paste this into an existing template.
- Respond with ONLY the reply text, no markdown, no preamble.`
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return json({ success: false, error: `AI request failed: ${err}` }, 500);
    }

    const cd    = await claudeRes.json();
    const draft = (cd.content?.[0]?.text || '').trim();
    if (!draft) return json({ success: false, error: 'AI returned an empty draft' }, 500);

    return json({ success: true, draft });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
