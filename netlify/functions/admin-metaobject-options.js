// Fetches metaobject entries for the 4 book category metafields.
// Discovers the metaobject type dynamically from the metafield definitions.
// POST { adminEmail, adminKey }
// Returns: { genre, bookCoverType, languageVersion, targetAudience }

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN;
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
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'Shopify GQL error');
  return data;
}

// Step 1: Get the metaobject definition GID from a metafield definition's validations
async function getMetaobjectType(namespace, key) {
  const data = await shopifyGql(`
    query {
      metafieldDefinitions(ownerType: PRODUCT, namespace: "${namespace}", key: "${key}", first: 1) {
        edges {
          node {
            validations { name value }
          }
        }
      }
    }`);
  const validations = data?.data?.metafieldDefinitions?.edges?.[0]?.node?.validations || [];
  // The validation contains the metaobject definition GID e.g. gid://shopify/MetaobjectDefinition/123
  const v = validations.find(v => v.name === 'metaobject_definition_id');
  return v?.value || null;
}

// Step 2: Given a MetaobjectDefinition GID, get its type handle, then fetch all entries
async function fetchMetaobjectsByDefinitionGid(definitionGid) {
  // Get the type handle from the definition GID
  const defData = await shopifyGql(`
    query($id: ID!) {
      metaobjectDefinition(id: $id) {
        type
        name
      }
    }`, { id: definitionGid });
  const type = defData?.data?.metaobjectDefinition?.type;
  if (!type) return [];
  return fetchMetaobjectsByType(type);
}

// Fetch all metaobject entries of a given type handle
async function fetchMetaobjectsByType(type) {
  const data = await shopifyGql(`
    query($type: String!) {
      metaobjects(type: $type, first: 250) {
        edges {
          node {
            id
            displayName
            handle
          }
        }
      }
    }`, { type });
  const edges = data?.data?.metaobjects?.edges || [];
  return edges
    .map(e => ({ id: e.node.id, label: e.node.displayName || e.node.handle }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Fetch options for one field — tries definition lookup first, falls back to guessed type names
async function fetchOptions(namespace, key, fallbackTypes) {
  try {
    const defGid = await getMetaobjectType(namespace, key);
    if (defGid) return fetchMetaobjectsByDefinitionGid(defGid);
  } catch(e) {
    console.warn(`Definition lookup failed for ${namespace}.${key}:`, e.message);
  }
  // Fallback: try known type handle patterns
  for (const type of fallbackTypes) {
    try {
      const results = await fetchMetaobjectsByType(type);
      if (results.length > 0) return results;
    } catch(e) { /* try next */ }
  }
  return [];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    const [genre, bookCoverType, languageVersion, targetAudience] = await Promise.all([
      fetchOptions('shopify', 'genre',            ['shopify--genre', 'genre']),
      fetchOptions('shopify', 'book-cover-type',  ['shopify--book-cover-type', 'book_cover_type', 'book-cover-type']),
      fetchOptions('shopify', 'language-version', ['shopify--language-version', 'language_version', 'language-version']),
      fetchOptions('shopify', 'target-audience',  ['shopify--target-audience', 'target_audience', 'target-audience']),
    ]);

    return json({ success: true, genre, bookCoverType, languageVersion, targetAudience });
  } catch (e) {
    console.error('admin-metaobject-options error:', e.message);
    return json({ success: false, error: e.message }, 500);
  }
};
