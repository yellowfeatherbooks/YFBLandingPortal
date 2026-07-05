// admin-razorpay-payments.js — read-only Razorpay payments ledger for the admin
// portal, split three ways:
//   subscriptions — payment has an invoice_id (each sub charge auto-invoices)
//   club          — payment/order matches a Supabase book_club_members row
//   other         — everything else = book-purchase (native app checkout) etc.
//
// POST { adminEmail, adminKey, action:'list', from:'YYYY-MM-DD', to:'YYYY-MM-DD' }
//
// NOTE: reads live data only where LIVE Razorpay keys exist for the deploy context
// (production). On the gst-test/deploy-preview context the keys are test-mode.
const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const RZP_KEY_ID   = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET   = process.env.RAZORPAY_KEY_SECRET;

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

const sbHdr  = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
const rzpHdr = { Authorization: 'Basic ' + Buffer.from(`${RZP_KEY_ID}:${RZP_SECRET}`).toString('base64') };
const mode = (RZP_KEY_ID || '').startsWith('rzp_live') ? 'live' : (RZP_KEY_ID || '').startsWith('rzp_test') ? 'test' : 'unknown';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success:false, error:'Method Not Allowed' }, 405);
  const body = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(body.adminEmail, body.adminKey)) return json({ success:false, error:'Unauthorized' }, 401);
  if (!RZP_KEY_ID || !RZP_SECRET) return json({ success:false, error:'Razorpay creds missing' }, 503);

  if (body.action !== 'list') return json({ success:false, error:'Unknown action' }, 400);
  const from = (body.from || '2026-06-01').slice(0,10);
  const to   = (body.to   || new Date().toISOString().slice(0,10)).slice(0,10);
  const fromUnix = Math.floor(Date.parse(from + 'T00:00:00Z') / 1000);
  const toUnix   = Math.floor(Date.parse(to   + 'T23:59:59Z') / 1000);

  try {
    // Club lookup: payment_id + order_id → member (name/email) from Supabase.
    let cr = await fetch(`${SUPABASE_URL}/rest/v1/book_club_members?select=email,name,razorpay_payment_id,razorpay_order_id`, { headers: sbHdr });
    const club = cr.ok ? await cr.json() : [];
    const clubByPay = {}, clubByOrder = {};
    club.forEach(m => { if (m.razorpay_payment_id) clubByPay[m.razorpay_payment_id] = m; if (m.razorpay_order_id) clubByOrder[m.razorpay_order_id] = m; });
    // Subscription plan by email (best-effort enrichment).
    let sr = await fetch(`${SUPABASE_URL}/rest/v1/subscriptions?select=email,plan_name`, { headers: sbHdr });
    const subsRows = sr.ok ? await sr.json() : [];
    const planByEmail = {}; subsRows.forEach(s => { if (s.email) planByEmail[s.email.toLowerCase()] = s.plan_name; });

    // Page through Razorpay payments in the window.
    const payments = [];
    for (let skip = 0; skip < 2000; skip += 100) {
      const r = await fetch(`https://api.razorpay.com/v1/payments?from=${fromUnix}&to=${toUnix}&count=100&skip=${skip}`, { headers: rzpHdr });
      if (!r.ok) break;
      const items = (await r.json()).items || [];
      payments.push(...items);
      if (items.length < 100) break;
    }

    const subscriptions = [], clubPays = [], other = [];
    for (const p of payments) {
      if (p.status !== 'captured') continue;              // successful only
      const row = { paymentId: p.id, amount: r2(p.amount/100), email: p.email || '', contact: p.contact || '',
        method: p.method || '', orderId: p.order_id || '', date: new Date(p.created_at*1000).toISOString(),
        description: p.description || '' };
      if (p.invoice_id) {
        row.plan = planByEmail[(p.email||'').toLowerCase()] || '';
        subscriptions.push(row);
      } else if (clubByPay[p.id] || clubByOrder[p.order_id]) {
        const m = clubByPay[p.id] || clubByOrder[p.order_id];
        row.name = m.name || ''; if (!row.email) row.email = m.email || '';
        clubPays.push(row);
      } else {
        other.push(row);
      }
    }
    const sum = a => r2(a.reduce((s,r)=>s+r.amount,0));
    const sortDesc = a => a.sort((x,y)=>y.date.localeCompare(x.date));
    return json({ success:true, from, to, mode,
      subscriptions: sortDesc(subscriptions), club: sortDesc(clubPays), other: sortDesc(other),
      totals: { subscriptions: sum(subscriptions), club: sum(clubPays), other: sum(other),
        all: r2(sum(subscriptions)+sum(clubPays)+sum(other)),
        count: subscriptions.length + clubPays.length + other.length } });
  } catch (e) { return json({ success:false, error:e.message }, 500); }
};
