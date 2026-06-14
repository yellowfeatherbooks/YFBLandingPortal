// Returns recent Shopify orders via Admin API.
// POST { adminEmail, adminKey, limit?, status? }

const crypto       = require('crypto');
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN  || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2024-01';

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
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return false;
  const expected = crypto.createHash('sha256').update(email + ':' + rows[0].password_hash).digest('hex');
  return expected === adminKey;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')    return json({ success: false, error: 'Method Not Allowed' }, 405);

  const { adminEmail, adminKey, limit = 50, status = 'any', customer_type } = JSON.parse(event.body || '{}');
  if (!await verifyAdmin(adminEmail, adminKey)) return json({ success: false, error: 'Unauthorized' }, 401);

  try {
    const fetchLimit = customer_type ? 250 : limit;
    const res = await fetch(
      `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/orders.json?status=${status}&limit=${fetchLimit}&fields=id,name,email,created_at,financial_status,fulfillment_status,total_price,current_total_price,subtotal_price,total_tax,cancelled_at,line_items,customer,shipping_address,note`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const data = await res.json();

    let orders = (data.orders || []).map(o => {
      const sa = o.shipping_address || {};
      const tags = (o.customer?.tags || '').toLowerCase().split(',').map(t => t.trim());
      return {
        id:                 o.id,
        name:               o.name,
        email:              o.email || o.customer?.email || '',
        customer:           [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || o.email || '—',
        phone:              o.customer?.phone || sa.phone || '',
        customer_tags:      o.customer?.tags || '',
        is_member:          tags.includes('member') || tags.includes('club_member'),
        is_author:          tags.includes('author'),
        shipping_address:   sa.address1 ? [sa.address1, sa.address2, sa.city, sa.province, sa.zip, sa.country].filter(Boolean).join(', ') : '',
        created_at:         o.created_at,
        financial_status:   o.financial_status,
        fulfillment_status: o.fulfillment_status || 'unfulfilled',
        total_price:         o.total_price,
        current_total_price: o.current_total_price,   // total after refunds/edits (net)
        cancelled_at:        o.cancelled_at || null,
        subtotal_price:     o.subtotal_price,
        total_tax:          o.total_tax,
        note:               o.note || '',
        items:              (o.line_items || []).map(l => ({ title: l.title, quantity: l.quantity, price: l.price, sku: l.sku || '' }))
      };
    });

    if (customer_type === 'member') orders = orders.filter(o => o.is_member);
    if (customer_type === 'author') orders = orders.filter(o => o.is_author);

    return json({ success: true, orders });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
};
