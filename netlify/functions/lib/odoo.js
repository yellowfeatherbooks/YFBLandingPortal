// lib/odoo.js
// Minimal Odoo External API (JSON-RPC) client + a helper that turns a Razorpay
// subscription charge into a GST-compliant tax invoice in Odoo.
//
// Why this exists: YFB books are GST-exempt, but the author listing SUBSCRIPTION
// is a taxable service (SAC 9984, 18% GST). Razorpay charges it; nothing recorded
// the GST. This closes that gap by raising the Odoo invoice on subscription.charged.
//
// No third-party deps — uses global fetch (Node 18+ / Netlify).
//
// Env:
//   ODOO_URL                e.g. https://yfb.odoo.com   (absent -> caller should skip)
//   ODOO_DB                 database name (e.g. yfb-odoo)
//   ODOO_USERNAME           login email of an Odoo user with invoicing rights
//   ODOO_PASSWORD           that user's password OR an Odoo API key
// Optional overrides (sensible defaults match the YFB l10n_in setup):
//   ODOO_SUBSCRIPTION_SKU   default 'SUB-LISTING'
//   ODOO_COMPANY_STATE      default 'Kerala'  (home state for intra/inter GST)
//   ODOO_TAX_INTRA          default '18% GST S'   (CGST+SGST, intra-state)
//   ODOO_TAX_INTER          default '18% IGST S'  (inter-state)
//   ODOO_FP_INTRA           default 'Within Kerala'
//   ODOO_FP_INTER           default 'Inter State'

const crypto = require('crypto');

const ODOO_URL  = process.env.ODOO_URL;
const ODOO_DB   = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USERNAME;
const ODOO_PW   = process.env.ODOO_PASSWORD || process.env.ODOO_API_KEY;

const SUB_SKU    = process.env.ODOO_SUBSCRIPTION_SKU || 'SUB-LISTING';
const CLUB_SKU   = process.env.ODOO_CLUB_SKU          || 'CLUB-ANNUAL';
const DIRECT_SKU = process.env.ODOO_DIRECT_SALE_SKU   || 'DIRECT-BOOK-SALE';
const DIRECT_CUSTOMER = process.env.ODOO_DIRECT_CUSTOMER || 'Direct Sales (Offline)';
const TAX_EXEMPT = process.env.ODOO_TAX_EXEMPT        || '0% Exempt';   // books, HSN 4901
const PAY_JOURNAL= process.env.ODOO_PAYMENT_JOURNAL   || 'Cash';        // offline collections
const HOME_STATE = process.env.ODOO_COMPANY_STATE     || 'Kerala';
const TAX_INTRA  = process.env.ODOO_TAX_INTRA || '18% GST S';
const TAX_INTER  = process.env.ODOO_TAX_INTER || '18% IGST S';
const FP_INTRA   = process.env.ODOO_FP_INTRA  || 'Within Kerala';
const FP_INTER   = process.env.ODOO_FP_INTER  || 'Inter State';
// MyBillBook → Odoo sync (recurring sale-order replay)
const DELIVERY_SKU   = process.env.ODOO_DELIVERY_SKU || 'DELIVERY-CHG';
const DISCOUNT_SKU   = process.env.ODOO_DISCOUNT_SKU || 'SALES-DISC';
const MBB_PAY_JOURNAL= process.env.ODOO_MBB_PAY_JOURNAL || 'Bank';   // Razorpay + UPI land in Axis bank
const STOCK_LOCATION = process.env.ODOO_STOCK_LOCATION || 'WH/Stock';

function isConfigured() {
  return Boolean(ODOO_URL && ODOO_DB && ODOO_USER && ODOO_PW);
}

// ── low-level JSON-RPC ──────────────────────────────────────────────────────
let _uid = null;
const _cache = {};   // warm-lambda cache for ids that don't change

