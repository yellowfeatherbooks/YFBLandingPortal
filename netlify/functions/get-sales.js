// get-sales.js
// Returns sales for all books belonging to an author (submitted OR admin-linked).
// Finds products tagged  submittedby:{email}  then scans Shopify orders.
// Also merges direct (offline) sales from the direct_sales Supabase table.

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

async function shopifyGQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({ query, variables })
    }
  );
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

// Extract numeric ID from GID string  gid://shopify/Product/1234  →  "1234"
function numId(gid) {
  if (!gid) return '';
  return String(gid).split('/').pop();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST')    return json({ sales: [] });

  try {
    const { email, from, to } = JSON.parse(event.body || '{}');
    if (!email) return json({ sales: [] });

    // Build date clause for Shopify query  e.g.  created_at:>='2026-05-23' created_at:<='2026-05-30'
    let dateClause = '';
    if (from) dateClause += ` created_at:>='${from}'`;
    if (to)   dateClause += ` created_at:<='${to}T23:59:59'`;

    if (!SHOPIFY_TOKEN) {
      return json({ sales: [], error: 'SHOPIFY_ADMIN_TOKEN not set' });
    }

    // ── Step 1: Products tagged submittedby:{email} ────────────────────────
    // Use GraphQL variables to avoid injection / escaping issues
    const prodData = await shopifyGQL(
      `query GetAuthorProducts($q: String!) {
        products(first: 100, query: $q) {
          edges {
            node { id title handle }
          }
        }
      }`,
      { q: `tag:'submittedby:${email}'` }
    );

    const products = (prodData?.products?.edges || []).map(e => e.node);

    // Debug: return early with product list if no products found
    if (!products.length) {
      return json({
        sales: [],
        _debug: {
          message: 'No products found with submittedby tag',
          tag_searched: `submittedby:${email}`,
          hint: 'Admin must link books to this author first via the Link Books panel'
        }
      });
    }

    // Build lookup by both GID and numeric ID for safe matching
    const byGid    = new Map(products.map(p => [p.id,        p.title]));
    const byNumId  = new Map(products.map(p => [numId(p.id), p.title]));

    function matchProduct(lineItemProduct) {
      if (!lineItemProduct) return null;
      return byGid.get(lineItemProduct.id) || byNumId.get(numId(lineItemProduct.id)) || null;
    }

    // ── Step 2: Scan orders — two passes: open + closed ───────────────────
    // Shopify GQL returns open orders by default; we need closed ones too.
    const sales      = [];
    let ordersScanned = 0;

    for (const statusFilter of [`status:open${dateClause}`, `status:closed${dateClause}`, `status:cancelled${dateClause}`]) {
      let cursor  = null;
      let hasMore = true;
      let pages   = 0;

      while (hasMore && pages < 4) {   // max 1000 orders per status
        pages++;
        const afterArg = cursor ? `, after: "${cursor}"` : '';

        const orderData = await shopifyGQL(`{
          orders(first: 250, query: "${statusFilter}"${afterArg}) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                lineItems(first: 50) {
                  edges {
                    node {
                      title
                      quantity
                      originalUnitPriceSet {
                        shopMoney { amount currencyCode }
                      }
                      product { id }
                    }
                  }
                }
              }
            }
          }
        }`);

        const edges    = orderData?.orders?.edges    || [];
        const pageInfo = orderData?.orders?.pageInfo || {};
        ordersScanned += edges.length;

        for (const { node: order } of edges) {
          for (const { node: item } of (order.lineItems?.edges || [])) {
            const bookTitle = matchProduct(item.product);
            if (!bookTitle) continue;

            const price = parseFloat(item.originalUnitPriceSet?.shopMoney?.amount || 0);
            const qty   = item.quantity || 1;

            sales.push({
              book_title:         item.title || bookTitle,
              order_number:       order.name,          // already "#1042" format
              date:               order.createdAt,
              quantity:           qty,
              unit_price:         price,
              revenue:            +(price * qty).toFixed(2),
              financial_status:   (order.displayFinancialStatus  || '').toLowerCase(),
              fulfillment_status: (order.displayFulfillmentStatus || 'unfulfilled').toLowerCase(),
              source:             'online'
            });
          }
        }

        hasMore = pageInfo.hasNextPage;
        cursor  = pageInfo.endCursor || null;
      }
    }

    // ── Step 3: Fetch direct (offline) sales from Supabase ───────────────────
    if (SUPABASE_URL && SUPABASE_KEY) {
      try {
        let directUrl = `${SUPABASE_URL}/rest/v1/direct_sales?author_email=eq.${encodeURIComponent(email)}&order=sale_date.desc`;
        if (from) directUrl += `&sale_date=gte.${from}`;
        if (to)   directUrl += `&sale_date=lte.${to}`;
        const dRes = await fetch(directUrl, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (dRes.ok) {
          const directRows = await dRes.json();
          for (const d of (directRows || [])) {
            sales.push({
              book_title:         d.book_title,
              order_number:       d.notes || '—',
              date:               d.sale_date,
              quantity:           d.quantity || 1,
              unit_price:         d.quantity ? +(d.amount / d.quantity).toFixed(2) : +d.amount,
              revenue:            +d.amount,
              financial_status:   'paid',
              fulfillment_status: 'fulfilled',
              source:             'direct'
            });
          }
        }
      } catch (dErr) {
        console.warn('direct_sales fetch failed:', dErr.message);
      }
    }

    // Sort newest first
    sales.sort((a, b) => new Date(b.date) - new Date(a.date));

    return json({
      sales,
      _debug: {
        products_found: products.length,
        product_titles: products.map(p => p.title),
        orders_scanned: ordersScanned,
        sales_found:    sales.length,
        date_from:      from || 'any',
        date_to:        to   || 'any'
      }
    });

  } catch (err) {
    console.error('get-sales error:', err.message);
    return json({ sales: [], error: err.message });
  }
};
