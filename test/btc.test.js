import test from 'node:test';
import assert from 'node:assert/strict';
import { Phi, twapDistribution, upProbability, edge, breakeven, digitalCall, digitalFromSmile, bsCall, realisedSigma } from '../lib/btc.js';

const close = (a, b, tol) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test('normal CDF', () => {
  close(Phi(0), 0.5, 1e-9); close(Phi(1.96), 0.975, 1e-4); close(Phi(-1), 0.158655, 1e-6);
});

test('TWAP variance: an average over L seconds varies a third as much as the price', () => {
  const base = { S: 100, sigma: 0.001, L: 60 };
  close(twapDistribution({ ...base, tRem: 60 }).sd, 0.1 * Math.sqrt(20), 1e-12);         // all of the average still ahead: L/3
  close(twapDistribution({ ...base, tRem: 300 }).sd, 0.1 * Math.sqrt(240 + 20), 1e-12);  // plus the gap before averaging starts
  const half = twapDistribution({ ...base, tRem: 30, avgSoFar: 99 });                     // half the average fixed at 99
  close(half.mean, 0.5 * 99 + 0.5 * 100, 1e-12);
  close(half.sd, 0.5 * 0.1 * Math.sqrt(10), 1e-12);
});

test('P(Up) is 50% at the strike, and delta matches a finite difference', () => {
  const a = { S: 85000, K: 85000, sigma: 7e-5, tRem: 200, L: 60 };
  close(upProbability(a).p, 0.5, 1e-9);
  const h = 0.5, fd = (upProbability({ ...a, S: a.S + h }).p - upProbability({ ...a, S: a.S - h }).p) / (2 * h);
  close(upProbability(a).delta, fd, 1e-7);
});

test('fee and Kelly', () => {
  close(breakeven(0.5), 0.0175, 1e-12); // 1.75 cents at 50 cents
  const e = edge(0.6, 0.5);
  close(e.cost, 0.5175, 1e-12); close(e.ev, 0.0825, 1e-12); close(e.kelly, 0.0825 / 0.4825, 1e-12);
  assert.equal(edge(0.4, 0.5).kelly, 0);
});

test('digital from a flat smile equals N(d2)', () => {
  const S = 85000, K = 86000, iv = 0.4, T = 1 / 365;
  close(digitalFromSmile(S, K, () => iv, T, 10), digitalCall(S, K, iv, T), 1e-4);
  assert.ok(bsCall(S, K, iv, T) > 0 && bsCall(S, K, iv, T) < S);
});

test('smile slope moves the digital: -dC/dK = N(d2) - vega * dsigma/dK', () => {
  const S = 85000, K = 85000, T = 2 / 365;
  const down = k => 0.45 - (k - 85000) * 2e-5, up = k => 0.45 + (k - 85000) * 2e-5;
  assert.ok(digitalFromSmile(S, K, down, T) > digitalCall(S, K, 0.45, T)); // put skew: worth more
  assert.ok(digitalFromSmile(S, K, up, T) < digitalCall(S, K, 0.45, T));   // call wing: worth less
});

test('realised volatility', () => {
  close(realisedSigma([100, 101, 100, 101]), Math.log(1.01), 1e-12); // every move is the same size
  assert.equal(realisedSigma([5]), null);
});
