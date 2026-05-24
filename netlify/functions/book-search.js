const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const CLAUDE_KEY    = (process.env.ANTHROPIC_API_KEY || '').trim();
const SERPER_KEY    = (process.env.SERPER_API_KEY    || '').trim();
const SHOPIFY_STORE = 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN;

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const { prompt } = JSON.parse(event.body || '{}');
    if (!prompt) return {
      statusCode: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Prompt is required' })
    };

    // ── 1. Claude extracts clean search terms ──────────────────────────────
    let searchQuery = prompt;
    let explanation = '';

    if (CLAUDE_KEY) {
      try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': CLAUDE_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
            messages: [{
              role: 'user',
              content: `You are a Malayalam book search assistant. Extract clean search keywords from the user's query to search Malayalam publisher websites.

User query: "${prompt}"

Respond ONLY with valid JSON (no markdown):
{
  "searchQuery": "short and specific search keywords — if author mentioned use their name, if title use the title, keep it concise (max 5 words)",
  "explanation": "one sentence describing what the user is looking for"
}`
            }]
          })
        });
        if (claudeRes.ok) {
          const cd  = await claudeRes.json();
          const raw = cd.content?.[0]?.text || '{}';
          const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
          if (parsed.searchQuery) searchQuery = parsed.searchQuery;
          if (parsed.explanation) explanation  = parsed.explanation;
        }
      } catch(e) { /* use raw prompt */ }
    }

    // ── 2. Direct Shopify search using clean query ────────────────────────
    let shopifyTop = null;
    if (SHOPIFY_TOKEN) {
      try {
        const titleSearch = searchQuery.replace(/"/g, '').substring(0, 40);
        const shopRes = await fetch(`https://${SHOPIFY_STORE}/api/2024-01/graphql.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN },
          body: JSON.stringify({
            query: `{ products(first:5, query:"title:${titleSearch}") { edges { node { title handle availableForSale description priceRange { minVariantPrice { amount } } images(first:1) { edges { node { url } } } variants(first:1) { edges { node { id } } } } } } }`
          })
        });
        const sd = await shopRes.json();
        const edges = sd.data?.products?.edges || [];
        const lq = searchQuery.toLowerCase();
        const match = edges.find(e => {
          const lt = e.node.title.toLowerCase();
          return lt.includes(lq.substring(0, 10)) || lq.includes(lt.substring(0, 10));
        }) || (edges.length ? edges[0] : null);
        if (match) {
          const variantGid = match.node.variants?.edges?.[0]?.node?.id || '';
          shopifyTop = {
            title:       match.node.title,
            author:      '',
            publisher:   'Yellow Feather Books',
            description: (match.node.description || '').substring(0, 280),
            coverUrl:    match.node.images?.edges?.[0]?.node?.url || '',
            year:        '',
            source:      'Yellow Feather Books',
            shopLink:    `https://yellowfeatherbookstore.in/products/${match.node.handle}`,
            inStore:     match.node.availableForSale,
            shopifyUrl:  `https://yellowfeatherbookstore.in/products/${match.node.handle}`,
            variantGid,
            price:       match.node.priceRange?.minVariantPrice?.amount
              ? `₹${parseFloat(match.node.priceRange.minVariantPrice.amount).toFixed(0)}`
              : null
          };
          console.log(`Shopify direct match: "${match.node.title}" inStore:${match.node.availableForSale}`);
        }
      } catch(e) { console.error('Shopify direct search error:', e.message); }
    }

    // ── 3. Search publisher sites via Serper ──────────────────────────────
    const cseResult = await searchSerper(searchQuery);
    const serperBooks = cseResult.books;
    const cseError    = cseResult.error;

    // Merge: Shopify result at top, then Serper results (deduplicated)
    const books = shopifyTop
      ? [shopifyTop, ...serperBooks.filter(b => b.title.toLowerCase() !== shopifyTop.title.toLowerCase())]
      : serperBooks;

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ books, explanation, total: books.length, debug: cseError || null })
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
