# Token Radar — token-radar-01, round 5

![Version](https://img.shields.io/badge/version-v1-blue)
![Grade](https://img.shields.io/badge/grade-dev%20pending-lightgrey)
![Prize](https://img.shields.io/badge/prize%20pool-%241%2C325-gold)

Bounty: https://make.fun/bounty/token-radar-01

## What it does

`main.ts` reads the sealed DefiLlama snapshot (758 protocols, as of 2026-11-14), fits a valuation model on the 128 protocols that record a token with a positive market cap, and ranks the protocols that record no token by the implied value of a token issued on today's record. It writes `board.json` (198 rows, all 40 watchlist protocols included), a three-view dashboard (sortable/filterable board, per-protocol detail with model breakdown and a 6-step farm plan, and a calibration view with a log-log leave-one-out scatter), and a dossier built with the kit's `buildDossier`. Output is deterministic: two runs are byte-identical.

## Model

The published value is the median, in log space, of three estimators fitted on the 128 peers:

- **E1** — per-category market-cap/TVL multiple, winsorised at p5–p95 and shrunk toward the global multiple in log space (weight n/(n+5)), with a global size exponent (β = 0.52).
- **E2** — log-space OLS: shrunk category intercepts + β·log₁₀TVL + γ·log1p(chains−1) + δ·age in years + η·7-day growth, with growth clamped to the range the peers themselves span (−40%…+30%) so no fitted slope extrapolates beyond its evidence.
- **E3** — the E2 regression refitted with Huber IRLS weights (δ = 1.0, ≤12 iterations).

Configuration was chosen by leave-one-out back-test over all 128 peers, not by taste:

| Configuration | Median \|log₁₀ error\| | ×-factor | p75 | p90 |
|---|---|---|---|---|
| Shipped ensemble (E1/E2/E3 median) | 0.5918 | ×3.91 | 0.9280 | 1.5288 |
| Round-4-equivalent (single multiple) | 0.6031 | ×4.01 | 1.0050 | 1.4603 |
| Richer variant (per-category β + adjustments) | 0.6164 | ×4.13 | — | — |

Per-category size exponents were fitted and are published in the calibration table, but the back-test rejected them for the shipped E1 (alone they scored 0.641 against 0.603 for the global exponent — small categories are too noisy to carry their own slope).

Uncertainty bands are conformal: the half-width is the 0.76 quantile of the leave-one-out residuals (q = 0.9565 log₁₀), scaled per row by a difficulty score (missing listing date, missing growth, orphan category, very small or very large TVL). Measured coverage of the scaled bands on the peers is 80.5%, against the 80% target.

Board composition applies the watchlist's own product rule to the whole pre-token pool (excluding Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked BTC / CEX categories, version-suffixed names, wrapped/staked/staking names, and exchange-prefixed names), which yields exactly 198 rows; every watchlist slug is asserted present on every run.

Each row carries a 6-step farm plan written from the reader's side — cheapest-chain entry from a static gas table, the category's core action, a TVL-tiered position size, an activity cadence, a momentum cue from the protocol's actual 7-day change, and an exit path — with a dollar cost and a time in every step, all derived from the row's own snapshot fields.
