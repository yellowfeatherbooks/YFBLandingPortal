// lib/shopify-customer.js
// Best-effort lookup of a customer's state (province) from their Shopify account,
// used to drive GST place-of-supply (intra-Kerala CGST+SGST vs inter-state IGST).
//
// Returns the full Indian state name (e.g. "Kerala", "Karnataka") matching Odoo's
// res.country.state names, or null when there's no address on record — in which
// case the invoice falls back to the supplier state (intra), the defensible B2C
// default. Never throws.
//
// Env: SHOPIFY_ADMIN_TOKEN (required), SHOPIFY_DOMAIN, SHOPIFY_API_VERSION

const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN      || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = process.env.SHOPIFY_API_VERSION || '2024-01';

async function getCustomerStateByEmail(email) {
  if (!email || !SHOPIFY_TOKEN) return null;
  try {
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers/search.json` +
      `?query=email:${encodeURIComponent(email)}&fields=default_address&limit=1`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data && data.customers && data.customers[0] && data.customers[0].default_address;
    if (!addr) return null;
    // Only trust Indian addresses for the GST split.
    if (addr.country_code && addr.country_code !== 'IN') return null;
    return addr.province || null;          // full state name, matches Odoo
  } catch (e) {
    console.warn('shopify state lookup failed:', e.message);
    return null;
  }
}

module.exports = { getCustomerStateByEmail };
