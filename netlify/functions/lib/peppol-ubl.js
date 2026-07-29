// lib/peppol-ubl.js
// Converts an invoice into a Peppol BIS Billing 3.0 UBL 2.1 XML document.
//
// Scope (2026-07-29): OUTBOUND only — YFB invoicing UAE customers. This module
// only BUILDS the XML document; it does not send anything anywhere. Sending
// requires a registered Peppol Participant ID (via an Access Point such as
// Flick, docs.flick.network) — see mapOdooInvoiceToUbl()'s opts for the pieces
// Odoo doesn't hold today.
//
// Standard used: Peppol BIS Billing 3.0 (the international baseline). The UAE's
// e-invoicing mandate (5-corner model, phased from Jul 2026) actually runs on
// "PINT AE", a UAE-localized profile layered on top of the same PINT/BIS-3.0
// UBL model — swap PEPPOL_CUSTOMIZATION_ID/PEPPOL_PROFILE_ID below once the
// Access Point confirms PINT AE's exact identifiers; the XML shape (parties,
// lines, tax totals) does not change.
//
// No third-party deps — plain string templating (matches lib/odoo.js's style).

const CUSTOMIZATION_ID = process.env.PEPPOL_CUSTOMIZATION_ID
  || 'urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0';
const PROFILE_ID = process.env.PEPPOL_PROFILE_ID
  || 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

const INVOICE_TYPE_CODE = 380; // Commercial invoice (UNCL1001)
const DEFAULT_UNIT_CODE = 'EA'; // UN/ECE Rec 20 — "each"
const VAT_SCHEME_ID = 'VAT';

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function money(n) { return round2(n).toFixed(2); }

function requireField(obj, path) {
  const val = path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  if (val === undefined || val === null || val === '') {
    throw new Error(`buildInvoiceUBL: missing required field "${path}"`);
  }
  return val;
}

function partyXml(tag, party, currency) {
  const endpoint = party.endpointId && party.endpointId.id
    ? `<cbc:EndpointID schemeID="${escapeXml(party.endpointId.scheme)}">${escapeXml(party.endpointId.id)}</cbc:EndpointID>`
    : '';
  const taxScheme = party.companyId && party.companyId.id
    ? `<cac:PartyTaxScheme><cbc:CompanyID>${escapeXml(party.companyId.id)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>${escapeXml(party.companyId.scheme || VAT_SCHEME_ID)}</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>`
    : '';
  const contact = (party.contactEmail || party.contactPhone)
    ? `<cac:Contact>${party.contactPhone ? `<cbc:Telephone>${escapeXml(party.contactPhone)}</cbc:Telephone>` : ''}${party.contactEmail ? `<cbc:ElectronicMail>${escapeXml(party.contactEmail)}</cbc:ElectronicMail>` : ''}</cac:Contact>`
    : '';
  return `
  <cac:${tag}>
    <cac:Party>
      ${endpoint}
      <cac:PostalAddress>
        <cbc:StreetName>${escapeXml(party.streetName)}</cbc:StreetName>
        <cbc:CityName>${escapeXml(party.city)}</cbc:CityName>
        ${party.postalZone ? `<cbc:PostalZone>${escapeXml(party.postalZone)}</cbc:PostalZone>` : ''}
        <cac:Country><cbc:IdentificationCode>${escapeXml(party.countryCode)}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      ${taxScheme}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(party.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      ${contact}
    </cac:Party>
  </cac:${tag}>`;
}

