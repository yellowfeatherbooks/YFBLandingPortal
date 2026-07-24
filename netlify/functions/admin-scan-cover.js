// admin-scan-cover.js
// Admin helper for the Add Book → Shopify form's "Scan Covers" feature.
// POST { adminEmail, adminKey, frontImageBase64, backImageBase64? }
//   → Claude vision reads the photographed front/back cover and extracts
//     title / author / publisher / genre / description / ISBN / MRP.
//   → Returns a DRAFT for the admin to review/correct before publishing —
//     never auto-submits anything. frontImageBase64 is required; backImageBase64
//     (often carries the blurb, printed ISBN digits, and sometimes MRP) is optional
//     but improves accuracy a lot.
//
// Env: SUPABASE_URL, SUPABASE_KEY (admin auth only), ANTHROPIC_API_KEY.

const crypto        = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CLAUDE_KEY    = (process.env.ANTHROPIC_API_KEY || '').trim();
const CLAUDE_MODEL  = 'claude-sonnet-5';

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

async function verifyAdmin(email, adminKey) {
  if (!email || !adminKey) return false;
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

// Same genre list the Add Book form's dropdown offers — giving Claude the closed
// list makes the raw guess land on a real option more often (the frontend still
// fuzzy-matches via ssMatchSelectOption, so an off-list guess isn't fatal).
const GENRES = [
  'Adventure','Anthologies','Autobiography','Biography','Business / Finance',
  "Children's Literature",'Classic Literature','Cookbooks','Crime','Drama',
  'Fantasy','Fiction','Graphic Novels / Comics','Health & Wellness',
  'Historical Fiction','Horror','Humor / Comedy','Literary Fiction','Memoir',
  'Mystery','Non-Fiction','Novel','Philosophy','Poetry','Romance',
  'Science Fiction','Self-Help','Short Stories','Socio-Political',
  'Spiritual / Religious','Suspense','Tantric','Thriller','Thriller & Crime',
  'Translations','Travel','Travelogues','Young Adult (YA)'
];

// "data:image/jpeg;base64,AAAA..." → { mediaType, data }
function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mediaType: m[1], data: m[2] };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, frontImageBase64, backImageBase64 } = JSON.parse(event.body || '{}');
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);
    if (!CLAUDE_KEY) return json({ success: false, error: 'Cover scanning not configured (missing ANTHROPIC_API_KEY).' }, 500);

    const front = splitDataUrl(frontImageBase64);
    if (!front) return json({ success: false, error: 'Front cover image is required.' }, 400);
    const back = splitDataUrl(backImageBase64);

    const content = [
      { type: 'text', text: 'FRONT COVER:' },
      { type: 'image', source: { type: 'base64', media_type: front.mediaType, data: front.data } },
    ];
    if (back) {
      content.push({ type: 'text', text: 'BACK COVER:' });
      content.push({ type: 'image', source: { type: 'base64', media_type: back.mediaType, data: back.data } });
    }
    content.push({
      type: 'text',
      text: `These are photo(s) of a physical book's cover, for a Malayalam/English bookstore's catalog. Extract what you can read.

Respond ONLY with valid JSON (no markdown fences), matching this exact shape:
{
  "title": "book title as printed (English, transliterate if needed)",
  "title_ml": "the title in Malayalam script if the cover shows it, else empty string",
  "author": "author's full name",
  "author_ml": "author's name in Malayalam script if shown, else empty string",
  "publisher": "publisher name as printed (on spine, front, or back cover)",
  "genre": "pick the SINGLE closest match from this exact list, or empty string if none fit: ${GENRES.join(', ')}",
  "description": "a clean 2-4 sentence description based on the back-cover blurb — rewrite marketing copy into plain descriptive sentences, don't just paste raw OCR text",
  "isbn": "the ISBN digits printed near the barcode (NOT decoded from the barcode lines themselves — read the printed digits), else empty string",
  "mrp": "the printed price as a plain number (no currency symbol), else empty string if not visible",
  "confidence": "high" | "medium" | "low",
  "notes": "one short sentence flagging anything uncertain or illegible — empty string if nothing to flag"
}

Rules:
- Never invent a value you can't actually read — use an empty string instead.
- If front and back cover disagree on a field, prefer whichever is clearer/more complete.
- The "FRONT COVER" image may actually be a single wraparound photo showing the back
  panel, spine, AND front panel side by side (common when someone photographs the
  whole flattened cover in one shot) — that's fine, read text from ANYWHERE in the
  image regardless of which panel it's in, don't restrict yourself to only the
  right-hand/front-facing portion.
- A stylized/decorative title logo can be hard to OCR — still report the author name,
  publisher, ISBN, price and description if those are in plainer text elsewhere on
  the cover, even if the title itself is illegible. Getting some fields right beats
  reporting nothing.
- "confidence":"low" whenever the photo is blurry, glared, or a field is a guess.`
    });

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      CLAUDE_MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('admin-scan-cover: Claude error', claudeRes.status, errText.slice(0, 300));
      return json({ success: false, error: 'Could not read the cover images. Please try again or enter details manually.' }, 502);
    }

    const cd  = await claudeRes.json();
    const raw = cd.content?.[0]?.text || '{}';
    console.log(`admin-scan-cover: front=${Math.round(front.data.length/1024)}KB back=${back ? Math.round(back.data.length/1024)+'KB' : 'none'} tokens_in=${cd.usage?.input_tokens} tokens_out=${cd.usage?.output_tokens}`);
    let extracted;
    try {
      extracted = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      console.error('admin-scan-cover: JSON parse failed', raw.slice(0, 300));
      return json({ success: false, error: 'Could not parse the extracted details. Please try again or enter details manually.' }, 502);
    }

    const result = {
      success: true,
      title:       extracted.title       || '',
      title_ml:    extracted.title_ml    || '',
      author:      extracted.author      || '',
      author_ml:   extracted.author_ml   || '',
      publisher:   extracted.publisher   || '',
      genre:       extracted.genre       || '',
      description: extracted.description || '',
      isbn:        extracted.isbn        || '',
      mrp:         extracted.mrp         || '',
      confidence:  extracted.confidence  || 'medium',
      notes:       extracted.notes       || ''
    };

    // Nothing readable at all is unusual for a real cover photo — surface Claude's
    // raw reply so a repeat can be diagnosed from the response alone, without
    // needing to pull Netlify function logs.
    const gotNothing = !result.title && !result.author && !result.publisher && !result.isbn && !result.description;
    if (gotNothing) {
      console.warn('admin-scan-cover: nothing extracted, raw reply:', raw.slice(0, 500));
      result.debug = raw.slice(0, 500);
    }

    return json(result);
  } catch (err) {
    console.error('admin-scan-cover error:', err.message);
    return json({ success: false, error: 'Scan failed. Please try again.' }, 500);
  }
};
