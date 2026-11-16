// Sunrose Technologies admin — Trader OS members report.
// Only a signed-in admin of the website dashboard can call this. It reads the Trader OS
// database (members, membership status and Sunrose Vision usage) and returns a summary.
//
// Uses environment variables already set in this Vercel project:
//   SITE_SUPABASE_URL, SITE_SUPABASE_SERVICE_KEY   (website admin database: who is an admin)
//   SUPABASE_SERVICE_KEY                           (Trader OS database)

const TOS_URL = 'https://bjjrwtwiljfhenyyxwqr.supabase.co';
const SITE_PUBLISHABLE = 'sb_publishable_kyoDkdMEKn7RWRI9vZF1cA_RpEBgkqN';
const ALLOWED_ORIGINS = ['https://sunrosetechnologies.com', 'https://www.sunrosetechnologies.com'];
const ALLOWED_ROLES = ['super_admin', 'support', 'finance'];

const keyHeaders = (k) => (k.startsWith('eyJ') ? { apikey: k, Authorization: 'Bearer ' + k } : { apikey: k });
function fail(res, status, message) { res.status(status).json({ error: message }); }

async function getAll(url, headers) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    const r = await fetch(url, { headers: { ...headers, Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!r.ok) throw new Error('read ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.');

  const siteUrl = process.env.SITE_SUPABASE_URL, siteKey = process.env.SITE_SUPABASE_SERVICE_KEY, tosKey = process.env.SUPABASE_SERVICE_KEY;
  if (!siteUrl || !siteKey || !tosKey) return fail(res, 500, 'Members report is not configured.');
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 401, 'Please sign in.');

  try {
    // 1. Is the caller a signed-in website admin with a suitable role?
    const ur = await fetch(siteUrl + '/auth/v1/user', { headers: { apikey: SITE_PUBLISHABLE, Authorization: 'Bearer ' + token } });
    if (!ur.ok) return fail(res, 401, 'Your session has expired. Please sign in again.');
    const me = await ur.json();
    const ar = await fetch(siteUrl + '/rest/v1/admins?select=role&user_id=eq.' + encodeURIComponent(me.id), { headers: keyHeaders(siteKey) });
    const roles = ar.ok ? await ar.json() : [];
    if (!roles[0] || !ALLOWED_ROLES.includes(roles[0].role)) return fail(res, 403, 'Your role cannot view Trader OS members.');

    // 2. Read the Trader OS data
    const tos = keyHeaders(tosKey);
    const users = [];
    for (let page = 1; page <= 50; page++) {
      const r = await fetch(TOS_URL + '/auth/v1/admin/users?page=' + page + '&per_page=1000', { headers: tos });
      if (!r.ok) throw new Error('users ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const j = await r.json();
      const list = j.users || [];
      users.push(...list);
      if (list.length < 1000) break;
    }
    const profiles = await getAll(TOS_URL + '/rest/v1/profiles?select=id,trial_end,early_access_until,subscription_status,plan,subscription_end', tos);
    const usage = await getAll(TOS_URL + '/rest/v1/ai_usage?select=user_id,created_at', tos);

    // 3. Combine per member
    const now = Date.now(), week = now - 7 * 86400000;
    const prof = new Map(profiles.map((p) => [p.id, p]));
    const use = new Map();
    for (const u of usage) {
      const t = new Date(u.created_at).getTime();
      const e = use.get(u.user_id) || { total: 0, week: 0, last: 0 };
      e.total++; if (t > week) e.week++; if (t > e.last) e.last = t;
      use.set(u.user_id, e);
    }
    const members = users.map((u) => {
      const p = prof.get(u.id) || {};
      const e = use.get(u.id) || { total: 0, week: 0, last: 0 };
      const paidEnd = p.subscription_end ? new Date(p.subscription_end).getTime() : 0;
      const ea = p.early_access_until ? new Date(p.early_access_until).getTime() : 0;
      const tr = p.trial_end ? new Date(p.trial_end).getTime() : 0;
      let status, until = null;
      if (paidEnd > now || (p.subscription_status === 'active' && !paidEnd)) {
        status = p.subscription_status === 'cancelled' ? 'cancelled' : 'paid'; until = p.subscription_end;
      } else if (ea > now && ea >= tr) { status = 'early'; until = p.early_access_until; }
      else if (tr > now) { status = 'trial'; until = p.trial_end; }
      else { status = 'expired'; until = p.subscription_end || p.early_access_until || p.trial_end || null; }
      return {
        email: u.email, joined: u.created_at, last_login: u.last_sign_in_at || null,
        status, plan: p.plan || null, until,
        analyses: e.total, analyses_7d: e.week, last_analysis: e.last ? new Date(e.last).toISOString() : null,
      };
    }).sort((a, b) => (b.joined || '').localeCompare(a.joined || ''));

    const summary = {
      members: members.length,
      paying: members.filter((m) => m.status === 'paid').length,
      active_7d: members.filter((m) => m.analyses_7d > 0).length,
      never: members.filter((m) => m.analyses === 0).length,
      analyses_7d: members.reduce((s, m) => s + m.analyses_7d, 0),
    };
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ summary, members, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('trader-members error', e);
    return fail(res, 500, 'Could not load the members report. Please try again.');
  }
}
