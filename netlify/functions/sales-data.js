// Sales team data endpoint — handles all sales portal data needs.
// POST { salesEmail, salesKey, action, ...params }
// Actions: orders | trending | book-requests | stock-check | direct-sales

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2025-04';

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

async function verifySales(email, salesKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/sales_team?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === salesKey;
}

async function shopifyGet(path) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/${path}`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  return res.json();
}

async function shopifyGql(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

// ── Action handlers ─────────────────────────────────────────────────────────

async function getOrders({ status = 'any', limit = 50, customer_type }) {
  const fetchLimit = customer_type ? 250 : limit;
  const data = await shopifyGet(
    `orders.json?status=${status}&limit=${fetchLimit}&fields=id,name,email,created_at,financial_status,fulfillment_status,total_price,line_items,customer,shipping_address`
  );
  let orders = (data.orders || []).map(o => {
    const sa = o.shipping_address || {};
    const tags = (o.customer?.tags || '').toLowerCase().split(',').map(t => t.trim());
    return {
      id:                 o.id,
      name:               o.name,
      email:              o.email || o.customer?.email || '',
      customer:           [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || '—',
      city:               sa.city || '',
      customer_tags:      o.customer?.tags || '',
      is_member:          tags.includes('member') || tags.includes('club_member'),
      is_author:          tags.includes('author'),
      created_at:         o.created_at,
      financial_status:   o.financial_status,
      fulfillment_status: o.fulfillment_status || 'unfulfilled',
      total_price:        o.total_price,
      items:              (o.line_items || []).map(l => ({ title: l.title, quantity: l.quantity, price: l.price }))
    };
  });
  if (customer_type === 'member') orders = orders.filter(o => o.is_member);
  if (customer_type === 'author') orders = orders.filter(o => o.is_author);
  return json({ success: true, orders });
}

async function getTrending({ days = 30 }) {
  // Fetch recent orders and aggregate by product
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const data  = await shopifyGet(
    `orders.json?status=any&limit=250&created_at_min=${since}&fields=line_items,financial_status`
  );
  const orders = (data.orders || []).filter(o => o.financial_status !== 'voided');

  // Aggregate by product title
  const bookMap = {};
  const genreMap = {};
  for (const o of orders) {
    for (const item of (o.line_items || [])) {
      const title = item.title;
      if (!bookMap[title]) bookMap[title] = { title, units: 0, revenue: 0 };
      bookMap[title].units   += item.quantity || 1;
      bookMap[title].revenue += parseFloat(item.price || 0) * (item.quantity || 1);
    }
  }

  const topBooks = Object.values(bookMap)
    .sort((a, b) => b.units - a.units)
    .slice(0, 15)
    .map(b => ({ ...b, revenue: b.revenue.toFixed(2) }));

  // Fetch slow movers — products with no recent sales
  const allProductsData = await shopifyGet(`products.json?limit=250&fields=id,title,status`);
  const soldTitles = new Set(Object.keys(bookMap));
  const slowMovers = (allProductsData.products || [])
    .filter(p => p.status === 'active' && !soldTitles.has(p.title))
    .slice(0, 20)
    .map(p => ({ id: p.id, title: p.title }));

  return json({ success: true, topBooks, slowMovers, orderCount: orders.length, days });
}

async function getBookRequests() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/book_requests?select=*&order=created_at.desc&limit=100`,
    { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
  );
  const requests = await res.json();
  return json({ success: true, requests: Array.isArray(requests) ? requests : [] });
}

async function stockCheck({ query }) {
  if (!query) return json({ success: false, error: 'Search query required' }, 400);
  const data = await shopifyGql(`
    query($q: String!) {
      products(first: 8, query: $q) {
        edges {
          node {
            id title status
            variants(first: 1) {
              edges {
                node {
                  price compareAtPrice sku barcode
                  inventoryQuantity
                  inventoryItem { tracked }
                }
              }
            }
            images(first: 1) { edges { node { url } } }
          }
        }
      }
    }`, { q: query });

  const products = (data?.data?.products?.edges || []).map(e => {
    const v   = e.node.variants.edges[0]?.node || {};
    const img = e.node.images.edges[0]?.node?.url || '';
    return {
      id:        e.node.id,
      title:     e.node.title,
      status:    e.node.status,
      price:     v.price,
      compareAt: v.compareAtPrice,
      sku:       v.sku,
      barcode:   v.barcode,
      stock:     v.inventoryQuantity ?? '—',
      tracked:   v.inventoryItem?.tracked ?? false,
      image:     img
    };
  });
  return json({ success: true, products });
}