// Groups invoice lines by (taxCategoryCode, taxPercent) into UBL TaxSubtotal blocks
// and returns { taxTotalAmount, subtotalsXml, taxTotalXml }.
function buildTaxTotal(lines, currency) {
  const groups = new Map();
  for (const l of lines) {
    const code = l.taxCategoryCode || 'E';
    const pct = Number(l.taxPercent) || 0;
    const key = `${code}:${pct}`;
    const g = groups.get(key) || { code, pct, taxable: 0, tax: 0 };
    const taxable = round2(l.lineExtensionAmount);
    g.taxable = round2(g.taxable + taxable);
    g.tax = round2(g.tax + round2(taxable * pct / 100));
    groups.set(key, g);
  }
  let taxTotalAmount = 0;
  const subtotalsXml = [...groups.values()].map(g => {
    taxTotalAmount = round2(taxTotalAmount + g.tax);
    return `
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${currency}">${money(g.taxable)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${currency}">${money(g.tax)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${escapeXml(g.code)}</cbc:ID>
        <cbc:Percent>${g.pct}</cbc:Percent>
        ${g.code === 'E' || g.code === 'O' || g.code === 'G' ? '<cbc:TaxExemptionReason>Not subject to VAT — cross-border export supply</cbc:TaxExemptionReason>' : ''}
        <cac:TaxScheme><cbc:ID>${VAT_SCHEME_ID}</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
  }).join('');
  return { taxTotalAmount, subtotalsXml };
}

// inv = {
//   id, issueDate, dueDate?, currencyCode, note?, buyerReference?, orderReference?,
//   seller: { name, endpointId?:{scheme,id}, streetName, city, postalZone?, countryCode,
//             companyId?:{scheme,id}, contactEmail?, contactPhone? },
//   buyer:  { same shape as seller },
//   lines: [{ id?, name, quantity, unitCode?, unitPrice, lineExtensionAmount,
//             taxCategoryCode?, taxPercent? }],   // categoryCode per UNCL5305: S/Z/E/AE/G/O...
// }
// Returns { xml, warnings } — warnings flag anything that won't stop XML generation
// but WILL stop real Peppol transmission (e.g. no registered Participant ID yet).
function buildInvoiceUBL(inv) {
  requireField(inv, 'id');
  requireField(inv, 'issueDate');
  requireField(inv, 'currencyCode');
  requireField(inv, 'seller.name');
  requireField(inv, 'seller.streetName');
  requireField(inv, 'seller.city');
  requireField(inv, 'seller.countryCode');
  requireField(inv, 'buyer.name');
  requireField(inv, 'buyer.streetName');
  requireField(inv, 'buyer.city');
  requireField(inv, 'buyer.countryCode');
  if (!Array.isArray(inv.lines) || !inv.lines.length) {
    throw new Error('buildInvoiceUBL: at least one invoice line is required');
  }

  const currency = inv.currencyCode;
  const warnings = [];
  if (!inv.seller.endpointId || !inv.seller.endpointId.id) {
    warnings.push('seller.endpointId not set — YFB has no registered Peppol Participant ID yet; this document cannot be transmitted until one exists (see Flick onboarding).');
  }
  if (!inv.buyer.endpointId || !inv.buyer.endpointId.id) {
    warnings.push('buyer.endpointId not set — look up the recipient\'s Peppol Participant ID (via the Access Point\'s directory) before sending.');
  }

  const lines = inv.lines.map((l, i) => ({
    id: l.id || String(i + 1),
    name: l.name || 'Item',
    quantity: Number(l.quantity) || 1,
    unitCode: l.unitCode || DEFAULT_UNIT_CODE,
    unitPrice: round2(l.unitPrice != null ? l.unitPrice : (l.lineExtensionAmount / (Number(l.quantity) || 1))),
    lineExtensionAmount: round2(l.lineExtensionAmount != null ? l.lineExtensionAmount : (Number(l.unitPrice) || 0) * (Number(l.quantity) || 1)),
    taxCategoryCode: l.taxCategoryCode || 'E',
    taxPercent: Number(l.taxPercent) || 0,
  }));

  const lineExtensionTotal = round2(lines.reduce((s, l) => s + l.lineExtensionAmount, 0));
  const { taxTotalAmount, subtotalsXml } = buildTaxTotal(lines, currency);
  const taxExclusive = lineExtensionTotal;
  const taxInclusive = round2(taxExclusive + taxTotalAmount);

  const linesXml = lines.map(l => `
  <cac:InvoiceLine>
    <cbc:ID>${escapeXml(l.id)}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${escapeXml(l.unitCode)}">${l.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${currency}">${money(l.lineExtensionAmount)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${escapeXml(l.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${escapeXml(l.taxCategoryCode)}</cbc:ID>
        <cbc:Percent>${l.taxPercent}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>${VAT_SCHEME_ID}</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${currency}">${money(l.unitPrice)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>${escapeXml(CUSTOMIZATION_ID)}</cbc:CustomizationID>
  <cbc:ProfileID>${escapeXml(PROFILE_ID)}</cbc:ProfileID>
  <cbc:ID>${escapeXml(inv.id)}</cbc:ID>
  <cbc:IssueDate>${escapeXml(inv.issueDate)}</cbc:IssueDate>
  ${inv.dueDate ? `<cbc:DueDate>${escapeXml(inv.dueDate)}</cbc:DueDate>` : ''}
  <cbc:InvoiceTypeCode>${INVOICE_TYPE_CODE}</cbc:InvoiceTypeCode>
  ${inv.note ? `<cbc:Note>${escapeXml(inv.note)}</cbc:Note>` : ''}
  <cbc:DocumentCurrencyCode>${escapeXml(currency)}</cbc:DocumentCurrencyCode>
  ${inv.buyerReference ? `<cbc:BuyerReference>${escapeXml(inv.buyerReference)}</cbc:BuyerReference>` : ''}
  ${inv.orderReference ? `<cac:OrderReference><cbc:ID>${escapeXml(inv.orderReference)}</cbc:ID></cac:OrderReference>` : ''}
  ${partyXml('AccountingSupplierParty', inv.seller, currency)}
  ${partyXml('AccountingCustomerParty', inv.buyer, currency)}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${money(taxTotalAmount)}</cbc:TaxAmount>${subtotalsXml}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${money(lineExtensionTotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${money(taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${money(taxInclusive)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${money(taxInclusive)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${linesXml}
</Invoice>
`;

  return { xml, warnings };
}

// ── Odoo invoice -> canonical inv object -> UBL ─────────────────────────────
// Odoo (account.move) doesn't hold Peppol Participant IDs or a UAE TRN today,
// so those come in via opts (or env defaults for YFB's own seller identity,
// once registered with the Access Point).
//
// opts = {
//   sellerEndpointScheme, sellerEndpointId,   // YFB's own Peppol Participant ID
//   buyerEndpointScheme,  buyerEndpointId,    // looked up per customer before sending
//   buyerTRN,                                  // UAE Tax Registration Number, if VAT-registered
//   buyerCountryCode = 'AE',
//   currencyCode,                              // overrides the invoice's Odoo currency if needed
// }
async function mapOdooInvoiceToUbl(invoiceId, opts = {}) {
  const odoo = require('./odoo');
  const move = await odoo.findOne('account.move', [['id', '=', invoiceId]],
    ['name', 'move_type', 'invoice_date', 'invoice_date_due', 'currency_id',
     'partner_id', 'ref', 'invoice_origin', 'narration']);
  if (!move) throw new Error(`Odoo invoice ${invoiceId} not found`);
  if (move.move_type !== 'out_invoice') throw new Error(`Odoo record ${invoiceId} is not a customer invoice`);

  const [company, partner] = await Promise.all([
    odoo.findOne('res.company', [['id', '=', 1]],
      ['name', 'street', 'street2', 'city', 'zip', 'country_id', 'vat', 'email', 'phone']),
    odoo.findOne('res.partner', [['id', '=', move.partner_id[0]]],
      ['name', 'street', 'street2', 'city', 'zip', 'country_id', 'vat', 'email', 'phone']),
  ]);

  const countryCode = async countryTuple => {
    if (!countryTuple) return null;
    const c = await odoo.findOne('res.country', [['id', '=', countryTuple[0]]], ['code']);
    return c ? c.code : null;
  };
  const [sellerCountry, buyerCountry] = await Promise.all([
    countryCode(company.country_id),
    countryCode(partner.country_id),
  ]);

  // Real invoice lines have a product_id; section/note/payment-term lines don't.
  // (display_type's "no line" sentinel varies across Odoo versions — this instance
  // uses the string 'product' for real lines rather than false — so filtering on
  // product_id presence is the portable way to select them.)
  const lineRows = await odoo.execKw('account.move.line', 'search_read',
    [[['move_id', '=', invoiceId], ['product_id', '!=', false]]],
    { fields: ['name', 'quantity', 'price_unit', 'price_subtotal', 'tax_ids'] });

  const taxIds = [...new Set(lineRows.flatMap(l => l.tax_ids || []))];
  const taxes = taxIds.length
    ? await odoo.execKw('account.tax', 'search_read', [[['id', 'in', taxIds]]], { fields: ['name', 'amount'] })
    : [];
  const taxById = new Map(taxes.map(t => [t.id, t]));

  const lines = lineRows.map(l => {
    const tax = (l.tax_ids || []).map(id => taxById.get(id)).find(Boolean);
    const pct = tax ? Number(tax.amount) : 0;
    return {
      name: l.name,
      quantity: l.quantity,
      lineExtensionAmount: l.price_subtotal,
      unitPrice: l.quantity ? l.price_subtotal / l.quantity : l.price_subtotal,
      taxPercent: pct,
      taxCategoryCode: pct > 0 ? 'S' : 'E',
    };
  });

  const currency = opts.currencyCode
    || (move.currency_id && (await odoo.findOne('res.currency', [['id', '=', move.currency_id[0]]], ['name'])).name)
    || 'AED';

  const inv = {
    id: move.name,
    issueDate: move.invoice_date,
    dueDate: move.invoice_date_due || undefined,
    currencyCode: currency,
    note: move.narration || undefined,
    orderReference: move.invoice_origin || undefined,
    seller: {
      name: company.name,
      endpointId: (opts.sellerEndpointScheme && opts.sellerEndpointId) ? { scheme: opts.sellerEndpointScheme, id: opts.sellerEndpointId }
        : (process.env.PEPPOL_SELLER_SCHEME && process.env.PEPPOL_SELLER_ID) ? { scheme: process.env.PEPPOL_SELLER_SCHEME, id: process.env.PEPPOL_SELLER_ID }
        : undefined,
      streetName: [company.street, company.street2].filter(Boolean).join(', '),
      city: company.city,
      postalZone: company.zip,
      countryCode: sellerCountry || 'IN',
      companyId: company.vat ? { scheme: 'GSTIN', id: company.vat } : undefined,
      contactEmail: company.email,
      contactPhone: company.phone,
    },
    buyer: {
      name: partner.name,
      endpointId: (opts.buyerEndpointScheme && opts.buyerEndpointId) ? { scheme: opts.buyerEndpointScheme, id: opts.buyerEndpointId } : undefined,
      streetName: [partner.street, partner.street2].filter(Boolean).join(', '),
      city: partner.city,
      postalZone: partner.zip,
      // No AE-specific default here — this converts ANY posted invoice (most are
      // domestic). Falls back to the partner's own Odoo country; if that's unset
      // too, buildInvoiceUBL throws a clear "missing buyer.countryCode" error
      // rather than silently mislabeling the customer's country.
      countryCode: opts.buyerCountryCode || buyerCountry || undefined,
      companyId: (opts.buyerTRN || partner.vat) ? { scheme: 'TRN', id: opts.buyerTRN || partner.vat } : undefined,
      contactEmail: partner.email,
    },
    lines,
  };

  return buildInvoiceUBL(inv);
}

module.exports = { buildInvoiceUBL, mapOdooInvoiceToUbl, escapeXml };
