// Backtest of Polymarket's 5-minute "Bitcoin Up or Down" markets.
//
// For every window in the last N days: the resolved outcome (Gamma), every taker fill (Polymarket
// data API), the once-a-minute price series (CLOB price history) and Binance BTCUSDT one-second
// candles. Questions:
//   1. Which reading of the rules reproduces the actual outcomes from Binance data?
//   2. Are traded prices calibrated probabilities, and is a volatility model better?
//   3. When someone actually traded at a price the model called cheap, did it pay after the fee?
//   4. Why the once-a-minute price series is not a backtest (it shows an edge the fills do not).
//   5. Do outcomes have memory (streaks)?
//
//   node research/btc5m.mjs [days=7]

import fs from 'node:fs';
import { upProbability, POLY_CRYPTO_FEE } from '../lib/btc.js';

const DAYS = +process.argv[2] || 7;
const W = 300, L = 60, VOL_LOOKBACK = 1800;
const SEEN_LAG = 3; // the model only sees BTC up to 3 seconds before a fill's on-chain timestamp
const fee = p => POLY_CRYPTO_FEE * p * (1 - p);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(1000 * (i + 1)); }
  }
}
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
/** t-statistic with errors clustered by window: fills in one window share an outcome, so they are not independent. */
const tstatByWindow = rows => {
  const g = new Map();
  for (const r of rows) { const x = g.get(r.s) || { w: 0, v: 0 }; x.w += r.size; x.v += r.pnl * r.size; g.set(r.s, x); }
  return tstat([...g.values()].map(x => x.v / x.w));
};
const tstat = a => { const m = mean(a), sd = Math.sqrt(mean(a.map(x => (x - m) ** 2))); return a.length > 1 && sd > 0 ? m / (sd / Math.sqrt(a.length)) : null; };

const now = Math.floor(Date.now() / 1000);
const lastStart = Math.floor(now / W) * W - 2 * W; // leave time for resolution
const starts = [];
for (let i = Math.round(DAYS * 86400 / W) - 1; i >= 0; i--) starts.push(lastStart - i * W);
console.log(`${starts.length} windows`);

// ---------- outcomes, token ids, condition ids ----------
const markets = new Map();
for (let i = 0; i < starts.length; i += 20) {
  const qs = starts.slice(i, i + 20).map(s => `slug=btc-updown-5m-${s}`).join('&');
  const rows = await get(`https://gamma-api.polymarket.com/markets?${qs}&closed=true&limit=20`);
  for (const m of rows || []) {
    const s = +m.slug.split('-').pop();
    const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
    if (prices[0] !== 1 && prices[1] !== 1) continue; // not resolved yet
    markets.set(s, { up: prices[0] === 1 ? 1 : 0, token: JSON.parse(m.clobTokenIds)[0], cid: m.conditionId, volume: +m.volumeNum || 0 });
  }
  await sleep(100);
}
console.log(`${markets.size} resolved markets`);

