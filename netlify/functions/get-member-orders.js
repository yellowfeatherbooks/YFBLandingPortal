// get-member-orders.js
// Returns ALL of the logged-in member's orders — INCLUDING cancelled / refunded /
// voided — via the Admin API. (Shopify's Storefront customer.orders deliberately
// EXCLUDES cancelled orders, which is why they vanished from "My Orders" once
// voided.) The member's email is derived from their verified Storefront customer
// access token, so a member can only ever see their own orders.
//
// POST { token }   ->   { orders: [ <storefront-shaped order> ] }

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const SF_TOKEN       = process.env.SHOPIFY_STOREFRONT_TOKEN || process.env.STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';
const API            = '2024-01';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body, status = 200) => ({ statusCode: status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function gql(path, token, headerName, query, variables) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [headerName]: token },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ orders: [] });

  try {
    const { token } = JSON.parse(event.body || '{}');
    if (!token) return json({ orders: null, needLogin: true });
    if (!ADMIN_TOKEN) return json({ orders: null, error: 'admin token not set' });

    // 1) Resolve the verified email from the member's storefront access token.
    // A valid token -> { customer: { email } }; an EXPIRED / invalid token ->
    // { customer: null } with NO GraphQL error. Treat that as a dead session so
    // the UI can prompt re-login instead of silently showing "No Orders Yet".
    const who = await gql(`/api/${API}/graphql.json`, SF_TOKEN, 'X-Shopify-Storefront-Access-Token',
      `query($t:String!){ customer(customerAccessToken:$t){ email } }`, { t: token });
    const email = who?.customer?.email;
    if (!email) return json({ orders: null, authExpired: true });

    // 2) ALL orders for that email via Admin (includes cancelled / refunded / voided)
    const data = await gql(`/admin/api/${API}/graphql.json`, ADMIN_TOKEN, 'X-Shopify-Access-Token',
      `query($q:String!,$n:Int!){
        orders(first:$n, query:$q, sortKey:CREATED_AT, reverse:true){
          edges{ node{
            name processedAt createdAt cancelledAt
            displayFinancialStatus displayFulfillmentStatus
            currentTotalPriceSet{ shopMoney{ amount currencyCode } }
            lineItems(first:15){ edges{ node{ title quantity
              variant{ image{ url } price product{ handle } } } } }
            fulfillments(first:1){ trackingInfo{ number url } }
          } }
        }
      }`, { q: `email:${email}`, n: 50 });

    const orders = (data?.orders?.edges || []).map(({ node: o }) => ({
      name: o.name,
      processedAt: o.processedAt || o.createdAt,
      cancelledAt: o.cancelledAt || null,
      financialStatus: o.displayFinancialStatus,
      fulfillmentStatus: o.displayFulfillmentStatus,
      currentTotalPrice: {
        amount: o.currentTotalPriceSet?.shopMoney?.amount || '0',
        currencyCode: o.currentTotalPriceSet?.shopMoney?.currencyCode || 'INR'
      },
      lineItems: { edges: (o.lineItems?.edges || []).map(({ node: li }) => ({
        node: {
          title: li.title, quantity: li.quantity,
          variant: li.variant ? {
            image: li.variant.image || null,
            price: { amount: li.variant.price || '0' },
            product: li.variant.product || null
          } : null
        }
      })) },
      successfulFulfillments: (o.fulfillments || []).slice(0, 1).map(f => ({ trackingInfo: f.trackingInfo || [] }))
    }));

    return json({ orders });
  } catch (e) {
    return json({ orders: null, error: e.message });
  }
};