async function directSales({ action, salesEmail, ...body }) {
  if (action === 'list') {
    const filter = body.author_email
      ? `&author_email=eq.${encodeURIComponent(body.author_email)}`
      : '';
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/direct_sales?select=*&order=sale_date.desc${filter}`,
      { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
    );
    const rows = await res.json();
    return json({ success: true, sales: Array.isArray(rows) ? rows : [] });
  }

  if (action === 'add') {
    const { book_title, quantity, amount, sale_date, order_number, payment_status, notes, author_email } = body;
    if (!book_title || !quantity || !amount || !sale_date) {
      return json({ success: false, error: 'book_title, quantity, amount and sale_date are required' }, 400);
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/direct_sales`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation'
      },
      body: JSON.stringify({
        book_title, author_email: author_email || null,
        quantity: parseInt(quantity), amount: parseFloat(amount),
        sale_date, order_number: order_number || null,
        payment_status: payment_status || 'paid',
        notes: notes || null,
        recorded_by: salesEmail
      })
    });
    const row = await res.json();
    return json({ success: true, sale: Array.isArray(row) ? row[0] : row });
  }

  return json({ success: false, error: 'Unknown action' }, 400);
}

// ── Metaobject options (for Add Book dropdowns) ──────────────────────────────

async function getMetaobjectOptions() {
  // Metaobject definition GIDs for Print Books category metafields
  // Confirmed from metafield definitions query (type: list.metaobject_reference)
  const DEF_GIDS = {
    genre:           'gid://shopify/MetaobjectDefinition/11374723376',
    bookCoverType:   'gid://shopify/MetaobjectDefinition/11374985520',
    languageVersion: 'gid://shopify/MetaobjectDefinition/11374952752',
    targetAudience:  'gid://shopify/MetaobjectDefinition/11374756144',
  };

  async function fetchByDefGid(defGid) {
    const typeData = await shopifyGql(`query($id: ID!) { metaobjectDefinition(id: $id) { type } }`, { id: defGid });
    const type = typeData?.data?.metaobjectDefinition?.type;
    if (!type) { console.warn('No type for defGid:', defGid); return []; }
    const data = await shopifyGql(`query($type: String!) { metaobjects(type: $type, first: 250) { edges { node { id displayName handle } } } }`, { type });
    const entries = (data?.data?.metaobjects?.edges || [])
      .map(e => ({ id: e.node.id, label: e.node.displayName || e.node.handle }))
      .sort((a, b) => a.label.localeCompare(b.label));
    console.log('Fetched', type, ':', entries.length, 'entries');
    return entries;
  }

  const [genre, bookCoverType, languageVersion, targetAudience] = await Promise.all([
    fetchByDefGid(DEF_GIDS.genre),
    fetchByDefGid(DEF_GIDS.bookCoverType),
    fetchByDefGid(DEF_GIDS.languageVersion),
    fetchByDefGid(DEF_GIDS.targetAudience),
  ]);

  console.log('Options — genre:', genre.length, 'cover:', bookCoverType.length, 'language:', languageVersion.length, 'audience:', targetAudience.length);
  return json({ success: true, genre, bookCoverType, languageVersion, targetAudience });
}

// ── Submit Book (creates draft in Shopify, pending admin approval) ────────────

