// api/cpr-alert.js
// Standalone CPR breakout alert -- runs independently of Chart Vision / analyze.js.
// Triggered externally (e.g. by cron-job.org) every 15 minutes.
// Checks every instrument listed in SYMBOLS below for:
//   15M close vs Daily CPR, 1H close vs Weekly CPR, 4H close vs Monthly CPR
// -- and sends a Telegram alert whenever a strong-momentum candle closes
// beyond its paired CPR level.

const WebSocket = require('ws');

var DERIV_PUBLIC_APP_ID = '1089'; // same public app_id used by index.html -- no auth needed for candle data

var SYMBOLS = {
  'Gold (XAUUSD)': 'frxXAUUSD',
  'Silver (XAGUSD)': 'frxXAGUSD',
  'EUR/USD': 'frxEURUSD',
  'GBP/USD': 'frxGBPUSD',
  'USD/JPY': 'frxUSDJPY',
  'USD/CHF': 'frxUSDCHF',
  'AUD/USD': 'frxAUDUSD',
  'USD/CAD': 'frxUSDCAD',
  'NZD/USD': 'frxNZDUSD',
  'GBP/JPY': 'frxGBPJPY',
  'EUR/JPY': 'frxEURJPY',
  'Bitcoin (BTCUSD)': 'cryBTCUSD',
  'Ethereum (ETHUSD)': 'cryETHUSD',
  'Solana (SOLUSD)': 'crySOLUSD',
};

// ---- Deriv candle fetch (mirrors index.html's derivWSRequest / derivFetchCandles) ----
function derivWSRequest(request, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var ws;
    try {
      ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=' + DERIV_PUBLIC_APP_ID);
    } catch (e) { reject(new Error('Could not open WebSocket: ' + e.message)); return; }
    var timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      reject(new Error('Deriv request timed out'));
    }, timeoutMs || 15000);
    ws.on('open', function () { ws.send(JSON.stringify(request)); });
    ws.on('message', function (raw) {
      var data;
      try { data = JSON.parse(raw); } catch (e) { return; }
      if (data.error) {
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        reject(new Error('Deriv API error: ' + data.error.message));
        return;
      }
      if (data.msg_type === 'candles') {
        clearTimeout(timer);
        try { ws.close(); } catch (e) {}
        resolve(data);
      }
    });
    ws.on('error', function (err) { clearTimeout(timer); reject(err); });
  });
}

async function fetchCandles(derivSymbol, granularitySec, count) {
  var resp = await derivWSRequest({
    ticks_history: derivSymbol,
    adjust_start_time: 1,
    count: count,
    end: 'latest',
    style: 'candles',
    granularity: granularitySec,
  });
  if (!resp.candles || !resp.candles.length) throw new Error('No candle data for ' + derivSymbol);
  // oldest-first, as Deriv returns them
  return resp.candles.map(function (c) {
    return { epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close };
  });
}

// ---- CPR calc -- identical formula to calcCPR() in index.html ----
function calcCPR(H, L, C) {
  var P = (H + L + C) / 3;
  var BC_raw = (H + L) / 2;
  var TC_raw = (2 * P) - BC_raw;
  var TC = Math.max(TC_raw, BC_raw);
  var BC = Math.min(TC_raw, BC_raw);
  return { P: P, BC: BC, TC: TC };
}

// ---- Monthly aggregation -- same grouping approach as weekly, but by calendar month ----
function buildMonthlyFromDaily(dailyCandles) {
  var months = {};
  dailyCandles.forEach(function (day) {
    var d = new Date(day.epoch * 1000);
    var key = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    if (!months[key]) months[key] = { high: day.high, low: day.low, close: day.close, firstEpoch: day.epoch, lastEpoch: day.epoch };
    var m = months[key];
    if (day.high > m.high) m.high = day.high;
    if (day.low < m.low) m.low = day.low;
    if (day.epoch > m.lastEpoch) { m.close = day.close; m.lastEpoch = day.epoch; }
    if (day.epoch < m.firstEpoch) { m.firstEpoch = day.epoch; }
  });
  var keys = Object.keys(months).sort().reverse();
  return keys.map(function (k) { return { key: k, high: months[k].high, low: months[k].low, close: months[k].close }; });
}

