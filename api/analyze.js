// Sunrose relay: only logged-in members with valid access can use the AI.
const SB_URL = 'https://bjjrwtwiljfhenyyxwqr.supabase.co';
const SB_KEY = 'sb_publishable_O1V_pifLmzEVj1xvvVu6eg_RILwwgAv';
const ALLOWED_ORIGIN = 'https://pastorsunnypraiseaba2-cloud.github.io';
const PRICE_IN = 3 / 1e6;     // Claude Sonnet price per input token (USD)
const PRICE_OUT = 15 / 1e6;   // Claude Sonnet price per output token (USD)
const MAX_TOKENS_CAP = 6000;  // largest answer a member can request
const MODEL = 'claude-sonnet-4-6';

function fail(res, status, message) {
  res.status(status).json({ error: { message: message } });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { fail(res, 405, 'Use POST'); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { fail(res, 500, 'Missing ANTHROPIC_API_KEY on server'); return; }
  const svcKey = process.env.SUPABASE_SERVICE_KEY;
  if (!svcKey) { fail(res, 500, 'Missing SUPABASE_SERVICE_KEY on server'); return; }
  const svcHeaders = { apikey: svcKey, 'Content-Type': 'application/json' };

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { fail(res, 401, 'Please log in to use the AI.'); return; }

  try {
    // 1. Who is this member?
    const ur = await fetch(SB_URL + '/auth/v1/user', {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token }
    });
    if (!ur.ok) { fail(res, 401, 'Your login has expired. Please log in again.'); return; }
    const user = await ur.json();
    if (!user || !user.id) { fail(res, 401, 'Please log in again.'); return; }

    // Owner accounts (set in the OWNER_EMAILS setting on Vercel) skip the AI allowance.
    // The email must also be confirmed, so nobody can pose as the owner.
    const ownerList = (process.env.OWNER_EMAILS || '').toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    const isOwner = !!(user.email && (user.email_confirmed_at || user.confirmed_at) && ownerList.indexOf(String(user.email).toLowerCase()) !== -1);

    // 2. Which group is this member in, and are they within their AI limit?
    if (!isOwner) {
      const sr = await fetch(SB_URL + '/rest/v1/rpc/ai_status', {
        method: 'POST',
        headers: svcHeaders,
        body: JSON.stringify({ uid: user.id })
      });
      if (!sr.ok) { fail(res, 500, 'Usage check failed. Please try again.'); return; }
      const srows = await sr.json();
      const st = srows && srows[0];
      if (!st || st.tier === 'none') {
        fail(res, 403, 'Your access period has ended. Please subscribe to continue.');
        return;
      }
      if (st.allowed !== true) {
        const lim = Number(st.limit_usd);
        let msg;
        if (st.tier === 'early') {
          msg = 'Your $' + lim + ' early access AI allowance for this month is used up. It renews on the 1st of next month.';
        } else if (st.tier === 'trial') {
          msg = 'Your trial AI allowance ($' + lim + ') is used up. Subscribe to keep using the AI.';
        } else {
          msg = 'You have reached the fair-use AI limit for this month. It renews on the 1st of next month.';
        }
        fail(res, 429, msg);
        return;
      }
    }

    // 3. Ask Claude
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || !Array.isArray(body.messages)) { fail(res, 400, 'Bad request'); return; }
    const maxTokens = Math.min(Number(body.max_tokens) || 1500, MAX_TOKENS_CAP);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: body.temperature != null ? body.temperature : 0,
        messages: body.messages
      })
    });
    const data = await r.json();

    // 4. Record what this request cost
    if (r.ok && data && data.usage) {
      const cost = (data.usage.input_tokens || 0) * PRICE_IN + (data.usage.output_tokens || 0) * PRICE_OUT;
      try {
        await fetch(SB_URL + '/rest/v1/ai_usage', {
          method: 'POST',
          headers: Object.assign({}, svcHeaders, { Prefer: 'return=minimal' }),
          body: JSON.stringify({ user_id: user.id, cost_usd: Number(cost.toFixed(4)) })
        });
      } catch (e) { /* recording is best effort */ }
    }
    res.status(r.status).json(data);
  } catch (e) {
    fail(res, 500, 'Relay error: ' + e.message);
  }
}
