// Triggers Shopify's native password reset email for any customer (members + authors).
// Uses the Storefront API customerRecover mutation — Shopify sends the reset link directly.
// Always returns success to prevent email enumeration.
// POST { email }

const SHOPIFY_DOMAIN   = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || 'ae73197f5be74e707d3f9ef8d2ee1593';
const API_VERSION      = '2024-01';

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
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  const { email } = JSON.parse(event.body || '{}');
  if (!email) return json({ error: 'Email is required' }, 400);

  try {
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/api/${API_VERSION}/graphql.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type':                      'application/json',
          'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN
        },
        body: JSON.stringify({
          query: `mutation customerRecover($email: String!) {
            customerRecover(email: $email) {
              customerUserErrors { code field message }
            }
          }`,
          variables: { email: email.trim().toLowerCase() }
        })
      }
    );

    const data   = await res.json();
    const errors = data?.data?.customerRecover?.customerUserErrors || [];

    // Log errors server-side but always return success to client (prevents enumeration)
    if (errors.length) {
      console.warn('customerRecover errors for', email, JSON.stringify(errors));
    } else {
      console.log('Password reset email triggered for:', email);
    }

    // Always respond with success — if account doesn't exist, Shopify silently ignores it
    return json({ success: true, message: 'If an account exists for this email, a reset link has been sent.' });

  } catch (e) {
    console.error('shopify-recover-password error:', e.message);
    // Still return success to prevent enumeration
    return json({ success: true, message: 'If an account exists for this email, a reset link has been sent.' });
  }
};
