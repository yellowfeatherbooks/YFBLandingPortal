const ALLOWED_ORIGINS = [
  'https://yellowfeather.netlify.app',
  'https://yellowfeatherbooks.com',
  'https://www.yellowfeatherbooks.com',
  'https://yellowfeathersbooks.com',
];

function getCors(event) {
  const origin  = event.headers?.origin || event.headers?.referer?.replace(/\/$/, '') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

const CLAUDE_KEY    = (process.env.ANTHROPIC_API_KEY || '').trim();
const SHOPIFY_STORE = 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SUPABASE_URL  = (process.env.SUPABASE_URL  || '').trim();
const SUPABASE_KEY  = (process.env.SUPABASE_KEY  || '').trim();
const SERVICE_KEY   = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '').trim();
const OPENAI_KEY    = (process.env.OPENAI_API_KEY || '').trim();

// Global-catalog semantic search — same model + adaptive thresholds as search-global-catalog.js
const EMBED_MODEL = 'text-embedding-3-small';
const CAT_FLOOR   = 0.28;   // noise floor
const CAT_GAP     = 0.10;   // keep matches within this of the top score

// ── Global catalog semantic search (Supabase pgvector) ─────────────────────
// Books from our partner catalog that are NOT in Shopify → shown with a "Request"
// action (no external shopLink, so we never bounce the shopper to another store).
async function catalogSearch(queryText) {
  if (!OPENAI_KEY || !SUPABASE_URL || !SERVICE_KEY || !queryText) return [];
  try {
    const er = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body:    JSON.stringify({ model: EMBED_MODEL, input: queryText })
    });
    const ed   = await er.json();
    const qEmb = ed?.data?.[0]?.embedding;
    if (!qEmb) return [];

    const rr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_catalog_books`, {
      method:  'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query_embedding: qEmb, match_count: 10 })
    });
    if (!rr.ok) { console.error('catalog rpc failed:', rr.status); return []; }
    const rows = await rr.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const topScore = rows[0].similarity ?? 0;
    const cutoff   = Math.max(CAT_FLOOR, topScore - CAT_GAP);
    return rows
      .filter(r => (r.similarity ?? 0) >= cutoff)
      .map(r => ({
        title:       r.title,
        title_ml:    r.title_ml || '',
        author:      r.author || '',
        publisher:   r.publisher || '',
        description: (r.description || '').substring(0, 280),
        coverUrl:    '',
        year:        '',
        source:      r.publisher || 'Partner Catalog',
        shopLink:    '',          // no external link → renders as "Request from Us"
        inStore:     false,
        catalog:     true,
        price:       r.price ? `₹${parseFloat(r.price).toFixed(0)}` : null
      }));
  } catch(e) {
    console.error('catalogSearch error:', e.message);
    return [];
  }
}

// ── Shopify product node → book object ────────────────────────────────────
function shopifyNodeToBook(node) {
  const variantGid = node.variants?.edges?.[0]?.node?.id || '';
  return {
    title:       node.title,
    author:      '',
    publisher:   'Yellow Feather Books',
    description: (node.description || '').substring(0, 280),
    coverUrl:    node.images?.edges?.[0]?.node?.url || '',
    year:        '',
    source:      'Yellow Feather Books',
    shopLink:    `https://yellowfeatherbookstore.in/products/${node.handle}`,
    inStore:     node.availableForSale,
    shopifyUrl:  `https://yellowfeatherbookstore.in/products/${node.handle}`,
    variantGid,
    price:       node.priceRange?.minVariantPrice?.amount
      ? `₹${parseFloat(node.priceRange.minVariantPrice.amount).toFixed(0)}`
      : null
  };
}

