const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const key = process.env.RAZORPAY_KEY_ID || '';

  // Plan IDs are env-var-driven so staging (test mode) and production (live mode)
  // can each point to their own Razorpay plans.
  // Production: falls back to the hardcoded live plan IDs if env vars are absent.
  const plans = {
    starter:   process.env.RAZORPAY_PLAN_STARTER   || 'plan_SkuiB2nyoaswNZ',
    growth:    process.env.RAZORPAY_PLAN_GROWTH     || 'plan_SkukwXUCHR58qz',
    publisher: process.env.RAZORPAY_PLAN_PUBLISHER  || 'plan_SkukHR8IHnriYi'
  };

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, plans })
  };
};
