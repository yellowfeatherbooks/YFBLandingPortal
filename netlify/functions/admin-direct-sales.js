// admin-direct-sales.js
// Admin CRUD for direct (offline) sales entries.
// POST { adminEmail, adminKey, action: 'list' | 'add' | 'delete', ... }

const crypto           = require('crypto');
const odoo             = require('./lib/odoo');   // direct sale -> Odoo GST-exempt invoice
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
    let url = `${SUPABASE_URL}/rest/v1/direct_sales?order=sale_date.desc,created_at.desc&limit=5000`;
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
    const { author_email, book_title, quantity, amount, sale_date, order_number, payment_status, notes, sku, items } = body;
    if (!author_email || !book_title || !amount || !sale_date) {
      return json({ success: false, error: 'author_email, book_title, amount and sale_date are required.' });
    }
    // ── ODOO FIRST ──────────────────────────────────────────────────────────
    // Offline sales are NOT in MyBillBook, so Odoo is the system of record here:
    // the sale must land in Odoo (inventory + accounting) BEFORE we write the
    // Supabase dashboard row. If Odoo is unreachable or the write fails, we record
    // NOTHING — no Supabase-only orphans that would drift from the ledger.
    // (Ref `direct:<order_number|timestamp>`; sales entered here are flagged as
    // "not in MyBillBook" in the out-of-sync report so staff can back-enter them.)
    if (!odoo.isConfigured()) {
      return json({ success: false, error: 'Odoo is not reachable (tunnel down) — sale NOT recorded. Bring Odoo up and retry.' }, 503);
    }
    let odooRes;
    try {
      odooRes = await odoo.createDirectSaleOrder({
        items:         Array.isArray(items) && items.length ? items : null,
        sku:           sku || null,
        bookTitle:     book_title,
        bookSummary:   book_title,
        authorEmail:   author_email,
        amount:        parseFloat(amount),
        quantity:      parseInt(quantity) || 1,
        saleDate:      sale_date,
        orderNumber:   order_number || null,   // idempotency key when supplied (Ref column)
        paymentStatus: payment_status || 'paid',
        notes:         notes || null,
      });
    } catch (e) {
      return json({ success: false, error: 'Odoo write failed — sale NOT recorded: ' + e.message }, 502);
    }

    // ── SUPABASE LAST (only now that Odoo has it) ───────────────────────────────
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
          order_number:   order_number || odooRes.number || null,   // keep the Odoo SO no. if no Ref given
          payment_status: payment_status || 'paid',
          notes:          notes          || null,
          source:         'direct'
        })
      }
    );
    if (!res.ok) return json({ success: false, error: 'Odoo recorded (' + odooRes.number + ') but the dashboard write failed: ' + await res.text() });
    const rows = await res.json();
    const sale = rows[0];

    // Store SKU + line items best-effort (separate PATCH; harmless if columns absent).
    const extra = {};
    if (sku) extra.sku = sku;
    if (Array.isArray(items) && items.length) extra.items = items;
    if (Object.keys(extra).length) {
      fetch(`${SUPABASE_URL}/rest/v1/direct_sales?id=eq.${sale.id}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(extra)
      }).then(r => { if (!r.ok) console.warn('direct_sales sku/items save failed:', r.status); })
        .catch(e => console.warn('direct_sales sku/items save failed:', e.message));
    }

    return json({ success: true, sale, odoo: { number: odooRes.number, total: odooRes.total, paymentState: odooRes.paymentState, created: odooRes.created } });
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
