// Fair value, hedge ratios and sizing for Bitcoin binary contracts. Shared by the browser,
// the API and the research scripts.
//
// Polymarket's "Bitcoin Up or Down" 5-minute markets resolve Up when the Chainlink BTC/USD
// 60-second TWAP at the end of the window is >= the value at the start. The price is modelled
// as Brownian motion with no drift over a few minutes: dS = sigma * S * dW.

export const POLY_CRYPTO_FEE = 0.07; // taker only: fee per share = 0.07 * p * (1 - p)

const SQRT2 = Math.SQRT2;
/** Standard normal CDF (Abramowitz and Stegun 7.1.26 erf, error below 1.5e-7). */
export function Phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
export const phi = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

/**
 * Distribution of the final average A = mean of S over the last L seconds of the window.
 *   Before the averaging starts (tRem >= L): A = S + noise with variance s^2 S^2 (gap + L/3),
 *   because the average of Brownian motion over L seconds has variance L/3, not L.
 *   Inside it: part of the average is already fixed. With w = elapsed share of the L seconds,
 *   A = w * avgSoFar + (1 - w) * (future average), and the future part has variance tRem/3.
 * `sigma` is volatility per sqrt(second), as a fraction of price.
 */
export function twapDistribution({ S, sigma, tRem, L = 60, avgSoFar = null }) {
  if (tRem <= 0) return { mean: avgSoFar ?? S, sd: 0, dMeanDS: L ? 0 : 1 };
  if (tRem >= L || !L) {
    const gap = tRem - L;
    return { mean: S, sd: sigma * S * Math.sqrt(Math.max(gap, 0) + L / 3), dMeanDS: 1 };
  }
  const w = (L - tRem) / L;
  const fixed = avgSoFar ?? S;
  return { mean: w * fixed + (1 - w) * S, sd: (1 - w) * sigma * S * Math.sqrt(tRem / 3), dMeanDS: 1 - w };
}

/**
 * P(Up), and its sensitivity to the BTC price.
 * delta = dP/dS: shares of the Up contract change value by delta dollars per $1 BTC move,
 * so hedging N Up shares means shorting N * delta BTC.
 */
export function upProbability(args) {
  const { K } = args;
  const { mean, sd, dMeanDS } = twapDistribution(args);
  if (sd <= 0) return { p: mean >= K ? 1 : 0, delta: 0, z: mean >= K ? Infinity : -Infinity, mean, sd };
  const z = (mean - K) / sd;
  return { p: Phi(z), delta: phi(z) * dMeanDS / sd, z, mean, sd };
}

/** Realised volatility per sqrt(second) from a series of prices one second apart. */
export function realisedSigma(prices) {
  let n = 0, s = 0;
  for (let i = 1; i < prices.length; i++) {
    if (!(prices[i] > 0 && prices[i - 1] > 0)) continue;
    const r = Math.log(prices[i] / prices[i - 1]);
    s += r * r; n++;
  }
  return n ? Math.sqrt(s / n) : null;
}

/** All-in cost of buying one share at `price` as a taker. */
export const takerCost = (price, rate = POLY_CRYPTO_FEE) => price + rate * price * (1 - price);

/**
 * Expected value of buying one $1 share at `price` when the true probability is `p`,
 * and the Kelly fraction of bankroll to stake: f = (p - c) / (1 - c) for all-in cost c.
 */
export function edge(p, price, rate = POLY_CRYPTO_FEE) {
  const c = takerCost(price, rate);
  const ev = p - c;
  return { cost: c, ev, evPerDollar: ev / c, kelly: ev > 0 ? ev / (1 - c) : 0 };
}

/**
 * Breakeven: the smallest gap between model probability and ask that pays for the fee and
 * half the spread. At p = 0.5 the fee alone is 1.75 cents.
 */
export const breakeven = (price, halfSpread = 0, rate = POLY_CRYPTO_FEE) => rate * price * (1 - price) + halfSpread;

// ---------- longer-dated: "Bitcoin above K at noon ET" vs options ----------

/** Black-Scholes digital (cash-or-nothing call) price with zero rates: N(d2). */
export function digitalCall(S, K, sigmaAnnual, years) {
  if (years <= 0 || sigmaAnnual <= 0) return S > K ? 1 : 0;
  const v = sigmaAnnual * Math.sqrt(years);
  const d2 = (Math.log(S / K) - v * v / 2) / v;
  return Phi(d2);
}

/** Black-Scholes call with zero rates (S is the forward). */
export function bsCall(S, K, sigmaAnnual, years) {
  if (years <= 0 || sigmaAnnual <= 0) return Math.max(S - K, 0);
  const v = sigmaAnnual * Math.sqrt(years);
  const d1 = (Math.log(S / K) + v * v / 2) / v;
  return S * Phi(d1) - K * Phi(d1 - v);
}

/**
 * Digital from the smile by central difference: D(K) = (C(K - h) - C(K + h)) / 2h, each call
 * priced at its own implied vol. This is the price of a tight call spread, which is how a
 * digital is hedged in practice, and it averages the smile slope on both sides of K.
 */
export function digitalFromSmile(S, K, ivAt, years, h = Math.max(50, K * 0.0025)) {
  const lo = ivAt(K - h), hi = ivAt(K + h);
  if (!(lo > 0 && hi > 0)) return null;
  return Math.min(1, Math.max(0, (bsCall(S, K - h, lo, years) - bsCall(S, K + h, hi, years)) / (2 * h)));
}

/** Linear interpolation of implied volatility across strikes, plus its slope. */
export function smileAt(points, K) {
  const pts = points.filter(p => p.iv > 0).sort((a, b) => a.k - b.k);
  if (!pts.length) return null;
  if (K <= pts[0].k) return { iv: pts[0].iv, slope: pts.length > 1 ? (pts[1].iv - pts[0].iv) / (pts[1].k - pts[0].k) : 0 };
  for (let i = 1; i < pts.length; i++) {
    if (K <= pts[i].k) {
      const a = pts[i - 1], b = pts[i], slope = (b.iv - a.iv) / (b.k - a.k);
      return { iv: a.iv + slope * (K - a.k), slope };
    }
  }
  const n = pts.length;
  return { iv: pts[n - 1].iv, slope: n > 1 ? (pts[n - 1].iv - pts[n - 2].iv) / (pts[n - 1].k - pts[n - 2].k) : 0 };
}
