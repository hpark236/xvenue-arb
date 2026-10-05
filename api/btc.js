import { digitalCall, digitalFromSmile, smileAt, edge, phi } from '../lib/btc.js';

// GET /api/btc
//   now:   the live 5-minute Up/Down market (the browser streams prices for it)
//   daily: Polymarket "Bitcoin above K at noon ET" strikes priced from Deribit's volatility smile
//   perp:  Binance BTCUSDT perpetual mark price and funding, for hedging

const ET_NOON_UTC_HOUR = 16; // noon New York time during daylight saving, which these markets list as 16:00Z
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const YEAR_MS = 365.25 * 864e5;

const getJSON = async (url, ms = 8000) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
};

async function fiveMinute() {
  const start = Math.floor(Date.now() / 3e5) * 300;
  const [m] = await getJSON(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${start}`);
  if (!m) return null;
  const [up, down] = JSON.parse(m.clobTokenIds);
  return {
    slug: m.slug, question: m.question, start: start * 1000, end: (start + 300) * 1000,
    upToken: up, downToken: down, bestBid: +m.bestBid, bestAsk: +m.bestAsk,
    feeRate: m.feesEnabled ? m.feeSchedule?.rate ?? 0.07 : 0,
    twapSeconds: m.cryptoMarketConfig?.twapLookbackSeconds ?? 60,
    url: `https://polymarket.com/event/${m.slug}`,
  };
}

/** Deribit option chain grouped by expiry (08:00 UTC), with out-of-the-money implied vols. */
async function deribit() {
  const { result } = await getJSON('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
  const byExp = new Map();
  for (const o of result) {
    const [, exp, k, cp] = o.instrument_name.split('-');
    const m = exp.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!m) continue;
    const t = Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8);
    if (!byExp.has(t)) byExp.set(t, { t, fwd: o.underlying_price, calls: [], puts: [] });
    (cp === 'C' ? byExp.get(t).calls : byExp.get(t).puts).push({ k: +k, iv: o.mark_iv / 100, bid: o.bid_price, ask: o.ask_price, oi: o.open_interest });
  }
  for (const e of byExp.values()) {
    // use out-of-the-money options on each side of the forward: they carry the smile
    e.smile = [...e.puts.filter(p => p.k < e.fwd), ...e.calls.filter(c => c.k >= e.fwd)].sort((a, b) => a.k - b.k);
  }
  return [...byExp.values()].sort((a, b) => a.t - b.t);
}

/** Implied vol and smile slope at strike K for time T, interpolating total variance between expiries. */
function volAt(chain, K, T, now) {
  const after = chain.find(e => e.t >= T), before = [...chain].reverse().find(e => e.t < T && e.t > now);
  if (!after) return null;
  const a = smileAt(after.smile, K);
  if (!a) return null;
  const tauA = (after.t - now) / YEAR_MS, tau = (T - now) / YEAR_MS;
  if (!before) return { iv: a.iv, slope: a.slope, expiries: [after.t], fwd: after.fwd };
  const b = smileAt(before.smile, K);
  const tauB = (before.t - now) / YEAR_MS;
  const x = (tau - tauB) / (tauA - tauB);
  const w = b.iv ** 2 * tauB + x * (a.iv ** 2 * tauA - b.iv ** 2 * tauB);
  return { iv: Math.sqrt(Math.max(w, 1e-12) / tau), slope: b.slope + x * (a.slope - b.slope), expiries: [before.t, after.t], fwd: before.fwd + x * (after.fwd - before.fwd) };
}

async function dailyEvents() {
  const out = [];
  const now = Date.now();
  for (let d = 0; d < 3; d++) {
    const day = new Date(now + d * 864e5 - 4 * 36e5); // calendar date in New York
    const slug = `bitcoin-above-on-${MONTHS[day.getUTCMonth()]}-${day.getUTCDate()}-${day.getUTCFullYear()}`;
    const [e] = await getJSON(`https://gamma-api.polymarket.com/events?slug=${slug}`).catch(() => []);
    if (!e || e.closed) continue;
    const end = Date.parse(e.endDate);
    if (!(end > now)) continue;
    out.push({
      slug, title: e.title, end, url: `https://polymarket.com/event/${slug}`,
      strikes: e.markets.filter(m => !m.closed).map(m => ({
        K: Number(String(m.groupItemTitle || m.question).replace(/[^\d.]/g, '')),
        yesBid: +m.bestBid || 0, yesAsk: +m.bestAsk || 1,
        feeRate: m.feesEnabled ? m.feeSchedule?.rate ?? 0 : 0,
        volume: +m.volumeNum || 0,
      })).filter(s => s.K > 0).sort((a, b) => a.K - b.K),
    });
  }
  return out;
}

export default async function handler(req, res) {
  const now = Date.now();
  const [five, chain, events, spot, perp] = await Promise.allSettled([
    fiveMinute(), deribit(), dailyEvents(),
    getJSON('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
    getJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
  ]);
  const S = spot.status === 'fulfilled' ? +spot.value.price : null;
  const daily = [];
  if (chain.status === 'fulfilled' && events.status === 'fulfilled' && S) {
    for (const ev of events.value) {
      const years = (ev.end - now) / YEAR_MS;
      daily.push({
        ...ev, hoursLeft: (ev.end - now) / 36e5,
        strikes: ev.strikes.map(s => {
          const v = volAt(chain.value, s.K, ev.end, now);
          if (!v) return { ...s, fair: null };
          const flat = digitalCall(S, s.K, v.iv, years);
          const fair = digitalFromSmile(S, s.K, k => volAt(chain.value, k, ev.end, now)?.iv, years) ?? flat;
          const yes = edge(fair, s.yesAsk, s.feeRate), no = edge(1 - fair, 1 - s.yesBid, s.feeRate);
          // delta of the digital in BTC per $1 contract: d/dS N(d2) = phi(d2) / (S sigma sqrt(T))
          const sd = v.iv * Math.sqrt(years);
          const d2 = (Math.log(S / s.K) - sd * sd / 2) / sd;
          return {
            ...s, iv: v.iv, ivSlopePer1k: v.slope * 1000, fairFlat: flat, fair,
            buyYes: yes, buyNo: no, deltaBtc: phi(d2) / (S * sd), expiries: v.expiries,
          };
        }),
      });
    }
  }
  const p = perp.status === 'fulfilled' ? perp.value : null;
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    updated: new Date(now).toISOString(), spot: S,
    perp: p ? { mark: +p.markPrice, index: +p.indexPrice, funding8h: +p.lastFundingRate, nextFunding: p.nextFundingTime } : null,
    now: five.status === 'fulfilled' ? five.value : null,
    daily,
    errors: Object.fromEntries([['five', five], ['deribit', chain], ['polymarket', events], ['spot', spot], ['perp', perp]].filter(([, r]) => r.status === 'rejected').map(([k, r]) => [k, String(r.reason?.message || r.reason)])),
  });
}
