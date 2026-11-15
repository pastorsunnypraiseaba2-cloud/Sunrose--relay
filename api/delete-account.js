// Sunrose Trader OS — delete my account.
// A logged-in member permanently deletes their own account and data.
// Uses the existing environment variables: SUPABASE_SERVICE_KEY, PAYSTACK_SECRET_KEY,
// and (optional, for a notice to you) RESEND_API_KEY, CONTACT_TO, CONTACT_FROM.

const SB_URL = 'https://bjjrwtwiljfhenyyxwqr.supabase.co';
const SB_KEY = 'sb_publishable_O1V_pifLmzEVj1xvvVu6eg_RILwwgAv';
const ALLOWED_ORIGINS = ['https://app.sunrosetechnologies.com', 'https://pastorsunnypraiseaba2-cloud.github.io', 'https://localhost', 'capacitor://localhost', 'http://localhost'];

function fail(res, status, message) { res.status(status).json({ error: { message } }); }

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return fail(res, 405, 'Use POST');

  const svcKey = process.env.SUPABASE_SERVICE_KEY;
  if (!svcKey) return fail(res, 500, 'Account deletion is not configured yet.');
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 401, 'Please log in first.');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || body.confirm !== 'DELETE') return fail(res, 400, 'Please type DELETE to confirm.');

  try {
    // 1. Who is asking? (only the logged-in member can delete their own account)
    const ur = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return fail(res, 401, 'Your login has expired. Please log in again.');
    const user = await ur.json();
    if (!user || !user.id) return fail(res, 401, 'Please log in again.');
    const uid = user.id;
    const db = svcKey.startsWith('eyJ')
      ? { apikey: svcKey, Authorization: 'Bearer ' + svcKey, 'Content-Type': 'application/json' }
      : { apikey: svcKey, 'Content-Type': 'application/json' };

    // 2. Stop any Paystack subscription so the card is never charged again
    const pr = await fetch(SB_URL + '/rest/v1/profiles?select=paystack_subscription_code,paystack_email_token&id=eq.' + uid, { headers: db });
    const prof = pr.ok ? ((await pr.json())[0] || {}) : {};
    const psKey = process.env.PAYSTACK_SECRET_KEY;
    if (psKey && prof.paystack_subscription_code && prof.paystack_email_token) {
      const dr = await fetch('https://api.paystack.co/subscription/disable', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + psKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: prof.paystack_subscription_code, token: prof.paystack_email_token }),
      });
      if (!dr.ok) {
        console.error('Paystack disable failed', dr.status, await dr.text());
        return fail(res, 502, 'We could not cancel your subscription automatically. Please email info@sunrosetechnologies.com and we will delete your account.');
      }
    }

    // 3. Delete the member's data, then the login itself
    for (const [table, col] of [['ai_usage', 'user_id'], ['payments', 'user_id'], ['profiles', 'id']]) {
      const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + col + '=eq.' + uid, { method: 'DELETE', headers: { ...db, Prefer: 'return=minimal' } });
      if (!r.ok && r.status !== 404) console.error('delete from', table, r.status, await r.text());
    }
    const ar = await fetch(SB_URL + '/auth/v1/admin/users/' + uid, { method: 'DELETE', headers: db });
    if (!ar.ok) {
      console.error('auth delete failed', ar.status, await ar.text());
      return fail(res, 500, 'We could not finish deleting your account. Please email info@sunrosetechnologies.com and we will complete it.');
    }

    // 4. Let Sunrose know (best effort, never blocks the deletion)
    const rk = process.env.RESEND_API_KEY;
    if (rk) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + rk, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.CONTACT_FROM || 'Sunrose Website <website@sunrosetechnologies.com>',
          to: [process.env.CONTACT_TO || 'info@sunrosetechnologies.com'],
          subject: 'Trader OS account deleted',
          text: 'A member deleted their Sunrose Trader OS account from inside the app.\nEmail: ' + (user.email || '-') + '\nTime: ' + new Date().toISOString(),
        }),
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('delete-account error', e);
    return fail(res, 500, 'Something went wrong. Please try again, or email info@sunrosetechnologies.com.');
  }
}
