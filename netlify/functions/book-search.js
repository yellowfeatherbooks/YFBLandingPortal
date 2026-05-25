const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const CLAUDE_KEY    = (process.env.ANTHROPIC_API_KEY || '').trim();
const SERPER_KEY    = (process.env.SERPER_API_KEY    || '').trim();
const SHOPIFY_STORE = 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;
const SUPABASE_URL  = (process.env.SUPABASE_URL  || '').trim();
const SUPABASE_KEY  = (process.env.SUPABASE_KEY  || '').trim();

const SOURCE_MAP = {
  'dcbooks.com':          'DC Books',
  'mathrubhumibooks.com': 'Mathrubhumi Books',
  'olivebooks.in':        'Olive Books',
  'greenbooks.in':        'Green Books',
  'currentbooks.in':      'Current Books',
  'sahyadribooks.com':    'Sahyadri Books',
  'manoramaonline.com':   'Manorama Books',
};

function getSourceName(link) {
  try {
    const host = new URL(link).hostname.replace('www.', '');
    for (const [domain, name] of Object.entries(SOURCE_MAP)) {
      if (host.includes(domain)) return name;
    }
    return host;
  } catch(e) { return ''; }
}

function cleanTitle(title) {
  return title
    .replace(/\s*[-|–|:]\s*(DC Books|Mathrubhumi|Olive Books|Green Books|Current Books|Sahyadri|Manorama|Buy|Shop|Online).*$/i, '')
    .trim();
}

async function searchSerper(query) {
  if (!SERPER_KEY) {
    console.error('Serper: missing SERPER_API_KEY env variable');
    return { books: [], error: 'Search engine not configured' };
  }
  async function serperFetch(q, n = 10) {
    const res  = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q, num: n })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || res.status);
    return data.organic || [];
  }

  try {
    const sites      = '(site:dcbooks.com OR site:mathrubhumibooks.com OR site:olivebooks.in OR site:greenbooks.in OR site:currentbooks.in OR site:sahyadribooks.com OR site:manoramaonline.com)';
    const siteQuery  = `${query} ${sites}`;
    console.log('Serper query (sites):', siteQuery);
    let organic = await serperFetch(siteQuery);
    console.log('Serper results count (sites):', organic.length);

    if (organic.length === 0) {
      const broadQuery = `${query} malayalam book`;
      console.log('Serper fallback query:', broadQuery);
      organic = await serperFetch(broadQuery);
      console.log('Serper results count (fallback):', organic.length);
    }

    const data = { organic };

    return {
      books: (data.organic || []).map(item => {
        const source = getSourceName(item.link);
        return {
          title:       cleanTitle(item.title),
          author:      '',
          publisher:   source,
          description: (item.snippet || '').substring(0, 280).trim(),
          coverUrl:    item.imageUrl || '',
          year:        '',
          source,
          shopLink:    item.link,
          inStore:     false
        };
      }).filter(b => b.title && b.shopLink),
      error: null
    };
  } catch(e) {
    console.error('Serper error:', e.message);
    return { books: [], error: e.message };
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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { prompt, cursor = null, searchMeta = null } = JSON.parse(event.body || '{}');
    if (!prompt) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Prompt is required' })
    };

    // On page 2+, searchMeta carries classification from page 1 — skip Claude
    const isPageTwo = !!(cursor && searchMeta);

    // ── 1. Claude: classify query + extract structured info ────────────────
    let searchType  = searchMeta?.searchType  || 'topic';
    let authorName  = searchMeta?.authorName  || '';
    let bookTitle   = searchMeta?.bookTitle   || '';
    let searchQuery = searchMeta?.searchQuery || prompt;
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
            max_tokens: 350,
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
  "explanation": "one sentence describing what the user is looking for"
}

Rules:
- searchType="author" when the user names a specific author (e.g. "MT Vasudevan Nair books", "works by Basheer")
- searchType="title" when the user names a specific book (e.g. "Randamoozham", "find Aadujeevitham")
- searchType="topic" for everything else (genre, mood, theme queries)`
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
          explanation = parsed.explanation || '';
        }
      } catch(e) { /* fall through with raw prompt */ }
    }

    console.log(`searchType:${searchType} author:"${authorName}" title:"${bookTitle}" query:"${searchQuery}"`);

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
          const { nodes } = await searchShopify(searchQuery, 5, null);
          if (nodes.length) shopifyBooks = [shopifyNodeToBook(nodes[0])];
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

    // ── 4. Serper: only on first page ─────────────────────────────────────
    let serperBooks = [];
    let cseError    = null;
    const skipSerper = isPageTwo || (searchType === 'author' && shopifyBooks.length >= 3);
    if (!skipSerper) {
      const cseResult = await searchSerper(searchQuery);
      serperBooks = cseResult.books;
      cseError    = cseResult.error;
    }

    // ── 5. Merge: Shopify first, then Serper (deduplicated by title) ───────
    const shopifyTitles = new Set(shopifyBooks.map(b => b.title.toLowerCase()));
    const books = [
      ...shopifyBooks,
      ...serperBooks.filter(b => !shopifyTitles.has(b.title.toLowerCase()))
    ];

    // ── 6. Log to Supabase (fire-and-forget) ──────────────────────────────
    const serperCalls   = skipSerper ? 0 : (serperBooks.length === 0 ? 2 : 1);
    const totalClaudeIn = claudeInputTokens  + correlateTokens.input;
    const totalClaudeOut= claudeOutputTokens + correlateTokens.output;
    const claudeCostUsd = (totalClaudeIn / 1_000_000 * 0.80) + (totalClaudeOut / 1_000_000 * 4.00);
    const serperCostUsd = serperCalls * 0.001;
    const totalCostUsd  = claudeCostUsd + serperCostUsd;

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
          serper_calls:         serperCalls,
          serper_cost_usd:      serperCostUsd.toFixed(6),
          total_cost_usd:       totalCostUsd.toFixed(6)
        })
      }).catch(e => console.error('search_logs insert failed:', e.message));
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        books, explanation, searchType,
        total: books.length,
        pageInfo: shopifyPageInfo,
        searchMeta: { searchType, authorName, bookTitle, searchQuery, explanation },
        debug: cseError || null
      })
    };

  } catch(err) {
    console.error('book-search error:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