async function submitBook(body, salesEmail) {
  const { book, author, publisher, genre, shopifyTags, description, mrp, salePrice, barcode, phone, cover, metafields, initialStock } = body;
  const stockQty = Math.max(1, parseInt(initialStock) || 1);

  if (!book || !author || !publisher || !genre || !mrp || !barcode) {
    return json({ success: false, error: 'All required fields must be filled' }, 400);
  }

  const webhookUrl = process.env.N8N_SUBMIT_BOOK_URL;
  if (!webhookUrl) return json({ success: false, error: 'N8N_SUBMIT_BOOK_URL not configured in Netlify env vars' }, 503);

  // Step 1 — Create draft product via n8n
  let n8nRes, data;
  try {
    n8nRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: salesEmail, name: 'Sales Team',
        book, author, publisher, genre,
        shopifyTags: shopifyTags || [],
        description, mrp, salePrice: salePrice || null,
        barcode, phone, cover
      })
    });
    const text = await n8nRes.text();
    try { data = JSON.parse(text); } catch(e) {
      return json({ success: false, error: `n8n returned non-JSON (status ${n8nRes.status}): ${text.slice(0, 200)}` });
    }
  } catch(e) {
    return json({ success: false, error: `n8n webhook call failed: ${e.message}` });
  }
  if (!data.success && data.status !== 'success') return json(data);

  const rawId     = data.shopifyId || data.shopify_Id || null;
  const shopifyId = rawId;
  // Normalise to GID — n8n may return numeric ID or full GID
  const productGid = rawId
    ? (String(rawId).startsWith('gid://') ? String(rawId) : `gid://shopify/Product/${rawId}`)
    : null;

  // Step 2 — Force product to DRAFT so it is NOT visible until admin approves
  if (productGid && SHOPIFY_TOKEN) {
    const draftRes = await shopifyGql(
      `mutation productUpdate($input: ProductInput!) {
         productUpdate(input: $input) {
           product { id status }
           userErrors { field message }
         }
       }`,
      { input: { id: productGid, status: 'DRAFT' } }
    );
    const draftErrors = draftRes?.data?.productUpdate?.userErrors || [];
    if (draftErrors.length) console.warn('setProductDraft errors:', JSON.stringify(draftErrors));
    else console.log('Product set to DRAFT:', productGid);
  } else {
    console.warn('Cannot set draft — productGid:', productGid, 'token set:', !!SHOPIFY_TOKEN);
  }

  // Step 3 — Set Print Books category + metafields on the draft product
  // Category MUST be set first — shopify.* metafields are constrained to products with Print Books category
  if (productGid && SHOPIFY_TOKEN) {
    const PRINT_BOOKS_GID = 'gid://shopify/TaxonomyCategory/me-1-3';
    const listVal = (gids) => JSON.stringify((gids || []).filter(Boolean));
    const mfInput = [];
    if (metafields?.genreGids?.length)           mfInput.push({ namespace: 'shopify', key: 'genre',            value: listVal(metafields.genreGids) });
    if (metafields?.bookCoverTypeGids?.length)   mfInput.push({ namespace: 'shopify', key: 'book-cover-type',  value: listVal(metafields.bookCoverTypeGids) });
    if (metafields?.languageVersionGids?.length) mfInput.push({ namespace: 'shopify', key: 'language-version', value: listVal(metafields.languageVersionGids) });
    if (metafields?.targetAudienceGids?.length)  mfInput.push({ namespace: 'shopify', key: 'target-audience',  value: listVal(metafields.targetAudienceGids) });
    if (author) mfInput.push({ namespace: 'custom', key: 'author', value: author });

    const updateInput = { id: productGid, category: PRINT_BOOKS_GID };
    if (mfInput.length) updateInput.metafields = mfInput;

    const upRes = await shopifyGql(
      `mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id category { name } } userErrors { field message } } }`,
      { input: updateInput }
    );
    const upErrors = upRes?.data?.productUpdate?.userErrors || [];
    if (upErrors.length) console.warn('Category/metafield errors:', JSON.stringify(upErrors));
    else console.log('Category + metafields set on draft:', upRes?.data?.productUpdate?.product?.category?.name, '— metafields:', mfInput.length);
  }

  // Step 5 — Save to Supabase as under_review (initial_stock stored for approval step)
  if (SUPABASE_URL && SUPABASE_KEY) {
    await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        title: book, author, publisher, genre,
        mrp: parseFloat(mrp), status: 'under_review',
        submitted_date: new Date().toISOString(),
        submitted_by: salesEmail,
        shopify_id: shopifyId,
        initial_stock: stockQty,
      })
    });
  }

  return json({ ...data, shopifyId });
}

// ── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const body = JSON.parse(event.body || '{}');
  const { salesEmail, salesKey, action } = body;

  if (!await verifySales(salesEmail, salesKey)) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    switch (action) {
      case 'orders':        return getOrders(body);
      case 'trending':      return getTrending(body);
      case 'book-requests': return getBookRequests();
      case 'stock-check':   return stockCheck(body);
      case 'direct-sales':      return directSales({ ...body, salesEmail });
      case 'metaobject-options': return getMetaobjectOptions();
      case 'submit-book':        return submitBook(body, salesEmail);
      default:                   return json({ success: false, error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    console.error('sales-data error:', action, e.message);
    return json({ success: false, error: e.message }, 500);
  }
};
