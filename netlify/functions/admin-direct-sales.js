// admin-direct-sales.js
// Admin CRUD for direct (offline) sales entries.
// POST { adminEmail, adminKey, action: 'list' | 'add' | 'delete', ... }

const crypto           = require('crypto');
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;

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

  const body = JSON.parse(event.body || '{}');
  const { adminEmail, adminKey, action } = body;

  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  // ── LIST ───────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { author_email } = body;
    let url = `${SUPABASE_URL}/rest/v1/direct_sales?order=sale_date.desc,created_at.desc&limit=200`;
    if (author_email) url += `&author_email=eq.${encodeURIComponent(author_email)}`;
    const res  = await fetch(url, {
      headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
    });
    if (!res.ok) return json({ success: false, error: await res.text() });
    const rows = await res.json();
    return json({ success: true, sales: rows });
  }

  // ── ADD ────────────────────────────────────────────────────────────────────
  if (action === 'add') {
    const { author_email, book_title, quantity, amount, sale_date, order_number, payment_status, notes } = body;
    if (!author_email || !book_title || !amount || !sale_date) {
      return json({ success: false, error: 'author_email, book_title, amount and sale_date are required.' });
    }
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/direct_sales`,
      {
        method:  'POST',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify({
          author_email,
          book_title,
          quantity:       parseInt(quantity) || 1,
          amount:         parseFloat(amount),
          sale_date,
          order_number:   order_number   || null,
          payment_status: payment_status || 'paid',
          notes:          notes          || null,
          source:         'direct'
        })
      }
    );
    if (!res.ok) return json({ success: false, error: await res.text() });
    const rows = await res.json();
    return json({ success: true, sale: rows[0] });
  }

  // ── UPDATE (e.g. mark paid/unpaid) ───────────────────────────────────────────
  if (action === 'update') {
    const { id, payment_status, amount, notes } = body;
    if (!id) return json({ success: false, error: 'id is required' });
    const patch = {};
    if (payment_status !== undefined) patch.payment_status = payment_status;
    if (amount !== undefined && amount !== '' && amount !== null) patch.amount = parseFloat(amount);
    if (notes !== undefined) patch.notes = notes;
    if (!Object.keys(patch).length) return json({ success: false, error: 'Nothing to update' });
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/direct_sales?id=eq.${id}`,
      {
        method:  'PATCH',
        headers: {
          'apikey':        SUPABASE_SVC_KEY,
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation'
        },
        body: JSON.stringify(patch)
      }
    );
    if (!res.ok) return json({ success: false, error: await res.text() });
    const rows = await res.json();
    return json({ success: true, sale: rows[0] });
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const { id } = body;
    if (!id) return json({ success: false, error: 'id is required' });
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/direct_sales?id=eq.${id}`,
      {
        method:  'DELETE',
        headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
      }
    );
    if (!res.ok) return json({ success: false, error: await res.text() });
    return json({ success: true });
  }

  return json({ success: false, error: 'Unknown action. Use list, add, update, or delete.' });
};
