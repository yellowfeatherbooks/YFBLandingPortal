/**
 * admin-tag-by-collection
 *
 * Mode 1 — list collections (no collectionId in body):
 *   Returns all collections, what tag each maps to, and product counts.
 *   POST { adminKey, dryRun? }
 *
 * Mode 2 — tag one collection (pass collectionId):
 *   Adds the resolved tag to every product in that collection.
 *   POST { adminKey, collectionId: "gid://shopify/Collection/123", dryRun? }
 *
 * Mode 3 — tag ALL collections (pass runAll: true):
 *   Processes every mappable collection sequentially.
 *   POST { adminKey, runAll: true, dryRun? }
 *
 * Netlify function timeout is ~26s; single-collection runs easily fit.
 * Use runAll only for small stores (< ~100 products across all collections).
 */

const crypto         = require('crypto');
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN     || 'zgqk4e-1m.myshopify.com';
const ADMIN_TOKEN    = process.env.SHOPIFY_ADMIN_TOKEN;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const API_VERSION    = '2024-01';

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

const ALLOWED_ORIGINS = [
  'https://yellowfeather.netlify.app',
  'https://yellowfeatherbooks.com',
  'https://www.yellowfeatherbooks.com',
  'http://localhost:4200',
];
function getCors(event) {
  const origin  = event.headers?.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
function json200(event, data) {
  return { statusCode: 200, headers: { ...getCors(event), 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}
function jsonErr(event, code, msg) {
  return { statusCode: code, headers: { ...getCors(event), 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) };
}

// ── Collection title → Shopify tag mapping ─────────────────────────────────
const COLLECTION_TAG_MAP = {
  // ── Romance ──
  'romantic':           'Romantic',
  'romance':            'Romantic',
  'love story':         'Romantic',
  'love stories':       'Romantic',
  // ── Crime / Thriller ──
  'crime':              'crime',
  'crime fiction':      'crime',
  'thriller':           'crime',
  'thrillers':          'crime',
  'mystery':            'investigation',
  'detective':          'investigation',
  'investigation':      'investigation',
  // ── Murder ──
  'murder':             'murder',
  // ── Fiction / Novels ──
  'fiction':            'Fiction',
  'novels':             'Fiction',
  'short stories':      'Fiction',
  'stories':            'Fiction',
  'classics':           'Fiction',
  'world-literature':   'Fiction',
  'world literature':   'Fiction',
  'malayalam-fiction':  'Fiction',
  'malayalam fiction':  'Fiction',
  // ── Historic ──
  'historic':           'historic',
  'historical':         'historic',
  'history':            'historic',
  'period drama':       'Period Drama',
  // ── Adventure / Travel ──
  'adventure':          'Adventure',
  'travel':             'Adventure',
  // ── Memoir ──
  'memoir':             'Memoir',
  'biography':          'Memoir',
  'autobiography':      'Memoir',
  'memories':           'Memoir',
  'nostalgia':          'Memoir',
  // ── Philosophy / Self-help ──
  'philosophy':         'Philosophy',
  'spiritual':          'Philosophy',
  'self-help':          'Philosophy',
  'self help':          'Philosophy',
  // ── Children ──
  'children':           'children',
  "children's":         'children',
  'kids':               'children',
  // ── Poetry ──
  'poetry':             'poetry',
  // ── Young Adult ──
  'young adult':        'Young Adult',
  // ── Skip utility/marketing collections (null = explicit skip) ──
  'best sellers':       null,
  'trending':           null,
  'award winners':      null,
  'award-winners':      null,
  'new arrivals':       null,
  'just arrived':       null,
  'home page':          null,
  'offer zon':          null,
  'offer':              null,
};

function resolveTag(collectionTitle) {
  const lower = collectionTitle.toLowerCase().trim();
  if (lower in COLLECTION_TAG_MAP) return COLLECTION_TAG_MAP[lower];        // exact match (including null)
  for (const [key, tag] of Object.entries(COLLECTION_TAG_MAP)) {
    if (tag === null) continue;
    if (lower.includes(key)) return tag;                                    // substring match
  }
  return undefined;  // undefined = truly unmapped (vs null = explicitly skipped)
}

// ── Shopify Admin GraphQL ──────────────────────────────────────────────────
async function adminGQL(query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': ADMIN_TOKEN },
      body:    JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

// ── Fetch all collections (paginated) ─────────────────────────────────────
async function fetchAllCollections() {
  const out = [];
  let cursor = null;
  do {
    const after = cursor ? `, after: "${cursor}"` : '';
    const data  = await adminGQL(`{
      collections(first: 50${after}) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title productsCount { count } } }
      }
    }`);
    const page = data.collections;
    out.push(...page.edges.map(e => e.node));
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// ── Fetch ONE PAGE of products in a collection ─────────────────────────────
async function fetchProductsPage(collectionId, pageSize = 25, cursor = null) {
  const after = cursor ? `, after: "${cursor}"` : '';
  const data  = await adminGQL(`{
    collection(id: "${collectionId}") {
      products(first: ${pageSize}${after}) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title tags } }
      }
    }
  }`);
  const page = data.collection?.products;
  return {
    products:    (page?.edges || []).map(e => e.node),
    hasNextPage: page?.pageInfo?.hasNextPage  || false,
    endCursor:   page?.pageInfo?.endCursor    || null,
  };
}

// ── Tag one product (skip if already tagged) ───────────────────────────────
async function tagProduct(product, tag, dryRun) {
  if (product.tags.includes(tag)) return { title: product.title, result: 'already_tagged' };
  if (dryRun) return { title: product.title, result: 'would_tag', newTags: [...product.tags, tag] };

  const data = await adminGQL(`
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id tags }
        userErrors { field message }
      }
    }`, { input: { id: product.id, tags: [...product.tags, tag] } }
  );
  const errs = data.productUpdate?.userErrors || [];
  if (errs.length) throw new Error(errs.map(e => e.message).join('; '));
  return { title: product.title, result: 'tagged', newTags: data.productUpdate.product.tags };
}

// ── Process ONE PAGE of a collection ──────────────────────────────────────
async function processCollectionPage(col, dryRun, cursor = null, pageSize = 25) {
  const tag = resolveTag(col.title);
  if (tag === null)      return { collection: col.title, status: 'skipped',    tag: null, hasNextPage: false, nextCursor: null, products: [] };
  if (tag === undefined) return { collection: col.title, status: 'no_mapping', tag: null, hasNextPage: false, nextCursor: null, products: [] };

  const { products, hasNextPage, endCursor } = await fetchProductsPage(col.id, pageSize, cursor);
  const results = [];
  for (const p of products) {
    try {
      const r = await tagProduct(p, tag, dryRun);
      results.push(r);
    } catch(e) {
      results.push({ title: p.title, result: 'error', error: e.message });
    }
  }

  return {
    collection:  col.title,
    collectionId: col.id,
    status:      'processed',
    tag,
    dryRun,
    hasNextPage,
    nextCursor:  endCursor,
    tagged:      results.filter(r => r.result === 'tagged'  || r.result === 'would_tag').length,
    skipped:     results.filter(r => r.result === 'already_tagged').length,
    errors:      results.filter(r => r.result === 'error').length,
    products:    results,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: getCors(event), body: '' };
  if (event.httpMethod !== 'POST')    return jsonErr(event, 405, 'Method Not Allowed');

  try {
    const body = JSON.parse(event.body || '{}');

    if (!await verifyAdmin(body.adminEmail, body.adminKey))
      return jsonErr(event, 401, 'Unauthorized');
    if (!ADMIN_TOKEN)
      return jsonErr(event, 500, 'SHOPIFY_ADMIN_TOKEN not configured');

    const dryRun = body.dryRun === true;

    // ── Mode 1: list all collections ──────────────────────────────────────
    if (!body.collectionId && !body.runAll) {
      const collections = await fetchAllCollections();
      const mapped = collections.map(col => {
        const tag = resolveTag(col.title);
        return {
          id:           col.id,
          title:        col.title,
          productCount: col.productsCount?.count ?? '?',
          tag:          tag ?? null,
          status:       tag === null ? 'skipped (utility collection)' : tag === undefined ? 'no mapping' : `will tag → "${tag}"`,
        };
      });
      return json200(event, {
        mode: 'list',
        totalCollections: mapped.length,
        mappable:   mapped.filter(c => c.tag).length,
        skipped:    mapped.filter(c => c.tag === null).length,
        unmapped:   mapped.filter(c => c.tag === undefined).length,
        collections: mapped,
      });
    }

    // ── Mode 2: tag a single collection (one page per call) ───────────────
    // Body: { collectionId, cursor? }
    // If hasNextPage=true in response, call again with nextCursor to continue.
    if (body.collectionId) {
      const cols = await fetchAllCollections();
      const col  = cols.find(c => c.id === body.collectionId);
      if (!col) return jsonErr(event, 404, `Collection not found: ${body.collectionId}`);
      const result = await processCollectionPage(col, dryRun, body.cursor || null);
      return json200(event, { mode: 'single', ...result });
    }

    // ── Mode 3: tag ALL mappable collections, one page each per call ──────
    // Body: { runAll: true }
    // Processes page 1 of every mappable collection in one call.
    // Collections with hasNextPage=true must be continued with Mode 2 + cursor.
    if (body.runAll) {
      const cols    = await fetchAllCollections();
      const results = [];
      let totalTagged = 0, totalSkipped = 0, totalErrors = 0;

      for (const col of cols) {
        const r = await processCollectionPage(col, dryRun, null, 25);
        results.push(r);
        totalTagged  += r.tagged  || 0;
        totalSkipped += r.skipped || 0;
        totalErrors  += r.errors  || 0;
        console.log(`${r.status} "${col.title}" tag:${r.tag} tagged:${r.tagged} skipped:${r.skipped} more:${r.hasNextPage}`);
      }

      // Surface any collections that have more pages
      const needsContinuation = results.filter(r => r.hasNextPage).map(r => ({
        collection: r.collection, collectionId: r.collectionId, nextCursor: r.nextCursor
      }));

      return json200(event, {
        mode: 'runAll',
        dryRun,
        summary: { totalTagged, totalSkipped, totalErrors, collections: results.length },
        needsContinuation,
        details: results,
      });
    }

  } catch(err) {
    console.error('admin-tag-by-collection:', err.message);
    return jsonErr(event, 500, err.message);
  }
};