// ---- Weekly aggregation -- identical grouping logic to buildWeeklyFromDaily() in index.html ----
function buildWeeklyFromDaily(dailyCandles) {
  var weeks = {};
  dailyCandles.forEach(function (day) {
    var d = new Date(day.epoch * 1000);
    var dow = d.getUTCDay();
    var diff = (dow === 0 ? -6 : 1) - dow;
    var monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diff);
    monday.setUTCHours(0, 0, 0, 0);
    var key = monday.toISOString().substring(0, 10);
    if (!weeks[key]) weeks[key] = { high: day.high, low: day.low, close: day.close, firstEpoch: day.epoch, lastEpoch: day.epoch };
    var w = weeks[key];
    if (day.high > w.high) w.high = day.high;
    if (day.low < w.low) w.low = day.low;
    if (day.epoch > w.lastEpoch) { w.close = day.close; w.lastEpoch = day.epoch; }
    if (day.epoch < w.firstEpoch) { w.firstEpoch = day.epoch; }
  });
  var keys = Object.keys(weeks).sort().reverse();
  return keys.map(function (k) { return { key: k, high: weeks[k].high, low: weeks[k].low, close: weeks[k].close }; });
}

// ---- Momentum check -- deterministic, no AI involved ----
// Strong = body is at least 60% of the candle's range, AND the range itself is at
// least 1.3x the average range of the preceding 20 candles (so it's a genuinely
// large move for this instrument/timeframe, not just a clean-looking small candle).
function isStrongMomentum(candle, precedingCandles) {
  var range = candle.high - candle.low;
  if (range <= 0) return false;
  var body = Math.abs(candle.close - candle.open);
  var bodyRatio = body / range;
  var recent = precedingCandles.slice(-20);
  if (!recent.length) return false;
  var avgRange = recent.reduce(function (sum, c) { return sum + (c.high - c.low); }, 0) / recent.length;
  return bodyRatio >= 0.6 && range >= avgRange * 1.3;
}

// ---- Telegram ----
async function sendTelegram(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN;
  var chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  var r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text }),
  });
  return r.ok;
}