async function jsonrpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { service, method, args } })
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status} on ${service}.${method}`);
  const data = await res.json();
  if (data.error) {
    const e = data.error.data || data.error;
    throw new Error(`Odoo ${service}.${method}: ${e.message || JSON.stringify(e)}`);
  }
  return data.result;
}

async function authenticate() {
  if (_uid) return _uid;
  _uid = await jsonrpc('common', 'authenticate', [ODOO_DB, ODOO_USER, ODOO_PW, {}]);
  if (!_uid) throw new Error('Odoo authentication failed (check ODOO_DB / USERNAME / PASSWORD)');
  return _uid;
}

async function execKw(model, method, args, kwargs = {}) {
  const uid = await authenticate();
  return jsonrpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_PW, model, method, args, kwargs]);
}

async function findOne(model, domain, fields) {
  const rows = await execKw(model, 'search_read', [domain], { fields, limit: 1 });
  return rows[0] || null;
}

// ── lookups (cached by name so the same code works on any l10n_in database) ──
async function saleTaxIdByName(name) {
  const k = 'tax:' + name;
  if (_cache[k]) return _cache[k];
  const t = await findOne('account.tax',
    [['name', '=', name], ['type_tax_use', '=', 'sale']], ['id']);
  if (!t) throw new Error(`Odoo sale tax not found: "${name}"`);
  return (_cache[k] = t.id);
}

async function fiscalPositionIdByName(name) {
  const k = 'fp:' + name;
  if (k in _cache) return _cache[k];
  const fp = await findOne('account.fiscal.position', [['name', '=', name]], ['id']);
  return (_cache[k] = fp ? fp.id : false);
}

async function stateIdByName(name) {
  if (!name) return false;
  const k = 'state:' + name.toLowerCase();
  if (k in _cache) return _cache[k];
  const st = await findOne('res.country.state',
    [['name', '=ilike', name], ['country_id.code', '=', 'IN']], ['id']);
  return (_cache[k] = st ? st.id : false);
}

async function indiaId() {
  if (_cache.india) return _cache.india;
  const c = await findOne('res.country', [['code', '=', 'IN']], ['id']);
  return (_cache.india = c ? c.id : false);
}

// Find the author (res.partner) by email; create if absent. Backfill state when
// we learn it (drives CGST/SGST vs IGST place-of-supply).
async function ensurePartner({ email, name, stateName }) {
  const stateId = await stateIdByName(stateName);
  let partner = await findOne('res.partner', [['email', '=ilike', email]], ['id', 'state_id']);
  if (!partner) {
    const id = await execKw('res.partner', 'create', [{
      name: name || email,
      email,
      customer_rank: 1,
      country_id: await indiaId(),
      ...(stateId ? { state_id: stateId } : {})
    }]);
    return { id, state_id: stateId ? [stateId, stateName] : false };
  }
  if (stateId && !partner.state_id) {
    await execKw('res.partner', 'write', [[partner.id], { state_id: stateId }]);
    partner.state_id = [stateId, stateName];
  }
  return partner;
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ── core invoice builder ─────────────────────────────────────────────────────
// Posts a GST-compliant out_invoice for ONE taxable service line (the author
// subscription or the reader book-club membership). Price is GST-INCLUSIVE: the
// 18% taxes are configured price-included, so entering the gross as price_unit
// makes Odoo back-out base + tax exactly (₹199 → 168.64 + 30.36; ₹99 → 83.90 +
// 15.10), total == amount charged. Idempotent by Razorpay payment id.
//
// opts = {
//   sku,            // product default_code to invoice (required)
//   lineName,       // invoice line label (defaults to the product name)
//   email, name,    // the customer (email required)
//   stateName,      // optional Indian state for GST place-of-supply
//   amountPaise,    // gross GST-inclusive charge in paise (required)
//   paymentId,      // Razorpay payment id (pay_…) — idempotency key
//   originRef,      // sub_… or order_… stored as invoice origin
//   chargedAt,      // ISO string or Date; defaults to now
// }
// Returns { created, invoiceId, number, total, tax, untaxed } — created:false if
// an invoice for this paymentId already exists.
async function createServiceInvoice(opts) {
  if (!isConfigured()) throw new Error('Odoo is not configured (ODOO_URL/DB/USERNAME/PASSWORD)');
  const { sku, lineName, email, name, stateName, amountPaise,
          paymentId, originRef, chargedAt } = opts;
  if (!sku)         throw new Error('createServiceInvoice: sku required');
  if (!email)       throw new Error('createServiceInvoice: email required');
  if (!amountPaise) throw new Error('createServiceInvoice: amountPaise required');

  // Idempotency key: prefer the unique Razorpay payment id; otherwise origin+time.
  const idemKey = paymentId || `${originRef || 'svc'}:${chargedAt || ''}`;
  const ref = `razorpay:${idemKey}`;

  const existing = await findOne('account.move',
    [['ref', '=', ref], ['move_type', '=', 'out_invoice']],
    ['id', 'name', 'state', 'amount_total']);
  if (existing) {
    return { created: false, invoiceId: existing.id, number: existing.name,
             state: existing.state, total: existing.amount_total };
  }

  const product = await findOne('product.product', [['default_code', '=', sku]], ['id', 'name']);
  if (!product) {
    throw new Error(`Service product SKU "${sku}" not found in Odoo — run odoo-setup-subscription.js`);
  }

  const partner = await ensurePartner({ email, name, stateName });

  // Place of supply: prefer the state resolved for THIS charge; else the
  // customer's stored state; else default to home. Home state → CGST+SGST;
  // any other state → IGST.
  const supplyState = stateName || (partner.state_id ? partner.state_id[1] : '');
  const intra = !supplyState || supplyState.toLowerCase().startsWith(HOME_STATE.toLowerCase());
  const taxId = await saleTaxIdByName(intra ? TAX_INTRA : TAX_INTER);
  const fpId  = await fiscalPositionIdByName(intra ? FP_INTRA : FP_INTER);

  const gross = round2(amountPaise / 100);
  const invoiceDate = (chargedAt ? new Date(chargedAt) : new Date()).toISOString().slice(0, 10);

  const invoiceId = await execKw('account.move', 'create', [{
    move_type: 'out_invoice',
    partner_id: partner.id,
    ref,                                  // idempotency marker (Razorpay payment id)
    invoice_origin: originRef || '',
    invoice_date: invoiceDate,
    ...(fpId ? { fiscal_position_id: fpId } : {}),
    invoice_line_ids: [[0, 0, {
      product_id: product.id,
      name: lineName || product.name,
      quantity: 1,
      price_unit: gross,
      tax_ids: [[6, 0, [taxId]]]
    }]]
  }]);

  await execKw('account.move', 'action_post', [[invoiceId]]);

  const posted = await findOne('account.move', [['id', '=', invoiceId]],
    ['name', 'amount_total', 'amount_tax', 'amount_untaxed']);

  // This invoice only ever gets created AFTER Razorpay confirms the charge
  // (real-time webhook / verify fn, or backfill from an already-paid Razorpay
  // record) — the money is already collected, so register it immediately.
  // Without this the invoice sits posted-but-unpaid forever and wrongly shows
  // up as an outstanding receivable.
  try { await registerPaymentAmount(invoiceId, posted.amount_total, invoiceDate, MBB_PAY_JOURNAL); }
  catch (e) { /* payment registration best-effort — invoice itself still stands */ }

  return {
    created: true,
    invoiceId,
    number: posted.name,
    total: posted.amount_total,
    tax: posted.amount_tax,
    untaxed: posted.amount_untaxed
  };
}

// Author Book Listing Subscription (recurring; razorpay-webhook subscription.charged).
// charge = { email, name, stateName?, amountPaise, paymentId, subscriptionId, planName, chargedAt? }
function createSubscriptionInvoice(charge) {
  return createServiceInvoice({
    sku: SUB_SKU,
    lineName: charge.planName
      ? `Author Book Listing Subscription — ${charge.planName}`
      : 'Author Book Listing Subscription',
    email: charge.email, name: charge.name, stateName: charge.stateName,
    amountPaise: charge.amountPaise, paymentId: charge.paymentId,
    originRef: charge.subscriptionId, chargedAt: charge.chargedAt,
  });
}

// Reader Book Club annual membership (one-time order; verify-book-club-payment).
// charge = { email, name, stateName?, amountPaise, paymentId, orderId, paidAt? }
function createClubMembershipInvoice(charge) {
  return createServiceInvoice({
    sku: CLUB_SKU,
    lineName: 'Yellow Feather Book Club — Annual Membership',
    email: charge.email, name: charge.name, stateName: charge.stateName,
    amountPaise: charge.amountPaise, paymentId: charge.paymentId,
    originRef: charge.orderId, chargedAt: charge.paidAt,
  });
}

// Find a customer (res.partner) by name (offline buyers have no email); create if
// absent. Optional comment carries the selling author for traceability.
async function ensurePartnerByName(name, comment) {
  const clean = (name || 'Walk-in Customer').trim();
  const found = await findOne('res.partner', [['name', '=', clean]], ['id']);
  if (found) return found.id;
  return execKw('res.partner', 'create', [{
    name: clean,
    customer_rank: 1,
    country_id: await indiaId(),
    ...(comment ? { comment } : {})
  }]);
}

// Register a full payment against a posted invoice (so it shows Paid and Odoo's
// Collected/Outstanding mirrors the portal). Uses the configured offline journal.
async function registerInvoicePayment(invoiceId) {
  const journal = await findOne('account.journal',
      [['type', 'in', ['cash', 'bank']], ['name', '=', PAY_JOURNAL]], ['id'])
    || await findOne('account.journal', [['type', '=', 'cash']], ['id'])
    || await findOne('account.journal', [['type', '=', 'bank']], ['id']);
  if (!journal) throw new Error('No bank/cash journal found to register payment');
  const ctx = { context: { active_model: 'account.move', active_ids: [invoiceId] } };
  const wizId = await execKw('account.payment.register', 'create', [{ journal_id: journal.id }], ctx);
  await execKw('account.payment.register', 'action_create_payments', [[wizId]], ctx);
}

// Record an offline / direct (book-fair, event, personal) sale as a GST-EXEMPT
// customer invoice (books = HSN 4901, 0%). Path A "revenue sync": captures the
// sale, customer and amount; it does NOT decrement a specific book's stock (the
// source data doesn't identify the book). Idempotent by order number / record id.
//
// sale = {
//   bookSummary,            // book(s) sold — the portal's book_title ("Title +N more")
//   customerName,           // buyer name IF known (usually absent); else generic partner
//   authorEmail,            // selling author (traceability)
//   amount,                 // total sale ₹ (required)
//   quantity = 1,
//   saleDate,               // 'YYYY-MM-DD'
//   orderNumber,            // YFB… (idempotency key)
//   recordId,               // direct_sales row id (idempotency fallback)
//   paymentStatus,          // 'paid' -> registers payment; else stays Outstanding
//   notes,                  // for bulk imports: "Books: A; B; C | via X"
// }
async function createDirectSaleInvoice(sale) {
  if (!isConfigured()) throw new Error('Odoo is not configured (ODOO_URL/DB/USERNAME/PASSWORD)');
  const { bookSummary, customerName, authorEmail, amount, quantity, saleDate,
          orderNumber, recordId, paymentStatus, notes } = sale;
  if (!amount) throw new Error('createDirectSaleInvoice: amount required');

  // Idempotency on the UNIQUE direct_sales row id (order numbers can repeat across
  // sales and would otherwise collide); fall back to order number, then timestamp.
  const idemKey = (recordId != null && recordId !== '') ? `id${recordId}`
                : (orderNumber || `t${Date.now()}`);
  const ref = `direct:${idemKey}`;

  const existing = await findOne('account.move',
    [['ref', '=', ref], ['move_type', '=', 'out_invoice']],
    ['id', 'name', 'state', 'amount_total', 'payment_state']);
  if (existing) {
    return { created: false, invoiceId: existing.id, number: existing.name,
             state: existing.state, total: existing.amount_total };
  }

  const product = await findOne('product.product', [['default_code', '=', DIRECT_SKU]], ['id', 'name']);
  if (!product) throw new Error(`Direct-sale product "${DIRECT_SKU}" not found — run the Odoo setup`);

  // Partner = the actual buyer if we have a name, else a single generic offline
  // customer (the buyer usually isn't captured). Book(s) go on the invoice line.
  const partnerId = customerName
    ? await ensurePartnerByName(customerName, authorEmail ? `Direct sale via author ${authorEmail}` : '')
    : await ensurePartnerByName(DIRECT_CUSTOMER, '');
  const taxId = await saleTaxIdByName(TAX_EXEMPT);

  const qty = Number(quantity) > 0 ? Number(quantity) : 1;
  const priceUnit = round2(Number(amount) / qty);
  const invoiceDate = (saleDate ? new Date(saleDate) : new Date()).toISOString().slice(0, 10);

  const invoiceId = await execKw('account.move', 'create', [{
    move_type: 'out_invoice',
    partner_id: partnerId,
    ref,
    invoice_origin: orderNumber || '',
    invoice_date: invoiceDate,
    narration: `Offline direct sale${authorEmail ? ` by ${authorEmail}` : ''}${notes ? ` — ${notes}` : ''}`,
    invoice_line_ids: [[0, 0, {
      product_id: product.id,
      name: bookSummary || 'Direct book sale',
      quantity: qty,
      price_unit: priceUnit,
      tax_ids: [[6, 0, [taxId]]]
    }]]
  }]);

  await execKw('account.move', 'action_post', [[invoiceId]]);

  let paid = false;
  if ((paymentStatus || '').toLowerCase() === 'paid') {
    try { await registerInvoicePayment(invoiceId); paid = true; }
    catch (e) { console.error('Direct-sale payment registration failed (invoice still posted):', e.message); }
  }

  const posted = await findOne('account.move', [['id', '=', invoiceId]],
    ['name', 'amount_total', 'payment_state']);
  return { created: true, invoiceId, number: posted.name,
           total: posted.amount_total, paymentState: posted.payment_state, paid };
}

// Full-chain direct sale for KNOWN book(s): Sales Order -> confirm -> validate
// delivery (DECREMENTS each book's stock) -> invoice -> payment. Books are
// GST-exempt (HSN 4901). Idempotent by sale.order.client_order_ref. Accepts a
// multi-book `items` array OR single-book fields; falls back to the generic
// revenue-only invoice when no line matches a real product.
//   sale.items = [{ sku, title, qty, price }, …]   (preferred, multi-book)
async function createDirectSaleOrder(sale) {
  if (!isConfigured()) throw new Error('Odoo is not configured');
  const { sku, bookTitle, customerName, authorEmail, amount, quantity,
          saleDate, orderNumber, recordId, paymentStatus, notes, items } = sale;

  // Normalise to a list of line specs.
  let lineSpecs;
  if (Array.isArray(items) && items.length) {
    lineSpecs = items.map(it => ({
      sku:   it.sku || null,
      name:  it.title || it.name || 'Book',
      qty:   Number(it.qty) > 0 ? Number(it.qty) : 1,
      price: round2(Number(it.price) || 0),
    }));
  } else {
    const q = Number(quantity) > 0 ? Number(quantity) : 1;
    lineSpecs = [{ sku: sku || null, name: bookTitle || 'Direct book sale',
                   qty: q, price: round2(Number(amount) / q) }];
  }

  // Resolve each line to a product (SKU -> title -> generic). If NOTHING matches a
  // real book product, fall back to the revenue-only invoice (no stock impact).
  const taxId = await saleTaxIdByName(TAX_EXEMPT);
  const generic = await findOne('product.product', [['default_code', '=', DIRECT_SKU]], ['id', 'name']);
  const matchedSkus = [];
  let anyReal = false;
  const orderLine = [];
  for (const ls of lineSpecs) {
    let prod = null;
    // Ignore junk Shopify SKUs ("Default Title" / blanks) — match by title instead.
    const skuClean = (ls.sku && ls.sku.trim() && ls.sku.trim().toLowerCase() !== 'default title') ? ls.sku.trim() : null;
    if (skuClean)  prod = await findOne('product.product', [['default_code', '=', skuClean]], ['id', 'name', 'default_code']);
    if (!prod && ls.name) prod = await findOne('product.product', [['name', '=', ls.name]], ['id', 'name', 'default_code']);
    if (prod) { anyReal = true; matchedSkus.push(prod.default_code || skuClean); } else { prod = generic; }
    if (!prod) throw new Error(`No product available (run the Odoo setup)`);
    orderLine.push([0, 0, {
      product_id: prod.id, name: ls.name,
      product_uom_qty: ls.qty, price_unit: ls.price,
      tax_id: [[6, 0, [taxId]]]
    }]);
  }
  if (!anyReal) return createDirectSaleInvoice(sale);

  // Idempotency on the UNIQUE direct_sales row id (order numbers can repeat across
  // sales and would otherwise collide); fall back to order number, then timestamp.
  const idemKey = (recordId != null && recordId !== '') ? `id${recordId}`
                : (orderNumber || `t${Date.now()}`);
  const ref = `direct:${idemKey}`;

  const existingSO = await findOne('sale.order', [['client_order_ref', '=', ref]],
    ['id', 'name', 'state', 'amount_total', 'invoice_ids']);
  if (existingSO) {
    return { created: false, saleOrderId: existingSO.id, number: existingSO.name,
             state: existingSO.state, total: existingSO.amount_total };
  }

  const partnerId = customerName
    ? await ensurePartnerByName(customerName, authorEmail ? `Direct sale via author ${authorEmail}` : '')
    : await ensurePartnerByName(DIRECT_CUSTOMER, '');
  const orderDate = (saleDate ? new Date(saleDate) : new Date()).toISOString().slice(0, 10);

  // 1 — Sales Order (one line per book)
  const soId = await execKw('sale.order', 'create', [{
    partner_id: partnerId,
    client_order_ref: ref,
    date_order: orderDate,
    note: `Offline direct sale${authorEmail ? ` by ${authorEmail}` : ''}${notes ? ` — ${notes}` : ''}`,
    order_line: orderLine
  }]);

  // 2 — Confirm -> generates the delivery picking
  await execKw('sale.order', 'action_confirm', [[soId]]);

  // 3 — Validate the delivery so stock decrements (force done qty; allows negative)
  const so = await findOne('sale.order', [['id', '=', soId]], ['picking_ids']);
  for (const pickId of (so.picking_ids || [])) {
    const moves = await execKw('stock.move', 'search_read',
      [[['picking_id', '=', pickId]]], { fields: ['id', 'product_uom_qty'] });
    for (const m of moves) {
      await execKw('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }]);
    }
    const res = await execKw('stock.picking', 'button_validate', [[pickId]]);
    // If a wizard pops (backorder/immediate transfer), process it through.
    if (res && typeof res === 'object' && res.res_model) {
      const ctx = res.context || {};
      const wizId = await execKw(res.res_model, 'create', [{}], { context: ctx });
      await execKw(res.res_model, 'process', [[wizId]], { context: ctx });
    }
  }

  // 4 — Invoice from the SO via the standard wizard (delivered qty) + post
  const wizId = await execKw('sale.advance.payment.inv', 'create',
    [{ advance_payment_method: 'delivered' }],
    { context: { active_model: 'sale.order', active_ids: [soId] } });
  await execKw('sale.advance.payment.inv', 'create_invoices', [[wizId]],
    { context: { active_model: 'sale.order', active_ids: [soId] } });
  const soInv = await findOne('sale.order', [['id', '=', soId]], ['invoice_ids']);
  const invoiceIds = soInv.invoice_ids || [];
  if (invoiceIds.length) {
    await execKw('account.move', 'action_post', [invoiceIds]);
    // 5 — Payment (offline 'paid' -> register full payment)
    if ((paymentStatus || '').toLowerCase() === 'paid') {
      try { await registerInvoicePayment(invoiceIds[0]); }
      catch (e) { console.error('Direct-sale payment registration failed:', e.message); }
    }
  }

  const posted = await findOne('sale.order', [['id', '=', soId]],
    ['name', 'amount_total', 'delivery_status', 'invoice_status']);
  const inv = invoiceIds && invoiceIds.length
    ? await findOne('account.move', [['id', '=', invoiceIds[0]]], ['name', 'payment_state'])
    : null;
  return {
    created: true, saleOrderId: soId, number: posted.name,
    total: posted.amount_total, deliveryStatus: posted.delivery_status,
    invoiceNumber: inv && inv.name, paymentState: inv && inv.payment_state,
    lines: orderLine.length, decrementedSkus: matchedSkus
  };
}

// Fetch a posted invoice's official PDF (the QWeb report) as base64, so it can be
// handed to the n8n mailer instead of n8n generating its own invoice. Uses a web
// session (cookie) because the report controller is session-authenticated.
const INVOICE_REPORT = process.env.ODOO_INVOICE_REPORT || 'account.report_invoice';

async function getInvoicePdfBase64(invoiceId) {
  if (!isConfigured()) throw new Error('Odoo is not configured (ODOO_URL/DB/USERNAME/PASSWORD)');
  const auth = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PW } })
  });
  const cookie = (auth.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Odoo session auth failed (no session cookie)');
  const res = await fetch(`${ODOO_URL}/report/pdf/${INVOICE_REPORT}/${invoiceId}`, { headers: { Cookie: cookie } });
  if (!res.ok) throw new Error(`Odoo invoice PDF HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('Odoo did not return a PDF');
  return buf.toString('base64');
}

