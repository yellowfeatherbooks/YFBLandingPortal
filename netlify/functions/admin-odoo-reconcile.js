// admin-odoo-reconcile.js — reconcile Odoo when MyBillBook cancels/returns a sale.
//
// MyBillBook is the book of record. When staff cancel/return/refuse an order there
// the invoice becomes ₹0 and its daybook row reads "Sales Invoice - Cancelled".
// Odoo still holds the original sale (SO → delivery → invoice → payment), so it is
// now overstated. The admin uploads the latest daybook; the portal filters the
// cancelled invoice numbers and sends them here.
//
// POST { adminEmail, adminKey, action, ... }
//   action 'scan'    { cancelledRefs:[invNo,...] }  → read-only: which cancelled
//                       invoices are still LIVE (real amount, not yet reversed) in Odoo.
//   action 'reverse' { invoiceNo, apply }           → reverse ONE sale in Odoo
//                       (credit note + stock return + refund). apply!=true = dry-run.
const crypto = require('crypto');
const odoo   = require('./lib/odoo');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (b, s=200) => ({ statusCode: s, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify(b) });
const r2 = n => Math.round((Number(n)||0)*100)/100;

async function verifyAdmin(email, adminKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  return crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex') === adminKey;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success:false, error:'Method Not Allowed' }, 405);
  const body = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(body.adminEmail, body.adminKey)) return json({ success:false, error:'Unauthorized' }, 401);
  if (!odoo.isConfigured()) return json({ success:false, error:'Odoo not reachable (ODOO_* / tunnel down)' }, 503);

  try {
    if (body.action === 'scan') {
      // Accepts either the new `invoices:[{no,total,cancelled}]` (full daybook diff)
      // or the legacy `cancelledRefs:[no,...]`. Classifies each vs Odoo:
      //   cancelled  — cancelled in MyBillBook, still live in Odoo → reverse
      //   edited     — live in Odoo but total ≠ MyBillBook total → re-sync
      //   in-sync    — totals match
      //   reconciled — cancellation already reversed
      //   not-synced — not in Odoo yet (normal Odoo Sync will create it)
      const TOL = 1;   // ₹ tolerance (rounding)
      let invoices = Array.isArray(body.invoices) ? body.invoices : null;
      if (!invoices) invoices = (body.cancelledRefs || []).map(n => ({ no:String(n), total:0, cancelled:true }));
      const seen = {};
      invoices = invoices.map(i => ({ no:String(i.no||'').trim(), total:Number(i.total)||0, moneyIn:Number(i.moneyIn)||0, cancelled:!!i.cancelled }))
        .filter(i => i.no && !seen[i.no] && (seen[i.no]=1));
      if (!invoices.length) return json({ success:true, rows:[], counts:{ total:0, cancelledFix:0, edited:0, payment:0, inSync:0, reconciled:0, notSynced:0 } });

      const refs = [];
      invoices.forEach(i => { refs.push(`mbb:${i.no}`, `sales:${i.no}`); });
      const sos = await odoo.execKw('sale.order', 'search_read',
        [[['client_order_ref', 'in', refs]],
         ['id','name','state','amount_total','invoice_ids','partner_id','client_order_ref']], { limit: 8000 });
      const byInv = {};
      sos.forEach(s => { const m = (s.client_order_ref||'').match(/^(?:mbb|sales):(.+)$/); if (m) byInv[m[1]] = s; });

      // Bulk-fetch invoice payment info (for payment-drift detection) keyed by SO.
      const invToSo = {}; const allInvIds = [];
      sos.forEach(s => (s.invoice_ids||[]).forEach(id => { invToSo[id] = s.id; allInvIds.push(id); }));
      const paidBySo = {};   // soId -> { total, residual }
      if (allInvIds.length) {
        const ivs = await odoo.execKw('account.move', 'search_read',
          [[['id','in',allInvIds],['move_type','=','out_invoice'],['state','=','posted']],
           ['id','amount_total','amount_residual']], { limit: 20000 });
        ivs.forEach(iv => { const soId = invToSo[iv.id]; if (soId==null) return;
          const m = paidBySo[soId] || (paidBySo[soId] = { total:0, residual:0 });
          m.total += iv.amount_total; m.residual += iv.amount_residual; });
      }

      const rows = [];
      for (const it of invoices) {
        const s = byInv[it.no];
        if (!s) { rows.push({ invoiceNo:it.no, inOdoo:false, mbbTotal:r2(it.total), cancelled:it.cancelled,
          status: it.cancelled ? 'reconciled' : 'not-synced' }); continue; }   // cancelled & never synced = nothing to do
        const base = { invoiceNo:it.no, inOdoo:true, so:s.name, customer:(s.partner_id&&s.partner_id[1])||'',
          odooTotal:r2(s.amount_total), mbbTotal:r2(it.total), state:s.state };
        // is this Odoo invoice already credit-noted (a prior cancellation fix)?
        let reversed = false;
        if ((it.cancelled || s.state === 'cancel') && s.invoice_ids && s.invoice_ids.length) {
          const cn = await odoo.execKw('account.move', 'search_count',
            [[['reversed_entry_id','in',s.invoice_ids],['move_type','=','out_refund'],['state','=','posted']]]);
          reversed = cn > 0;
        }
        const pm = paidBySo[s.id];
        const odooPaid = pm ? r2(pm.total - pm.residual) : 0;
        if (it.cancelled) {
          base.status = (reversed || s.state === 'cancel' || s.amount_total <= 0) ? 'reconciled' : 'cancelled';
        } else if (Math.abs(s.amount_total - it.total) > TOL) {
          base.status = 'edited'; base.delta = r2(it.total - s.amount_total);
        } else if (Math.abs(it.moneyIn - odooPaid) > TOL) {
          // total matches but the collected amount drifted (paid later in MyBillBook)
          base.status = 'payment'; base.odooPaid = odooPaid; base.mbbMoneyIn = r2(it.moneyIn); base.payDelta = r2(it.moneyIn - odooPaid);
        } else {
          base.status = 'in-sync';
        }
        rows.push(base);
      }
      const cnt = k => rows.filter(r => r.status === k).length;
      return json({ success:true, rows,
        counts: { total: invoices.length, cancelledFix: cnt('cancelled'), edited: cnt('edited'), payment: cnt('payment'),
          inSync: cnt('in-sync'), reconciled: cnt('reconciled'), notSynced: cnt('not-synced') },
        cancelledTotal: r2(rows.filter(r=>r.status==='cancelled').reduce((s,r)=>s+r.odooTotal,0)),
        editedDelta: r2(rows.filter(r=>r.status==='edited').reduce((s,r)=>s+(r.delta||0),0)),
        paymentDelta: r2(rows.filter(r=>r.status==='payment').reduce((s,r)=>s+(r.payDelta||0),0)) });
    }

    if (body.action === 'find-product') {
      // Diagnostic: list products whose name matches a term (to spot apostrophe /
      // punctuation / duplicate mismatches that break title-based line matching).
      const term = String(body.term || '').trim();
      if (!term) return json({ success:false, error:'term required' });
      const prods = await odoo.execKw('product.product', 'search_read',
        [[['name', 'ilike', term]], ['id','name','default_code','qty_available','active']], { limit: 50, context:{ active_test:false } });
      const rows = prods.map(p => ({ id:p.id, name:p.name, sku:p.default_code||'',
        qty:p.qty_available, active:p.active,
        codepoints: [...p.name].map(c => { const cp=c.codePointAt(0); return cp>126 ? `${c}=U+${cp.toString(16).toUpperCase()}` : c; }).join('') }));
      return json({ success:true, term, count:rows.length, rows });
    }

    if (body.action === 'reverse') {
      const invoiceNo = String(body.invoiceNo || '').trim();
      if (!invoiceNo) return json({ success:false, error:'invoiceNo required' });
      const result = await odoo.reverseMbbSale(invoiceNo, { dryRun: body.apply !== true });
      return json({ success:true, result });
    }

    if (body.action === 'pay') {
      const invoiceNo = String(body.invoiceNo || '').trim();
      if (!invoiceNo) return json({ success:false, error:'invoiceNo required' });
      // Server recomputes the shortfall from the CURRENT Odoo state; moneyIn is the
      // MyBillBook collected total for this invoice (from the daybook).
      const result = await odoo.applyMbbPayment(invoiceNo, Number(body.moneyIn) || 0, { dryRun: body.apply !== true });
      return json({ success:true, result });
    }

    return json({ success:false, error:'Unknown action' }, 400);
  } catch (e) { return json({ success:false, error: e.message }, 500); }
};
