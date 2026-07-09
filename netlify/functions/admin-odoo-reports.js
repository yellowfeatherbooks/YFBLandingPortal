// admin-odoo-reports.js — quick month-end / receivables reports read live from Odoo.
// POST { adminEmail, adminKey, action, ...params }
//   action: 'customer-statement' { nameLike }
//           'pl'                  { from, to }
//           'gstr1'               { from, to }
//           'aged'               (open receivables by customer, aged)
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
  const { action, from='2026-06-01', to='2026-06-30', nameLike='' } = body;
  try {
    if (action === 'customer-statement') {
      if (!nameLike.trim()) return json({ success:false, error:'Enter a customer name' });
      const partners = await odoo.execKw('res.partner','search_read',
        [[['name','ilike',nameLike],['customer_rank','>',0]], ['id','name','vat','phone','email','city']], { limit: 20 });
      const pool = partners.length ? partners : await odoo.execKw('res.partner','search_read',
        [[['name','ilike',nameLike]], ['id','name','vat','phone','email','city']], { limit: 20 });
      if (!pool.length) return json({ success:true, notFound:true, message:`No customer matching "${nameLike}"` });
      const p = pool[0];
      const lines = await odoo.execKw('account.move.line','search_read',
        [[['partner_id','=',p.id],['parent_state','=','posted'],['account_id.account_type','=','asset_receivable']],
         ['date','move_name','name','debit','credit']], { order:'date asc, id asc' });
      let bal = 0;
      const rows = lines.map(l => { bal += (l.debit||0)-(l.credit||0);
        return { date:l.date, doc:l.move_name, label:l.name, debit:r2(l.debit), credit:r2(l.credit), balance:r2(bal) }; });
      return json({ success:true, partner:p, otherMatches: pool.slice(1,8).map(x=>x.name),
        lines: rows, totalInvoiced:r2(rows.reduce((s,r)=>s+r.debit,0)), totalPaid:r2(rows.reduce((s,r)=>s+r.credit,0)), outstanding:r2(bal) });
    }

    if (action === 'pl') {
      // Rolling P&L: reflects current known truth, not a locked snapshot. A sale
      // dated in this period that gets reversed LATER (credit note posted in a
      // different month, e.g. a MyBillBook cancellation caught weeks after the
      // fact) must still net out of THIS period's revenue — the sale never really
      // happened. GSTR-1 stays date-as-issued (unchanged); only P&L nets forward.
      const accts = await odoo.execKw('account.account','search_read',
        [[['account_type','in',['income','income_other','expense','expense_direct_cost','expense_depreciation']]], ['id','code','name','account_type']]);
      const byId={}; accts.forEach(a=>byId[a.id]=a);
      const acctIds = accts.map(a=>a.id);
      const grp = await odoo.execKw('account.move.line','read_group',
        [[['parent_state','=','posted'],['date','>=',from],['date','<=',to],['account_id','in',acctIds]], ['balance:sum'], ['account_id']]);
      const balByAcct = {}; grp.forEach(g => balByAcct[g.account_id[0]] = g.balance);

      // Fold in credit notes dated OUTSIDE this range that reverse an invoice dated
      // INSIDE it — their own-month ledger entry would otherwise hide the reversal
      // from this period. A credit note dated inside the range is already counted
      // by the query above, so it's excluded here to avoid double-counting.
      const invs = await odoo.execKw('account.move','search_read',
        [[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',from],['invoice_date','<=',to]], ['id']], { limit: 20000 });
      const invIds = invs.map(i => i.id);
      if (invIds.length) {
        const cns = await odoo.execKw('account.move','search_read',
          [[['move_type','=','out_refund'],['state','=','posted'],['reversed_entry_id','in',invIds]], ['id','date']], { limit: 20000 });
        const outsideCnIds = cns.filter(c => !(c.date >= from && c.date <= to)).map(c => c.id);
        if (outsideCnIds.length) {
          const cnLines = await odoo.execKw('account.move.line','read_group',
            [[['parent_state','=','posted'],['move_id','in',outsideCnIds],['account_id','in',acctIds]], ['balance:sum'], ['account_id']]);
          cnLines.forEach(g => { balByAcct[g.account_id[0]] = (balByAcct[g.account_id[0]]||0) + g.balance; });
        }
      }

      const rows = acctIds.map(id => ({ code:byId[id].code, name:byId[id].name, type:byId[id].account_type, balance:r2(balByAcct[id]||0) }))
        .filter(x=>x.balance!==0).sort((a,b)=>a.code.localeCompare(b.code));
      const income = r2(rows.filter(r=>r.type.startsWith('income')).reduce((s,r)=>s-r.balance,0));
      const expense = r2(rows.filter(r=>r.type.startsWith('expense')).reduce((s,r)=>s+r.balance,0));
      return json({ success:true, from, to, rows, revenue:income, expenses:expense, net:r2(income-expense) });
    }

    if (action === 'gstr1') {
      const invs = await odoo.execKw('account.move','search_read',
        [[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',from],['invoice_date','<=',to]],
         ['partner_id','amount_untaxed','amount_tax','amount_total']]);
      const pids=[...new Set(invs.map(i=>i.partner_id&&i.partner_id[0]).filter(Boolean))];
      const partners = pids.length ? await odoo.execKw('res.partner','search_read',[[['id','in',pids]],['id','vat']]) : [];
      const vat={}; partners.forEach(p=>vat[p.id]=p.vat);
      let taxable=0, tax=0, exempt=0, b2b=0, b2c=0;
      for (const i of invs){ const t=i.amount_tax||0,u=i.amount_untaxed||0; tax+=t; if(t>0)taxable+=u; else exempt+=u;
        if(vat[i.partner_id&&i.partner_id[0]]) b2b+=i.amount_total; else b2c+=i.amount_total; }
      return json({ success:true, from, to, invoiceCount:invs.length, taxableValue:r2(taxable), taxAmount:r2(tax),
        exemptValue:r2(exempt), b2bTotal:r2(b2b), b2cTotal:r2(b2c) });
    }

    if (action === 'aged') {
      const today = new Date();
      const lines = await odoo.execKw('account.move.line','search_read',
        [[['parent_state','=','posted'],['account_id.account_type','=','asset_receivable'],['amount_residual','!=',0]],
         ['partner_id','amount_residual','date_maturity','date','move_name']], { limit: 5000 });
      const by = {};
      for (const l of lines) {
        const pid = l.partner_id && l.partner_id[0]; if(!pid) continue;
        const nm = l.partner_id[1];
        const due = new Date((l.date_maturity || l.date) + 'T00:00:00');
        const days = Math.floor((today - due)/86400000);
        const b = by[pid] || (by[pid] = { customer:nm, d0_30:0, d31_60:0, d61_90:0, d90:0, total:0 });
        const amt = l.amount_residual;
        if (days<=30) b.d0_30+=amt; else if(days<=60) b.d31_60+=amt; else if(days<=90) b.d61_90+=amt; else b.d90+=amt;
        b.total+=amt;
      }
      const rows = Object.values(by).map(b=>({ customer:b.customer, d0_30:r2(b.d0_30), d31_60:r2(b.d31_60),
        d61_90:r2(b.d61_90), d90:r2(b.d90), total:r2(b.total) })).filter(b=>Math.abs(b.total)>0.01).sort((a,b)=>b.total-a.total);
      const tot = k => r2(rows.reduce((s,r)=>s+r[k],0));
      return json({ success:true, rows, totals:{ d0_30:tot('d0_30'), d31_60:tot('d31_60'), d61_90:tot('d61_90'), d90:tot('d90'), total:tot('total') } });
    }

    if (action === 'stock') {
      // On-hand inventory straight from Odoo (fed by the MyBillBook sync + live sales/purchases).
      const prods = await odoo.execKw('product.product','search_read',
        [[['type','=','product']], ['default_code','name','qty_available','standard_price','categ_id']], { limit: 5000 });
      const rows = prods.filter(p => Math.abs(p.qty_available||0) > 0.0001).map(p => ({
        sku: p.default_code||'', name: p.name, category: (p.categ_id&&p.categ_id[1])||'',
        qty: r2(p.qty_available), cost: r2(p.standard_price), value: r2((p.qty_available||0)*(p.standard_price||0))
      })).sort((a,b)=> b.value - a.value);
      const negatives = rows.filter(r=>r.qty<0);
      return json({ success:true, rows, itemCount: rows.length,
        totalQty: r2(rows.reduce((s,r)=>s+r.qty,0)), totalValue: r2(rows.reduce((s,r)=>s+r.value,0)),
        negativeCount: negatives.length, negativeValue: r2(negatives.reduce((s,r)=>s+r.value,0)) });
    }

    if (action === 'stock-match') {
      // Compare an uploaded MyBillBook Stock Summary CSV (parsed client-side into
      // {sku, qty} rows, aggregated here) against live Odoo on-hand by SKU.
      const mbbRows = Array.isArray(body.mbbRows) ? body.mbbRows : [];
      if (!mbbRows.length) return json({ success:false, error:'No MyBillBook rows provided' });
      const mbb = {};
      for (const r of mbbRows) {
        const sku = String(r.sku||'').trim(); if (!sku) continue;
        mbb[sku] = (mbb[sku]||0) + (Number(r.qty)||0);
      }
      const prods = await odoo.execKw('product.product','search_read',
        [[['type','=','product']], ['default_code','name','qty_available']], { limit: 5000 });
      const odooQty = {}, nameBySku = {};
      for (const p of prods) {
        const sku = (p.default_code||'').trim(); if (!sku) continue;
        odooQty[sku] = r2(p.qty_available); nameBySku[sku] = p.name;
      }
      const allSkus = new Set([...Object.keys(mbb), ...Object.keys(odooQty)]);
      const mismatched = [], mbbOnly = [], odooOnly = [];
      let matchedCount = 0;
      for (const sku of allSkus) {
        const inMbb = Object.prototype.hasOwnProperty.call(mbb, sku);
        const inOdoo = Object.prototype.hasOwnProperty.call(odooQty, sku);
        if (inMbb && inOdoo) {
          const mq = r2(mbb[sku]), oq = odooQty[sku];
          if (Math.abs(mq-oq) < 0.01) matchedCount++;
          else mismatched.push({ sku, name: nameBySku[sku]||'', mbbQty: mq, odooQty: oq, delta: r2(oq-mq) });
        } else if (inMbb && !inOdoo) {
          mbbOnly.push({ sku, qty: r2(mbb[sku]) });
        } else if (!inMbb && inOdoo && Math.abs(odooQty[sku]) > 0.0001) {
          odooOnly.push({ sku, name: nameBySku[sku]||'', qty: odooQty[sku] });
        }
      }
      mismatched.sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
      odooOnly.sort((a,b)=>Math.abs(b.qty)-Math.abs(a.qty));
      return json({ success:true, matchedCount, mismatched, mbbOnly, odooOnly });
    }

    if (action === 'sales-match') {
      // Side-by-side per-order comparison: an uploaded MyBillBook daybook (parsed
      // client-side into {no, customer, total, cancelled} sale-invoice rows) vs the
      // matching Odoo SO's LIVE total (posted invoices minus any already-reversed
      // ones), so a credit-noted cancellation nets to 0 rather than showing stale.
      const mbbRows = Array.isArray(body.mbbRows) ? body.mbbRows : [];
      if (!mbbRows.length) return json({ success:false, error:'No MyBillBook rows provided' });
      const byNo = {};
      for (const r of mbbRows) {
        const no = String(r.no||'').trim(); if (!no) continue;
        byNo[no] = { no, customer: String(r.customer||''), mbbTotal: r2(r.total), cancelled: !!r.cancelled };
      }
      const nos = Object.keys(byNo);
      const refs = [];
      nos.forEach(no => refs.push(`mbb:${no}`, `sales:${no}`));
      const sos = await odoo.execKw('sale.order','search_read',
        [[['client_order_ref','in',refs]], ['id','name','client_order_ref','partner_id','invoice_ids']], { limit: 8000 });
      const byInvoiceNo = {};
      sos.forEach(s => { const m=(s.client_order_ref||'').match(/^(?:mbb|sales):(.+)$/); if (m) byInvoiceNo[m[1]] = s; });

      const allInvIds = [];
      sos.forEach(s => (s.invoice_ids||[]).forEach(id => allInvIds.push(id)));
      const invById = {};
      if (allInvIds.length) {
        const ivs = await odoo.execKw('account.move','search_read',
          [[['id','in',allInvIds],['move_type','=','out_invoice'],['state','=','posted']], ['id','amount_total']], { limit: 20000 });
        ivs.forEach(iv => invById[iv.id] = iv.amount_total);
      }
      const reversedIds = new Set();
      if (allInvIds.length) {
        const cns = await odoo.execKw('account.move','search_read',
          [[['move_type','=','out_refund'],['state','=','posted'],['reversed_entry_id','in',allInvIds]], ['reversed_entry_id']], { limit: 20000 });
        cns.forEach(c => { if (c.reversed_entry_id) reversedIds.add(c.reversed_entry_id[0]); });
      }

      const rows = nos.map(no => {
        const mbb = byNo[no];
        const s = byInvoiceNo[no];
        if (!s) return { no, customer: mbb.customer, mbbTotal: mbb.mbbTotal, odooTotal: null, so: null, delta: null, inOdoo: false };
        const liveTotal = r2((s.invoice_ids||[]).filter(id => !reversedIds.has(id)).reduce((sum,id) => sum+(invById[id]||0), 0));
        return { no, customer: (s.partner_id&&s.partner_id[1])||mbb.customer, so: s.name,
          mbbTotal: mbb.mbbTotal, odooTotal: liveTotal, delta: r2(liveTotal-mbb.mbbTotal), inOdoo: true };
      }).sort((a,b) => Math.abs(b.delta||0) - Math.abs(a.delta||0));

      const notInOdoo = rows.filter(r => !r.inOdoo).length;
      const mismatched = rows.filter(r => r.inOdoo && Math.abs(r.delta) > 0.5).length;
      const matched = rows.length - mismatched - notInOdoo;
      return json({ success:true, rows, counts: { total: rows.length, matched, mismatched, notInOdoo },
        mbbTotal: r2(rows.reduce((s,r)=>s+r.mbbTotal,0)), odooTotal: r2(rows.reduce((s,r)=>s+(r.odooTotal||0),0)) });
    }

    if (action === 'unsynced') {
      // Sales that exist in Odoo but NOT in MyBillBook = those entered via the Direct
      // Sales page (client_order_ref 'direct:%'). While MyBillBook is the book of
      // record, staff should back-enter these into MyBillBook. (mbb:/sales: refs came
      // FROM MyBillBook, so they're excluded.)
      const sos = await odoo.execKw('sale.order','search_read',
        [[['client_order_ref','=like','direct:%'],['state','!=','cancel']],
         ['name','client_order_ref','partner_id','amount_total','date_order','invoice_ids']],
        { order:'date_order desc, id desc', limit: 2000 });
      const rows = sos.map(s => ({ so:s.name, ref:s.client_order_ref, cust:(s.partner_id&&s.partner_id[1])||'',
        total:r2(s.amount_total), date:(s.date_order||'').slice(0,10), invoiced:(s.invoice_ids||[]).length>0 }));
      return json({ success:true, count:rows.length, total:r2(rows.reduce((s,r)=>s+r.total,0)), rows });
    }

    if (action === 'razorpay-invoices') {
      // All Odoo customer invoices sourced from Razorpay (ref = 'razorpay:<paymentId>').
      // type: sub if origin is a subscription id (sub_…), else club/other.
      const rows = await odoo.execKw('account.move', 'search_read',
        [[['move_type','=','out_invoice'],['ref','=like','razorpay:%']],
         ['name','invoice_date','partner_id','amount_total','amount_tax','payment_state','state','invoice_origin','ref']],
        { order: 'invoice_date asc, id asc', limit: 1000 });
      const TEST_RE = /test|webhook|sub_(TEST|WHTEST|STATETEST|GST|PREF|DRAFTTEST|KOCHU)/i;
      const map = r => ({ number:r.name, date:r.invoice_date, customer:(r.partner_id&&r.partner_id[1])||'',
        total:r2(r.amount_total), tax:r2(r.amount_tax), paid:r.payment_state, state:r.state,
        isTest: TEST_RE.test(r.invoice_origin||'') || TEST_RE.test((r.partner_id&&r.partner_id[1])||''),
        type:/^sub_/.test(r.invoice_origin||'') ? 'subscription' : 'club', origin:r.invoice_origin, ref:r.ref });
      const all = rows.map(map);
      const subs = all.filter(x => x.type === 'subscription');
      const club = all.filter(x => x.type === 'club');
      return json({ success:true, count: all.length,
        subscriptions: subs, club, subscriptionsTotal: r2(subs.reduce((s,x)=>s+x.total,0)),
        clubTotal: r2(club.reduce((s,x)=>s+x.total,0)) });
    }

    if (action === 'month-close') {
      // Correct monthly P&L + GSTR-1 that NETS OUT reversed sales: an invoice with
      // a posted credit note reversing it (e.g. an edit-reconcile whose credit note
      // is dated in a later month) is excluded, so each sale counts once at its
      // final value. Revenue = surviving invoices' untaxed; COGS/expenses = expense
      // account balances (unaffected by the sales reconcile).
      const invs = await odoo.execKw('account.move', 'search_read',
        [[['move_type','=','out_invoice'],['state','=','posted'],['invoice_date','>=',from],['invoice_date','<=',to]],
         ['id','name','amount_untaxed','amount_tax','amount_total','partner_id']], { limit: 8000 });
      const ids = invs.map(i => i.id);
      const reversed = new Set();
      if (ids.length) {
        const cns = await odoo.execKw('account.move','search_read',
          [[['move_type','=','out_refund'],['state','=','posted'],['reversed_entry_id','in',ids]], ['reversed_entry_id']], { limit: 8000 });
        cns.forEach(c => { if (c.reversed_entry_id) reversed.add(c.reversed_entry_id[0]); });
      }
      const live = invs.filter(i => !reversed.has(i.id));
      const pids = [...new Set(live.map(i => i.partner_id && i.partner_id[0]).filter(Boolean))];
      const partners = pids.length ? await odoo.execKw('res.partner','search_read',[[['id','in',pids]],['id','vat']]) : [];
      const vat = {}; partners.forEach(p => vat[p.id] = p.vat);
      let taxable=0, tax=0, exempt=0, b2b=0, b2c=0;
      for (const i of live) { const t=i.amount_tax||0, u=i.amount_untaxed||0; tax+=t; if (t>0) taxable+=u; else exempt+=u;
        if (vat[i.partner_id && i.partner_id[0]]) b2b+=i.amount_total; else b2c+=i.amount_total; }
      const expAccts = await odoo.execKw('account.account','search_read',
        [[['account_type','in',['expense','expense_direct_cost','expense_depreciation']]], ['id','code','name']]);
      const byId = {}; expAccts.forEach(a => byId[a.id] = a);
      const expGrp = await odoo.execKw('account.move.line','read_group',
        [[['parent_state','=','posted'],['date','>=',from],['date','<=',to],['account_id','in',expAccts.map(a=>a.id)]], ['balance:sum'], ['account_id']]);
      const expenses = expGrp.map(g => ({ code: byId[g.account_id[0]].code, name: byId[g.account_id[0]].name, balance: r2(g.balance) }))
        .filter(x => x.balance !== 0).sort((a,b) => a.code.localeCompare(b.code));
      const revenueNet = r2(live.reduce((s,i) => s + (i.amount_untaxed||0), 0));
      const expenseTotal = r2(expenses.reduce((s,e) => s + e.balance, 0));
      return json({ success:true, from, to,
        gstr1: { invoiceCount: live.length, reversedExcluded: invs.length - live.length,
          taxableValue: r2(taxable), taxAmount: r2(tax), exemptValue: r2(exempt), b2bTotal: r2(b2b), b2cTotal: r2(b2c) },
        pl: { revenueNet, exempt: r2(exempt), taxable: r2(taxable), outputGst: r2(tax),
          expenses, expenseTotal, net: r2(revenueNet - expenseTotal) } });
    }

    return json({ success:false, error:'Unknown action' }, 400);
  } catch (e) { return json({ success:false, error: e.message }, 500); }
};