// Register a payment of a SPECIFIC amount (supports partial) against a posted
// invoice, on a named bank/cash journal, dated. Used by the MyBillBook sync where
// each invoice's Money-In may be full, partial or zero.
async function registerPaymentAmount(invoiceId, amount, dateStr, journalName) {
  const want = round2(Number(amount) || 0);
  if (want <= 0) return;
  const journal = await findOne('account.journal',
      [['type', 'in', ['bank', 'cash']], ['name', '=', journalName || MBB_PAY_JOURNAL]], ['id'])
    || await findOne('account.journal', [['type', '=', 'bank']], ['id'])
    || await findOne('account.journal', [['type', '=', 'cash']], ['id']);
  if (!journal) throw new Error('No bank/cash journal found to register payment');
  const ctx = { context: { active_model: 'account.move', active_ids: [invoiceId] } };
  const vals = { journal_id: journal.id, amount: want };
  if (dateStr) vals.payment_date = dateStr;
  const wizId = await execKw('account.payment.register', 'create', [vals], ctx);
  await execKw('account.payment.register', 'action_create_payments', [[wizId]], ctx);
}

// Validate a delivery picking so stock decrements. Forces done qty, bypasses the
// SMS confirmation, and processes any residual wizard (backorder/immediate).
async function validateDelivery(pickId) {
  const moves = await execKw('stock.move', 'search_read',
    [[['picking_id', '=', pickId]]], { fields: ['id', 'product_uom_qty'] });
  for (const m of moves) {
    await execKw('stock.move', 'write', [[m.id], { quantity: m.product_uom_qty, picked: true }]);
  }
  const res = await execKw('stock.picking', 'button_validate', [[pickId]],
    { context: { skip_sms: true, skip_backorder: true } });
  if (res && typeof res === 'object' && res.res_model) {
    const ctx = res.context || {};
    try {
      const wizId = await execKw(res.res_model, 'create', [{}], { context: ctx });
      for (const m of ['process', 'button_validate', 'dont_send_sms', 'process_cancel_backorder']) {
        try { await execKw(res.res_model, m, [[wizId]], { context: ctx }); break; } catch (_) {}
      }
    } catch (_) {}
  }
}

