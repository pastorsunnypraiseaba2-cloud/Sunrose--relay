// Sunrose Technologies — website contact form
// Vercel serverless function: receives the form and emails it to info@ via Resend.
//
// Environment variables to add in Vercel (Project > Settings > Environment Variables):
//   RESEND_API_KEY   your Resend API key (already used by this project for email)
//   CONTACT_TO       info@sunrosetechnologies.com
//   CONTACT_FROM     Sunrose Website <website@sunrosetechnologies.com>
//                    (the domain must be verified in Resend > Domains)

const ALLOWED_ORIGINS = [
  "https://sunrosetechnologies.com",
  "https://www.sunrosetechnologies.com",
];

const SERVICES = {
  "custom-software": "Custom Software Development",
  "ai-solutions": "Artificial Intelligence Solutions",
  "mobile-apps": "Mobile Application Development",
  "web-apps": "Web Application Development",
  "automation": "Business Automation",
  "digital-transformation": "Digital Transformation",
  "consulting": "Technology Consulting",
  "enterprise": "Enterprise Solutions",
  "trader-os": "Sunrose Trader OS",
  "shepherd-os": "Shepherd OS",
  "partnership": "Partnership enquiry",
  "other": "Something else",
};

// Best-effort rate limit (per warm instance): 5 messages per IP per 10 minutes
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (!ALLOWED_ORIGINS.includes(origin)) return res.status(403).json({ error: "This form can only be sent from sunrosetechnologies.com." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Spam protection: honeypot field must be empty, and the form must not be submitted instantly
  if (body.website || Number(body.elapsed) < 3000) return res.status(200).json({ ok: true });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Too many messages. Please wait a few minutes and try again." });

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  const company = clean(body.company, 160);
  const service = SERVICES[body.service] ? body.service : "";
  const subject = clean(body.subject, 200).replace(/[\r\n]+/g, " ");
  const message = clean(body.message, 5000);

  if (name.length < 2) return res.status(400).json({ error: "Please enter your full name." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!service) return res.status(400).json({ error: "Please choose the service you need." });
  if (subject.length < 3) return res.status(400).json({ error: "Please add a short subject." });
  if (message.length < 20) return res.status(400).json({ error: "Please describe your project in at least 20 characters." });

  const key = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO || "info@sunrosetechnologies.com";
  const from = process.env.CONTACT_FROM || "Sunrose Website <website@sunrosetechnologies.com>";
  if (!key) return res.status(500).json({ error: "The contact form is not configured yet." });

  const html = `
    <h2 style="font-family:Arial,sans-serif">New website enquiry</h2>
    <table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 12px 6px 0"><b>Name</b></td><td>${esc(name)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><b>Email</b></td><td>${esc(email)}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><b>Company</b></td><td>${esc(company) || "-"}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><b>Service</b></td><td>${esc(SERVICES[service])}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><b>Subject</b></td><td>${esc(subject)}</td></tr>
    </table>
    <p style="font-family:Arial,sans-serif;font-size:14px;white-space:pre-wrap;border-top:1px solid #ddd;padding-top:12px">${esc(message)}</p>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: `Website enquiry: ${subject} [${SERVICES[service]}]`,
        html,
        text: `Name: ${name}\nEmail: ${email}\nCompany: ${company || "-"}\nService: ${SERVICES[service]}\nSubject: ${subject}\n\n${message}`,
      }),
    });
    if (!r.ok) {
      console.error("Resend error", r.status, await r.text());
      return res.status(502).json({ error: "We could not send your message right now." });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Contact form failure", e);
    return res.status(500).json({ error: "We could not send your message right now." });
  }
}
