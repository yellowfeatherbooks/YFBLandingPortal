// search-global-catalog.js
// Customer-facing RAG search over the publisher catalog (catalog_books + pgvector).
// POST { query } → embeds the query (OpenAI) → match_catalog_books RPC (Supabase)
//                → adaptive relevance threshold → returns matching books.
//
// Env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_KEY)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

const EMBED_MODEL = 'text-embedding-3-small';
const FLOOR = 0.28;   // noise floor
const GAP   = 0.10;   // keep matches within this of the top score (adaptive threshold)

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: getCors(event), body: '' };
  if (event.httpMethod !== 'POST')    return json(event, { error: 'Method Not Allowed' }, 405);

  try {
    const { query } = JSON.parse(event.body || '{}');
    if (!query || !query.trim()) return json(event, { matches: [] });
    if (!OPENAI_KEY || !SUPABASE_URL || !SERVICE_KEY) return json(event, { error: 'Search is not configured.' }, 500);

    // 1) Embed the query.
    const er = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
      body:    JSON.stringify({ model: EMBED_MODEL, input: query.trim() }),
    });
    const ed = await er.json();
    const qEmb = ed?.data?.[0]?.embedding;
    if (!qEmb) return json(event, { error: 'Could not process the query.' }, 502);

    // 2) Vector search in Postgres.
    const rr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_catalog_books`, {
      method:  'POST',
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query_embedding: qEmb, match_count: 8 }),
    });
    if (!rr.ok) return json(event, { error: 'Catalog search failed.' }, 502);
    const rows = await rr.json();
    if (!Array.isArray(rows) || rows.length === 0) return json(event, { matches: [] });

    // 3) Adaptive relevance threshold.
    const topScore = rows[0].similarity ?? 0;
    const cutoff   = Math.max(FLOOR, topScore - GAP);
    const matches  = rows
      .filter(r => (r.similarity ?? 0) >= cutoff)
      .map(r => ({ title: r.title, author: r.author, price: r.price, publisher: r.publisher }));

    return json(event, { matches });
  } catch (err) {
    return json(event, { error: err.message }, 500);
  }
};
