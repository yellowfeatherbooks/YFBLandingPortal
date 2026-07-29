// admin-peppol-export.js
// Admin-only: browse posted Odoo customer invoices. Three things you can do
// with any one invoice: (1) download a Peppol BIS Billing 3.0 UBL XML — see
// lib/peppol-ubl.js (no Peppol Participant ID registered yet, so this is
// download-only, nothing is transmitted); (2) download the NORMAL human-
// readable Odoo invoice PDF; (3) email that same PDF to the customer — to
// their captured Odoo email if there is one, otherwise to an address the
// admin types in.
//
// POST { adminEmail, adminKey, action, ... }
//   action 'list'     { from, to }        -> { rows:[ {id,number,date,customer,email,country,total,currency} ] }
//   action 'generate' { invoiceId, sellerEndpointScheme?, sellerEndpointId?,
//                        buyerEndpointScheme?, buyerEndpointId?, buyerTRN?,
//                        buyerCountryCode?, currencyCode? }
//                                          -> { xml, filename, warnings }
//   action 'pdf'      { invoiceId }        -> { pdfBase64, filename }
//   action 'email'    { invoiceId, toEmail? }
//                                          -> { to } — sends the PDF via the
//                                             N8N_INVOICE_EMAIL_URL webhook (see
//                                             n8n-invoice-email-workflow.json)

const crypto    = require('crypto');
const odoo      = require('./lib/odoo');
const peppolUbl = require('./lib/peppol-ubl');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

async function verifyAdmin(email, adminKey) {
  if (!email || !adminKey) return false;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  return crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex') === adminKey;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);
  const body = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(body.adminEmail, body.adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!odoo.isConfigured()) return json({ success: false, error: 'Odoo not reachable (ODOO_* / tunnel down)' }, 503);
  const { action } = body;

  try {
    if (action === 'list') {
      const { from = '2026-01-01', to = '2099-12-31' } = body;
      const invs = await odoo.execKw('account.move', 'search_read',
        [[['move_type', '=', 'out_invoice'], ['state', '=', 'posted'],
          ['invoice_date', '>=', from], ['invoice_date', '<=', to]],
         ['name', 'invoice_date', 'partner_id', 'amount_total', 'currency_id']],
        { order: 'invoice_date desc, id desc', limit: 2000 });

      const pids = [...new Set(invs.map(i => i.partner_id && i.partner_id[0]).filter(Boolean))];
      const partners = pids.length
        ? await odoo.execKw('res.partner', 'search_read', [[['id', 'in', pids]]], { fields: ['id', 'country_id', 'email'] })
        : [];
      const cids = [...new Set(partners.map(p => p.country_id && p.country_id[0]).filter(Boolean))];
      const countries = cids.length
        ? await odoo.execKw('res.country', 'search_read', [[['id', 'in', cids]]], { fields: ['id', 'code'] })
        : [];
      const codeByCountryId = {}; countries.forEach(c => { codeByCountryId[c.id] = c.code; });
      const countryByPartnerId = {}, emailByPartnerId = {};
      partners.forEach(p => {
        countryByPartnerId[p.id] = p.country_id ? (codeByCountryId[p.country_id[0]] || '') : '';
        emailByPartnerId[p.id] = p.email || '';
      });

      const rows = invs.map(i => ({
        id: i.id,
        number: i.name,
        date: i.invoice_date,
        customer: (i.partner_id && i.partner_id[1]) || '',
        email: (i.partner_id && emailByPartnerId[i.partner_id[0]]) || '',
        country: (i.partner_id && countryByPartnerId[i.partner_id[0]]) || '',
        total: r2(i.amount_total),
        currency: (i.currency_id && i.currency_id[1]) || 'INR',
      }));
      return json({ success: true, from, to, count: rows.length, rows });
    }

    if (action === 'generate') {
      const invoiceId = Number(body.invoiceId);
      if (!invoiceId) return json({ success: false, error: 'invoiceId required' });
      const { xml, warnings } = await peppolUbl.mapOdooInvoiceToUbl(invoiceId, {
        sellerEndpointScheme: body.sellerEndpointScheme,
        sellerEndpointId: body.sellerEndpointId,
        buyerEndpointScheme: body.buyerEndpointScheme,
        buyerEndpointId: body.buyerEndpointId,
        buyerTRN: body.buyerTRN,
        buyerCountryCode: body.buyerCountryCode,
        currencyCode: body.currencyCode,
      });
      const inv = await odoo.findOne('account.move', [['id', '=', invoiceId]], ['name']);
      const filename = `peppol-${(inv && inv.name || 'invoice').replace(/[\/\\]/g, '-')}.xml`;
      return json({ success: true, xml, filename, warnings });
    }

    if (action === 'pdf') {
      const invoiceId = Number(body.invoiceId);
      if (!invoiceId) return json({ success: false, error: 'invoiceId required' });
      const inv = await odoo.findOne('account.move',
        [['id', '=', invoiceId], ['move_type', '=', 'out_invoice']], ['name']);
      if (!inv) return json({ success: false, error: 'Invoice not found' });
      const pdfBase64 = await odoo.getInvoicePdfBase64(invoiceId);
      const filename = `${inv.name.replace(/[\/\\]/g, '-')}.pdf`;
      return json({ success: true, pdfBase64, filename });
    }

    if (action === 'email') {
      const invoiceId = Number(body.invoiceId);
      if (!invoiceId) return json({ success: false, error: 'invoiceId required' });
      const inv = await odoo.findOne('account.move',
        [['id', '=', invoiceId], ['move_type', '=', 'out_invoice']], ['name', 'partner_id']);
      if (!inv) return json({ success: false, error: 'Invoice not found' });

      let toEmail = (body.toEmail || '').trim();
      let toName = '';
      if (inv.partner_id) {
        const partner = await odoo.findOne('res.partner', [['id', '=', inv.partner_id[0]]], ['name', 'email']);
        toName = (partner && partner.name) || (inv.partner_id[1] || '');
        if (!toEmail) toEmail = (partner && partner.email) || '';
      }
      if (!toEmail) return json({ success: false, error: 'No email on file for this customer — enter one to send to' });
      if (!EMAIL_RE.test(toEmail)) return json({ success: false, error: `"${toEmail}" doesn't look like a valid email address` });

      const webhookUrl = process.env.N8N_INVOICE_EMAIL_URL;
      if (!webhookUrl) return json({ success: false, error: 'N8N_INVOICE_EMAIL_URL not configured — import n8n-invoice-email-workflow.json and set the env var' }, 503);

      const pdfBase64 = await odoo.getInvoicePdfBase64(invoiceId);
      const n8nRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toEmail, toName, invoiceNumber: inv.name,
          pdfBase64, filename: `${inv.name.replace(/[\/\\]/g, '-')}.pdf`,
        })
      });
      if (!n8nRes.ok) {
        const errText = await n8nRes.text().catch(() => '');
        return json({ success: false, error: `n8n returned ${n8nRes.status}: ${errText}` });
      }
      return json({ success: true, to: toEmail });
    }

    return json({ success: false, error: 'Unknown action' }, 400);
  } catch (e) { return json({ success: false, error: e.message }, 500); }
};
