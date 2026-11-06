// Sunrose Technologies — newsletter subscribe / unsubscribe
// Vercel serverless function. Uses the same environment variables as api/contact.js.

const ALLOWED_ORIGINS = ["https://sunrosetechnologies.com", "https://www.sunrosetechnologies.com"];
const SITE = "https://sunrosetechnologies.com";

// New-style keys (sb_secret_...) go in "apikey" only; older JWT keys also go in Authorization
const sbHeaders = (k) => (k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" } : { apikey: k, "Content-Type": "application/json" });

const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > 8;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: "Not allowed." });

  const sbUrl = process.env.SITE_SUPABASE_URL, sbKey = process.env.SITE_SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: "Newsletter is not configured yet." });
  const headers = sbHeaders(sbKey);

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Too many requests. Please try again later." });

  // ----- Unsubscribe -----
  if (body.action === "unsubscribe") {
    const token = String(body.token || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return res.status(400).json({ error: "Invalid link." });
    const r = await fetch(`${sbUrl}/rest/v1/subscribers?token=eq.${token}`, {
      method: "PATCH", headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "unsubscribed", unsubscribed_at: new Date().toISOString() }),
    });
    if (!r.ok) { console.error("Unsubscribe error", r.status, await r.text()); return res.status(502).json({ error: "Could not process the request." }); }
    return res.status(200).json({ ok: true });
  }

  // ----- Subscribe -----
  if (body.company_site || Number(body.elapsed) < 2000) return res.status(200).json({ ok: true }); // bot
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });

  const r = await fetch(`${sbUrl}/rest/v1/subscribers?on_conflict=email&select=token,status`, {
    method: "POST",
    headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ email, status: "active", unsubscribed_at: null }),
  });
  if (!r.ok) { console.error("Subscribe error", r.status, await r.text()); return res.status(502).json({ error: "Sorry, we couldn't subscribe you right now." }); }
  const rows = await r.json().catch(() => []);
  const token = rows[0] && rows[0].token;

  // Welcome email with unsubscribe link (optional; skipped if email is not configured)
  const key = process.env.RESEND_API_KEY;
  const from = process.env.CONTACT_FROM || "Sunrose Website <website@sunrosetechnologies.com>";
  if (key && token) {
    const unsub = `${SITE}/unsubscribe.html?t=${token}`;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [email], reply_to: process.env.CONTACT_TO || "info@sunrosetechnologies.com",
          subject: "Welcome to Sunrose Technologies updates",
          headers: { "List-Unsubscribe": `<${unsub}>` },
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#111">
            <p>Thank you for subscribing to updates from Sunrose Technologies.</p>
            <p>We'll share occasional news about our products, insights and launches. No spam.</p>
            <p>Visit us any time at <a href="${SITE}">sunrosetechnologies.com</a>.</p>
            <p style="font-size:12px;color:#666;margin-top:28px">Didn't sign up, or changed your mind? <a href="${unsub}">Unsubscribe here</a>.</p></div>`,
          text: `Thank you for subscribing to updates from Sunrose Technologies.\n\nUnsubscribe: ${unsub}`,
        }),
      });
    } catch (err) { console.error("Welcome email failure", err); }
  }
  return res.status(200).json({ ok: true });
}
