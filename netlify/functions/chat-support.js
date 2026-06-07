// Proxies customer chat messages to n8n AI Agent.
// Keeps the n8n webhook URL hidden from the browser.
// POST { message, sessionId }

const N8N_CHAT_URL = process.env.N8N_CHAT_WEBHOOK_URL;

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);
  if (!N8N_CHAT_URL)                  return json({ error: 'Chat service not configured' }, 503);

  let message, sessionId;
  try {
    ({ message, sessionId } = JSON.parse(event.body || '{}'));
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  if (!message?.trim()) return json({ error: 'Message is required' }, 400);

  try {
    const res = await fetch(N8N_CHAT_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        message:   message.trim(),
        sessionId: sessionId || 'anonymous',
        source:    'website-widget'
      })
    });

    const text = await res.text();
    let data;
    try   { data = JSON.parse(text); }
    catch { data = { reply: text }; }

    // n8n AI Agent returns { output } or { reply } or plain text
    const reply = data?.output || data?.reply || data?.text || data?.message || text || 'Sorry, I could not process your request.';
    return json({ reply });

  } catch (e) {
    console.error('chat-support error:', e.message);
    return json({ reply: 'Sorry, our chat service is temporarily unavailable. Please try again shortly.' });
  }
};
