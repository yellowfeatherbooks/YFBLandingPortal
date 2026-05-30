const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const SHOPIFY_DOMAIN  = process.env.SHOPIFY_DOMAIN || 'zgqk4e-1m.myshopify.com';
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION     = '2024-01';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email) return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissions: [] })
    };

    // ── 1. Supabase submissions ──────────────────────────────────────────────
    let supabaseRows = [];
    try {
      const res  = await fetch(
        `${SUPABASE_URL}/rest/v1/submissions?submitted_by=eq.${encodeURIComponent(email)}&order=submitted_date.desc`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await res.json();
      supabaseRows = Array.isArray(rows) ? rows : [];
    } catch(e) { /* ignore — fall through to Shopify */ }

    // Collect shopify_ids already in Supabase so we don't duplicate
    const knownShopifyIds = new Set(supabaseRows.map(r => String(r.shopify_id || '')).filter(Boolean));

    // ── 2. Shopify — products tagged submittedby:{email} ────────────────────
    let shopifyRows = [];
    if (SHOPIFY_TOKEN) {
      try {
        const gqlRes = await fetch(
          `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
          {
            method:  'POST',
            headers: {
              'Content-Type':           'application/json',
              'X-Shopify-Access-Token': SHOPIFY_TOKEN
            },
            body: JSON.stringify({
              query: `
                query GetSubmittedProducts($q: String!) {
                  products(first: 100, query: $q) {
                    edges {
                      node {
                        id
                        title
                        vendor
                        status
                        tags
                        createdAt
                        featuredImage { url }
                        variants(first: 1) {
                          edges { node { price } }
                        }
                      }
                    }
                  }
                }`,
              variables: { q: `tag:'submittedby:${email}'` }
            })
          }
        );
        const gqlData = await gqlRes.json();
        const edges   = gqlData?.data?.products?.edges || [];

        shopifyRows = edges
          .map(e => e.node)
          .filter(p => {
            // Extract numeric Shopify ID and skip if already in Supabase
            const numId = String(p.id).split('/').pop();
            return !knownShopifyIds.has(numId);
          })
          .map(p => {
            const numId = String(p.id).split('/').pop();
            const price = parseFloat(p.variants?.edges?.[0]?.node?.price || 0);
            return {
              title:          p.title,
              author:         p.vendor,
              publisher:      p.vendor,
              genre:          '',
              mrp:            price,
              status:         p.status === 'ACTIVE' ? 'live' : 'under_review',
              submitted_date: p.createdAt,
              submitted_by:   email,
              shopify_id:     numId,
              // frontend compat aliases
              submittted_date: p.createdAt,
              shopify_Id:      numId,
              _source:         'shopify'
            };
          });
      } catch(e) { /* ignore Shopify errors */ }
    }

    // ── 3. Merge — Supabase first (authoritative), Shopify fills gaps ────────
    const supabaseMapped = supabaseRows.map(r => ({
      ...r,
      submittted_date: r.submitted_date,
      shopify_Id:      r.shopify_id
    }));

    const submissions = [...supabaseMapped, ...shopifyRows];

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissions })
    };

  } catch (err) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissions: [], error: err.message })
    };
  }
};
