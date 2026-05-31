// admin-book-lookup.js
// Lightweight Shopify title autocomplete for the admin Direct Sales form.
// POST { query } — returns up to 8 matching products with title + cover + price.
// No Claude, no Serper — direct Shopify Storefront search only.

const SHOPIFY_STORE = process.env.SHOPIFY_DOMAIN        || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ books: [] });

  const { query } = JSON.parse(event.body || '{}');
  if (!query || query.trim().length < 2) return json({ books: [] });

  if (!SHOPIFY_TOKEN) return json({ books: [], error: 'Storefront token not configured' });

  const q = query.replace(/"/g, '').trim().substring(0, 60);

  const gql = `{
    products(first: 8, query: "title:${q}*") {
      edges {
        node {
          title
          handle
          priceRange { minVariantPrice { amount } }
          images(first: 1) { edges { node { url } } }
        }
      }
    }
  }`;

  try {
    const res  = await fetch(`https://${SHOPIFY_STORE}/api/2024-01/graphql.json`, {
      method:  'POST',
      headers: {
        'Content-Type':                      'application/json',
        'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({ query: gql })
    });
    const data = await res.json();
    const edges = data.data?.products?.edges || [];
    const books = edges.map(({ node }) => ({
      title:    node.title,
      handle:   node.handle,
      coverUrl: node.images?.edges?.[0]?.node?.url || '',
      price:    node.priceRange?.minVariantPrice?.amount
                  ? `₹${parseFloat(node.priceRange.minVariantPrice.amount).toFixed(0)}`
                  : ''
    }));
    return json({ books });
  } catch (err) {
    console.error('admin-book-lookup error:', err.message);
    return json({ books: [], error: err.message });
  }
};
