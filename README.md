# xvenue-arb

Compares tennis and golf prices on Polymarket, Kalshi and Pinnacle and flags two-leg arbitrage.

Live: https://xvenue-arb.vercel.app

## How it works

- Every price is converted to the cost, including fees, of a contract that pays $1.
- **Tennis** (ATP, WTA, Challenger): match winner. "Player does not win" can be bought as a No contract on Kalshi or as the opponent winning on any venue.
- **Golf** (PGA, LPGA, DP World, LIV): tournament winner, compared player by player. Pinnacle only offers "to win"; Polymarket and Kalshi offer both Yes and No.
- If the cheapest Yes and the cheapest No for a player cost less than $1 together, the payout is the same whatever happens.
- Clicking a row lists every pairing, splits a stake for equal payout, and checks the live Polymarket and Kalshi order books to see how much would actually fill.

Fees: Polymarket `shares × rate × p × (1 − p)` with each market's rate; Kalshi `0.07 × p × (1 − p)`, rounded up per order. Pinnacle prices are `1 / decimal odds`.

Players are matched across venues by surname and first initial (accents and hyphens removed), tournaments by tour and name.

## Bitcoin page (`/btc`)

- **5-minute Up or Down, live.** Fair P(Up) from Chainlink BTC/USD (Polymarket's live-data socket) and one-second Binance volatility, against the live order book. The markets resolve on a 60-second Chainlink TWAP, so the model prices the average, not the closing price: before the last minute the variance is σ²S²(t − 60 + 60/3), and inside it the fixed part of the average is carried. Shows EV after the 0.07 × p × (1 − p) taker fee, Kelly size and the BTC delta hedge (with what the perpetual fees would cost).
- **Backtest (`research/btc5m.mjs`).** 7 days, 2,016 windows, about 2.7 million real taker fills from Polymarket's trade log, with the model only seeing BTC up to 3 seconds before each fill. Results: the TWAP reading of the rules reproduces 97.9% of outcomes (end vs start price: 85%). Traded prices are calibrated. Takers lose about the fee (1 cent a share). The model is less accurate than the market, and following it does not pay. Run on the minute price series instead, the same rule shows a large fake edge, which is why that series should not be used for backtests.
- **Daily strikes vs Deribit.** Polymarket's "Bitcoin above K at noon ET" markets are digital options. Fair value comes from Deribit's smile: total variance interpolated between the 08:00 UTC expiries either side of noon, and the digital priced as a tight call spread (C(K − h) − C(K + h)) / 2h with each strike at its own implied vol. Shows EV per contract after fees and the BTC delta to hedge.

```
api/btc.js         live 5-minute market, daily strikes priced from Deribit, Binance perpetual
lib/btc.js         TWAP fair value, delta, Kelly, Black-Scholes digitals with smile
research/btc5m.mjs the backtest; writes research/btc5m.json
```

## Data

Polymarket Gamma and CLOB APIs, Kalshi public API, and Pinnacle's public guest API (the same one its website uses for logged-out visitors). No keys needed. The API runs in Vercel's Singapore region.

## Files

```
api/board.js   fetch and join all venues
api/depth.js   order book for one Polymarket token or Kalshi market
lib/feeds.js   venue adapters and name matching
lib/core.js    pricing math (shared with the browser)
test/          unit tests
```

```bash
npm test
npx vercel dev
```

Not betting advice.
