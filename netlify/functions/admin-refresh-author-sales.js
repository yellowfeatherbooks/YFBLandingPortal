// admin-refresh-author-sales.js — the Odoo → Supabase leg of the pipeline.
// Reads all shop sales from Odoo (client_order_ref mbb:/sales:) for a date range,
// tags each book to its author via Shopify submittedby:{email} product tags, and
// (re)writes them into Supabase `direct_sales` (source='odoo') — the attribution
// layer behind the Sales-by-Author / Total Sales dashboards.
// POST { adminEmail, adminKey, from, to, dryRun }
const crypto = require('crypto');
const odoo   = require('./lib/odoo');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const SHOP_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SF_TOKEN     = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';
const API = '2024-01';

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const json = (b, s=200) => ({ statusCode: s, headers: { ...cors, 'Content-Type':'application/json' }, body: JSON.stringify(b) });
const _COMBINING = new RegExp('[\\u0300-\\u036f]','g');
const norm = s => (s||'').normalize('NFKD').replace(_COMBINING,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const r2 = n => Math.round((Number(n)||0)*100)/100;

async function verifyAdmin(email, adminKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  return crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex') === adminKey;
}
async function shopifySF(query) {
  const r = await fetch(`https://${SHOP_DOMAIN}/api/${API}/graphql.json`,
    { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Shopify-Storefront-Access-Token': SF_TOKEN }, body: JSON.stringify({ query }) });
  const d = await r.json(); if (d.errors) throw new Error('Shopify: '+JSON.stringify(d.errors)); return d.data;
}
async function sb(method, path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method,
    headers:{ apikey:SUPABASE_SVC, Authorization:`Bearer ${SUPABASE_SVC}`, 'Content-Type':'application/json', Prefer:'return=minimal' },
    body: body!=null ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Supabase ${method} ${r.status}: ${(await r.text()).slice(0,180)}`);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success:false, error:'Method Not Allowed' }, 405);
  const { adminEmail, adminKey, from, to, dryRun=false } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success:false, error:'Unauthorized' }, 401);
  if (!from || !to) return json({ success:false, error:'from and to dates required' });
  if (!odoo.isConfigured()) return json({ success:false, error:'Odoo not reachable (tunnel down)' }, 503);
  try {
    // 1) author map from Shopify submittedby: tags
    const title2author = {}, sku2author = {}; let cursor=null, linked=0;
    for (let guard=0; guard<40; guard++) {
      const after = cursor ? `, after:"${cursor}"` : '';
      const d = await shopifySF(`{ products(first:250${after}){ pageInfo{hasNextPage} edges{ cursor node{ title tags variants(first:1){edges{node{sku}}} } } } }`);
      const edges = d.products.edges;
      for (const e of edges) {
        const tag = (e.node.tags||[]).find(t => t.toLowerCase().startsWith('submittedby:'));
        if (!tag) continue;
        const email = tag.split(':').slice(1).join(':').trim().toLowerCase(); linked++;
        if (e.node.title && !(norm(e.node.title) in title2author)) title2author[norm(e.node.title)] = email;
        const v = e.node.variants.edges[0];
        if (v && v.node.sku && !(v.node.sku.trim() in sku2author)) sku2author[v.node.sku.trim()] = email;
      }
      if (edges.length) cursor = edges[edges.length-1].cursor;
      if (!d.products.pageInfo.hasNextPage) break;
    }

    // 2) Odoo shop sales in range (batched)
    const sos = await odoo.execKw('sale.order','search_read',
      [['|',['client_order_ref','=like','sales:%'],['client_order_ref','=like','mbb:%']], ['id','client_order_ref','date_order','invoice_ids','partner_id','state']], { limit: 10000 });
    const inRangeAll = sos.filter(s => { const d=(s.date_order||'').slice(0,10); return d>=from && d<=to; });

    // Exclude cancelled-state SOs and any whose invoice has been reversed by a
    // posted credit note (e.g. a MyBillBook cancellation reconciled after the
    // fact) — those sales never really happened and shouldn't feed the author
    // attribution / Total Sales dashboards, regardless of what date_order says.
    const candInvIds = [...new Set(inRangeAll.flatMap(s=>s.invoice_ids||[]))];
    const reversedInvIds = new Set();
    if (candInvIds.length) {
      const cns = await odoo.execKw('account.move','search_read',
        [[['move_type','=','out_refund'],['state','=','posted'],['reversed_entry_id','in',candInvIds]], ['reversed_entry_id']], { limit: 20000 });
      cns.forEach(c => { if (c.reversed_entry_id) reversedInvIds.add(c.reversed_entry_id[0]); });
    }
    const inRange = inRangeAll.filter(s => s.state !== 'cancel' && !(s.invoice_ids||[]).some(id => reversedInvIds.has(id)));
    const soById = {}; inRange.forEach(s => soById[s.id]=s);
    const invIds = [...new Set(inRange.flatMap(s=>s.invoice_ids||[]))];
    const payById = {};
    if (invIds.length) (await odoo.execKw('account.move','search_read',[[['id','in',invIds]],['id','payment_state']])).forEach(i=>payById[i.id]=i.payment_state);
    const soIds = inRange.map(s=>s.id);
    const lines = soIds.length ? await odoo.execKw('sale.order.line','search_read',
      [[['order_id','in',soIds],['product_id','!=',false]], ['name','product_uom_qty','price_subtotal','product_id','order_id']], { limit: 20000 }) : [];
    const prodIds = [...new Set(lines.map(l=>l.product_id[0]))];
    const prodById = {};
    if (prodIds.length) (await odoo.execKw('product.product','search_read',[[['id','in',prodIds]],['id','default_code','type']])).forEach(p=>prodById[p.id]=p);

    const rows = [];
    for (const l of lines) {
      const prod = prodById[l.product_id[0]]; if (!prod || prod.type!=='product') continue; // skip delivery/discount
      const s = soById[l.order_id[0]]; if (!s) continue;
      const d = (s.date_order||'').slice(0,10);
      const yfb = s.client_order_ref.split(':').slice(1).join(':');
      const pstate = payById[(s.invoice_ids||[])[0]] || '';
      const paid = pstate==='paid' ? 'paid' : (pstate==='partial' ? 'partial' : 'unpaid');
      const customer = s.partner_id ? s.partner_id[1] : '';
      const sku = prod.default_code || '';
      const author = sku2author[sku] || title2author[norm(l.name)] || '';
      rows.push({ author_email: author, book_title: l.name, quantity: Math.round(l.product_uom_qty),
        amount: r2(l.price_subtotal), sale_date: d, order_number: yfb, payment_status: paid,
        sku, source: 'odoo', notes: customer ? ('Customer: '+customer) : 'Imported from Odoo' });
    }
    const attributed = rows.filter(r=>r.author_email);
    const authors = [...new Set(attributed.map(r=>r.author_email))];
    const summary = { from, to, linkedProducts: linked, orders: inRange.length, rowCount: rows.length,
      attributedRows: attributed.length, authors: authors.length, totalAmount: r2(rows.reduce((s,r)=>s+r.amount,0)) };

    if (dryRun) return json({ success:true, dryRun:true, ...summary });

    await sb('DELETE', `direct_sales?source=eq.odoo&sale_date=gte.${from}&sale_date=lte.${to}`);
    for (let i=0; i<rows.length; i+=200) await sb('POST', 'direct_sales', rows.slice(i, i+200));
    return json({ success:true, applied:true, ...summary });
  } catch (e) { return json({ success:false, error: e.message }, 500); }
};
