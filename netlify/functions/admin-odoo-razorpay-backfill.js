// admin-odoo-razorpay-backfill.js
// Backfill historical Razorpay charges into Odoo as GST tax invoices — the two
// TAXABLE revenue streams (18% GST), unlike books:
//   • Author Book Listing Subscription  (recurring; each renewal = one charge)
//   • Reader Book Club annual membership (one-time ₹99)
// Going forward these are invoiced in real time (razorpay-webhook.js /
// verify-book-club-payment.js). This closes the history from a cutoff date.
//
// Sources:
//   club  → Supabase book_club_members (email, name, payment id, joined_at)
//   sub   → Razorpay Invoices API per subscription_id (each paid invoice = a charge)
// Idempotent: every charge maps to an Odoo invoice ref `razorpay:<paymentId>`, so
// re-running (or a real-time invoice that already fired) is skipped.
//
// POST { adminEmail, adminKey, action, from, charges }
//   action 'scan'  { from:'YYYY-MM-DD' } → read-only: list every charge >= from,
//                    flag which already exist in Odoo.
//   action 'apply' { charges:[...] }     → create the given charges' invoices.
const crypto = require('crypto');
const odoo   = require('./lib/odoo');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const RZP_KEY_ID   = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET   = process.env.RAZORPAY_KEY_SECRET;
const CLUB_AMOUNT_PAISE = 9900;   // ₹99/yr — matches verify-book-club-payment.js

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

const sbHdr = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
const rzpHdr = () => ({ Authorization: 'Basic ' + Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64') });

// All club-membership charges on/after `from` (each row = one ₹99 payment).
async function clubCharges(fromISO) {
  let sel = 'email,name,razorpay_payment_id,razorpay_order_id,joined_at,state';
  let res = await fetch(`${SUPABASE_URL}/rest/v1/book_club_members?select=${sel}&order=joined_at.asc`, { headers: sbHdr });
  if (!res.ok) { sel = 'email,name,razorpay_payment_id,razorpay_order_id,joined_at';
    res = await fetch(`${SUPABASE_URL}/rest/v1/book_club_members?select=${sel}&order=joined_at.asc`, { headers: sbHdr }); }
  const rows = res.ok ? await res.json() : [];
  return rows.filter(m => m.razorpay_payment_id && m.joined_at && m.joined_at >= fromISO).map(m => ({
    type: 'club', email: m.email, name: m.name, stateName: m.state || '',
    amountPaise: CLUB_AMOUNT_PAISE, paymentId: m.razorpay_payment_id,
    originRef: m.razorpay_order_id || '', chargedAt: m.joined_at,
    label: 'Book Club membership',
  }));
}

// All subscription charges on/after `from`: for each Supabase subscription, pull
// its paid Razorpay invoices (one per charge/renewal).
async function subCharges(fromISO) {
  let sel = 'subscription_id,email,plan_name,state';
  let res = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=${sel}`, { headers: sbHdr });
  if (!res.ok) { sel = 'subscription_id,email,plan_name';
    res = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=${sel}`, { headers: sbHdr }); }
  const subs = res.ok ? await res.json() : [];
  const out = [];
  for (const s of subs) {
    if (!s.subscription_id) continue;
    let items = [];
    try {
      const r = await fetch(`https://api.razorpay.com/v1/invoices?subscription_id=${encodeURIComponent(s.subscription_id)}&count=100`, { headers: rzpHdr() });
      if (r.ok) items = (await r.json()).items || [];
    } catch (e) { /* skip this sub on API error */ }
    for (const inv of items) {
      if (inv.status !== 'paid' || !inv.payment_id) continue;
      const paidUnix = inv.paid_at || inv.issued_at || inv.date;
      const chargedAt = paidUnix ? new Date(paidUnix * 1000).toISOString() : null;
      if (!chargedAt || chargedAt.slice(0,10) < fromISO) continue;
      out.push({ type: 'sub', email: s.email, name: null, planName: s.plan_name, stateName: s.state || '',
        amountPaise: inv.amount_paid || inv.amount, paymentId: inv.payment_id,
        originRef: s.subscription_id, chargedAt,
        label: `Subscription${s.plan_name ? ' — ' + s.plan_name : ''}` });
    }
  }
  return out;
}