// ---------- Binance one-second closes, with prefix sums for fast averages and volatility ----------
const T0 = starts[0] - VOL_LOOKBACK - L - 10, T1 = lastStart + W + 10;
const N = T1 - T0;
const price = new Float64Array(N);
for (let t = T0; t < T1; t += 1000) {
  const rows = await get(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=1000&startTime=${t * 1000}`);
  for (const k of rows) { const i = k[0] / 1000 - T0; if (i >= 0 && i < N) price[i] = +k[4]; }
  await sleep(50);
}
for (let i = 1; i < N; i++) if (!price[i]) price[i] = price[i - 1]; // carry forward missing seconds
const cumP = new Float64Array(N + 1), cumR2 = new Float64Array(N + 1);
for (let i = 0; i < N; i++) {
  cumP[i + 1] = cumP[i] + price[i];
  const r = i && price[i - 1] ? Math.log(price[i] / price[i - 1]) : 0;
  cumR2[i + 1] = cumR2[i] + r * r;
}
const at = t => price[t - T0] || null;
const avg = (a, b) => (b > a ? (cumP[b - T0] - cumP[a - T0]) / (b - a) : null);
const sigmaAt = t => Math.sqrt((cumR2[t - T0 + 1] - cumR2[t - T0 + 1 - VOL_LOOKBACK]) / VOL_LOOKBACK);

// ---------- 1. which reading of the rules matches ----------
const RULES = {
  'TWAP of last 60s vs TWAP of 60s before start': s => avg(s + W - L, s + W) >= avg(s - L, s),
  'TWAP of last 60s vs price at start': s => avg(s + W - L, s + W) >= at(s),
  'Price at end vs price at start': s => at(s + W) >= at(s),
  'TWAP of whole window vs price at start': s => avg(s, s + W) >= at(s),
};
const ruleMatch = Object.entries(RULES).map(([rule, fn]) => {
  let ok = 0, n = 0;
  for (const [s, m] of markets) { n++; ok += (fn(s) ? 1 : 0) === m.up ? 1 : 0; }
  return { rule, agreement: ok / n, n };
}).sort((a, b) => b.agreement - a.agreement);
console.table(ruleMatch);
const strike = s => avg(s - L, s); // the best match above: TWAP of the minute before the window

/** Model P(Up) using only BTC prices up to second t. */
function model(s, t) {
  const tRem = s + W - t;
  return upProbability({ S: at(t), K: strike(s), sigma: sigmaAt(t), tRem, L, avgSoFar: tRem < L ? avg(s + W - L, t + 1) : null }).p;
}

// ---------- 2. fills and minute prints ----------
const fills = [], prints = [];
let n = 0, truncated = 0;
for (const [s, m] of markets) {
  if (n++ % 100 === 0) console.log(`window ${n}/${markets.size}, fills so far ${fills.length}`);
  const trades = [];
  for (let off = 0; off < 4000; off += 1000) {
    const page = await get(`https://data-api.polymarket.com/trades?market=${m.cid}&limit=1000&offset=${off}&takerOnly=true`).catch(() => null);
    if (!Array.isArray(page)) break;
    trades.push(...page);
    if (page.length < 1000) break;
    if (off === 3000) truncated++;
  }
  for (const x of trades) {
    const t = x.timestamp, seen = t - SEEN_LAG;
    if (t <= s + 2 || t >= s + W - 1 || seen <= s) continue;
    // Express every taker trade as buying one side: selling Up at x is buying Down at 1 - x.
    const isUp = (x.outcome === 'Up') === (x.side === 'BUY');
    const paid = x.side === 'BUY' ? x.price : 1 - x.price;
    if (!(paid > 0.005 && paid < 0.995)) continue;
    const pUp = model(s, seen);
    const pSide = isUp ? pUp : 1 - pUp;
    const won = isUp ? m.up : 1 - m.up;
    fills.push({ s, tRem: s + W - t, paid, size: x.size, edge: pSide - paid - fee(paid), pnl: won - paid - fee(paid), pSide, won });
  }
  const h = await get(`https://clob.polymarket.com/prices-history?market=${m.token}&startTs=${s}&endTs=${s + W}&fidelity=1`).catch(() => null);
  for (const { t, p } of h?.history || []) {
    if (t <= s + 5 || t >= s + W - 5 || !(p > 0 && p < 1)) continue;
    prints.push({ s, tRem: s + W - t, market: p, model: model(s, t), up: m.up });
  }
  await sleep(60);
}
console.log(`${fills.length} fills, ${prints.length} prints, ${truncated} windows with over 4,000 fills (capped)`);

// ---------- 3. scoring ----------
const sw = (rows, f) => { const w = rows.reduce((a, r) => a + r.size, 0); return w ? rows.reduce((a, r) => a + f(r) * r.size, 0) / w : null; };
const allTaker = { fills: fills.length, shares: fills.reduce((a, r) => a + r.size, 0), pnlPerShare: sw(fills, r => r.pnl), feePerShare: sw(fills, r => fee(r.paid)), tStat: tstatByWindow(fills) };

// Calibration of traded prices: price paid vs how often that side won.
const calibration = Array.from({ length: 10 }, (_, i) => {
  const rows = fills.filter(r => r.paid >= i / 10 && r.paid < (i + 1) / 10);
  return { bin: `${i * 10}-${i * 10 + 10}c`, fills: rows.length, avgPaid: sw(rows, r => r.paid), won: sw(rows, r => r.won), modelSaid: sw(rows, r => r.pSide) };
});

