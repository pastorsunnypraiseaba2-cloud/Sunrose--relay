// Sunrose Technologies — website enquiry form (quote, consultation, general)
// Vercel serverless function. Emails each enquiry to info@ via Resend and saves it to the admin database.
//
// Environment variables (Vercel > sunrose-relay > Settings > Environment Variables):
//   RESEND_API_KEY              Resend API key
//   CONTACT_TO                  info@sunrosetechnologies.com
//   CONTACT_FROM                Sunrose Website <website@sunrosetechnologies.com>
//   SITE_SUPABASE_URL           https://xxxx.supabase.co  (the NEW company-website project)
//   SITE_SUPABASE_SERVICE_KEY   that project's service_role / secret key (never put this in the website)

const ALLOWED_ORIGINS = ["https://sunrosetechnologies.com", "https://www.sunrosetechnologies.com"];

const SERVICES = {
  "corporate-websites": "Corporate Website Development",
  "ecommerce": "E-commerce Development",
  "custom-software": "Custom Software Development",
  "mobile-apps": "Mobile Application Development",
  "ai-solutions": "AI Solutions and Integration",
  "automation": "Business Process Automation",
  "enterprise": "Enterprise Software Solutions",
  "cloud-database": "Database and Cloud Solutions",
  "api-integration": "API Development and Integration",
  "maintenance-support": "Software Maintenance and Technical Support",
  "consulting": "Technology Consulting",
  "ui-ux": "UI/UX Design",
  "trader-os": "Sunrose Trader OS",
  "shepherd-os": "Shepherd OS",
  "partnership": "Partnership enquiry",
  "other": "Something else",
  // older form values, kept so old links still work
  "web-apps": "Web Application Development",
  "digital-transformation": "Digital Transformation",
};
const BUDGETS = {
  "under-300k": "Under ₦300,000", "300k-700k": "₦300,000 – ₦700,000", "700k-2m": "₦700,000 – ₦2,000,000",
  "over-2m": "Above ₦2,000,000", "web-starter": "Website Starter package", "web-professional": "Website Professional package",
  "web-premium": "Website Premium package", "web-enterprise": "Website Enterprise package",
  "international": "International project (USD/GBP)", "not-sure": "Not sure yet",
};
const TYPES = { quote: "Quote request", consultation: "Consultation request", general: "General enquiry" };
const TIMES = ["Morning (9am–12pm)", "Afternoon (12pm–4pm)", "Evening (4pm–7pm)"];
const MODES = ["WhatsApp call", "Google Meet video call", "Phone call"];

// Best-effort rate limit per warm instance: 5 messages per IP per 10 minutes
// New-style keys (sb_secret_...) go in "apikey" only; older JWT keys also go in Authorization
const sbHeaders = (k) => (k.startsWith("eyJ") ? { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json" } : { apikey: k, "Content-Type": "application/json" });

const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > 5;
}
const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clean = (s, max) => String(s || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
const oneLine = (s, max) => clean(s, max).replace(/[\r\n]+/g, " ");

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: "This form can only be sent from sunrosetechnologies.com." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Spam protection: hidden field must be empty and the form must not be sent instantly
  if (body.website || Number(body.elapsed) < 3000) return res.status(200).json({ ok: true });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Too many messages. Please wait a few minutes and try again." });

  const type = TYPES[body.request_type] ? body.request_type : "general";
  const e = {
    request_type: type,
    name: oneLine(body.name, 120),
    email: oneLine(body.email, 200),
    phone: oneLine(body.phone, 40),
    company: oneLine(body.company, 160),
    country: oneLine(body.country, 80),
    service: SERVICES[body.service] ? body.service : "",
    budget: type === "quote" ? (BUDGETS[body.budget] || oneLine(body.budget, 100)) : "",
    preferred_date: type === "consultation" && /^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date || "") ? body.preferred_date : null,
    preferred_time: type === "consultation" && TIMES.includes(body.preferred_time) ? body.preferred_time : "",
    meeting_mode: type === "consultation" && MODES.includes(body.meeting_mode) ? body.meeting_mode : "",
    subject: oneLine(body.subject, 200),
    message: clean(body.message, 5000),
    page: oneLine(body.page, 200),
  };

  if (e.name.length < 2) return res.status(400).json({ error: "Please enter your full name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!e.service) return res.status(400).json({ error: "Please choose the service you need." });
  if (e.subject.length < 3) return res.status(400).json({ error: "Please add a short subject." });
  if (e.message.length < 20) return res.status(400).json({ error: "Please describe your project in at least 20 characters." });
  if (type === "consultation" && !e.preferred_date) return res.status(400).json({ error: "Please choose a preferred date for your consultation." });

  // 1) Save to the admin database (if configured)
  let saved = false;
  const sbUrl = process.env.SITE_SUPABASE_URL, sbKey = process.env.SITE_SUPABASE_SERVICE_KEY;
  if (sbUrl && sbKey) {
    try {
      const r = await fetch(`${sbUrl}/rest/v1/enquiries`, {
        method: "POST",
        headers: { ...sbHeaders(sbKey), Prefer: "return=minimal" },
        body: JSON.stringify(e),
      });
      saved = r.ok;
      if (!r.ok) console.error("Supabase insert error", r.status, await r.text());
    } catch (err) { console.error("Supabase insert failure", err); }
  }

  // 2) Email it to info@
  let emailed = false;
  const key = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO || "info@sunrosetechnologies.com";
  const from = process.env.CONTACT_FROM || "Sunrose Website <website@sunrosetechnologies.com>";
  if (key) {
    const rows = [
      ["Type", TYPES[type]], ["Name", e.name], ["Email", e.email], ["Phone / WhatsApp", e.phone], ["Company", e.company],
      ["Country", e.country], ["Service", SERVICES[e.service]], ["Budget / plan", e.budget],
      ["Preferred date", e.preferred_date], ["Preferred time", e.preferred_time], ["Meeting", e.meeting_mode],
      ["Subject", e.subject], ["Sent from page", e.page],
    ].filter(([, v]) => v);
    const html = `<h2 style="font-family:Arial,sans-serif">New ${esc(TYPES[type].toLowerCase())}</h2>
      <table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;vertical-align:top"><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join("")}
      </table>
      <p style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;border-top:1px solid #ddd;padding-top:12px">${esc(e.message)}</p>
      ${saved ? '<p style="font-family:Arial,sans-serif;font-size:12px;color:#666">Also saved in your admin dashboard.</p>' : ""}`;
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [to], reply_to: e.email,
          subject: `${TYPES[type]}: ${e.subject} [${SERVICES[e.service]}]`,
          html,
          text: rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\n${e.message}`,
        }),
      });
      emailed = r.ok;
      if (!r.ok) console.error("Resend error", r.status, await r.text());
    } catch (err) { console.error("Resend failure", err); }
  }

  if (saved || emailed) return res.status(200).json({ ok: true });
  return res.status(502).json({ error: "We could not send your message right now." });
}
