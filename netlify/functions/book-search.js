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
  try {
    const siteFilter = 'site:dcbooks.com OR site:mathrubhumibooks.com OR site:olivebooks.in OR site:greenbooks.in OR site:currentbooks.in OR site:sahyadribooks.com OR site:manoramaonline.com';
    const fullQuery  = `${query} ${siteFilter}`;
    console.log('Serper query:', fullQuery);
    const res  = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: fullQuery, num: 10 })
    });
    const data = await res.json();

    if (!res.ok) {
      console.error('Serper API error:', JSON.stringify(data));
      return { books: [], error: `Serper: ${data.message || res.status}` };
    }

    console.log('Serper results count:', (data.organic || []).length);

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

    // ── 2. Search publisher sites via Serper ──────────────────────────────
    const cseResult = await searchSerper(searchQuery);
    const books     = cseResult.books;
    const cseError  = cseResult.error;

    // ── 3. Shopify availability check ─────────────────────────────────────
    if (SHOPIFY_TOKEN && books.length) {
      await Promise.all(books.map(async (book) => {
        try {
          const titleSearch = book.title.replace(/"/g, '').substring(0, 40);
          const shopRes = await fetch(`https://${SHOPIFY_STORE}/api/2024-01/graphql.json`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Storefront-Access-Token': SHOPIFY_TOKEN
            },
            body: JSON.stringify({
              query: `{ products(first:3, query:"title:${titleSearch}") { edges { node { title handle availableForSale priceRange { minVariantPrice { amount } } } } } }`
            })
          });
          const sd    = await shopRes.json();
          const edges = sd.data?.products?.edges || [];
          const shortTitle = book.title.toLowerCase().substring(0, 20);
          const match = edges.find(e =>
            e.node.title.toLowerCase().includes(shortTitle) ||
            shortTitle.includes(e.node.title.toLowerCase().substring(0, 20))
          );
          if (match) {
            book.inStore       = match.node.availableForSale;
            book.shopifyHandle = match.node.handle;
            book.shopifyUrl    = `https://yellowfeatherbookstore.in/products/${match.node.handle}`;
            book.price         = match.node.priceRange?.minVariantPrice?.amount
              ? `₹${parseFloat(match.node.priceRange.minVariantPrice.amount).toFixed(0)}`
              : null;
          }
        } catch(e) { /* skip */ }
      }));
    }

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
