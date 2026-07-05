// admin-odoo-sync.js
// Admin-only: sync MyBillBook exports into Odoo (local Docker via the ODOO_* tunnel).
// The browser sends pre-parsed, SKU-resolved payloads (produced by the local
// mbb_sync_prep.py tool) in small batches, so each request stays under the
// function timeout and the UI can show live progress.
//
// POST { adminEmail, adminKey, action, ... }
//   action 'check'    -> { configured, reachable }
//   action 'sales'    -> { orders:[ {invoiceNo,customer,date,dayTotal,moneyIn,delivery,billDiscount,lines:[{sku,title,qty,total}]} ] }
//                        -> { results:[ {invoiceNo,status:'ok'|'skip'|'fail', ...} ] }
//   action 'snapshot' -> { rows:[ {sku,qty} ] } -> { applied, skipped }
//
// Sales/PO/Expense: only 'sales' is implemented; 'purchase' & 'expense' reserved.

const crypto       = require('crypto');
const odoo         = require('./lib/odoo');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
  if (!email || !adminKey) return false;
  const res = await fetch(
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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json({ success: false, error: 'Bad JSON' }, 400); }

  const { adminEmail, adminKey, action } = body;
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  // ── CHECK: is Odoo configured + reachable through the tunnel? ───────────────
  if (action === 'check') {
    if (!odoo.isConfigured()) {
      return json({ success: true, configured: false, reachable: false,
        message: 'ODOO_* env not set on this deploy context (tunnel down / not gone live).' });
    }
    try { await odoo.authenticate(); return json({ success: true, configured: true, reachable: true }); }
    catch (e) { return json({ success: true, configured: true, reachable: false, message: e.message }); }
  }

  if (!odoo.isConfigured()) {
    return json({ success: false, error: 'Odoo is not reachable from this deploy (ODOO_* not set / tunnel down).' }, 503);
  }

  // ── SALES: replay a batch of MyBillBook invoices as Odoo sale orders ────────
  if (action === 'sales') {
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (!orders.length) return json({ success: false, error: 'No orders in batch' }, 400);
    const reconcileEdits = body.reconcileEdits === true;   // re-sync edits: reverse old sale + rebuild from new lines
    const results = [];
    for (const o of orders) {
      try {
        const r = await odoo.createMbbSaleOrder(o, { reconcileEdits });
        results.push(r);
      } catch (e) {
        results.push({ invoiceNo: o.invoiceNo, status: 'fail', error: e.message });
      }
    }
    return json({ success: true, results });
  }

  // ── SNAPSHOT: set on-hand to a batch of {sku,qty} ──────────────────────────
  if (action === 'snapshot') {
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json({ success: false, error: 'No rows in batch' }, 400);
    try {
      const r = await odoo.applyStockSnapshot(rows);
      return json({ success: true, ...r });
    } catch (e) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  // ── PURCHASE: replay a batch of MyBillBook purchase bills as Odoo POs ───────
  if (action === 'purchase') {
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (!orders.length) return json({ success: false, error: 'No purchases in batch' }, 400);
    const autoCreate = body.autoCreate === true;
    const moveStock  = body.moveStock === true;   // LIVE mode (post-cutover): receipt increments stock
    const results = [];
    for (const o of orders) {
      try { results.push(await odoo.createMbbPurchaseOrder(o, { autoCreate, moveStock })); }
      catch (e) { results.push({ billNo: o.billNo, status: 'fail', error: e.message }); }
    }
    return json({ success: true, results });
  }

  // ── EXPENSE: record a batch of MyBillBook expense vouchers as categorized bills ──
  if (action === 'expense') {
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (!orders.length) return json({ success: false, error: 'No expenses in batch' }, 400);
    const results = [];
    for (const e of orders) {
      try { results.push(await odoo.createMbbExpenseBill(e)); }
      catch (err) { results.push({ voucherNo: e.voucherNo, status: 'fail', error: err.message }); }
    }
    return json({ success: true, results });
  }

  // ── ARCHIVE: deactivate products by SKU (e.g. retired placeholder items) ──
  if (action === 'archive') {
    const skus = Array.isArray(body.skus) ? body.skus.map(s => String(s).trim()).filter(Boolean) : [];
    if (!skus.length) return json({ success: false, error: 'No skus provided' }, 400);
    const results = [];
    for (const sku of skus) {
      try {
        const prod = await odoo.findOne('product.product', [['default_code', '=', sku]], ['id', 'name', 'product_tmpl_id']);
        if (!prod) { results.push({ sku, status: 'not_found' }); continue; }
        await odoo.execKw('product.template', 'write', [[prod.product_tmpl_id[0]], { active: false }]);
        results.push({ sku, status: 'archived', name: prod.name });
      } catch (e) { results.push({ sku, status: 'fail', error: e.message }); }
    }
    return json({ success: true, results });
  }

  return json({ success: false, error: `Unknown action '${action}'` }, 400);
};
