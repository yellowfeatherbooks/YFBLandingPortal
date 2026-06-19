// web-book-lookup.js
// Admin helper: fetch ISBN + a short description for a book title from the web.
// POST { adminEmail, adminKey, title, author? }
//   → Google Books (ISBN-13 + description) → Open Library (ISBN)
//   → Serper web search (snippet ISBN, bookstore-page ISBN, Amazon ASIN + meta description)
//   → all gated by a title-similarity check so we never return a wrong book's ISBN.
//
// Read-only; admin-gated. Env: SUPABASE_URL, SUPABASE_KEY, SERPER_API_KEY, [GOOGLE_BOOKS_API_KEY].

const crypto       = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GBOOKS_KEY   = process.env.GOOGLE_BOOKS_API_KEY || '';
const SERPER_KEY   = process.env.SERPER_API_KEY || '';

const MIN_TITLE_SIM = 0.45;  // reject results whose title doesn't really match
const DESC_MAX = 740;        // max description length we return
const ISBN_RE = /97[89](?:[\s-]?\d){10}/;  // ISBN-13 with optional spaces/hyphens
const JUNK_RE = /(instagram|facebook|youtube|youtu\.be|pinterest|tiktok|twitter|x\.com|reddit)/i; // not book descriptions

// fetch with a timeout so a slow page can't stall the whole function.
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

// Dice bigram similarity (lexical, like the catalog's trigram check).
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

function cleanDesc(s) {
  if (!s) return '';
  let t = String(s)
    .replace(/<[^>]*>/g, ' ')                 // strip HTML
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (t.length > DESC_MAX) t = t.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, '') + '…';
  return t;
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

async function fromGoogleBooks(title, author) {
  let q = `intitle:${title}`;
  if (author) q += `+inauthor:${author}`;
  let url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=5&country=IN`;
  if (GBOOKS_KEY) url += `&key=${GBOOKS_KEY}`;
  const res  = await fetch(url);
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
  const ids  = best.industryIdentifiers || [];
  const isbn = (ids.find(i => i.type === 'ISBN_13') || ids.find(i => i.type === 'ISBN_10') || {}).identifier || '';
  return {
    isbn, description: cleanDesc(best.description),
    author: (best.authors || []).join(', '), publisher: best.publisher || '', genre: '',
    matchedTitle: best.title, sim: bestSim, source: 'Google Books'
  };
}

async function fromOpenLibrary(title, author) {
  let url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}&limit=5&fields=title,isbn,author_name`;
  if (author) url += `&author=${encodeURIComponent(author)}`;
  const res  = await fetch(url);
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
  return { isbn, description: '', matchedTitle: best.title, sim: bestSim, source: 'Open Library' };
}

function metaDesc(html) {
  const m = html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:og:)?description["']/i);
  return m ? cleanDesc(m[1]) : '';
}

// Best-effort description from a product page: og/meta description, else the text
// under a "Book Summary / About the Book / Description" heading.
function pageDesc(html) {
  const meta = metaDesc(html);
  if (meta && meta.length >= 40) return meta;
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const m = clean.match(/(?:book\s*summary|about\s*the\s*book|description|summary)\s*<\/[a-z0-9]+>([\s\S]{0,2500})/i);
  if (m) { const txt = cleanDesc(m[1]); if (txt && txt.length >= 40) return txt; }
  return meta || '';
}

const hostOf = (link) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return 'page'; } };

// Web-search tier (Serper): gathers ISBN + description independently
// (snippet ISBN → page ISBN/description → Amazon ASIN fallback).
async function fromSerper(title, author) {
  if (!SERPER_KEY) return null;
  const q = [title, author].filter(Boolean).join(' ');
  const res = await fetchT('https://google.serper.dev/search', {
    method:  'POST',
    headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q, gl: 'in', num: 10 }),
  }, 5000);
  if (!res.ok) return null;
  const data    = await res.json();
  const organic = (data.organic || []).filter(o => titleSim(o.title, title) >= 0.40); // only our book
  if (!organic.length) return null;

  let isbn = '', description = '', matchedTitle = '', source = '', isAsin = false, asin = '', asinTitle = '';
  // Best NON-junk result's snippet — a description fallback when pages are bot-protected.
  // (Skip social/video sites — an Instagram caption is not a book description.)
  const bestSnippet = (organic.filter(o => !JUNK_RE.test(o.link || ''))
    .sort((a, b) => titleSim(b.title, title) - titleSim(a.title, title))[0] || {}).snippet || '';

  // 1) ISBN from a snippet, and the first Amazon ASIN (kept as a fallback).
  for (const o of organic) {
    if (!isbn) {
      const m = `${o.title || ''} ${o.snippet || ''}`.match(ISBN_RE);
      if (m) { const d = m[0].replace(/[^0-9]/g, ''); if (d.length === 13) { isbn = d; matchedTitle = o.title; source = 'Web search'; } }
    }
    if (!asin) { const am = (o.link || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/); if (am) { asin = am[1]; asinTitle = o.title; } }
  }

  // 2) Fetch the top non-Amazon, non-junk pages for ISBN (if still missing) AND a description.
  const pages = organic.filter(o => o.link && !/amazon\./i.test(o.link) && !JUNK_RE.test(o.link)).slice(0, 2);
  for (const o of pages) {
    if (isbn && description) break;
    try {
      const r = await fetchT(o.link, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YFBBookBot/1.0)' } }, 4500);
      if (!r.ok) continue;
      const html = await r.text();
      if (!isbn) {
        const m = html.match(ISBN_RE);
        if (m) { const d = m[0].replace(/[^0-9]/g, ''); if (d.length === 13) { isbn = d; matchedTitle = matchedTitle || o.title; source = `Web (${hostOf(o.link)})`; } }
      }
      if (!description) {
        const dsc = pageDesc(html);
        if (dsc) { description = dsc; if (!source) { matchedTitle = matchedTitle || o.title; source = `Web (${hostOf(o.link)})`; } }
      }
    } catch (e) { /* skip slow/blocked pages */ }
  }

  // 2b) Description fallback: use the best search snippet if pages were unreachable.
  if (!description && bestSnippet) { description = cleanDesc(bestSnippet); if (description) source = source ? source + ' + snippet' : 'Web snippet'; }

  // 3) Amazon ASIN fallback for the barcode.
  if (!isbn && asin) { isbn = asin; isAsin = true; matchedTitle = matchedTitle || asinTitle; source = source ? source + ' + Amazon (ASIN)' : 'Amazon (ASIN)'; }

  if (!isbn && !description) return null;
  return { isbn, isAsin, description, matchedTitle, sim: titleSim(matchedTitle, title), source: source || 'Web search' };
}

