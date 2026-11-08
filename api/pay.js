// Sunrose Trader OS — start a Paystack subscription checkout, or open the "manage subscription" page.
// Only logged-in members can call this.
//
// Environment variables (Vercel > sunrose-relay > Settings > Environment Variables):
//   PAYSTACK_SECRET_KEY     sk_test_... while testing, sk_live_... when you go live
//   PAYSTACK_PLAN_MONTHLY   plan code of the ₦39,500 monthly plan (PLN_...)
//   PAYSTACK_PLAN_YEARLY    plan code of the ₦330,000 yearly plan (PLN_...)
//   SUPABASE_SERVICE_KEY    already set (Trader OS database secret key)

const SB_URL = 'https://bjjrwtwiljfhenyyxwqr.supabase.co';
const SB_KEY = 'sb_publishable_O1V_pifLmzEVj1xvvVu6eg_RILwwgAv';
const APP_URL = 'https://pastorsunnypraiseaba2-cloud.github.io/sunrose-trader-os/';
const ALLOWED_ORIGINS = ['https://pastorsunnypraiseaba2-cloud.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];
const PLANS = {
  monthly: { env: 'PAYSTACK_PLAN_MONTHLY', amount: 39500 },
  yearly:  { env: 'PAYSTACK_PLAN_YEARLY',  amount: 330000 },
};

function fail(res, status, message) { res.status(status).json({ error: { message } }); }

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return fail(res, 405, 'Use POST');

  const psKey = process.env.PAYSTACK_SECRET_KEY;
  const svcKey = process.env.SUPABASE_SERVICE_KEY;
  if (!psKey || !svcKey) return fail(res, 500, 'Payments are not configured yet.');

  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 401, 'Please log in first.');

  try {
    // 1. Who is paying?
    const ur = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return fail(res, 401, 'Your login has expired. Please log in again.');
    const user = await ur.json();
    if (!user || !user.id || !user.email) return fail(res, 401, 'Please log in again.');

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const action = body.action || 'checkout';
    const ps = { Authorization: 'Bearer ' + psKey, 'Content-Type': 'application/json' };

    // 2a. Manage an existing subscription (update card / cancel)
    if (action === 'manage') {
      const pr = await fetch(SB_URL + '/rest/v1/profiles?select=paystack_subscription_code&id=eq.' + user.id, { headers: { apikey: svcKey } });
      const rows = pr.ok ? await pr.json() : [];
      const code = rows[0] && rows[0].paystack_subscription_code;
      if (!code) return fail(res, 404, 'No active subscription found on this account.');
      const lr = await fetch('https://api.paystack.co/subscription/' + encodeURIComponent(code) + '/manage/link', { headers: ps });
      const lj = await lr.json().catch(() => ({}));
      if (!lr.ok || !lj.data || !lj.data.link) return fail(res, 502, 'Could not open the subscription page. Please try again.');
      return res.status(200).json({ url: lj.data.link });
    }

    // 2b. Start a new subscription checkout
    const plan = PLANS[body.plan];
    if (!plan) return fail(res, 400, 'Choose the monthly or yearly plan.');
    const planCode = process.env[plan.env];
    if (!planCode) return fail(res, 500, 'This plan is not configured yet.');

    const ir = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: ps,
      body: JSON.stringify({
        email: user.email,
        amount: plan.amount * 100,          // kobo; Paystack uses the plan's own amount when a plan is given
        plan: planCode,
        callback_url: APP_URL + '?paid=1',
        metadata: { user_id: user.id, plan: body.plan, cancel_action: APP_URL },
        channels: ['card'],                 // subscriptions renew automatically from a saved card
      }),
    });
    const ij = await ir.json().catch(() => ({}));
    if (!ir.ok || !ij.data || !ij.data.authorization_url) {
      console.error('Paystack initialize error', ir.status, JSON.stringify(ij));
      return fail(res, 502, (ij && ij.message) || 'Could not start the payment. Please try again.');
    }
    return res.status(200).json({ url: ij.data.authorization_url, reference: ij.data.reference });
  } catch (e) {
    console.error('pay error', e);
    return fail(res, 500, 'Payment error. Please try again.');
  }
}
