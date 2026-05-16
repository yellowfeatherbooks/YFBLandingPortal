const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { customerAccessToken } = JSON.parse(event.body || '{}');
    if (!customerAccessToken) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Missing customerAccessToken' })
    };

    // 1 — Get customer ID from Storefront API
    const sfRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/api/2024-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `{ customer(customerAccessToken: "${customerAccessToken}") { id } }`
        })
      }
    );
    const sfData = await sfRes.json();
    const gid = sfData?.data?.customer?.id;
    if (!gid) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: 'Customer not found' })
    };

    // 2 — Extract numeric ID from gid://shopify/Customer/1234567890
    const numericId = gid.split('/').pop();

    // 3 — Delete via Admin API
    const delRes = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers/${numericId}.json`,
      {
        method: 'DELETE',
        headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
      }
    );

    if (delRes.status === 200 || delRes.status === 204) {
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true })
      };
    }

    const errBody = await delRes.text();
    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: errBody })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
