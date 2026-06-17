// book-news.js — "Trends & News" discovery panel.
// Web search (Serper) over Malayalam book publishers & media for news, reviews,
// and new releases. Outbound links are the point here (unlike AI Book Search,
// which now keeps shoppers on-site via Shopify + our global catalog).
//
// POST { query? } → { articles: [{ title, snippet, link, source, imageUrl }] }
// Env: SERPER_API_KEY

const SERPER_KEY = (process.env.SERPER_API_KEY || '').trim();

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
const json = (event, body, status = 200) => ({
  statusCode: status,
  headers: { ...getCors(event), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const SOURCE_MAP = {
  'dcbooks.com':          'DC Books',
  'mathrubhumibooks.com': 'Mathrubhumi Books',
  'mathrubhumi.com':      'Mathrubhumi',
  'olivebooks.in':        'Olive Books',
  'greenbooks.in':        'Green Books',
  'currentbooks.in':      'Current Books',
  'sahyadribooks.com':    'Sahyadri Books',
  'manoramaonline.com':   'Manorama',
  'thehindu.com':         'The Hindu',
};

function getSourceName(link) {
  try {
    const host = new URL(link).hostname.replace('www.', '');
    for (const [domain, name] of Object.entries(SOURCE_MAP)) {
      if (host.includes(domain)) return name;
    }
    return host;
  } catch (e) { return ''; }
}

async function serperFetch(q, n = 12) {
  const res  = await fetch('https://google.serper.dev/search', {
    method:  'POST',
    headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q, num: n }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || res.status);
  return data.organic || [];
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: getCors(event), body: '' };
  if (event.httpMethod !== 'POST')    return json(event, { error: 'Method Not Allowed' }, 405);

  if (!SERPER_KEY) return json(event, { error: 'News search is not configured.' }, 500);

  try {
    const { query } = JSON.parse(event.body || '{}');
    const q = (query || '').trim();
    // Default discovery feed when the user hasn't typed anything.
    const searchQuery = q
      ? `${q} malayalam book`
      : 'malayalam books new releases reviews news';

    let organic = await serperFetch(searchQuery);
    if (organic.length === 0 && q) {
      organic = await serperFetch(`${q} book`);  // broaden once
    }

    const articles = organic
      .map(item => ({
        title:    (item.title || '').trim(),
        snippet:  (item.snippet || '').substring(0, 280).trim(),
        link:     item.link || '',
        source:   getSourceName(item.link),
        imageUrl: item.imageUrl || '',
      }))
      .filter(a => a.title && a.link);

    return json(event, { articles });
  } catch (err) {
    console.error('book-news error:', err.message);
    return json(event, { error: err.message }, 500);
  }
};
