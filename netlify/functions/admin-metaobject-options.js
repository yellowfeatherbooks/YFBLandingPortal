// Fetches metaobject entries for the 4 book category metafields.
// POST { adminEmail, adminKey, debug? }

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
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, debug } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) {
    return json({ success: false, error: 'Unauthorized' }, 401);
  }

  try {
    // Step 1 — Get all product metafield definitions under "shopify" namespace
    const defQuery = `{
      metafieldDefinitions(ownerType: PRODUCT, namespace: "shopify", first: 20) {
        edges {
          node {
            key
            name
            type { name }
            validations { name value }
          }
        }
      }
    }`;
    const defData = await shopifyGql(defQuery);
    const defs = (defData?.data?.metafieldDefinitions?.edges || []).map(e => e.node);

    if (debug) {
      return json({ success: true, debug: true, defs });
    }

    // Step 2 — For each field, find the metaobject definition GID from validations
    const FIELDS = {
      genre:           'genre',
      bookCoverType:   'book-cover-type',
      languageVersion: 'language-version',
      targetAudience:  'target-audience',
    };

    const defMap = {};
    for (const [fieldKey, shopifyKey] of Object.entries(FIELDS)) {
      const def = defs.find(d => d.key === shopifyKey);
      const v   = (def?.validations || []).find(v => v.name === 'metaobject_definition_id');
      defMap[fieldKey] = v?.value || null;
    }

    // Step 3 — For each found definition GID, get type handle then fetch entries
    async function fetchByDefGid(gid) {
      if (!gid) return [];
      const typeData = await shopifyGql(
        `query($id: ID!) { metaobjectDefinition(id: $id) { type } }`,
        { id: gid }
      );
      const type = typeData?.data?.metaobjectDefinition?.type;
      if (!type) return [];

      const entriesData = await shopifyGql(
        `query($type: String!) {
          metaobjects(type: $type, first: 250) {
            edges { node { id displayName handle } }
          }
        }`,
        { type }
      );
      const edges = entriesData?.data?.metaobjects?.edges || [];
      return edges
        .map(e => ({ id: e.node.id, label: e.node.displayName || e.node.handle }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }

    const [genre, bookCoverType, languageVersion, targetAudience] = await Promise.all([
      fetchByDefGid(defMap.genre),
      fetchByDefGid(defMap.bookCoverType),
      fetchByDefGid(defMap.languageVersion),
      fetchByDefGid(defMap.targetAudience),
    ]);

    return json({ success: true, genre, bookCoverType, languageVersion, targetAudience, _defMap: defMap });

  } catch (e) {
    console.error('admin-metaobject-options error:', e.message);
    return json({ success: false, error: e.message }, 500);
  }
};
