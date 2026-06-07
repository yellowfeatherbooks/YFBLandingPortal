// Fetches metaobject entries for the 4 book category metafields.
// POST { adminEmail, adminKey, debug? }

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
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

async function verifyAdmin(email, adminKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

async function shopifyGql(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query, variables })
    }
  );
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    // Print Books category GID — confirmed from taxonomy search logs
    const PRINT_BOOKS_GID = 'gid://shopify/TaxonomyCategory/me-1-3';

    // Use categories(search:) — 'category(id:)' singular does not exist in Shopify's schema
    const data = await shopifyGql(`{
      taxonomy {
        categories(search: "Print Books", first: 1) {
          edges {
            node {
              id name
              attributes {
                edges {
                  node {
                    id name
                    values(first: 250) {
                      edges { node { id name } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`);

    const catNode  = data?.data?.taxonomy?.categories?.edges?.[0]?.node;
    console.log('Taxonomy errors:', JSON.stringify(data?.errors));
    console.log('Taxonomy attributes:', JSON.stringify(catNode?.attributes?.edges?.map(e => ({ name: e.node.name, count: e.node.values?.edges?.length }))));

    const attrEdges = catNode?.attributes?.edges || [];

    function extractAttr(nameMatch) {
      const edge = attrEdges.find(e => e.node.name.toLowerCase().includes(nameMatch.toLowerCase()));
      if (!edge) return [];
      return (edge.node.values?.edges || [])
        .map(e => ({ id: e.node.id, label: e.node.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }

    const genre           = extractAttr('genre');
    const bookCoverType   = extractAttr('cover');
    const languageVersion = extractAttr('language');
    const targetAudience  = extractAttr('audience');

    // If nothing came back, log metafield definitions for diagnostics
    if (!attrEdges.length) {
      const defData = await shopifyGql(`{
        metafieldDefinitions(ownerType: PRODUCT, namespace: "shopify", first: 20) {
          edges { node { key name type { name } validations { name value } } }
        }
      }`);
      const defs = defData?.data?.metafieldDefinitions?.edges || [];
      console.log('Fallback — metafield defs:', JSON.stringify(defs.map(e => ({ key: e.node.key, type: e.node.type?.name, validations: e.node.validations }))));
    }

    console.log('Options — genre:', genre.length, 'cover:', bookCoverType.length, 'language:', languageVersion.length, 'audience:', targetAudience.length);

    return json({ success: true, genre, bookCoverType, languageVersion, targetAudience });

  } catch (e) {
    console.error('admin-metaobject-options error:', e.message);
    return json({ success: false, error: e.message }, 500);
  }
};
