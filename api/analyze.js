export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY on server' }); return; }
  try {
    var body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    var r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: body.model || 'claude-sonnet-4-6', max_tokens: body.max_tokens || 1500, messages: body.messages })
    });
    var data = await r.json();
    res.status(r.status).json(data);
  } catch(e) {
    res.status(500).json({ error: { message: 'Relay error: ' + e.message } });
  }
}
