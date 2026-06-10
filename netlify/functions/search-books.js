// Returns structured book data (with images + variant IDs) for the chat widget card view.
// GET /.netlify/functions/search-books?q=Madhavikutty

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2025-04';
const GQL_URL        = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const json = (body, status = 200) => ({
  statusCode: status,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const q = event.queryStringParameters?.q || '';
  if (!q.trim()) return json({ books: [] });

  const query = `
    query($q: String!) {
      products(first: 6, query: $q, sortKey: RELEVANCE) {
        edges {
          node {
            id
            title
            handle
            tags
            images(first: 1) {
              edges { node { url altText } }
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  compareAtPrice
                  inventoryQuantity
                  inventoryPolicy
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(GQL_URL, {
      method:  'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables: { q: `${q} status:active` } })
    });

    const data = await res.json();
    const edges = data?.data?.products?.edges || [];

    const books = edges.map(({ node: p }) => {
      const v   = p.variants?.edges?.[0]?.node;
      const img = p.images?.edges?.[0]?.node;

      // Extract numeric variant ID for cart
      const variantGid = v?.id || '';
      const variantId  = variantGid.replace('gid://shopify/ProductVariant/', '');

      const qty = v?.inventoryQuantity ?? -1;
      const tracked = v?.inventoryPolicy !== 'continue';
      const inStock = !tracked || qty > 0;

      return {
        title:      p.title,
        handle:     p.handle,
        variantId,
        price:      v?.price || '0',
        mrp:        v?.compareAtPrice || null,
        image:      img?.url || null,
        imageAlt:   img?.altText || p.title,
        inStock,
        qty:        tracked ? qty : null,
      };
    });

    return json({ books });
  } catch (e) {
    console.error('search-books error:', e.message);
    return json({ books: [], error: e.message });
  }
};