// Deterministic canonical SKU from a title — SAME algorithm as the portal's SKU
// Generator (SHA-256 of the normalised title -> 10 base-36 chars -> XX-XXXX-XXXX).
function canonicalSku(title) {
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const n = (title || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const b = crypto.createHash('sha256').update(n).digest();
  let s = '';
  for (let i = 0; i < 10; i++) s += CH[b[i] % 36];
  return `${s.slice(0, 2)}-${s.slice(2, 6)}-${s.slice(6, 10)}`;
}

// Resolve a book product by SKU then title; if absent and autoCreate, create it as
// a GST-exempt storable book (HSN 4901) with a canonical SKU and the purchase cost.
// Returns { id, code, created }.
async function ensureBookProduct({ sku, title, cost, autoCreate }) {
  const skuClean = (sku && sku.trim() && sku.trim().toLowerCase() !== 'default title') ? sku.trim() : null;
  let prod = null;
  if (skuClean) prod = await findOne('product.product', [['default_code', '=', skuClean]], ['id']);
  if (!prod && title) prod = await findOne('product.product', [['name', '=', title]], ['id']);
  if (prod) return { id: prod.id, code: skuClean, created: false };
  // Match on the canonical SKU before creating, so a title variant (apostrophe /
  // case / spacing) doesn't spawn a duplicate of an existing book.
  if (title) {
    const cs = canonicalSku(title);
    const bySku = await findOne('product.product', [['default_code', '=', cs]], ['id']);
    if (bySku) return { id: bySku.id, code: cs, created: false };
  }
  if (!autoCreate) return null;
  const code = skuClean || canonicalSku(title);
  const saleTax = await saleTaxIdByName(TAX_EXEMPT);
  const purchTax = await purchaseTaxIdByName(TAX_EXEMPT);
  const c = cost ? round2(cost) : 0;
  const tmplId = await execKw('product.template', 'create', [{
    name: title, default_code: code, type: 'product', categ_id: 1,
    taxes_id: [[6, 0, [saleTax]]], supplier_taxes_id: [[6, 0, [purchTax]]],
    l10n_in_hsn_code: '4901', invoice_policy: 'order',
    list_price: c, standard_price: c
  }]);
  const pp = await findOne('product.product', [['product_tmpl_id', '=', tmplId]], ['id']);
  return { id: pp.id, code, created: true };
}

// Fill a customer's address from the parsed invoice Bill-To, only where empty
// (never overwrites existing data). a = { street, city, zip, mobile, state }.
async function setPartnerAddress(partnerId, a) {
  if (!a) return;
  const cur = await findOne('res.partner', [['id', '=', partnerId]],
    ['street', 'city', 'zip', 'mobile', 'state_id', 'country_id']);
  if (!cur) return;
  const vals = {};
  if (a.street && !cur.street) vals.street = a.street;
  if (a.city && !cur.city) vals.city = a.city;
  if (a.zip && !cur.zip) vals.zip = a.zip;
  if (a.mobile && !cur.mobile) vals.mobile = a.mobile;
  if (a.state && !cur.state_id) {
    const sid = await stateIdByName(a.state);
    if (sid) vals.state_id = sid;
  }
  if (!cur.country_id) vals.country_id = await indiaId();
  if (Object.keys(vals).length) await execKw('res.partner', 'write', [[partnerId], vals]);
}

// Replay ONE MyBillBook sale invoice as a full Odoo sale order:
//   SO (book lines exempt + Delivery line + negative Bill-Discount line)
//   -> confirm -> validate delivery (decrement stock) -> invoice -> post
//   -> register Money-In on the Bank journal (full / partial / none).
// Idempotent on client_order_ref = 'mbb:<invoiceNo>' (re-runs are safe).
//
// order = { invoiceNo, customer, date:'YYYY-MM-DD', dayTotal, moneyIn,
//           delivery, billDiscount, lines:[{ sku, title, qty, total }] }
async function createMbbSaleOrder(order, opts = {}) {
  if (!isConfigured()) throw new Error('Odoo is not configured (ODOO_URL/DB/USERNAME/PASSWORD)');
  const invoiceNo = order.invoiceNo;
  if (!invoiceNo) throw new Error('invoiceNo is required');
  const ref = `mbb:${invoiceNo}`;
  // Dedupe against BOTH this tool's ref and the one-off June bootstrap replay
  // ('sales:<invoiceNo>'), so re-syncing an overlapping range never duplicates.
  const existing = await findOne('sale.order',
    [['client_order_ref', 'in', [ref, `sales:${invoiceNo}`]]],
    ['id', 'name', 'amount_total', 'state', 'client_order_ref']);
  if (existing) {
    // Incoming MyBillBook total for this invoice (grand total incl. delivery/discount).
    const incoming = round2(Number(order.dayTotal) || (order.lines || []).reduce((s, l) => s + (Number(l.total) || 0), 0)
      + (Number(order.delivery) || 0) - (Number(order.billDiscount) || 0));
    const changed = Math.abs((existing.amount_total || 0) - incoming) > 1;
    // Only reconcile an EDIT when explicitly asked AND the total actually moved AND
    // the sale isn't already cancelled — otherwise this is a normal duplicate → skip.
    if (!(opts.reconcileEdits && changed && existing.state !== 'cancel')) {
      return { invoiceNo, status: 'skip', number: existing.name, total: existing.amount_total,
        ...(changed ? { changed: true, odooTotal: existing.amount_total, mbbTotal: incoming } : {}) };
    }
    // EDIT (books added/removed in MyBillBook after the original sync): unwind the
    // old Odoo sale (credit note + stock return + refund) and retire its ref, then
    // STOP. The caller re-sends this invoice as a normal sync (its ref is now
    // retired, so the next call creates a fresh mbb:<inv> from the new lines).
    // Splitting reverse from rebuild keeps each request well under Netlify's ~26s
    // limit — the combined chain overran it for large invoices.
    const rev = await reverseMbbSale(invoiceNo, {});
    let v = 1;
    while (await findOne('sale.order', [['client_order_ref', '=', `${existing.client_order_ref}:v${v}`]], ['id'])) v++;
    await execKw('sale.order', 'write', [[existing.id], { client_order_ref: `${existing.client_order_ref}:v${v}` }]);
    return { invoiceNo, status: 'reversed', number: existing.name, needsRebuild: true,
      edit: { from: round2(existing.amount_total), to: incoming, reversed: rev && rev.status } };
  }

  const taxId = await saleTaxIdByName(TAX_EXEMPT);
  const taxCmd = [[6, 0, [taxId]]];
  const orderLine = [];
  const unresolved = [];
  for (const l of (order.lines || [])) {
    const sku = (l.sku || '').trim();
    let prod = null;
    if (sku && sku.toLowerCase() !== 'default title') {
      prod = await findOne('product.product', [['default_code', '=', sku]], ['id']);
    }
    if (!prod && l.title) prod = await findOne('product.product', [['name', '=', l.title]], ['id']);
    // Fallback: match on the canonical SKU derived from the title. This normalises
    // case / spacing / punctuation (incl. straight-vs-curly apostrophes, e.g.
    // "90's Kid"), catching books the exact-name match misses.
    if (!prod && l.title) {
      const cs = canonicalSku(l.title);
      prod = await findOne('product.product', [['default_code', '=', cs]], ['id']);
    }
    if (!prod) { unresolved.push(l.title || sku); continue; }
    const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
    const total = Number(l.total) || 0;
    orderLine.push([0, 0, {
      product_id: prod.id, name: l.title || 'Book',
      product_uom_qty: qty, price_unit: round2(total / qty), tax_id: taxCmd
    }]);
  }
  if (!orderLine.length) throw new Error(`No resolvable book lines for ${invoiceNo}`);

  if (Number(order.delivery) > 0) {
    const dp = await findOne('product.product', [['default_code', '=', DELIVERY_SKU]], ['id']);
    if (dp) orderLine.push([0, 0, { product_id: dp.id, name: 'Delivery / Shipping',
      product_uom_qty: 1, price_unit: round2(order.delivery), tax_id: taxCmd }]);
  }
  if (Number(order.billDiscount) > 0) {
    const sp = await findOne('product.product', [['default_code', '=', DISCOUNT_SKU]], ['id']);
    if (sp) orderLine.push([0, 0, { product_id: sp.id, name: 'Bill Discount',
      product_uom_qty: 1, price_unit: -round2(order.billDiscount), tax_id: taxCmd }]);
  }

  const partnerId = await ensurePartnerByName(order.customer || 'Walk-in Customer',
    `MyBillBook sync ${invoiceNo}`);
  if (order.address) await setPartnerAddress(partnerId, order.address);
  const orderDate = (order.date || new Date().toISOString().slice(0, 10));

  const soId = await execKw('sale.order', 'create', [{
    partner_id: partnerId, client_order_ref: ref,
    date_order: `${orderDate} 00:00:00`, order_line: orderLine
  }]);
  await execKw('sale.order', 'action_confirm', [[soId]]);

  const so = await findOne('sale.order', [['id', '=', soId]], ['picking_ids', 'name', 'amount_total']);
  for (const pickId of (so.picking_ids || [])) await validateDelivery(pickId);

  const wizId = await execKw('sale.advance.payment.inv', 'create',
    [{ advance_payment_method: 'delivered' }],
    { context: { active_model: 'sale.order', active_ids: [soId] } });
  await execKw('sale.advance.payment.inv', 'create_invoices', [[wizId]],
    { context: { active_model: 'sale.order', active_ids: [soId] } });

  const soInv = await findOne('sale.order', [['id', '=', soId]], ['invoice_ids', 'name', 'amount_total']);
  const invIds = soInv.invoice_ids || [];
  let invoiceNumber = null, paymentState = null;
  if (invIds.length) {
    await execKw('account.move', 'write', [invIds, { invoice_date: orderDate }]);
    await execKw('account.move', 'action_post', [invIds]);
    const moneyIn = Number(order.moneyIn) || 0;
    if (moneyIn > 0) {
      try { await registerPaymentAmount(invIds[0], moneyIn, orderDate, MBB_PAY_JOURNAL); }
      catch (e) { console.error(`mbb payment ${invoiceNo}:`, e.message); }
    }
    const inv = await findOne('account.move', [['id', '=', invIds[0]]], ['name', 'payment_state']);
    invoiceNumber = inv && inv.name; paymentState = inv && inv.payment_state;
  }

  return {
    invoiceNo, status: order.__edit ? 'edited' : 'ok', saleOrderId: soId, number: soInv.name,
    total: soInv.amount_total, invoiceNumber, paymentState,
    lines: orderLine.length, unresolved,
    ...(order.__edit ? { edit: order.__edit } : {})
  };
}

// Snapshot on-hand to absolute counted quantities (mirrors a MyBillBook stock
// summary). rows = [{ sku, qty }]. Negatives allowed. Returns counts.
async function applyStockSnapshot(rows) {
  if (!isConfigured()) throw new Error('Odoo is not configured');
  const loc = await findOne('stock.location', [['complete_name', '=', STOCK_LOCATION]], ['id'])
    || await findOne('stock.location', [['usage', '=', 'internal']], ['id']);
  if (!loc) throw new Error('No internal stock location found');
  let applied = 0, skipped = 0;
  const quantIds = [];
  for (const r of rows) {
    const sku = (r.sku || '').trim();
    if (!sku) { skipped++; continue; }
    const prod = await findOne('product.product', [['default_code', '=', sku]], ['id']);
    if (!prod) { skipped++; continue; }
    const existing = await findOne('stock.quant',
      [['product_id', '=', prod.id], ['location_id', '=', loc.id]], ['id']);
    let qid;
    if (existing) {
      qid = existing.id;
      await execKw('stock.quant', 'write', [[qid], { inventory_quantity: Number(r.qty) || 0 }]);
    } else {
      qid = await execKw('stock.quant', 'create',
        [{ product_id: prod.id, location_id: loc.id, inventory_quantity: Number(r.qty) || 0 }]);
    }
    quantIds.push(qid); applied++;
  }
  if (quantIds.length) await execKw('stock.quant', 'action_apply_inventory', [quantIds]);
  return { applied, skipped };
}

async function purchaseTaxIdByName(name) {
  const k = 'ptax:' + name;
  if (_cache[k]) return _cache[k];
  const t = await findOne('account.tax',
    [['name', '=', name], ['type_tax_use', '=', 'purchase']], ['id']);
  if (!t) throw new Error(`Odoo purchase tax not found: "${name}"`);
  return (_cache[k] = t.id);
}

// Find a vendor (res.partner) by name; create as a supplier company if absent.
async function ensureVendorByName(name) {
  const clean = (name || 'Unknown Vendor').trim();
  const found = await findOne('res.partner', [['name', '=', clean]], ['id']);
  if (found) return found.id;
  return execKw('res.partner', 'create', [{
    name: clean, supplier_rank: 1, company_type: 'company',
    country_id: await indiaId()
  }]);
}

// Record ONE MyBillBook purchase in Odoo. Two modes (opts.moveStock):
//   • BACKFILL (default, moveStock=false): direct vendor BILL only, NO stock move —
//     for purchases ≤ the snapshot cutover, already counted in the MyBillBook stock
//     summary that drives the snapshot (a receipt here would double-count).
//   • LIVE (moveStock=true): PO → confirm → receipt (INCREMENTS stock) → vendor bill —
//     for purchases AFTER cutover, when Odoo tracks inventory itself (no more snapshot).
// Either way posts a vendor bill + registers Money-Out. Idempotent on
// account.move.ref / purchase.order.partner_ref = 'mbbpo:<billNo>' (dedupes across modes).
//
// p = { billNo, vendor, date:'YYYY-MM-DD', dayTotal, moneyOut, balance,
//       lines:[{ sku, title, qty, total }] }
async function createMbbPurchaseOrder(p, opts = {}) {
  if (!isConfigured()) throw new Error('Odoo is not configured');
  const billNo = p.billNo;
  if (!billNo) throw new Error('billNo is required');
  const ref = `mbbpo:${billNo}`;

  const existingBill = await findOne('account.move',
    [['move_type', '=', 'in_invoice'], ['ref', '=', ref], ['state', '!=', 'cancel']], ['id', 'name', 'amount_total']);
  if (existingBill) return { billNo, status: 'skip', number: existingBill.name, total: existingBill.amount_total };
  const existingPO = await findOne('purchase.order', [['partner_ref', '=', ref], ['state', '!=', 'cancel']], ['id', 'name', 'amount_total']);
  if (existingPO) return { billNo, status: 'skip', number: existingPO.name, total: existingPO.amount_total };

  const taxId = await purchaseTaxIdByName(TAX_EXEMPT);
  const taxCmd = [[6, 0, [taxId]]];
  const vendorId = await ensureVendorByName(p.vendor);
  const billDate = (p.date || new Date().toISOString().slice(0, 10));

  const specs = [];
  const unresolved = [];
  const created = [];
  for (const l of (p.lines || [])) {
    const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
    const total = Number(l.total) || 0;
    const res = await ensureBookProduct({ sku: l.sku, title: l.title, cost: total / qty, autoCreate: opts.autoCreate });
    if (!res) { unresolved.push(l.title || (l.sku || '')); continue; }
    if (res.created) created.push({ sku: res.code, title: l.title });
    specs.push({ prodId: res.id, name: l.title || 'Book', qty, price: round2(total / qty) });
  }
  if (!specs.length) throw new Error(`No resolvable book lines for purchase ${billNo}`);

  // Footer adjustments so the bill total matches the daybook: freight/other charges
  // (+, when daybook > line-sum) and trade discount (-, when daybook < line-sum).
  // Kept as BILL lines only (never PO/receipt lines) so they bill regardless of the
  // PO's per-line "received" state (un-received service lines aren't auto-billed).
  const adj = [];
  const delivery = Number(p.delivery) || 0;
  const billDiscount = Number(p.billDiscount) || 0;
  if (delivery > 0) {
    const fp = await findOne('product.product', [['default_code', '=', DELIVERY_SKU]], ['id']);
    if (fp) adj.push({ prodId: fp.id, name: 'Freight / Other charges', qty: 1, price: round2(delivery) });
  }
  if (billDiscount > 0) {
    const dp = await findOne('product.product', [['default_code', '=', DISCOUNT_SKU]], ['id']);
    if (dp) adj.push({ prodId: dp.id, name: 'Purchase discount', qty: 1, price: -round2(billDiscount) });
  }
  const billLine = s => [0, 0, { product_id: s.prodId, name: s.name, quantity: s.qty, price_unit: s.price, tax_ids: taxCmd }];

  let billId = null, poId = null;
  if (opts.moveStock) {
    // LIVE: PO (books only) -> confirm -> receive (increments stock) -> bill -> append adjustments
    poId = await execKw('purchase.order', 'create', [{
      partner_id: vendorId, partner_ref: ref, date_order: `${billDate} 00:00:00`,
      order_line: specs.map(s => [0, 0, { product_id: s.prodId, name: s.name, product_qty: s.qty, price_unit: s.price, taxes_id: taxCmd }])
    }]);
    await execKw('purchase.order', 'button_confirm', [[poId]]);
    const po = await findOne('purchase.order', [['id', '=', poId]], ['picking_ids']);
    for (const pickId of (po.picking_ids || [])) await validateDelivery(pickId);  // receipt -> increment
    await execKw('purchase.order', 'action_create_invoice', [[poId]]);
    const poInv = await findOne('purchase.order', [['id', '=', poId]], ['invoice_ids']);
    billId = (poInv.invoice_ids || [])[0];
    if (billId) {
      const vals = { invoice_date: billDate, ref };
      if (adj.length) vals.invoice_line_ids = adj.map(billLine);  // freight/discount onto the bill
      await execKw('account.move', 'write', [[billId], vals]);
    }
  } else {
    // BACKFILL: direct vendor bill, no stock movement
    billId = await execKw('account.move', 'create', [{
      move_type: 'in_invoice', partner_id: vendorId, invoice_date: billDate, date: billDate, ref,
      invoice_line_ids: specs.concat(adj).map(billLine)
    }]);
  }
  if (!billId) throw new Error(`Vendor bill not created for purchase ${billNo}`);
  await execKw('account.move', 'action_post', [[billId]]);

  const moneyOut = Number(p.moneyOut) || 0;
  if (moneyOut > 0) {
    try { await registerPaymentAmount(billId, moneyOut, billDate, MBB_PAY_JOURNAL); }
    catch (e) { console.error(`mbb purchase payment ${billNo}:`, e.message); }
  }

  const bill = await findOne('account.move', [['id', '=', billId]], ['name', 'payment_state', 'amount_total']);
  return {
    billNo, status: 'ok', billId, poId, number: bill.name,
    total: bill.amount_total, paymentState: bill.payment_state,
    lines: specs.length, unresolved, created, movedStock: !!opts.moveStock
  };
}

// MyBillBook expense category ("Exp. Name") -> Odoo account code. Ordered: first
// keyword that appears in the category wins ('book printing' before 'printing').
const EXPENSE_MAP = [
  ['book printing', '211002'],
  ['rent', '211003'],
  ['sales and marketting', '211004'], ['salary', '211004'], ['salaries', '211004'],
  ['commission', '211004'], ['wages', '211004'], ['staff', '211004'],
  ['postal', '211005'], ['courier', '211005'], ['postage', '211005'], ['shipping', '211005'],
  ['subscription', '211006'], ['software', '211006'], ['saas', '211006'],
  ['domain', '211007'], ['hosting', '211007'],
  ['legal', '211008'], ['professional', '211008'], ['accounting', '211008'],
  ['advertis', '211009'], ['marketing', '211009'], ['promotion', '211009'],
  ['printing and stationery', '211010'], ['stationery', '211010'], ['printing', '211010'],
  ['goverment', '211011'], ['government', '211011'], ['govt', '211011'],
  ['statutory', '211011'], ['stamp', '211011'], ['registrar', '211011'],
];
const EXPENSE_FALLBACK = process.env.ODOO_EXPENSE_FALLBACK || '211013';   // Other Expenses
const EXPENSE_PARTNER  = process.env.ODOO_EXPENSE_PARTNER  || 'Sundry Expenses (MyBillBook)';

function expenseAccountCode(category) {
  const c = (category || '').toLowerCase();
  for (const [kw, code] of EXPENSE_MAP) if (c.includes(kw)) return code;
  return EXPENSE_FALLBACK;
}
function expenseJournalName(mode) {
  const m = (mode || '').toLowerCase();
  if (m.includes('cash')) return 'Cash';
  if (m.includes('card')) return 'Credit Card';
  return MBB_PAY_JOURNAL;   // netbanking / bank / upi -> Bank (Axis)
}
async function accountIdByCode(code) {
  const k = 'acccode:' + code;
  if (_cache[k]) return _cache[k];
  const a = await findOne('account.account', [['code', '=', code]], ['id']);
  if (!a) throw new Error(`Expense account code not found: ${code}`);
  return (_cache[k] = a.id);
}

// Record ONE MyBillBook expense voucher as a categorized vendor bill (line posted
// directly to the mapped expense account) + register Money-Out on the pay-mode
// journal. Idempotent on account.move.ref = 'mbbexp:<voucherNo>' (also dedupes a
// bare '<voucherNo>' ref, in case it was hand-recorded earlier).
//
// e = { voucherNo, category, amount, date:'YYYY-MM-DD', paymentMode, notes }
async function createMbbExpenseBill(e) {
  if (!isConfigured()) throw new Error('Odoo is not configured');
  const voucher = e.voucherNo;
  if (!voucher) throw new Error('voucherNo is required');
  const ref = `mbbexp:${voucher}`;
  const existing = await findOne('account.move',
    [['move_type', '=', 'in_invoice'], ['ref', 'in', [ref, String(voucher)]], ['state', '!=', 'cancel']],
    ['id', 'name', 'amount_total']);
  if (existing) return { voucherNo: voucher, status: 'skip', number: existing.name, total: existing.amount_total };

  const code = expenseAccountCode(e.category);
  const acctId = await accountIdByCode(code);
  const partnerId = await ensureVendorByName(EXPENSE_PARTNER);
  const billDate = e.date || new Date().toISOString().slice(0, 10);
  const amt = round2(Number(e.amount) || 0);

  const billId = await execKw('account.move', 'create', [{
    move_type: 'in_invoice', partner_id: partnerId, invoice_date: billDate, date: billDate, ref,
    invoice_line_ids: [[0, 0, {
      account_id: acctId, name: (e.notes || e.category || 'Expense'),
      quantity: 1, price_unit: amt, tax_ids: [[6, 0, []]]
    }]]
  }]);
  await execKw('account.move', 'action_post', [[billId]]);
  if (amt > 0) {
    try { await registerPaymentAmount(billId, amt, billDate, expenseJournalName(e.paymentMode)); }
    catch (err) { console.error(`mbb expense payment ${voucher}:`, err.message); }
  }
  const bill = await findOne('account.move', [['id', '=', billId]], ['name', 'payment_state', 'amount_total']);
  return {
    voucherNo: voucher, status: 'ok', billId, number: bill.name, total: bill.amount_total,
    paymentState: bill.payment_state, category: e.category, account: code,
    fallback: code === EXPENSE_FALLBACK
  };
}

// Create + validate a return for a DONE outgoing delivery so the book(s) flow
// back into stock. Mirrors validateDelivery's force-done handling.
async function returnPicking(pickId) {
  const ctx = { context: { active_id: pickId, active_ids: [pickId], active_model: 'stock.picking' } };
  const defs = await execKw('stock.return.picking', 'default_get',
    [['product_return_moves', 'parent_location_id', 'original_location_id', 'location_id', 'picking_id']], ctx);
  if (!defs.picking_id) defs.picking_id = pickId;
  const wizId = await execKw('stock.return.picking', 'create', [defs], ctx);
  let act;
  try { act = await execKw('stock.return.picking', 'action_create_returns', [[wizId]], ctx); }
  catch (_) { act = await execKw('stock.return.picking', 'create_returns', [[wizId]], ctx); }
  const newPickId = act && (act.res_id || (act.context && act.context.active_id));
  if (newPickId) await validateDelivery(newPickId);
  return newPickId;
}

// ── Reconcile a MyBillBook cancellation / return / rejection into Odoo ─────────
// MyBillBook is the book of record. When staff cancel/return/refuse an order there
// the invoice becomes ₹0 ("Sales Invoice - Cancelled"), stock is restored and the
// day's sale total drops. Odoo still holds the original SO → delivery → invoice
// (+ payment), so it is now OVERSTATED. This unwinds it with proper, auditable
// documents — nothing is deleted:
//   • credit note reversing the customer invoice  (removes revenue + receivable)
//   • reconcile the credit note against the invoice's still-open receivable;
//     any remainder = cash actually collected → refund it (outbound payment) so
//     Odoo cash + receivable end up matching MyBillBook
//   • return picking                               (books flow back into stock)
// Idempotent: if a posted credit note already reverses the invoice AND its
// delivery is already returned, it's a no-op.
//
//   invoiceNo    MyBillBook invoice number, e.g. 'YFB4142'
//   opts.dryRun  true → inspect only; report the plan and change nothing.
async function reverseMbbSale(invoiceNo, opts = {}) {
  if (!isConfigured()) throw new Error('Odoo is not configured');
  const dryRun = !!opts.dryRun;
  const refs = [`mbb:${invoiceNo}`, `sales:${invoiceNo}`];
  const so = await findOne('sale.order', [['client_order_ref', 'in', refs]],
    ['id', 'name', 'state', 'amount_total', 'invoice_ids', 'picking_ids', 'partner_id', 'client_order_ref']);
  if (!so) return { invoiceNo, status: 'not_found', message: 'No Odoo sale for this MyBillBook invoice' };

  const today = new Date().toISOString().slice(0, 10);
  const plan = { invoiceNo, dryRun, so: so.name, soId: so.id,
    customer: (so.partner_id && so.partner_id[1]) || '', amount: round2(so.amount_total),
    invoices: [], pickings: [] };

  // ---- customer invoices on this sale ----
  const invs = (so.invoice_ids && so.invoice_ids.length)
    ? await execKw('account.move', 'search_read',
        [[['id', 'in', so.invoice_ids], ['move_type', '=', 'out_invoice']],
         ['id', 'name', 'state', 'amount_total', 'amount_residual', 'payment_state', 'journal_id']])
    : [];
  const toReverse = [];
  let allReversed = invs.length > 0;
  for (const inv of invs) {
    const cn = await execKw('account.move', 'search_read',
      [[['reversed_entry_id', '=', inv.id], ['move_type', '=', 'out_refund'], ['state', '=', 'posted']],
       ['id', 'name']]);
    if (cn.length) {
      plan.invoices.push({ id: inv.id, name: inv.name, amount: round2(inv.amount_total),
        payment_state: inv.payment_state, action: 'already-reversed', creditNote: cn[0].name });
      continue;
    }
    allReversed = false;
    if (inv.state !== 'posted') {
      plan.invoices.push({ id: inv.id, name: inv.name, amount: round2(inv.amount_total),
        payment_state: inv.payment_state, action: `skip (${inv.state})` });
      continue;
    }
    const paid = (inv.payment_state === 'paid' || inv.payment_state === 'in_payment' || inv.payment_state === 'partial');
    plan.invoices.push({ id: inv.id, name: inv.name, amount: round2(inv.amount_total),
      payment_state: inv.payment_state, action: 'credit-note' + (paid ? ' + refund' : '') });
    toReverse.push(inv);
  }

  // ---- deliveries (return done outgoing pickings so stock comes back) ----
  const picks = (so.picking_ids && so.picking_ids.length)
    ? await execKw('stock.picking', 'search_read',
        [[['id', 'in', so.picking_ids]], ['id', 'name', 'state', 'picking_type_code']])
    : [];
  const toReturn = [];
  for (const pk of picks) {
    if (pk.state === 'done' && pk.picking_type_code === 'outgoing') {
      const back = await execKw('stock.picking', 'search_count', [[['origin', '=', `Return of ${pk.name}`]]]);
      if (back) { plan.pickings.push({ id: pk.id, name: pk.name, action: 'already-returned' }); }
      else { plan.pickings.push({ id: pk.id, name: pk.name, action: 'return' }); toReturn.push(pk); }
    } else {
      plan.pickings.push({ id: pk.id, name: pk.name, state: pk.state, action: 'skip' });
    }
  }

  if (allReversed && !toReturn.length) { plan.status = 'already'; return plan; }
  if (dryRun) { plan.status = 'plan'; return plan; }

  // ================= APPLY =================
  const done = { creditNotes: [], refunds: 0, returns: [] };
  for (const inv of toReverse) {
    // 1 — reverse the invoice → draft credit note
    const ctx = { context: { active_model: 'account.move', active_ids: [inv.id] } };
    const wizId = await execKw('account.move.reversal', 'create',
      [{ move_ids: [[6, 0, [inv.id]]], journal_id: inv.journal_id && inv.journal_id[0],
         date: today, reason: `MyBillBook cancelled ${invoiceNo}` }], ctx);
    await execKw('account.move.reversal', 'reverse_moves', [[wizId]], ctx);
    const wiz = await findOne('account.move.reversal', [['id', '=', wizId]], ['new_move_ids']);
    const cnId = wiz && wiz.new_move_ids && wiz.new_move_ids[0];
    if (!cnId) throw new Error(`credit note not created for ${inv.name}`);
    // 2 — date + post (guard: some refund methods auto-post)
    const cnState = await findOne('account.move', [['id', '=', cnId]], ['state']);
    if (cnState && cnState.state === 'draft') {
      await execKw('account.move', 'write', [[cnId], { invoice_date: today }]);
      await execKw('account.move', 'action_post', [[cnId]]);
    }
    // 3 — reconcile the credit note against the invoice's still-OPEN receivable
    //     (clears the unpaid part). Whatever's left on the credit note = cash that
    //     was really collected → refund it so Odoo cash matches MyBillBook.
    const invAR = await execKw('account.move.line', 'search_read',
      [[['move_id', '=', inv.id], ['account_id.account_type', '=', 'asset_receivable'], ['reconciled', '=', false]], ['id']]);
    const cnAR = await execKw('account.move.line', 'search_read',
      [[['move_id', '=', cnId], ['account_id.account_type', '=', 'asset_receivable'], ['reconciled', '=', false]], ['id']]);
    const recIds = [...invAR.map(l => l.id), ...cnAR.map(l => l.id)];
    if (recIds.length > 1) { try { await execKw('account.move.line', 'reconcile', [recIds]); } catch (e) { console.error('reconcile', inv.name, e.message); } }
    const cnNow = await findOne('account.move', [['id', '=', cnId]], ['name', 'amount_residual']);
    if (cnNow && round2(cnNow.amount_residual) > 0.01) {
      try {
        const journal = await findOne('account.journal', [['type', 'in', ['bank', 'cash']], ['name', '=', MBB_PAY_JOURNAL]], ['id'])
          || await findOne('account.journal', [['type', '=', 'bank']], ['id'])
          || await findOne('account.journal', [['type', '=', 'cash']], ['id']);
        const rctx = { context: { active_model: 'account.move', active_ids: [cnId] } };
        const rwizId = await execKw('account.payment.register', 'create', [{ journal_id: journal.id, payment_date: today }], rctx);
        await execKw('account.payment.register', 'action_create_payments', [[rwizId]], rctx);
        done.refunds++;
      } catch (e) { console.error('refund', inv.name, e.message); }
    }
    done.creditNotes.push(cnNow ? cnNow.name : cnId);
  }

  // 4 — return the deliveries so stock flows back in
  for (const pk of toReturn) {
    try { done.returns.push(await returnPicking(pk.id)); }
    catch (e) { console.error('return picking', pk.name, e.message); }
  }

  plan.status = 'reversed';
  plan.done = done;
  return plan;
}

// ── Reconcile a later PAYMENT from MyBillBook into Odoo ───────────────────────
// An invoice synced while UNPAID (or part-paid) that the customer later settled:
// MyBillBook's Money-In goes up, but Odoo still shows it open. This registers the
// shortfall as a payment on the Bank journal so Odoo's collected amount matches.
// Total unchanged (that's the EDIT path); only the paid amount moved.
//   invoiceNo   MyBillBook invoice number
//   moneyIn     the CURRENT MyBillBook Money-In (total collected) for that invoice
//   opts.dryRun true → report the plan; change nothing.
// Idempotent: re-running once Odoo already matches is a no-op. Never overpays the
// invoice (caps at residual). If MyBillBook shows LESS than Odoo (a reversal), it
// flags manual-review rather than guessing an un-reconcile.
async function applyMbbPayment(invoiceNo, moneyIn, opts = {}) {
  if (!isConfigured()) throw new Error('Odoo is not configured');
  const dryRun = !!opts.dryRun;
  const want = round2(Number(moneyIn) || 0);
  const refs = [`mbb:${invoiceNo}`, `sales:${invoiceNo}`];
  const so = await findOne('sale.order', [['client_order_ref', 'in', refs]], ['id', 'name', 'invoice_ids']);
  if (!so) return { invoiceNo, status: 'not_found' };
  const invs = (so.invoice_ids && so.invoice_ids.length)
    ? await execKw('account.move', 'search_read',
        [[['id', 'in', so.invoice_ids], ['move_type', '=', 'out_invoice'], ['state', '=', 'posted']],
         ['id', 'name', 'amount_total', 'amount_residual', 'payment_state']])
    : [];
  if (!invs.length) return { invoiceNo, status: 'no_invoice', so: so.name };
  const totalNow = round2(invs.reduce((s, i) => s + i.amount_total, 0));
  const paidNow = round2(invs.reduce((s, i) => s + (i.amount_total - i.amount_residual), 0));
  const delta = round2(want - paidNow);
  const plan = { invoiceNo, so: so.name, invoiceTotal: totalNow, odooPaid: paidNow, mbbMoneyIn: want, delta };
  if (Math.abs(delta) <= 1) { plan.status = 'in_sync'; return plan; }
  if (delta < 0) { plan.status = 'manual-review';
    plan.note = 'MyBillBook shows less collected than Odoo — a payment may have been reversed; handle manually.';
    return plan; }
  if (dryRun) { plan.status = 'plan'; return plan; }
  // delta > 0 → register the extra collection, oldest invoice first, capped at residual.
  const today = new Date().toISOString().slice(0, 10);
  let remaining = delta;
  for (const inv of invs.sort((a, b) => a.id - b.id)) {
    if (remaining <= 0.01) break;
    const canPay = round2(inv.amount_residual);
    if (canPay <= 0) continue;
    const pay = round2(Math.min(remaining, canPay));
    await registerPaymentAmount(inv.id, pay, today, MBB_PAY_JOURNAL);
    remaining = round2(remaining - pay);
  }
  const after = await execKw('account.move', 'search_read',
    [[['id', 'in', so.invoice_ids], ['move_type', '=', 'out_invoice']], ['amount_residual', 'payment_state']]);
  plan.status = 'paid';
  plan.applied = round2(delta - remaining);
  plan.residualLeft = round2(after.reduce((s, i) => s + i.amount_residual, 0));
  return plan;
}

module.exports = {
  isConfigured,
  reverseMbbSale,
  applyMbbPayment,
  createServiceInvoice,
  createSubscriptionInvoice,
  createClubMembershipInvoice,
  createDirectSaleInvoice,
  createDirectSaleOrder,
  createMbbSaleOrder,
  createMbbPurchaseOrder,
  createMbbExpenseBill,
  applyStockSnapshot,
  getInvoicePdfBase64,
  // exported for the setup/test scripts
  execKw, findOne, authenticate, jsonrpc,
};
