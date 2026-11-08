// Sunrose Trader OS — Paystack webhook.
// Paystack calls this address after payments and subscription changes; it updates the member's access.
// Webhook URL to enter in Paystack (Settings > API Keys & Webhooks), for both Test and Live:
//   https://sunrose-relay.vercel.app/api/paystack-webhook
//
// Uses PAYSTACK_SECRET_KEY and SUPABASE_SERVICE_KEY (same as api/pay.js).

import crypto from 'crypto';

const SB_URL = 'https://bjjrwtwiljfhenyyxwqr.supabase.co';
const GRACE_DAYS = 2; // extra days after a renewal date before access is removed

function readRaw(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const psKey = process.env.PAYSTACK_SECRET_KEY, svcKey = process.env.SUPABASE_SERVICE_KEY;
  if (!psKey || !svcKey) return res.status(500).end();

  // ---- 1. Make sure the message really comes from Paystack ----
  let raw = '';
  try { raw = await readRaw(req); } catch { raw = ''; }
  if (!raw && req.body) raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const sig = req.headers['x-paystack-signature'] || '';
  const hash = crypto.createHmac('sha512', psKey).update(raw).digest('hex');
  if (!sig || sig.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash))) {
    console.warn('Paystack webhook: bad signature');
    return res.status(401).end();
  }
  let evt; try { evt = JSON.parse(raw); } catch { return res.status(400).end(); }
  const d = evt.data || {};
  const db = { apikey: svcKey, 'Content-Type': 'application/json' };
  const ps = { Authorization: 'Bearer ' + psKey };

  async function findUser() {
    const uid = d.metadata && d.metadata.user_id;
    if (uid && /^[0-9a-f-]{36}$/i.test(uid)) return uid;
    const cc = d.customer && d.customer.customer_code;
    if (cc) {
      const r = await fetch(SB_URL + '/rest/v1/profiles?select=id&paystack_customer_code=eq.' + encodeURIComponent(cc), { headers: db });
      const rows = r.ok ? await r.json() : [];
      if (rows[0]) return rows[0].id;
    }
    return null;
  }
  async function updateProfile(uid, fields) {
    const r = await fetch(SB_URL + '/rest/v1/profiles?id=eq.' + uid, { method: 'PATCH', headers: { ...db, Prefer: 'return=minimal' }, body: JSON.stringify(fields) });
    if (!r.ok) console.error('profile update failed', r.status, await r.text());
  }

  try {
    const type = evt.event;

    // ---- 2. A payment succeeded (first payment or renewal) ----
    if (type === 'charge.success') {
      // Double-check with Paystack before giving access
      const vr = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(d.reference), { headers: ps });
      const vj = await vr.json().catch(() => ({}));
      const tx = vj && vj.data;
      if (!vr.ok || !tx || tx.status !== 'success') { console.warn('verify failed', d.reference); return res.status(200).end(); }
      const uid = await findUser();
      if (!uid) { console.warn('no member for payment', d.reference); return res.status(200).end(); }
      const planObj = tx.plan_object || tx.plan || d.plan || {};
      const interval = planObj.interval || (d.metadata && d.metadata.plan === 'yearly' ? 'annually' : 'monthly');
      const isYear = /annual|year/i.test(interval);
      const planName = isYear ? 'yearly' : 'monthly';
      const end = addDays(new Date(), (isYear ? 365 : 30) + GRACE_DAYS);
      await updateProfile(uid, {
        subscription_status: 'active', plan: planName, subscription_end: end,
        paystack_customer_code: (tx.customer && tx.customer.customer_code) || null,
      });
      await fetch(SB_URL + '/rest/v1/payments', {
        method: 'POST', headers: { ...db, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: uid, reference: tx.reference, amount_kobo: tx.amount, currency: tx.currency, plan: planName, status: tx.status, paid_at: tx.paid_at || new Date().toISOString() }),
      });
      return res.status(200).end();
    }

    // ---- 3. Subscription created: remember its codes and next billing date ----
    if (type === 'subscription.create') {
      const uid = await findUser();
      if (uid) await updateProfile(uid, {
        paystack_subscription_code: d.subscription_code || null,
        paystack_email_token: d.email_token || null,
        paystack_customer_code: (d.customer && d.customer.customer_code) || null,
        ...(d.next_payment_date ? { subscription_end: addDays(d.next_payment_date, GRACE_DAYS) } : {}),
      });
      return res.status(200).end();
    }

    // ---- 4. Member cancelled, or renewal stopped: keep access until the paid period ends ----
    if (type === 'subscription.not_renew' || type === 'subscription.disable') {
      const uid = await findUser();
      if (uid) await updateProfile(uid, { subscription_status: 'cancelled' });
      return res.status(200).end();
    }

    // ---- 5. A renewal payment failed ----
    if (type === 'invoice.payment_failed') {
      const uid = await findUser();
      if (uid) await updateProfile(uid, { subscription_status: 'past_due' });
      return res.status(200).end();
    }

    return res.status(200).end(); // other events are ignored
  } catch (e) {
    console.error('webhook error', e);
    return res.status(500).end(); // Paystack will retry
  }
}
