// WhatsApp Campaign sender for Admin.
// POST { adminEmail, adminKey, action, ...params }
//
// Actions:
//   upload-media   { base64, mimeType, fileName }
//   count-customers { segments }
//   send-campaign  { segments, message, media, mediaType }
//
// Meta WhatsApp templates required (create in Meta Business Manager):
//   yfb_campaign_text  — Category: Marketing, Body: {{message}}
//   yfb_campaign_image — Category: Marketing, Header: IMAGE (var), Body: {{message}}
//   yfb_campaign_video — Category: Marketing, Header: VIDEO (var), Body: {{message}}

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const WA_PHONE_ID     = process.env.WA_PHONE_NUMBER_ID || '1178132198705778';
const WA_TOKEN        = process.env.WA_TOKEN;           // Meta permanent token
const API_VERSION     = '2024-01';
const WA_API_VERSION  = 'v20.0';

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
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

// ── Shopify: fetch customers with phone numbers by segment ──────────────────
async function fetchCustomers(segments) {
  const customers = [];
  let url = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/customers.json?limit=250&fields=id,first_name,last_name,email,phone,tags`;

  while (url) {
    const res  = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
    const data = await res.json();
    const page = data.customers || [];

    for (const c of page) {
      const tags = (c.tags || '').toLowerCase().split(',').map(t => t.trim());
      const isMember = tags.includes('member') || tags.includes('club_member');
      const isAuthor = tags.includes('author');
      const isGuest  = !isMember && !isAuthor;

      const include = (segments.includes('member') && isMember)
                   || (segments.includes('author') && isAuthor)
                   || (segments.includes('guest')  && isGuest);

      if (!include) continue;

      // Normalise phone
      const raw = (c.phone || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
      const waPhone = raw.length === 10 ? '91' + raw
                    : raw.startsWith('91') && raw.length === 12 ? raw
                    : raw;

      if (waPhone.length < 11) continue; // skip if no valid phone

      customers.push({
        id:        c.id,
        name:      [c.first_name, c.last_name].filter(Boolean).join(' ') || 'there',
        firstName: c.first_name || 'there',
        email:     c.email || '',
        phone:     waPhone,
        isMember, isAuthor, isGuest
      });
    }

    // Pagination via Link header
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  return customers;
}

// ── WhatsApp: upload media and return media_id ──────────────────────────────
async function uploadMedia(base64, mimeType, fileName) {
  const buffer = Buffer.from(base64, 'base64');

  // Use node-fetch FormData or manual multipart
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';

  const header =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="messaging_product"${CRLF}${CRLF}` +
    `whatsapp${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="type"${CRLF}${CRLF}` +
    `${mimeType}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`;

  const footer = `${CRLF}--${boundary}--${CRLF}`;

  const headerBuf = Buffer.from(header, 'utf-8');
  const footerBuf = Buffer.from(footer, 'utf-8');
  const body = Buffer.concat([headerBuf, buffer, footerBuf]);

  const res  = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/media`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type':  `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  const data = await res.json();
  if (!data.id) throw new Error(data.error?.message || 'Media upload failed');
  return data.id;
}

// ── WhatsApp: build template message payload ────────────────────────────────
function buildWaMessage(phone, message, media, mediaType) {
  if (mediaType === 'images' && media.length > 0) {
    // Send first image as template header (yfb_campaign_image)
    // Additional images sent as separate messages
    return {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: 'yfb_campaign_image',
        language: { code: 'en' },
        components: [
          {
            type: 'header',
            parameters: [{ type: 'image', image: { id: media[0].mediaId } }]
          },
          {
            type: 'body',
            parameters: [{ type: 'text', parameter_name: 'campaign_message', text: message.slice(0, 750).replace(/[\n\r\t]/g, ' ').replace(/ {5,}/g, '    ') }]
          }
        ]
      }
    };
  } else if (mediaType === 'video' && media.length > 0) {
    // Support both pre-uploaded media (mediaId) and direct URL (videoUrl from Cloudinary)
    const videoParam = media[0].videoUrl
      ? { type: 'video', video: { link: media[0].videoUrl } }
      : { type: 'video', video: { id: media[0].mediaId } };
    return {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: 'yfb_campaign_video',
        language: { code: 'en' },
        components: [
          {
            type: 'header',
            parameters: [videoParam]
          },
          {
            type: 'body',
            parameters: [{ type: 'text', parameter_name: 'campaign_message', text: message.slice(0, 750).replace(/[\n\r\t]/g, ' ').replace(/ {5,}/g, '    ') }]
          }
        ]
      }
    };
  } else {
    // Text only
    return {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: 'yfb_campaign_text',
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', parameter_name: 'campaign_message', text: message.slice(0, 750).replace(/[\n\r\t]/g, ' ').replace(/ {5,}/g, '    ') }]
          }
        ]
      }
    };
  }
}

