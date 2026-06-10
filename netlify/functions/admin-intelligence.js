// Sales Intelligence Dashboard
// POST { adminEmail, adminKey, action, ...params }
// Actions: search-trends | cart-insights | demand-gap

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2024-01';

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

async function verifyAdmin(email, adminKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

async function verifySales(email, key) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/sales_team?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === key;
}

async function shopifyGql(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return res.json();
}

async function shopifyGet(path) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/${path}`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  return res.json();
}

// ── 1. Search Trends ────────────────────────────────────────────────────────
async function getSearchTrends(days = 30) {
  try {
    // Use Shopify ShopifyQL for search analytics
    const gqlData = await shopifyGql(`
      {
        shopifyqlQuery(query: "FROM shopify_seo SHOW query, sessions SINCE -${days}d ORDER BY sessions DESC LIMIT 25") {
          ... on TableResponse {
            tableData {
              headers { name }
              rowData
            }
          }
          parseErrors { code message }
        }
      }
    `);

    const table = gqlData?.data?.shopifyqlQuery?.tableData;
    if (table?.rowData?.length) {
      const headers = table.headers.map(h => h.name);
      const qIdx = headers.indexOf('query');
      const sIdx = headers.indexOf('sessions');
      const trends = table.rowData
        .map(row => ({ query: row[qIdx], sessions: parseInt(row[sIdx] || 0) }))
        .filter(t => t.query && t.query !== '(not provided)');
      return { success: true, trends, source: 'shopifyql', days };
    }
  } catch(e) {}

  // Fallback: use Shopify search results from order data analysis
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const data  = await shopifyGet(`orders.json?status=any&limit=250&created_at_min=${since}&fields=note_attributes,line_items`);
    // Extract search-related note attributes
    const searchMap = {};
    for (const order of (data.orders || [])) {
      for (const item of (order.line_items || [])) {
        const title = item.title;
        if (title) searchMap[title] = (searchMap[title] || 0) + 1;
      }
    }
    const trends = Object.entries(searchMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([query, sessions]) => ({ query, sessions }));
    return { success: true, trends, source: 'orders', days };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── 2. Cart Insights ────────────────────────────────────────────────────────
async function getCartInsights(days = 30) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const data  = await shopifyGet(`checkouts.json?limit=250&updated_at_min=${since}`);
    const checkouts = (data.checkouts || []).filter(c => !c.completed_at && c.line_items?.length);

    // Most abandoned books
    const bookMap = {};
    const hourMap = Array(24).fill(0);
    let totalValue = 0, totalCount = 0;
    const memberCount = { member: 0, author: 0, guest: 0 };

    for (const c of checkouts) {
      totalCount++;
      totalValue += parseFloat(c.total_price || 0);

      const hour = new Date(c.updated_at).getHours();
      hourMap[hour]++;

      const tags = (c.customer?.tags || '').toLowerCase();
      if (tags.includes('member') || tags.includes('club_member')) memberCount.member++;
      else if (tags.includes('author')) memberCount.author++;
      else memberCount.guest++;

      for (const item of (c.line_items || [])) {
        const key = item.title;
        if (!bookMap[key]) bookMap[key] = { title: key, count: 0, value: 0, handle: item.handle || '' };
        bookMap[key].count++;
        bookMap[key].value += parseFloat(item.price || 0);
      }
    }

    const topAbandoned = Object.values(bookMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // Peak abandonment hours
    const peakHour = hourMap.indexOf(Math.max(...hourMap));

    return {
      success: true,
      summary: {
        totalAbandoned: totalCount,
        totalValue: totalValue.toFixed(2),
        avgValue:  totalCount ? (totalValue / totalCount).toFixed(2) : '0',
        memberBreakdown: memberCount,
        peakHour,
        peakHourLabel: `${peakHour}:00 – ${peakHour + 1}:00`
      },
      topAbandoned,
      hourlyData: hourMap,
      days
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── 3. Demand Gap ───────────────────────────────────────────────────────────
async function getDemandGap(days = 30) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Fetch in parallel: book requests + abandoned carts + sold-out products
    const [reqRes, checkoutData, inventoryData] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/book_requests?created_at=gte.${encodeURIComponent(since)}&select=book_title,author_name,created_at&order=created_at.desc`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }),
      shopifyGet(`checkouts.json?limit=250&updated_at_min=${since}`),
      shopifyGet(`products.json?status=active&limit=250&fields=id,title,variants`)
    ]);

    const bookRequests = await reqRes.json();
    const checkouts   = (checkoutData.checkouts || []).filter(c => !c.completed_at);
    const products    = inventoryData.products || [];

    // Requested books (grouped)
    const requestMap = {};
    for (const r of (bookRequests || [])) {
      const key = (r.book_title || '').trim().toLowerCase();
      if (!requestMap[key]) requestMap[key] = { title: r.book_title, author: r.author_name, requests: 0 };
      requestMap[key].requests++;
    }
    const topRequested = Object.values(requestMap)
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 15);

    // Abandoned cart books (demand signal)
    const abandonedMap = {};
    for (const c of checkouts) {
      for (const item of (c.line_items || [])) {
        const key = (item.title || '').toLowerCase();
        if (!abandonedMap[key]) abandonedMap[key] = { title: item.title, abandonedCount: 0 };
        abandonedMap[key].abandonedCount++;
      }
    }
    const topAbandoned = Object.values(abandonedMap)
      .sort((a, b) => b.abandonedCount - a.abandonedCount)
      .slice(0, 15);

    // Out-of-stock products
    const outOfStock = products
      .filter(p => p.variants?.every(v => v.inventory_quantity <= 0))
      .map(p => ({ id: p.id, title: p.title }))
      .slice(0, 15);

    return {
      success: true,
      topRequested,
      topAbandoned,
      outOfStock,
      summary: {
        totalRequests:   (bookRequests || []).length,
        totalAbandoned:  checkouts.length,
        outOfStockCount: outOfStock.length
      },
      days
    };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const body = JSON.parse(event.body || '{}');
  const { adminEmail, adminKey, action, days = 30 } = body;

  const isAdmin = await verifyAdmin(adminEmail, adminKey);
  const isSales = !isAdmin && await verifySales(adminEmail, adminKey);
  if (!isAdmin && !isSales) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    if (action === 'search-trends') return json(await getSearchTrends(days));
    if (action === 'cart-insights') return json(await getCartInsights(days));
    if (action === 'demand-gap')    return json(await getDemandGap(days));
    return json({ success: false, error: 'Unknown action' }, 400);
  } catch(e) {
    return json({ success: false, error: e.message });
  }
};