// ---- Dedup storage (Upstash Redis REST) -- prevents the same 1H candle from
// re-alerting every 15 minutes for the hour it's the "most recent close". ----
async function alreadyAlerted(key) {
  var base = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return false; // dedup disabled if not configured -- see setup notes
  var r = await fetch(base + '/get/' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
  var data = await r.json();
  return !!data.result;
}
async function markAlerted(key) {
  var base = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return;
  // EX 604800 = expire after 7 days, so the store doesn't grow forever
  await fetch(base + '/set/' + encodeURIComponent(key) + '/1/EX/604800', { headers: { Authorization: 'Bearer ' + token } });
}

// ---- Per-instrument check ----
async function checkInstrument(label, symbol) {
  var alerts = [];
  var timeframes = [
    { label: '15M', granularity: 900 },
    { label: '1H', granularity: 3600 },
    { label: '4H', granularity: 14400 },
  ];

  // Fetch everything this instrument needs AT ONCE instead of one-by-one --
  // six independent Deriv requests running in parallel instead of in sequence.
  // This is what keeps total run time low enough to stay under Vercel's 10s
  // Hobby-plan function limit as more instruments are added.
  var results = await Promise.all([
    fetchCandles(symbol, 86400, 4),   // for Daily CPR
    fetchCandles(symbol, 86400, 16),  // for Weekly CPR
    fetchCandles(symbol, 86400, 65),  // for Monthly CPR
    fetchCandles(symbol, timeframes[0].granularity, 25), // 15M
    fetchCandles(symbol, timeframes[1].granularity, 25), // 1H
    fetchCandles(symbol, timeframes[2].granularity, 25), // 4H
  ]);
  var dailyCandles = results[0];
  var dailyForWeek = results[1];
  var dailyForMonth = results[2];
  var candlesByTf = { '15M': results[3], '1H': results[4], '4H': results[5] };

  // Daily CPR (from previous completed day)
  var prevDay = dailyCandles[dailyCandles.length - 2];
  var dailyCPR = calcCPR(prevDay.high, prevDay.low, prevDay.close);

  // Weekly CPR (from previous completed week, built from daily candles)
  var weeks = buildWeeklyFromDaily(dailyForWeek);
  var weeklyCPR = weeks.length >= 2 ? calcCPR(weeks[1].high, weeks[1].low, weeks[1].close) : null;

  // Monthly CPR (from previous completed month, built from daily candles).
  // 65 daily candles comfortably covers 2+ full calendar months even with weekends/holidays.
  var months = buildMonthlyFromDaily(dailyForMonth);
  var monthlyCPR = months.length >= 2 ? calcCPR(months[1].high, months[1].low, months[1].close) : null;

  for (var i = 0; i < timeframes.length; i++) {
    var tf = timeframes[i];
    var candles = candlesByTf[tf.label];
    var nowSec = Math.floor(Date.now() / 1000);
    // last candle whose close time has actually passed = most recently CLOSED candle
    var closedCandles = candles.filter(function (c) { return c.epoch + tf.granularity <= nowSec; });
    if (closedCandles.length < 2) continue;
    var last = closedCandles[closedCandles.length - 1];
    var preceding = closedCandles.slice(0, -1);

    var strong = isStrongMomentum(last, preceding);
    if (!strong) continue;

    var direction = last.close > last.open ? 'Bullish' : 'Bearish';

    // 15M candle closes are checked against Daily CPR only.
    // 1H candle closes are checked against Weekly CPR only.
    // 4H candle closes are checked against Monthly CPR only.
    var checks = tf.label === '15M'
      ? [{ name: 'Daily', cpr: dailyCPR }]
      : tf.label === '1H'
      ? [{ name: 'Weekly', cpr: weeklyCPR }]
      : [{ name: 'Monthly', cpr: monthlyCPR }];

    for (var j = 0; j < checks.length; j++) {
      var c = checks[j];
      if (!c.cpr) continue;
      var brokeUp = last.close > c.cpr.TC;
      var brokeDown = last.close < c.cpr.BC;
      if (!brokeUp && !brokeDown) continue;
      if ((brokeUp && direction !== 'Bullish') || (brokeDown && direction !== 'Bearish')) continue; // close direction must agree with the break direction

      var dedupKey = 'cprbreak:' + symbol + ':' + tf.label + ':' + c.name + ':' + last.epoch;
      if (await alreadyAlerted(dedupKey)) continue;

      alerts.push({
        text: '\uD83D\uDEA8 ' + label + ' -- ' + direction + ' break of ' + c.name + ' CPR on ' + tf.label + ' close\n' +
          'Close: ' + last.close + ' | ' + c.name + ' ' + (brokeUp ? 'TC' : 'BC') + ': ' + (brokeUp ? c.cpr.TC : c.cpr.BC).toFixed(2) + '\n' +
          'Strong momentum candle confirmed.',
        dedupKey: dedupKey,
      });
    }
  }

  return alerts;
}

module.exports = async function handler(req, res) {
  var secret = process.env.CRON_SECRET;
  if (secret && req.query.secret !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  var sent = [];
  var errors = [];

  // Check every instrument at the same time, not one after another --
  // this is the other half of keeping total run time low.
  var labels = Object.keys(SYMBOLS);
  var checkResults = await Promise.allSettled(labels.map(function (label) {
    return checkInstrument(label, SYMBOLS[label]);
  }));

  for (var idx = 0; idx < labels.length; idx++) {
    var label = labels[idx];
    var result = checkResults[idx];
    if (result.status === 'rejected') {
      errors.push(label + ': ' + result.reason.message);
      continue;
    }
    var alerts = result.value;
    for (var i = 0; i < alerts.length; i++) {
      var a = alerts[i];
      var ok = await sendTelegram(a.text);
      if (ok) { await markAlerted(a.dedupKey); sent.push(a.text); }
    }
  }

  res.status(200).json({ checked: Object.keys(SYMBOLS), sent: sent.length, alerts: sent, errors: errors });
};