async function sendWaMessage(payload) {
  const res  = await fetch(`https://graph.facebook.com/${WA_API_VERSION}/${WA_PHONE_ID}/messages`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// ── Main handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const body = JSON.parse(event.body || '{}');
  const { adminEmail, adminKey, action } = body;

  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  // ── Get direct customers (paginated) ──
  if (action === 'get-direct-customers') {
    const page  = parseInt(body.page  || 1);
    const limit = parseInt(body.limit || 100);
    const offset = (page - 1) * limit;
    try {
      const [countRes, dataRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/wa_direct_customers?select=count`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Prefer': 'count=exact' } }),
        fetch(`${SUPABASE_URL}/rest/v1/wa_direct_customers?select=name,phone&order=name.asc&limit=${limit}&offset=${offset}`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } })
      ]);
      const total     = parseInt(countRes.headers.get('content-range')?.split('/')[1] || 0);
      const customers = await dataRes.json();
      return json({ success: true, total, customers: customers || [], page, limit });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Get blacklist ──
  if (action === 'get-blacklist') {
    try {
      const res  = await fetch(`${SUPABASE_URL}/rest/v1/wa_campaign_blacklist?select=phone`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      const rows = await res.json();
      const phones = (rows || []).map(r => r.phone);
      return json({ success: true, phones });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Toggle blacklist (add or remove) ──
  if (action === 'toggle-blacklist') {
    const { phone, email, name, remove } = body;
    if (!phone) return json({ success: false, error: 'phone required' }, 400);
    try {
      if (remove) {
        await fetch(`${SUPABASE_URL}/rest/v1/wa_campaign_blacklist?phone=eq.${encodeURIComponent(phone)}`,
          { method: 'DELETE', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      } else {
        await fetch(`${SUPABASE_URL}/rest/v1/wa_campaign_blacklist`,
          { method: 'POST',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
                       'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ phone, email: email||'', name: name||'', blacklisted_by: adminEmail }) });
      }
      return json({ success: true });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Upload media ──
  if (action === 'upload-media') {
    const { base64, mimeType, fileName } = body;
    if (!base64 || !mimeType) return json({ success: false, error: 'base64 and mimeType required' }, 400);
    try {
      const mediaId = await uploadMedia(base64, mimeType, fileName || 'file');
      return json({ success: true, mediaId });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Count + list customers ──
  if (action === 'count-customers') {
    const { segments = [] } = body;
    try {
      const all       = await fetchCustomers(segments);
      const customers = all.filter(c => c.phone.length >= 11);
      return json({ success: true, count: customers.length, total: all.length, customers });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Send campaign ──
  if (action === 'send-campaign') {
    const { phones = [], message, media = [], mediaType = 'none' } = body;
    if (!message)       return json({ success: false, error: 'message is required' }, 400);
    if (!phones.length) return json({ success: false, error: 'No recipients selected' }, 400);

    try {
      // Build minimal customer objects from phone list
      const customers = phones.map(phone => ({ phone, name: phone, email: '' }));
      let sent = 0, failed = 0;
      const errors = [];

      for (const customer of customers) {
        try {
          const payload = buildWaMessage(customer.phone, message, media, mediaType);
          const result  = await sendWaMessage(payload);

          if (result.messages?.[0]?.message_status === 'accepted' || result.messages?.length) {
            sent++;
            // Send extra images as separate image messages (if more than 1 image)
            if (mediaType === 'images' && media.length > 1) {
              for (let i = 1; i < media.length; i++) {
                await sendWaMessage({
                  messaging_product: 'whatsapp',
                  to: customer.phone,
                  type: 'image',
                  image: { id: media[i].mediaId }
                });
              }
            }
          } else {
            failed++;
            errors.push({
              name:  customer.name,
              phone: customer.phone,
              error: result.error?.message || JSON.stringify(result.error) || 'Unknown error',
              code:  result.error?.code,
              subcode: result.error?.error_subcode
            });
          }

          // Small delay to respect rate limits (~80 msg/sec WhatsApp limit)
          // Use 20ms for video (batches are smaller, need to stay under Netlify 10s timeout)
          await new Promise(r => setTimeout(r, mediaType === 'video' ? 20 : 50));

        } catch(e) {
          failed++;
          errors.push({ phone: customer.phone, error: e.message });
        }
      }

      return json({ success: true, sent, failed, total: customers.length, errors: errors.slice(0, 10) });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  return json({ success: false, error: 'Unknown action' }, 400);
};