// ── Shopify search (with cursor pagination) ────────────────────────────────
async function searchShopify(queryStr, first = 10, cursor = null) {
  if (!SHOPIFY_TOKEN) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const q      = queryStr.replace(/"/g, '').substring(0, 60);
  const after  = cursor ? `, after:"${cursor}"` : '';
  const gql = `{ products(first:${first}${after}, query:"${q}") {
    pageInfo { hasNextPage endCursor }
    edges { node {
      title handle availableForSale description
      priceRange { minVariantPrice { amount } }
      images(first:1) { edges { node { url } } }
      variants(first:1) { edges { node { id } } }
    } }
  } }`;
  const res = await fetch(`https://${SHOPIFY_STORE}/api/2024-01/graphql.json`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN },
    body:    JSON.stringify({ query: gql })
  });
  const sd       = await res.json();
  const products = sd.data?.products;
  return {
    nodes:    (products?.edges || []).map(e => e.node),
    pageInfo: products?.pageInfo || { hasNextPage: false, endCursor: null }
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: getCors(event), body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: getCors(event), body: 'Method Not Allowed' };

  try {
    // includeCatalog: only the web portal sends this. The mobile app calls the same
    // function but has no "Request" flow, so it must get Shopify-only results (no
    // un-actionable catalog cards). Mobile omits the flag → catalog leg is skipped.
    const { prompt, cursor = null, searchMeta = null, includeCatalog = false } = JSON.parse(event.body || '{}');
    if (!prompt) return {
      statusCode: 400,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Prompt is required' })
    };

    // On page 2+, searchMeta carries classification from page 1 — skip Claude
    const isPageTwo = !!(cursor && searchMeta);

    // ── 1. Claude: classify query + extract structured info ────────────────
    let searchType  = searchMeta?.searchType  || 'topic';
    let authorName  = searchMeta?.authorName  || '';
    let bookTitle   = searchMeta?.bookTitle   || '';
    let searchQuery = searchMeta?.searchQuery || prompt;
    let shopifyTag  = searchMeta?.shopifyTag  || '';
    let explanation = searchMeta?.explanation || '';
    let claudeInputTokens = 0, claudeOutputTokens = 0;

    if (CLAUDE_KEY && !isPageTwo) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key':          CLAUDE_KEY,
            'anthropic-version':  '2023-06-01',
            'content-type':       'application/json'
          },
          body: JSON.stringify({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{
              role:    'user',
              content: `You are a Malayalam book search assistant. Analyse the user's query and classify it.

User query: "${prompt}"

Respond ONLY with valid JSON (no markdown):
{
  "searchType": "author" | "title" | "topic",
  "authorName": "full author name if the query is about an author, else empty string",
  "bookTitle":  "specific book title if the query is about a title, else empty string",
  "searchQuery": "2-5 word clean keywords for searching publisher websites",
  "shopifyTag":  "pick the single best matching tag from this exact list of available store tags — use the EXACT spelling/case shown: Romantic, crime, Fiction, historic, Adventure, investigation, Memoir, murder, Period Drama, Philosophy — or empty string if no tag fits",
  "explanation": "one sentence describing what the user is looking for"
}

Rules:
- searchType="author" when the user names a specific author (e.g. "MT Vasudevan Nair books", "works by Basheer")
- searchType="title" when the user names a specific book (e.g. "Randamoozham", "find Aadujeevitham")
- searchType="topic" for everything else (genre, mood, theme queries)
- For romantic/love/relationship/love story queries → shopifyTag="Romantic"
- For detective/mystery/whodunit queries → shopifyTag="investigation" or "crime"
- For historical/period queries → shopifyTag="historic" or "Period Drama"
- For biography/life story queries → shopifyTag="Memoir"
- Only use tags from the exact list above — do not invent new tags`
            }]
          })
        });
        if (claudeRes.ok) {
          const cd     = await claudeRes.json();
          claudeInputTokens  = cd.usage?.input_tokens  || 0;
          claudeOutputTokens = cd.usage?.output_tokens || 0;
          const raw    = cd.content?.[0]?.text || '{}';
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
          searchType  = parsed.searchType  || 'topic';
          authorName  = parsed.authorName  || '';
          bookTitle   = parsed.bookTitle   || '';
          searchQuery = parsed.searchQuery || prompt;
          shopifyTag  = (parsed.shopifyTag  || '').toLowerCase().trim();
          explanation = parsed.explanation || '';
        }
      } catch(e) { /* fall through with raw prompt */ }
    }

    console.log(`searchType:${searchType} author:"${authorName}" title:"${bookTitle}" query:"${searchQuery}" tag:"${shopifyTag}"`);

    // ── 2. Shopify search (strategy depends on type) ───────────────────────
    let shopifyBooks = [];
    let shopifyPageInfo = { hasNextPage: false, endCursor: null };
    if (SHOPIFY_TOKEN) {
      try {
        if (searchType === 'author' && authorName) {
          const { nodes, pageInfo } = await searchShopify(authorName, 10, cursor);
          shopifyPageInfo = pageInfo;
          shopifyBooks = nodes
            .map(shopifyNodeToBook)
            .sort((a, b) => (b.inStore ? 1 : 0) - (a.inStore ? 1 : 0));
          console.log(`Shopify author results: ${shopifyBooks.length} for "${authorName}" hasNext:${pageInfo.hasNextPage}`);

        } else if (searchType === 'title' && bookTitle) {
          const { nodes } = await searchShopify(`title:${bookTitle}`, 5, null);
          const lq    = bookTitle.toLowerCase();
          const match = nodes.find(n => {
            const lt = n.title.toLowerCase();
            return lt.includes(lq.substring(0, 10)) || lq.includes(lt.substring(0, 10));
          }) || nodes[0] || null;
          if (match) shopifyBooks = [shopifyNodeToBook(match)];
          console.log(`Shopify title match: "${match?.title}" for "${bookTitle}"`);

        } else {
          // 1. Tag search (most reliable for genre/mood queries)
          let tagNodes = [];
          if (shopifyTag) {
            const tagResult = await searchShopify(`tag:${shopifyTag}`, 10, cursor);
            tagNodes = tagResult.nodes;
            shopifyPageInfo = tagResult.pageInfo;
            console.log(`Shopify tag:"${shopifyTag}" results: ${tagNodes.length}`);
          }

          // 2. Keyword search on title/description
          let { nodes: kwNodes } = await searchShopify(searchQuery, 8, null);
          if (!kwNodes.length) {
            const fallbackQ = prompt.replace(/^(i am looking for|find me|show me|books about|books by)\s+/i, '').trim();
            ({ nodes: kwNodes } = await searchShopify(fallbackQ, 8, null));
          }
          console.log(`Shopify keyword:"${searchQuery}" results: ${kwNodes.length}`);

          // 3. Merge: tag results first (most relevant), then keyword results, deduplicated
          const seenHandles = new Set(tagNodes.map(n => n.handle));
          const merged = [
            ...tagNodes,
            ...kwNodes.filter(n => !seenHandles.has(n.handle))
          ];
          shopifyBooks = merged.map(shopifyNodeToBook).sort((a, b) => (b.inStore ? 1 : 0) - (a.inStore ? 1 : 0));
        }
      } catch(e) { console.error('Shopify search error:', e.message); }
    }

    // ── 3. Claude correlates Shopify results for author searches ───────────
    let correlateTokens = { input: 0, output: 0 };
    if (
      CLAUDE_KEY && !isPageTwo &&
      searchType === 'author' &&
      shopifyBooks.length > 1 &&
      prompt.toLowerCase() !== authorName.toLowerCase()
    ) {
      try {
        const catalog = shopifyBooks.map((b, i) => `${i + 1}. "${b.title}"`).join(', ');
        const corrRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key':         CLAUDE_KEY,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json'
          },
          body: JSON.stringify({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role:    'user',
              content: `User searched: "${prompt}"
Available books by ${authorName} in store: ${catalog}

Rank these by relevance to the user's query. Respond ONLY with a JSON array of 1-based indexes in order of relevance, e.g. [2,1,3]. Include all indexes.`
            }]
          })
        });
        if (corrRes.ok) {
          const cd  = await corrRes.json();
          correlateTokens.input  = cd.usage?.input_tokens  || 0;
          correlateTokens.output = cd.usage?.output_tokens || 0;
          const raw    = cd.content?.[0]?.text || '[]';
          const ranked = JSON.parse(raw.replace(/```json|```/g, '').trim());
          if (Array.isArray(ranked) && ranked.length) {
            shopifyBooks = ranked
              .map(i => shopifyBooks[i - 1])
              .filter(Boolean);
          }
        }
      } catch(e) { /* keep original order */ }
    }

    // ── 4. Global catalog semantic search (page 1 only; Shopify drives paging) ──
    let catalogBooks = [];
    if (!isPageTwo && includeCatalog) {
      catalogBooks = await catalogSearch(searchQuery || prompt);
    }

    // ── 5. Merge: Shopify first (in-stock sorted), then catalog (deduped by title) ──
    const shopifyTitles = new Set(shopifyBooks.map(b => b.title.toLowerCase().trim()));
    const books = [
      ...shopifyBooks,
      ...catalogBooks.filter(b => !shopifyTitles.has(b.title.toLowerCase().trim()))
    ];
    const noMatch = books.length === 0;

    // ── 6. Log to Supabase (fire-and-forget) ──────────────────────────────
    const totalClaudeIn = claudeInputTokens  + correlateTokens.input;
    const totalClaudeOut= claudeOutputTokens + correlateTokens.output;
    const claudeCostUsd = (totalClaudeIn / 1_000_000 * 0.80) + (totalClaudeOut / 1_000_000 * 4.00);
    const totalCostUsd  = claudeCostUsd;

    if (SUPABASE_URL && SUPABASE_KEY) {
      fetch(`${SUPABASE_URL}/rest/v1/search_logs`, {
        method:  'POST',
        headers: {
          'apikey':        SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=minimal'
        },
        body: JSON.stringify({
          prompt,
          search_query:         searchQuery,
          explanation,
          results_count:        books.length,
          shopify_match:        shopifyBooks.length > 0,
          has_results:          books.length > 0,
          claude_input_tokens:  totalClaudeIn,
          claude_output_tokens: totalClaudeOut,
          claude_cost_usd:      claudeCostUsd.toFixed(6),
          serper_calls:         0,
          serper_cost_usd:      '0.000000',
          total_cost_usd:       totalCostUsd.toFixed(6)
        })
      }).catch(e => console.error('search_logs insert failed:', e.message));
    }

    return {
      statusCode: 200,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        books, explanation, searchType,
        total: books.length,
        noMatch,
        pageInfo: shopifyPageInfo,
        searchMeta: { searchType, authorName, bookTitle, searchQuery, shopifyTag, explanation }
      })
    };

  } catch(err) {
    console.error('book-search error:', err.message);
    return {
      statusCode: 500,
      headers: { ...getCors(event), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
