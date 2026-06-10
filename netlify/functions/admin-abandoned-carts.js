// Admin: fetch abandoned carts + send manual reminders
// POST { adminEmail, adminKey, action }
// Actions: list | remind

const crypto         = require('crypto');
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2024-01';
const N8N_REMINDER_URL = process.env.N8N_REMINDER_URL;
const WA_PHONE_ID     = process.env.WA_PHONE_NUMBER_ID || '1178132198705778';
const WA_TOKEN        = process.env.WA_TOKEN;

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

async function verifySales(email, salesKey) {
  const res  = await fetch(
    `${SUPABASE_URL}/rest/v1/sales_team?email=eq.${encodeURIComponent(email)}&select=password_hash&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === salesKey;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method not allowed' }, 405);

  const body = JSON.parse(event.body || '{}');
  const { adminEmail, adminKey, action } = body;

  // Accept either admin or sales team credentials
  const isAdmin = await verifyAdmin(adminEmail, adminKey);
  const isSales = !isAdmin && await verifySales(adminEmail, adminKey);
  if (!isAdmin && !isSales) return json({ success: false, error: 'Unauthorized' }, 401);

  // ── List abandoned carts ──────────────────────────────────────────────────
  if (action === 'list') {
    try {
      // Fetch checkouts not completed in last 72 hours
      const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
      const res   = await fetch(
        `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/checkouts.json?limit=100&updated_at_min=${since}`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
      );
      const data  = await res.json();
      const checkouts = (data.checkouts || [])
        .filter(c => !c.completed_at && c.line_items?.length > 0)
        .map(c => {
          const tags       = (c.customer?.tags || '').toLowerCase();
          const isMember   = tags.includes('member') || tags.includes('club_member');
          const isAuthor   = tags.includes('author');
          const rawPhone   = (c.phone || c.billing_address?.phone || c.shipping_address?.phone || '').replace(/\D/g, '').replace(/^0+/, '');
          const waPhone    = rawPhone.length === 10 ? '91' + rawPhone : rawPhone.startsWith('91') && rawPhone.length === 12 ? rawPhone : '';
          const hoursAgo   = Math.round((Date.now() - new Date(c.updated_at).getTime()) / 3600000);
          return {
            token:       c.token,
            email:       c.email || '',
            phone:       waPhone,
            name:        [c.customer?.first_name, c.customer?.last_name].filter(Boolean).join(' ') || c.email || 'Guest',
            isMember, isAuthor,
            items:       (c.line_items || []).map(i => i.title),
            total:       parseFloat(c.total_price || 0),
            hoursAgo,
            cartUrl:     c.abandoned_checkout_url || '',
            updatedAt:   c.updated_at
          };
        })
        .filter(c => c.isMember || c.isAuthor) // only members & authors
        .sort((a, b) => b.hoursAgo - a.hoursAgo); // oldest first

      return json({ success: true, checkouts });
    } catch(e) { return json({ success: false, error: e.message }); }
  }

  // ── Send manual reminder ──────────────────────────────────────────────────
  if (action === 'remind') {
    const { email, phone, name, items, total, cartUrl } = body;
    const firstName = (name || email).split(' ')[0];
    const bookList  = (items || []).slice(0, 3).join(', ') + ((items||[]).length > 3 ? ` and ${items.length - 3} more` : '');
    const results   = { email: false, whatsapp: false };

    // Send email via n8n reminder workflow
    if (email && N8N_REMINDER_URL) {
      try {
        const bodyText = `Hello ${firstName},\n\nYou left some wonderful books in your cart at Yellow Feather Books!\n\n📚 ${bookList}\n\nTotal: ₹${total?.toFixed(2) || ''}\n\nYour cart is saved — complete your purchase here:\n${cartUrl}\n\nNeed help? Contact us at https://wa.me/919400448000\n\nRegards\nTeam Yellow Feather Books`;
        await fetch(N8N_REMINDER_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: email, toName: name,
            subject: `You left ${items?.[0] || 'books'} in your cart — Yellow Feather Books`,
            bodyText, type: 'cart_reminder'
          })
        });
        results.email = true;
      } catch(e) { results.emailError = e.message; }
    }

    // Send WhatsApp
    if (phone && WA_TOKEN) {
      try {
        const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: phone, type: 'template',
            template: {
              name: 'abandoned_cart_recovery', language: { code: 'en_GB' },
              components: [{ type: 'body', parameters: [
                { type: 'text', parameter_name: 'customer_name', text: firstName },
                { type: 'text', parameter_name: 'book_list',     text: bookList },
                { type: 'text', parameter_name: 'cart_url',      text: cartUrl }
              ]}]
            }
          })
        });
        const waData = await waRes.json();
        results.whatsapp = !!waData.messages?.length;
      } catch(e) { results.waError = e.message; }
    }

    return json({ success: true, results });
  }

  return json({ success: false, error: 'Unknown action' }, 400);
};