// The key table: fills grouped by how cheap the model thought they were.
const EDGE_BINS = [[-1, -0.1], [-0.1, -0.05], [-0.05, -0.02], [-0.02, 0], [0, 0.02], [0.02, 0.05], [0.05, 0.1], [0.1, 1]];
const byEdge = rows => EDGE_BINS.map(([a, b]) => {
  const r = rows.filter(x => x.edge >= a && x.edge < b);
  return { edge: `${a <= -1 ? 'below ' + b * 100 : b >= 1 ? 'above ' + a * 100 : a * 100 + ' to ' + b * 100}c`, fills: r.length, shares: Math.round(r.reduce((s, x) => s + x.size, 0)), modelEdge: sw(r, x => x.edge), realised: sw(r, x => x.pnl), windows: new Set(r.map(x => x.s)).size, tStat: tstatByWindow(r) };
});
const edgeAll = byEdge(fills), edgeEarly = byEdge(fills.filter(f => f.tRem > 60)), edgeLate = byEdge(fills.filter(f => f.tRem <= 60));

/** One trade per window: copy the first real fill the model rates more than theta cheap, hold to the end. */
function follow(theta, minLeft = 0, maxLeft = W) {
  const seen = new Set(), pnl = [];
  for (const f of fills) {
    if (seen.has(f.s) || f.tRem < minLeft || f.tRem > maxLeft || f.edge <= theta) continue;
    seen.add(f.s); pnl.push(f.pnl);
  }
  return { theta, window: `${minLeft}-${maxLeft}s left`, trades: pnl.length, pnlPerShare: mean(pnl), tStat: tstat(pnl) };
}
fills.sort((a, b) => a.s - b.s || b.tRem - a.tRem); // chronological within each window
const strategies = [0, 0.02, 0.05, 0.1].map(th => follow(th)).concat([follow(0.05, 60, W), follow(0.05, 0, 60)]);

// The same rule on minute prints, which are not executable prices.
function followPrints(theta, halfSpread = 0.01) {
  const seen = new Set(), pnl = [];
  for (const p of prints) {
    if (seen.has(p.s)) continue;
    const up = Math.min(0.99, p.market + halfSpread), dn = Math.min(0.99, 1 - p.market + halfSpread);
    let side = null, cost;
    if (p.model - up - fee(up) > theta) { side = 1; cost = up + fee(up); }
    else if (1 - p.model - dn - fee(dn) > theta) { side = 0; cost = dn + fee(dn); }
    if (side == null) continue;
    seen.add(p.s); pnl.push((side ? p.up : 1 - p.up) - cost);
  }
  return { theta, halfSpread, trades: pnl.length, pnlPerShare: mean(pnl), tStat: tstat(pnl) };
}
prints.sort((a, b) => a.s - b.s || b.tRem - a.tRem);
const printTrap = [0.02, 0.05, 0.1].map(th => followPrints(th));

const buckets = [[240, 300], [180, 240], [120, 180], [60, 120], [0, 60]];
const brierByTime = buckets.map(([a, b]) => {
  const r = fills.filter(f => f.tRem > a && f.tRem <= b);
  return { secondsLeft: `${a}-${b}`, fills: r.length, brierPrice: sw(r, x => (x.paid - x.won) ** 2), brierModel: sw(r, x => (x.pSide - x.won) ** 2) };
});

// ---------- 4. memory ----------
const seq = [...markets.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m.up);
let uu = 0, u = 0, dd = 0, d = 0;
for (let i = 1; i < seq.length; i++) { if (seq[i - 1]) { u++; uu += seq[i]; } else { d++; dd += 1 - seq[i]; } }
const memory = { windows: seq.length, upRate: mean(seq), upAfterUp: uu / u, downAfterDown: dd / d, nAfterUp: u, nAfterDown: d };

const out = {
  builtAt: new Date().toISOString(), days: DAYS, windows: starts.length, resolved: markets.size,
  fills: fills.length, prints: prints.length, truncatedWindows: truncated, seenLagSeconds: SEEN_LAG,
  volumeMedian: [...markets.values()].map(m => m.volume).sort((a, b) => a - b)[Math.floor(markets.size / 2)],
  ruleMatch, allTaker, calibration, edgeAll, edgeEarly, edgeLate, strategies, printTrap, brierByTime, memory,
};
fs.writeFileSync(new URL('./btc5m.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(allTaker); console.table(edgeAll); console.table(edgeLate); console.table(strategies); console.table(printTrap); console.table(brierByTime); console.table(calibration); console.log(memory);
