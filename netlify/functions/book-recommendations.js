// "Readers Also Loved" — AI-picked recommendations for a book, cached per handle.
// POST { handle, title, description } -> { success: true, handles: [...] }

const SUPABASE_URL   = process.env.SUPABASE_URL;
const SERVICE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const CLAUDE_KEY     = (process.env.ANTHROPIC_API_KEY || '').trim();
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';

const CACHE_DAYS = 30;

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

async function shopifyGet(path) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/${path}`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { handle, title, description } = JSON.parse(event.body || '{}');
  if (!handle) return json({ success: true, handles: [] });

  try {
    // ── Cache check ──
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/book_recommendations?handle=eq.${encodeURIComponent(handle)}&select=recommended_handles,generated_at&limit=1`,
      { headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` } }
    );
    const cacheRows = await cacheRes.json();
    const cached    = Array.isArray(cacheRows) && cacheRows.length ? cacheRows[0] : null;
    if (cached) {
      const ageMs = Date.now() - new Date(cached.generated_at).getTime();
      if (ageMs < CACHE_DAYS * 24 * 60 * 60 * 1000) {
        return json({ success: true, handles: cached.recommended_handles || [] });
      }
    }

    if (!CLAUDE_KEY || !SHOPIFY_TOKEN) return json({ success: true, handles: [] });

    // ── Candidate pool from Shopify ──
    const productData = await shopifyGet('products.json?status=active&limit=250&fields=title,handle,vendor,tags');
    const candidates = (productData.products || []).filter(p => p.handle !== handle);
    if (!candidates.length) return json({ success: true, handles: [] });

    const catalog = candidates
      .map((p, i) => `${i + 1}. "${p.title}" by ${p.vendor || 'Unknown'} [${p.tags || ''}]`)
      .join('\n');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role:    'user',
          content: `A reader just viewed this book:
Title: ${title || handle}
Description: ${(description || '').substring(0, 500)}

Here is the store's catalog (numbered):
${catalog}

Pick the 3 books from this catalog that a reader who enjoyed the viewed book would most likely also enjoy (similar genre, theme, or author).

Do NOT explain your reasoning or list characteristics. Respond with ONLY a JSON array of 1-based indexes on a single line, e.g. [4,12,7]. Only use indexes from the numbered list above. No markdown, no prose, no preamble — the array must be the entire response.`
        }]
      })
    });

    let handles = [];
    if (claudeRes.ok) {
      const cd  = await claudeRes.json();
      const raw = cd.content?.[0]?.text || '[]';
      try {
        const match  = raw.match(/\[[\d,\s]*\]/);
        const picked = JSON.parse(match ? match[0] : raw);
        if (Array.isArray(picked)) {
          handles = picked
            .map(i => candidates[i - 1]?.handle)
            .filter(Boolean)
            .slice(0, 3);
        }
        if (!handles.length) console.error('book-recommendations: no handles resolved from Claude response:', raw);
      } catch(e) { console.error('book-recommendations: failed to parse Claude response:', raw, e.message); }
    } else {
      console.error('book-recommendations: Claude request failed', claudeRes.status, await claudeRes.text());
    }

    // ── Cache the result (even if empty, to avoid retrying every view on a persistent failure) ──
    fetch(`${SUPABASE_URL}/rest/v1/book_recommendations`, {
      method:  'POST',
      headers: {
        'apikey':        SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({ handle, recommended_handles: handles, generated_at: new Date().toISOString() })
    }).catch(e => console.error('book_recommendations cache write failed:', e.message));

    return json({ success: true, handles });
  } catch (err) {
    console.error('book-recommendations error:', err.message);
    return json({ success: true, handles: [] });
  }
};
