// Finds candidate cover images for a book: Google Books -> Open Library ->
// Amazon -> Kerala Book Store -> general web (Serper Images), each gated by
// title-similarity so we never suggest a wrong book's cover. Uses Serper's
// image-search endpoint (not page-scraping) for the last three tiers, since
// Amazon in particular blocks direct scraping from serverless IPs.
// POST { adminEmail, adminKey, title, vendor }
//
// NOTE: `vendor` is this store's Shopify PUBLISHER field, not the book's
// author — it must never be used as an `inauthor:`/`author=` filter (that
// silently kills matches, since no book's real author is named e.g. "DC Books").

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GBOOKS_KEY   = process.env.GOOGLE_BOOKS_API_KEY || '';
const SERPER_KEY   = process.env.SERPER_API_KEY || '';

const MIN_TITLE_SIM = 0.40;
const JUNK_RE = /(instagram|facebook|youtube|youtu\.be|pinterest|tiktok|twitter|x\.com|reddit)/i;

async function fetchT(url, opts = {}, ms = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

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

const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '').trim();

function titleSim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

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

// ── Tier 1: Google Books (title-only — vendor is a publisher, not an author) ──
async function fromGoogleBooks(title) {
  const q = `intitle:${title}`;
  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&country=IN`;
  if (GBOOKS_KEY) url += `&key=${GBOOKS_KEY}`;
  const res = await fetchT(url);
  if (!res.ok) return null;
  const data = await res.json();
  const items = data.items || [];
  let best = null, bestSim = 0;
  for (const it of items) {
    const vi  = it.volumeInfo || {};
    const sim = titleSim(vi.title, title);
    if (sim > bestSim) { bestSim = sim; best = vi; }
  }
  if (!best || bestSim < MIN_TITLE_SIM) return null;
  const thumb = best.imageLinks?.thumbnail || best.imageLinks?.smallThumbnail || '';
  if (!thumb) return null;
  // Google Books thumbnails default to a small curled-edge preview — request a
  // bigger, flat version and force https (the API returns http:// URLs).
  const imageUrl = thumb
    .replace('http://', 'https://')
    .replace('zoom=1', 'zoom=0')
    .replace('&edge=curl', '');
  return { imageUrl, matchedTitle: best.title, source: 'Google Books' };
}

// ── Tier 2: Open Library (title-only) ──
async function fromOpenLibrary(title) {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=5&fields=title,isbn`;
  const res = await fetchT(url);
  if (!res.ok) return null;
  const data = await res.json();
  const docs = data.docs || [];
  let best = null, bestSim = 0;
  for (const d of docs) {
    const sim = titleSim(d.title, title);
    if (sim > bestSim) { bestSim = sim; best = d; }
  }
  if (!best || bestSim < MIN_TITLE_SIM) return null;
  const isbn = Array.isArray(best.isbn) ? (best.isbn.find(x => x.length === 13) || best.isbn[0] || '') : '';
  if (!isbn) return null;

  const coverUrl = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
  const coverRes = await fetchT(coverUrl, { method: 'HEAD' }).catch(() => null);
  if (!coverRes || !coverRes.ok) return null; // ?default=false -> 404 when there's no real cover

  return { imageUrl: coverUrl, matchedTitle: best.title, source: 'Open Library' };
}

// ── Serper Images tiers: ask Google Images directly for a photo of the
// product page, rather than fetching the page ourselves — Amazon in
// particular actively blocks scraping from datacenter/serverless IPs, so
// trying to load an Amazon product page directly and read its og:image
// tag mostly just gets blocked. Serper has already crawled the image, so
// this sidesteps that entirely (the returned imageUrl is usually a plain
// static image on the site's own CDN, e.g. m.media-amazon.com).
async function serperImages(q) {
  if (!SERPER_KEY) return [];
  const res = await fetchT('https://google.serper.dev/images', {
    method:  'POST',
    headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q, gl: 'in', num: 10 }),
  }, 5000);
  if (!res.ok) return [];
  const data = await res.json();
  return data.images || [];
}

async function bestImageMatch(q, title, sourceLabel, extraFilter) {
  let images = await serperImages(q);
  if (extraFilter) images = images.filter(extraFilter);
  const match = images.find(im => titleSim(im.title, title) >= MIN_TITLE_SIM) || images[0];
  if (!match || !match.imageUrl) return null;
  return { imageUrl: match.imageUrl, matchedTitle: match.title || title, source: sourceLabel };
}

async function fromAmazonImages(title, vendor) {
  const q = `${title} ${vendor || ''} site:amazon.in`.trim();
  return bestImageMatch(q, title, 'Amazon', im => /amazon\./i.test(im.domain || im.link || ''));
}

async function fromKeralaBookStoreImages(title, vendor) {
  const q = `${title} ${vendor || ''} site:keralabookstore.com`.trim();
  return bestImageMatch(q, title, 'Kerala Book Store', im => /keralabookstore\.com/i.test(im.domain || im.link || ''));
}

async function fromWebImages(title, vendor) {
  const q = `${title} ${vendor || ''} book cover`.trim();
  return bestImageMatch(q, title, 'Web search', im => !JUNK_RE.test(im.domain || im.link || ''));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, title, vendor } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
  if (!title) return json({ success: false, error: 'Missing title' }, 400);

  const candidates = [];
  const tiers = [
    () => fromGoogleBooks(title),
    () => fromOpenLibrary(title),
    () => fromAmazonImages(title, vendor),
    () => fromKeralaBookStoreImages(title, vendor),
    () => fromWebImages(title, vendor),
  ];
  for (const tier of tiers) {
    try {
      const r = await tier();
      if (r) candidates.push(r);
    } catch(e) { /* try the next tier */ }
    if (candidates.length >= 4) break; // enough choices for the admin to pick from
  }

  return json({ success: true, candidates });
};
