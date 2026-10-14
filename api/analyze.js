// Sunrose relay: only logged-in members with valid access can use the AI.
const SB_URL = 'https://bjjrwtwiljfhenyyxwqr.supabase.co';
const SB_KEY = 'sb_publishable_O1V_pifLmzEVj1xvvVu6eg_RILwwgAv';
const ALLOWED_ORIGIN = 'https://pastorsunnypraiseaba2-cloud.github.io';
const BUDGET_USD = 5;         // monthly AI allowance per member, in US dollars (change here)
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

    // 2. Does this member still have access?
    const pr = await fetch(
      SB_URL + '/rest/v1/profiles?id=eq.' + user.id + '&select=trial_end,subscription_status',
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } }
    );
    const rows = pr.ok ? await pr.json() : [];
    const p = rows && rows[0];
    const active = p && (p.subscription_status === 'active' ||
      (p.trial_end && new Date(p.trial_end) > new Date()));
    if (!active) { fail(res, 403, 'Your access period has ended.'); return; }

    // 3. Monthly budget (per member)
    const br = await fetch(SB_URL + '/rest/v1/rpc/ai_budget_ok', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_limit: BUDGET_USD })
    });
    if (!br.ok) { fail(res, 500, 'Usage check failed. Please try again.'); return; }
    const withinBudget = await br.json();
    if (withinBudget !== true) {
      fail(res, 429, 'Your $' + BUDGET_USD + ' AI allowance for this month is used up. It renews on the 1st of next month.');
      return;
    }

    // 4. Ask Claude
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

    // 5. Record what this request cost
    if (r.ok && data && data.usage) {
      const cost = (data.usage.input_tokens || 0) * PRICE_IN + (data.usage.output_tokens || 0) * PRICE_OUT;
      try {
        await fetch(SB_URL + '/rest/v1/rpc/ai_add_spend', {
          method: 'POST',
          headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_usd: Number(cost.toFixed(4)) })
        });
      } catch (e) { /* recording is best effort */ }
    }
    res.status(r.status).json(data);
  } catch (e) {
    fail(res, 500, 'Relay error: ' + e.message);
  }
}
