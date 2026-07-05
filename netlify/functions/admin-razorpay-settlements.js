// admin-razorpay-settlements.js — Razorpay settlement history for the admin portal.
// Razorpay settles captured payments to the bank in BATCHES (net of fees + tax),
// not order-by-order. Each settlement = one bank transfer with a UTR reference.
// This lists them so the admin can see exactly how much hit the bank and when.
//
// POST { adminEmail, adminKey, action:'list', from:'YYYY-MM-DD', to:'YYYY-MM-DD' }
//
// NOTE: live data only where LIVE Razorpay keys exist for the deploy context.
const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
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
    const items = [];
    for (let skip = 0; skip < 2000; skip += 100) {
      const r = await fetch(`https://api.razorpay.com/v1/settlements?from=${fromUnix}&to=${toUnix}&count=100&skip=${skip}`, { headers: rzpHdr });
      if (!r.ok) { if (skip === 0) return json({ success:false, error:`Razorpay settlements HTTP ${r.status}`, mode }); break; }
      const page = (await r.json()).items || [];
      items.push(...page);
      if (page.length < 100) break;
    }
    // amount = NET credited to bank (paise); fees + tax were deducted from gross.
    const rows = items.map(s => ({
      id: s.id, status: s.status, utr: s.utr || '',
      date: new Date(s.created_at * 1000).toISOString(),
      toBank: r2((s.amount||0)/100),
      fees:   r2((s.fees||0)/100),
      tax:    r2((s.tax||0)/100),
      gross:  r2(((s.amount||0)+(s.fees||0)+(s.tax||0))/100),
    })).sort((a,b) => b.date.localeCompare(a.date));
    const sum = k => r2(rows.reduce((s,r)=>s+r[k],0));
    return json({ success:true, from, to, mode, count: rows.length, rows,
      totals: { toBank: sum('toBank'), fees: sum('fees'), tax: sum('tax'), gross: sum('gross') } });
  } catch (e) { return json({ success:false, error: e.message }, 500); }
};