// Which of these charges already have an Odoo invoice (ref = razorpay:<paymentId>).
async function existingRefs(charges) {
  const refs = charges.map(c => `razorpay:${c.paymentId}`);
  const found = new Set();
  for (let i = 0; i < refs.length; i += 200) {
    const slice = refs.slice(i, i + 200);
    const rows = await odoo.execKw('account.move', 'search_read',
      [[['ref','in',slice],['move_type','=','out_invoice']], ['ref']], { limit: 1000 });
    rows.forEach(m => found.add(m.ref));
  }
  return found;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success:false, error:'Method Not Allowed' }, 405);
  const body = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(body.adminEmail, body.adminKey)) return json({ success:false, error:'Unauthorized' }, 401);
  if (!odoo.isConfigured()) return json({ success:false, error:'Odoo not reachable (ODOO_* / tunnel down)' }, 503);

  try {
    if (body.action === 'scan') {
      if (!RZP_KEY_ID || !RZP_SECRET) return json({ success:false, error:'Razorpay creds missing (RAZORPAY_KEY_ID/SECRET)' }, 503);
      const from = (body.from || '2026-06-01').slice(0, 10);
      const [club, sub] = await Promise.all([clubCharges(from), subCharges(from)]);
      const all = [...sub, ...club].sort((a,b) => (a.chargedAt||'').localeCompare(b.chargedAt||''));
      const done = await existingRefs(all);
      const rows = all.map(c => ({ ...c, month: (c.chargedAt||'').slice(0,7),
        gross: r2(c.amountPaise/100), tax: r2((c.amountPaise/100) - (c.amountPaise/100)/1.18),
        inOdoo: done.has(`razorpay:${c.paymentId}`) }));
      const todo = rows.filter(r => !r.inOdoo);
      const byMonth = {};
      todo.forEach(r => { const m = byMonth[r.month] || (byMonth[r.month] = { month:r.month, count:0, gross:0, tax:0 });
        m.count++; m.gross = r2(m.gross + r.gross); m.tax = r2(m.tax + r.tax); });
      return json({ success:true, from, rows,
        counts: { total: rows.length, alreadyInOdoo: rows.length - todo.length, toCreate: todo.length,
          club: todo.filter(r=>r.type==='club').length, sub: todo.filter(r=>r.type==='sub').length },
        toCreateGross: r2(todo.reduce((s,r)=>s+r.gross,0)), toCreateTax: r2(todo.reduce((s,r)=>s+r.tax,0)),
        months: Object.values(byMonth).sort((a,b)=>a.month.localeCompare(b.month)) });
    }

    if (body.action === 'apply') {
      const charges = Array.isArray(body.charges) ? body.charges : [];
      if (!charges.length) return json({ success:false, error:'No charges in batch' }, 400);
      const results = [];
      for (const c of charges) {
        try {
          const inv = (c.type === 'club')
            ? await odoo.createClubMembershipInvoice({ email:c.email, name:c.name, stateName:c.stateName,
                amountPaise:c.amountPaise, paymentId:c.paymentId, orderId:c.originRef, paidAt:c.chargedAt })
            : await odoo.createSubscriptionInvoice({ email:c.email, name:c.name, planName:c.planName, stateName:c.stateName,
                amountPaise:c.amountPaise, paymentId:c.paymentId, subscriptionId:c.originRef, chargedAt:c.chargedAt });
          results.push({ paymentId:c.paymentId, type:c.type, email:c.email,
            status: inv.created ? 'created' : 'skip', number: inv.number, total: inv.total });
        } catch (e) {
          results.push({ paymentId:c.paymentId, type:c.type, email:c.email, status:'fail', error:e.message });
        }
      }
      return json({ success:true, results });
    }

    if (body.action === 'delete-test-invoices') {
      // Strictly scoped: only CANCELLED Razorpay invoices whose origin/customer looks
      // like test data. Real subscription/club invoices are POSTED, so they're never
      // matched. Reset cancel->draft, then unlink; if unlink is blocked, re-cancel so
      // nothing is left dangling as a live draft.
      const TEST_RE = /test|webhook|sub_(TEST|WHTEST|STATETEST|GST|PREF|DRAFTTEST|KOCHU)/i;
      const invs = await odoo.execKw('account.move', 'search_read',
        [[['move_type','=','out_invoice'],['ref','=like','razorpay:%'],['state','=','cancel']],
         ['id','name','partner_id','invoice_origin']], { limit: 500 });
      const target = invs.filter(i => TEST_RE.test(i.invoice_origin||'') || TEST_RE.test((i.partner_id&&i.partner_id[1])||''));
      const deleted = [], failed = [];
      for (const i of target) {
        try {
          await odoo.execKw('account.move', 'button_draft', [[i.id]]);
          await odoo.execKw('account.move', 'unlink', [[i.id]]);
          deleted.push(i.name);
        } catch (e) {
          try { await odoo.execKw('account.move', 'button_cancel', [[i.id]]); } catch (_) {}
          failed.push({ name: i.name, error: e.message });
        }
      }
      return json({ success:true, candidates: target.length, deletedCount: deleted.length, deleted, failed });
    }

    return json({ success:false, error:'Unknown action' }, 400);
  } catch (e) { return json({ success:false, error:e.message }, 500); }
};
