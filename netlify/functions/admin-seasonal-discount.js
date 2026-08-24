// GET  → returns current seasonal discount config (public, no auth) — used by the
//        website's checkout estimate and the admin panel's prefill.
// POST { adminEmail, adminKey, enabled, label, percent, startDate, endDate }
//   → saves to Supabase (site_config key 'seasonal_discount') AND syncs a matching
//     Shopify Automatic Discount so the real website checkout (Storefront API →
//     Shopify hosted checkout) applies it too. The app's native checkout instead
//     reads this same Supabase config server-side, in create-native-order.js —
//     see that file's getSeasonalDiscount()/isSeasonalActive() for why: the app's
//     own client code can't be trusted to compute the percent (see FLASH5 history).
//
// Shopify side: a DiscountAutomaticBasic targeting ALL products (customerGets.items.all),
// with combinesWith set to allow stacking with Book Club / Flash / Author discount CODES —
// note that stacking is a two-way agreement in Shopify: those existing codes must ALSO
// have combinesWith.orderDiscounts (or productDiscounts, depending on their type) enabled
// on their own side for the combination to actually apply at checkout. This function only
// controls the seasonal discount's own combinesWith; verify the other codes in Shopify
// Admin if stacking doesn't appear to work end-to-end.

const crypto        = require('crypto');
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION    = '2025-04';
const GQL_URL        = `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
const GQL_HEADERS    = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

const DEFAULTS = { enabled: false, label: '', percent: 0, startDate: null, endDate: null, shopifyDiscountId: null };

let _cache = null; // { config, ts }
const CACHE_TTL = 5 * 60 * 1000;

function getCached() {
  if (_cache && (Date.now() - _cache.ts) < CACHE_TTL) return _cache.config;
  return null;
}
function setCache(config) { _cache = { config, ts: Date.now() }; }
function bustCache() { _cache = null; }

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
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

async function shopifyGql(query, variables = {}) {
  const res = await fetch(GQL_URL, { method: 'POST', headers: GQL_HEADERS, body: JSON.stringify({ query, variables }) });
  return res.json();
}

function isActive(config) {
  if (!config?.enabled || !config.startDate || !config.endDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return today >= config.startDate && today <= config.endDate;
}

function toShopifyDiscountInput(config) {
  return {
    title: config.label,
    startsAt: `${config.startDate}T00:00:00Z`,
    endsAt: `${config.endDate}T23:59:59Z`,
    combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
    customerGets: {
      value: { percentage: config.percent / 100 },
      items: { all: true },
    },
  };
}

// Creates, updates, or deletes the Shopify automatic discount to match the saved
// config. Returns { shopifyDiscountId, shopifyError } — shopifyError is surfaced to
// the admin but never blocks the Supabase save (Supabase stays the source of truth
// for the app; Shopify sync is best-effort for the website).
async function syncShopifyDiscount(config, previousId) {
  if (!SHOPIFY_TOKEN) return { shopifyDiscountId: previousId, shopifyError: 'SHOPIFY_ADMIN_TOKEN not configured — website checkout will not reflect this campaign.' };

  try {
    if (!config.enabled) {
      if (previousId) {
        const r = await shopifyGql(
          `mutation discountAutomaticDelete($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } } }`,
          { id: previousId }
        );
        const ue = r?.data?.discountAutomaticDelete?.userErrors;
        if (ue?.length) return { shopifyDiscountId: previousId, shopifyError: 'Delete failed: ' + JSON.stringify(ue) };
      }
      return { shopifyDiscountId: null, shopifyError: null };
    }

    const input = toShopifyDiscountInput(config);

    if (previousId) {
      const r = await shopifyGql(
        `mutation discountAutomaticBasicUpdate($id: ID!, $automaticBasicDiscount: DiscountAutomaticBasicInput!) {
          discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $automaticBasicDiscount) {
            automaticDiscountNode { id }
            userErrors { field message }
          }
        }`,
        { id: previousId, automaticBasicDiscount: input }
      );
      const ue = r?.data?.discountAutomaticBasicUpdate?.userErrors;
      if (ue?.length) return { shopifyDiscountId: previousId, shopifyError: 'Update failed: ' + JSON.stringify(ue) };
      if (r?.errors) return { shopifyDiscountId: previousId, shopifyError: 'Update failed: ' + JSON.stringify(r.errors) };
      const id = r?.data?.discountAutomaticBasicUpdate?.automaticDiscountNode?.id || previousId;
      return { shopifyDiscountId: id, shopifyError: null };
    }

    const r = await shopifyGql(
      `mutation discountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
          automaticDiscountNode { id }
          userErrors { field message }
        }
      }`,
      { automaticBasicDiscount: input }
    );
    const ue = r?.data?.discountAutomaticBasicCreate?.userErrors;
    if (ue?.length) return { shopifyDiscountId: null, shopifyError: 'Create failed: ' + JSON.stringify(ue) };
    if (r?.errors) return { shopifyDiscountId: null, shopifyError: 'Create failed: ' + JSON.stringify(r.errors) };
    const id = r?.data?.discountAutomaticBasicCreate?.automaticDiscountNode?.id || null;
    return { shopifyDiscountId: id, shopifyError: null };
  } catch (e) {
    return { shopifyDiscountId: previousId, shopifyError: e.message };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  // ── GET: public read (cached) ─────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const cached = getCached();
    if (cached) return json({ ...cached, active: isActive(cached) });
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/site_config?key=eq.seasonal_discount&select=value&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      const config = rows?.[0]?.value || DEFAULTS;
      setCache(config);
      return json({ ...config, active: isActive(config) });
    } catch (e) {
      return json({ ...DEFAULTS, active: false });
    }
  }

  // ── POST: admin save ──────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json({ error: 'Method Not Allowed' }, 405);

  try {
    const { adminEmail, adminKey, enabled, label, percent, startDate, endDate, adoptShopifyDiscountId } = JSON.parse(event.body || '{}');
    if (!await verifyAdmin(adminEmail, adminKey)) return json({ error: 'Unauthorized' }, 401);

    // Adopting a discount while "enabled" is off would otherwise DELETE that Shopify
    // discount (the enabled=false branch below deletes whatever previousId points at) —
    // block that combination outright rather than silently destroying someone's manually
    // created discount because a checkbox was left unchecked.
    if (adoptShopifyDiscountId && !enabled) {
      return json({ error: 'Check "Campaign enabled" before adopting an existing Shopify discount — otherwise this would delete it. Enable the campaign first, then save.' }, 400);
    }

    const percentNum = Number(percent);
    if (enabled) {
      if (!label || !String(label).trim())              return json({ error: 'Campaign label is required.' }, 400);
      if (!Number.isFinite(percentNum) || percentNum <= 0 || percentNum > 100) return json({ error: 'Discount must be between 1 and 100.' }, 400);
      if (!startDate || !endDate)                        return json({ error: 'Start and end dates are required.' }, 400);
      if (startDate > endDate)                            return json({ error: 'Start date must be on or before end date.' }, 400);
    }

    // Read previous config to get any existing Shopify discount id (for update/delete).
    let previousId = null;
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/site_config?key=eq.seasonal_discount&select=value&limit=1`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      previousId = rows?.[0]?.value?.shopifyDiscountId || null;
    } catch (e) { /* proceed without previousId — will create fresh */ }

    // Adopting an existing Shopify discount (e.g. one created manually in Shopify
    // Admin before this panel existed) — takes precedence over whatever's stored,
    // so the next save UPDATEs that discount (fixing its combinesWith to match our
    // "always stack" design) instead of creating a duplicate.
    if (adoptShopifyDiscountId) {
      const raw = String(adoptShopifyDiscountId).trim();
      previousId = raw.startsWith('gid://') ? raw : `gid://shopify/DiscountAutomaticNode/${raw}`;
    }

    const config = {
      enabled:  !!enabled,
      label:    String(label || '').trim(),
      percent:  percentNum,
      startDate: startDate || null,
      endDate:   endDate || null,
    };

    const { shopifyDiscountId, shopifyError } = await syncShopifyDiscount(config, previousId);
    config.shopifyDiscountId = shopifyDiscountId;

    bustCache();

    await fetch(`${SUPABASE_URL}/rest/v1/site_config`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key: 'seasonal_discount', value: config, updated_at: new Date().toISOString() })
    });

    return json({ success: true, ...config, active: isActive(config), shopifyError: shopifyError || undefined });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