// PRIMARY source for Malayalam books: keralabookstore.com — scrapable, and its
// <title>/meta carry ISBN + author + publisher + category in a fixed format.
async function fromKeralaBookStore(title, author) {
  if (!SERPER_KEY) return null;
  const q = `${title} ${author || ''} site:keralabookstore.com`.trim();
  let link = '';
  try {
    const sr = await fetchT('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q, gl: 'in', num: 5 }),
    }, 5000);
    if (!sr.ok) return null;
    const sd = await sr.json();
    link = ((sd.organic || []).map(o => o.link).find(l => /keralabookstore\.com\/book\//i.test(l || ''))) || '';
  } catch (e) { return null; }
  if (!link) return null;

  let html = '';
  try {
    const r = await fetchT(link, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, 5000);
    if (!r.ok) return null;
    html = await r.text();
  } catch (e) { return null; }

  // Verify it's the right book via the English book name on the page.
  const eng = (html.match(/Book Name in English\s*:\s*([^<]+)</i) || [])[1] || '';
  if (eng && titleSim(eng, title) < 0.5) return null;

  // Parse the structured <title> tag: "...written by X in category Y, ISBN Z, Published by W from Kerala Book Store..."
  const tt = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const tm = tt.match(/written by\s+(.+?)\s+in category\s+(.+?)\s*,\s*ISBN\s+([0-9Xx-]+)\s*,\s*Published by\s+(.+?)\s+from Kerala Book Store/i);

  let isbn = '', authorName = '', publisher = '', genre = '';
  if (tm) { authorName = tm[1].trim(); genre = tm[2].trim(); isbn = tm[3].replace(/[^0-9Xx]/g, ''); publisher = tm[4].trim(); }
  if (!isbn) { const im = html.match(/ISBN\s*(97[89][0-9]{10})/i); if (im) isbn = im[1]; }
  if (!authorName) { const am = html.match(/<h3[^>]*class="panel-title"[^>]*>\s*Author\s+([^<]+)<\/h3>/i); if (am) authorName = am[1].trim(); }

  // Real blurb (strip the "Book Name in English" line); ignore if it's just the title.
  let description = '';
  const bm = html.match(/itemprop="description"[^>]*>([\s\S]*?)<\/div>/i);
  if (bm) {
    const b = cleanDesc(bm[1].replace(/<h4>[\s\S]*?<\/h4>/i, ' '));
    if (b && b.length >= 40 && titleSim(b, eng || title) < 0.9) description = b;
  }

  if (!isbn && !authorName && !publisher && !description) return null;
  return { isbn, author: authorName, publisher, genre, description, matchedTitle: eng || title, sim: eng ? titleSim(eng, title) : 0.6, source: 'Kerala Book Store' };
}

// Fill empty fields of `base` from `extra` (first source wins); append source label.
function fillGaps(base, extra) {
  if (!extra) return base;
  if (!base)  return extra;
  let added = false;
  for (const k of ['isbn', 'author', 'publisher', 'genre', 'description']) {
    if (!base[k] && extra[k]) { base[k] = extra[k]; if (k === 'isbn') base.isAsin = extra.isAsin; added = true; }
  }
  if (added && extra.source && (base.source || '').indexOf(extra.source) < 0) base.source = (base.source ? base.source + ' + ' : '') + extra.source;
  return base;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, title, author } = JSON.parse(event.body || '{}');
    if (!title || !title.trim())  return json({ found: false });
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ error: 'Unauthorized' }, 401);

    const t = title.trim(), a = (author || '').trim();

    // Source priority: Kerala Book Store (best for Malayalam) → Google Books → Open Library → general web.
    let r = await fromKeralaBookStore(t, a);
    if (!r || !r.isbn || !r.description) r = fillGaps(r, await fromGoogleBooks(t, a));
    if (!r || !r.isbn)                   r = fillGaps(r, await fromOpenLibrary(t, a));
    if (!r || !r.isbn || !r.description) r = fillGaps(r, await fromSerper(t, a));

    if (!r || (!r.isbn && !r.description && !r.author)) return json({ found: false });
    return json({
      found:        true,
      isbn:         r.isbn || '',
      isAsin:       !!r.isAsin,
      author:       r.author || '',
      publisher:    r.publisher || '',
      genre:        r.genre || '',
      description:  r.description || '',
      matchedTitle: r.matchedTitle || '',
      source:       r.source,
      sim:          Math.round((r.sim || 0) * 100) / 100,
    });
  } catch (err) {
    console.error('web-book-lookup error:', err.message);
    return json({ found: false, error: err.message });
  }
};
