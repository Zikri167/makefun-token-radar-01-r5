// Token Radar — round 5 entry.
// Reads a DefiLlama snapshot, fits a three-estimator log-space ensemble on the
// protocols that record a token (the calibration peers), leave-one-out
// validates it, and ranks the protocols that record no token by the implied
// value of a token issued on today's record. Deterministic: no clock, no
// randomness; ages are measured against the snapshot's own as_of date.
import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const AS_OF = "2026-11-14";
const AS_OF_MS = Date.UTC(2026, 10, 14);
const YEAR_MS = 365.25 * 86400000;

// ------------------------------------------------------------------ types
interface Proto {
  slug: string; name: string; category: string; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
interface Snapshot { as_of: string; floor_usd: number; protocols: Proto[]; watchlist: string[]; }

// ------------------------------------------------------------------ math helpers
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const log10 = (x: number): number => Math.log(x) / Math.LN10;
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function mean(a: number[]): number { return a.reduce((s, x) => s + x, 0) / a.length; }
function fmtInt(n: number): string { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtPct(x: number): string { return `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`; }

// Solve (X'WX + ridge) b = X'Wy by Gaussian elimination with partial pivoting.
// Column 0 is the intercept and is never ridged.
function solveWLS(X: number[][], y: number[], w: number[], ridge: number): number[] {
  const n = X[0].length;
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i], wi = w[i];
    for (let p = 0; p < n; p++) {
      b[p] += wi * xi[p] * y[i];
      for (let q = 0; q < n; q++) A[p][q] += wi * xi[p] * xi[q];
    }
  }
  for (let p = 1; p < n; p++) A[p][p] += ridge;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; const tb = b[piv]; b[piv] = b[col]; b[col] = tb; }
    const d = A[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col] / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : v / A[i][i]));
}

// ------------------------------------------------------------------ features
function ageYears(p: Proto, catMedianAge: Map<string, number>, globalMedianAge: number): number {
  if (p.listed_at) return Math.max(0, (AS_OF_MS - Date.parse(p.listed_at)) / YEAR_MS);
  return catMedianAge.get(p.category) ?? globalMedianAge;
}
function medianAges(peers: Proto[]): { cat: Map<string, number>; global: number } {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of peers) {
    if (!p.listed_at) continue;
    const a = Math.max(0, (AS_OF_MS - Date.parse(p.listed_at)) / YEAR_MS);
    all.push(a);
    const arr = byCat.get(p.category) ?? []; arr.push(a); byCat.set(p.category, arr);
  }
  const cat = new Map<string, number>();
  for (const [k, v] of byCat) cat.set(k, median(v));
  return { cat, global: all.length ? median(all) : 0 };
}
const chainTerm = (p: Proto): number => Math.log1p(Math.max(0, p.chains.length - 1));
// Growth is clamped to the range the calibration peers actually span
// (-40.1% to +26.7%), with the cap set just above the peer maximum. The first
// build clamped at +150% and let the fitted growth coefficient extrapolate
// far outside the observed range: the six board protocols with 7-day growth
// above +50% (one at +4448%) were crushed to the bottom six ranks by a
// penalty no peer ever exhibited. A fitted slope is only evidence inside the
// range it was fitted on, so prediction now caps there too. Peer fits and
// the leave-one-out numbers are untouched — no peer reaches the cap.
const growthTerm = (p: Proto): number => clamp(p.change_7d ?? 0, -40, 30) / 100;

// ------------------------------------------------------------------ E2 / E3 regression
interface RegFit {
  coef: number[]; // [intercept, beta, gamma, delta, eta]
  offsets: Map<string, number>; // shrunk category intercept deviations
  ages: { cat: Map<string, number>; global: number };
}
function designRow(p: Proto, ages: { cat: Map<string, number>; global: number }): number[] {
  return [1, log10(p.tvl_usd), chainTerm(p), ageYears(p, ages.cat, ages.global), growthTerm(p)];
}
function fitRegression(train: Proto[], huber: boolean): RegFit {
  const ages = medianAges(train);
  const X = train.map((p) => designRow(p, ages));
  const y = train.map((p) => log10(p.mcap_usd as number));
  const w = new Array(train.length).fill(1);
  let coef = solveWLS(X, y, w, 1e-6);
  let offsets = computeOffsets(train, X, y, coef, w);
  if (huber) {
    for (let it = 0; it < 12; it++) {
      const res = train.map((p, i) => y[i] - (dot(coef, X[i]) + (offsets.get(p.category) ?? 0)));
      for (let i = 0; i < res.length; i++) { const a = Math.abs(res[i]); w[i] = a <= 1.0 ? 1 : 1.0 / a; }
      const next = solveWLS(X, y, w, 1e-6);
      const nextOff = computeOffsets(train, X, y, next, w);
      const shift = Math.max(...next.map((v, i) => Math.abs(v - coef[i])));
      coef = next; offsets = nextOff;
      if (shift < 1e-10) break;
    }
  }
  return { coef, offsets, ages };
}
function computeOffsets(train: Proto[], X: number[][], y: number[], coef: number[], w: number[]): Map<string, number> {
  const acc = new Map<string, { sw: number; sr: number; n: number }>();
  train.forEach((p, i) => {
    const r = y[i] - dot(coef, X[i]);
    const e = acc.get(p.category) ?? { sw: 0, sr: 0, n: 0 };
    e.sw += w[i]; e.sr += w[i] * r; e.n++; acc.set(p.category, e);
  });
  const out = new Map<string, number>();
  for (const [k, e] of acc) out.set(k, (e.n / (e.n + 5)) * (e.sr / e.sw));
  return out;
}
const dot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0);
function predictReg(fit: RegFit, p: Proto): number {
  return dot(fit.coef, designRow(p, fit.ages)) + (fit.offsets.get(p.category) ?? 0);
}

// ------------------------------------------------------------------ E1 multiples
interface E1Stats {
  multGlobal: number; betaGlobal: number; medTvlGlobal: number;
  cats: Map<string, { mult: number; beta: number; medTvl: number; n: number }>;
  medChain: Map<string, number>; medAge: Map<string, number>; medGrowth: Map<string, number>;
  medChainG: number; medAgeG: number; medGrowthG: number;
}
function olsSlope(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den < 1e-12 ? 0 : num / den;
}
function winsorMedian(vals: number[]): number {
  const lo = quantile(vals, 0.05), hi = quantile(vals, 0.95);
  return median(vals.map((v) => clamp(v, lo, hi)));
}
function e1Stats(train: Proto[]): E1Stats {
  const mults = train.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const multGlobal = winsorMedian(mults);
  const betaGlobal = olsSlope(train.map((p) => log10(p.tvl_usd)), train.map((p) => log10(p.mcap_usd as number)));
  const ages = medianAges(train);
  const byCat = new Map<string, Proto[]>();
  for (const p of train) { const a = byCat.get(p.category) ?? []; a.push(p); byCat.set(p.category, a); }
  const cats = new Map<string, { mult: number; beta: number; medTvl: number; n: number }>();
  const medChain = new Map<string, number>(), medAge = new Map<string, number>(), medGrowth = new Map<string, number>();
  for (const [cat, arr] of byCat) {
    const n = arr.length, wgt = n / (n + 5);
    const multCat = winsorMedian(arr.map((p) => (p.mcap_usd as number) / p.tvl_usd));
    const mult = Math.pow(10, wgt * log10(multCat) + (1 - wgt) * log10(multGlobal));
    const betaCat = n >= 2 ? olsSlope(arr.map((p) => log10(p.tvl_usd)), arr.map((p) => log10(p.mcap_usd as number))) : betaGlobal;
    const beta = wgt * betaCat + (1 - wgt) * betaGlobal;
    cats.set(cat, { mult, beta, medTvl: median(arr.map((p) => p.tvl_usd)), n });
    medChain.set(cat, median(arr.map(chainTerm)));
    medAge.set(cat, median(arr.map((p) => ageYears(p, ages.cat, ages.global))));
    medGrowth.set(cat, median(arr.map(growthTerm)));
  }
  return {
    multGlobal, betaGlobal, medTvlGlobal: median(train.map((p) => p.tvl_usd)), cats, medChain, medAge, medGrowth,
    medChainG: median(train.map(chainTerm)),
    medAgeG: median(train.map((p) => ageYears(p, ages.cat, ages.global))),
    medGrowthG: median(train.map(growthTerm)),
  };
}
// E1 with optional centered gamma/delta/eta adjustments borrowed from the E2 fit.
function predictE1(p: Proto, st: E1Stats, ages: { cat: Map<string, number>; global: number }, adj: number[] | null, perCatBeta: boolean): number {
  const c = st.cats.get(p.category);
  const mult = c ? c.mult : st.multGlobal;
  const beta = perCatBeta && c ? c.beta : st.betaGlobal;
  const medTvl = perCatBeta && c ? c.medTvl : st.medTvlGlobal;
  let v = log10(mult) + log10(p.tvl_usd) + (beta - 1) * (log10(p.tvl_usd) - log10(medTvl));
  if (adj) {
    const mc = st.medChain.get(p.category) ?? st.medChainG;
    const ma = st.medAge.get(p.category) ?? st.medAgeG;
    const mg = st.medGrowth.get(p.category) ?? st.medGrowthG;
    v += adj[2] * (chainTerm(p) - mc) + adj[3] * (ageYears(p, ages.cat, ages.global) - ma) + adj[4] * (growthTerm(p) - mg);
  }
  return v;
}

// ------------------------------------------------------------------ difficulty + board rule
function difficulty(p: Proto, orphan: boolean): number {
  let d = 1;
  if (!p.listed_at) d += 0.15;
  if (p.change_7d === null) d += 0.10;
  if (orphan) d += 0.20;
  if (p.tvl_usd < 10_000_000) d += 0.10;
  if (p.tvl_usd > 1_000_000_000) d += 0.05;
  return d;
}
const EXCLUDED_CATS = new Set(["Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC", "CEX"]);
const VERSION_RE = /\s(?:[Vv]\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$/;
const WRAP_RE = /\b(?:wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
function excludedByRule(p: Proto): boolean {
  if (EXCLUDED_CATS.has(p.category)) return true;
  if (VERSION_RE.test(p.name)) return true;
  if (WRAP_RE.test(p.name)) return true;
  const lower = p.name.toLowerCase();
  for (const ex of EXCHANGE_PREFIXES) if (lower.startsWith(ex.toLowerCase())) return true;
  return false;
}

// ------------------------------------------------------------------ farm plans
const GAS_USD: Record<string, number> = {
  Ethereum: 18, Binance: 0.4, Arbitrum: 0.6, Base: 0.35, Optimism: 0.5, Polygon: 0.15,
  Avalanche: 0.9, Solana: 0.05, Sonic: 0.1, Berachain: 0.3, Mantle: 0.2, Linea: 0.4,
  Scroll: 0.4, "zkSync Era": 0.4, Blast: 0.3, Mode: 0.3, Taiko: 0.4, Fantom: 0.2,
  Cronos: 0.2, xDai: 0.05, Gnosis: 0.05, Metis: 0.3, Kava: 0.2, Canto: 0.1, Harmony: 0.05,
  Moonbeam: 0.3, Moonriver: 0.3, Astar: 0.2, Tron: 1.2, Bitcoin: 4, Sui: 0.1, Aptos: 0.1,
  Plasma: 0.2, Monad: 0.2, "Hyperliquid L1": 0.1, Sei: 0.1, Katana: 0.2, Ink: 0.3,
};
const BRIDGE: Record<string, { fee: number; mins: number }> = {
  Ethereum: { fee: 12, mins: 30 }, Bitcoin: { fee: 15, mins: 60 }, Solana: { fee: 5, mins: 15 },
  Tron: { fee: 6, mins: 20 }, Avalanche: { fee: 5, mins: 15 }, Polygon: { fee: 4, mins: 20 },
};
const BRIDGE_DEFAULT = { fee: 6, mins: 25 };
const GAS_DEFAULT = 1.5;
function cheapestChain(p: Proto): { chain: string; gas: number; fee: number; mins: number } {
  let best: { chain: string; gas: number } | null = null;
  for (const c of p.chains) {
    const g = GAS_USD[c] ?? GAS_DEFAULT;
    if (!best || g < best.gas || (g === best.gas && c < best.chain)) best = { chain: c, gas: g };
  }
  const b = BRIDGE[best!.chain] ?? BRIDGE_DEFAULT;
  return { chain: best!.chain, gas: best!.gas, fee: b.fee, mins: b.mins };
}
const CORE_ACTION: Record<string, (n: string) => string> = {
  Dexs: (n) => `Provide liquidity to the two deepest ${n} pools and route a few swaps through them yourself, so your wallet shows both LP and trader activity`,
  Lending: (n) => `Supply a blue-chip collateral asset to ${n}, borrow a small stablecoin amount against it, repay in full, and keep the health factor above 2 at all times`,
  Yield: (n) => `Deposit into the main ${n} vault, hold the receipt position across a full epoch, and restake or roll it once instead of withdrawing early`,
  "Yield Aggregator": (n) => `Deposit into the largest ${n} auto-compounding vault, let it compound for at least two harvest cycles, and add a second smaller deposit later`,
  Derivatives: (n) => `Open and close small hedged perpetual positions on ${n} on several separate days, keeping margin modest so liquidation risk stays near zero`,
  CDP: (n) => `Open a small collateralised position in ${n}, mint a modest amount against it, repay, and repeat once so the wallet shows a full borrow cycle`,
  RWA: (n) => `Complete onboarding for ${n}, subscribe a small amount to its flagship real-world-asset product, and hold it through one full distribution cycle`,
  "Risk Curators": (n) => `Deposit into a flagship vault curated through ${n}, split across two vaults if available, and keep the position through a full reallocation cycle`,
  "Basis Trading": (n) => `Run a small delta-neutral basis position through ${n}: fund the long leg, confirm the hedge leg is live, and unwind it once end to end`,
  "Leveraged Farming": (n) => `Open a conservatively leveraged farm in ${n} at the lowest leverage tier, monitor it daily, and close it once so the full loop is on record`,
  Indexes: (n) => `Buy and hold the flagship ${n} index product, add a second purchase in a later week, and rebalance once when the index reweights`,
  "Onchain Capital Allocator": (n) => `Allocate to one strategy vault on ${n}, keep it through a full reporting period, and shift a small part to a second strategy later`,
  Launchpad: (n) => `Register for the next ${n} launch, complete its participation steps, and make the minimum qualifying contribution if one opens`,
  Payments: (n) => `Make real payments through ${n} on several separate days, receive one payment back, and keep the account active across a full month`,
  "Prediction Market": (n) => `Take small positions on several liquid markets on ${n}, settle at least one to completion, and keep total exposure modest`,
  Privacy: (n) => `Make a small shielded deposit into ${n}, hold it for several days, and withdraw to a fresh address so the full privacy loop is exercised`,
  Restaking: (n) => `Restake a small amount through ${n}, pick one operator or strategy, and keep the position delegated through a full epoch`,
  "Cross Chain Bridge": (n) => `Bridge a small amount through ${n} in both directions on separate days, using two different destination chains if available`,
  "Token Locker": (n) => `Lock a small token amount in ${n} for the shortest available term, then claim it back at unlock so the full cycle completes`,
  "NFT Marketplace": (n) => `List one item for sale on ${n}, buy one low-cost item, and settle both so the wallet shows maker and taker activity`,
};
const CADENCE: Record<string, { times: string; every: string; track: string }> = {
  Dexs: { times: "twice a week", every: "about 15 minutes", track: "swap count, LP share and any points or epoch tally the interface shows" },
  Lending: { times: "once a week", every: "about 10 minutes", track: "supplied balance, borrow health and any points or epoch tally the interface shows" },
  Yield: { times: "once per epoch, roughly weekly", every: "about 10 minutes", track: "vault share balance, harvest history and any points tally the interface shows" },
  Derivatives: { times: "three times a week", every: "about 20 minutes", track: "open interest share, funding paid and any volume tier the interface shows" },
};
const CADENCE_DEFAULT = { times: "once a week", every: "about 10 minutes", track: "position balance, activity streak and any points or epoch tally the interface shows" };
function capitalTier(tvl: number): { size: number; pct: string } {
  const size = tvl >= 1e9 ? 5000 : tvl >= 2.5e8 ? 2500 : tvl >= 1e8 ? 1000 : tvl >= 5e7 ? 500 : tvl >= 1e7 ? 250 : 100;
  const raw = (size / tvl) * 100;
  return { size, pct: raw < 0.001 ? "<0.001" : raw.toFixed(3) };
}
function farmSteps(p: Proto): string[] {
  const cc = cheapestChain(p);
  const tier = capitalTier(p.tvl_usd);
  const cad = CADENCE[p.category] ?? CADENCE_DEFAULT;
  const core = (CORE_ACTION[p.category] ?? ((n: string) => `Use the core ${p.category} product on ${n}: make a first deposit or trade, repeat it in a later week, and keep the position live`))(p.name);
  const chg = p.change_7d;
  let momentum: string;
  if (chg === null) {
    momentum = `Momentum is unreported for ${p.name} (no 7-day TVL change in the record), so keep the starter size of $${fmtInt(tier.size)}, review the position every 7 days for about 10 minutes, and only scale up after two calm weekly checks.`;
  } else if (chg >= 10) {
    momentum = `Momentum is strong: ${p.name} TVL grew ${fmtPct(chg)} in 7 days. Ride it with the full $${fmtInt(tier.size)} tier, add a second $${fmtInt(Math.round(tier.size / 2))} tranche after 7 days if growth holds, and spend about 10 minutes weekly checking the trend has not flipped.`;
  } else if (chg >= 0) {
    momentum = `Momentum is mildly positive: ${p.name} TVL changed ${fmtPct(chg)} in 7 days. Deploy the standard $${fmtInt(tier.size)} tier, recheck in 7 days for about 10 minutes, and add only if the next reading is also positive.`;
  } else if (chg >= -10) {
    momentum = `Momentum is soft: ${p.name} TVL changed ${fmtPct(chg)} in 7 days. Start at half size, $${fmtInt(Math.round(tier.size / 2))}, review every 7 days for about 10 minutes, and top up to the full tier only after a positive weekly reading.`;
  } else {
    momentum = `Momentum is negative: ${p.name} TVL changed ${fmtPct(chg)} in 7 days. Keep exposure small at $${fmtInt(Math.round(tier.size / 4))} or wait, review every 7 days for about 10 minutes, and do not add until TVL stabilises for two straight weeks.`;
  }
  const steps = [
    `Move funds to ${cc.chain}, the cheapest of ${p.name}'s ${p.chains.length} chain${p.chains.length === 1 ? "" : "s"} in our gas table: budget about $${fmtInt(cc.fee)} for the bridge, roughly ${cc.mins} minutes in transit, and about $${cc.gas.toFixed(2)} of gas for the first deposit interaction.`,
    `${core}. Fund it with the tier from step 3, expect the actions to take about 15 minutes in total, and keep transaction hashes in case eligibility is ever checked against them.`,
    `Size the position at $${fmtInt(tier.size)}: that is ${tier.pct}% of ${p.name}'s $${fmtInt(p.tvl_usd)} TVL, large enough to register as a real user of a protocol this size without concentrating risk; setup takes about 10 minutes.`,
    `Interact ${cad.times}, ${cad.every} per session: ${cad.track}. A steady multi-week streak matters more than one large day, so spread activity over at least 4 separate weeks.`,
    momentum,
    `Exit by unwinding back to ${cc.chain}: withdraw, bridge out for about $${fmtInt(cc.fee)} and roughly ${cc.mins} minutes, plus about $${cc.gas.toFixed(2)} of gas. Before any rumoured snapshot, spend 10 minutes confirming the position and activity history still show on the interface.`,
  ];
  return steps;
}
function riskFlags(p: Proto, orphan: boolean): string[] {
  const f: string[] = [];
  if (!p.listed_at) f.push("age imputed");
  if (orphan) f.push("orphan category — no live peer");
  if (p.change_7d !== null && p.change_7d < 0) f.push("negative 7d growth");
  if (p.chains.length === 1) f.push("single-chain");
  if (p.tvl_usd < 10_000_000) f.push("TVL below $10M");
  return f;
}
function confidence(p: Proto, catPeerCount: number): string {
  let s = 0;
  if (p.listed_at) s++;
  if (p.change_7d !== null) s++;
  if (catPeerCount >= 5) s++;
  if (p.tvl_usd >= 100_000_000) s++;
  return s >= 3 ? "High" : s >= 1 ? "Medium" : "Low";
}

// ------------------------------------------------------------------ main
function assert(cond: boolean, msg: string): void { if (!cond) throw new Error(`ASSERT: ${msg}`); }

function main(): void {
  const args = process.argv.slice(2);
  const inIdx = args.indexOf("--input");
  const inputPath = inIdx >= 0 ? args[inIdx + 1] : "/input/snapshot.json";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const repoRoot = dirname(fileURLToPath(import.meta.url));
  const snap: Snapshot = JSON.parse(readFileSync(inputPath, "utf8"));
  assert(snap.as_of === AS_OF, `snapshot as_of ${snap.as_of} != ${AS_OF}`);
  const protos = snap.protocols;
  const peers = protos.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const peerCatCount = new Map<string, number>();
  for (const p of peers) peerCatCount.set(p.category, (peerCatCount.get(p.category) ?? 0) + 1);

  // ---- leave-one-out over all peers, every candidate configuration.
  // Model selection is done by this back-test, not by taste: the LOO rejected
  // per-category size exponents (alone: median |err| 0.641 vs 0.603 global) and
  // the centred covariate adjustments on E1 (ensemble 0.616 with, 0.592
  // without), so the shipped round-5 ensemble pairs a pure E1 (per-category
  // shrunk multiple, global size exponent) with E2 and E3. All numbers are
  // published in the calibration object below.
  interface LooRow { p: Proto; r5: number; r4: number; rLit: number; predShip: number; orphan: boolean; }
  const loo: LooRow[] = [];
  for (let i = 0; i < peers.length; i++) {
    const held = peers[i];
    const train = peers.filter((_, j) => j !== i);
    const fitOls = fitRegression(train, false);
    const fitHub = fitRegression(train, true);
    const st = e1Stats(train);
    const orphan = !st.cats.has(held.category);
    const e1 = predictE1(held, st, fitOls.ages, null, false);
    const e1Lit = predictE1(held, st, fitOls.ages, fitOls.coef, true);
    const e2 = predictReg(fitOls, held);
    const e3 = predictReg(fitHub, held);
    const pred5 = median([e1, e2, e3]);
    const predLit = median([e1Lit, e2, e3]);
    const actual = log10(held.mcap_usd as number);
    loo.push({ p: held, r5: pred5 - actual, r4: e1 - actual, rLit: predLit - actual, predShip: 0, orphan });
  }
  const stats = (rs: number[]) => {
    const a = rs.map(Math.abs);
    return { med: median(a), p75: quantile(a, 0.75), p90: quantile(a, 0.90) };
  };
  const s5 = stats(loo.map((r) => r.r5));
  const s4 = stats(loo.map((r) => r.r4));
  const sLit = stats(loo.map((r) => r.rLit));
  const useR5 = s5.med <= s4.med; // ship the configuration with the better LOO median error
  const shipped = loo.map((r) => (useR5 ? r.r5 : r.r4));
  const shippedStats = useR5 ? s5 : s4;
  loo.forEach((r, i) => { r.predShip = Math.pow(10, log10(r.p.mcap_usd as number) + shipped[i]); });

  // ---- conformal band level: search so scaled coverage lands closest to 80%
  const absR = shipped.map(Math.abs);
  const diffs = loo.map((r) => difficulty(r.p, r.orphan));
  let bestLevel = 0.8, bestQ = quantile(absR, 0.8), bestCov = -1, bestGap = Infinity;
  for (let lvl = 0.76; lvl <= 0.861; lvl += 0.005) {
    const q = quantile(absR, lvl);
    const cov = absR.filter((v, i) => v <= q * diffs[i]).length / absR.length;
    const gap = Math.abs(cov - 0.8);
    if (gap < bestGap - 1e-12) { bestGap = gap; bestLevel = lvl; bestQ = q; bestCov = cov; }
  }
  const q80 = bestQ, coverage = bestCov, bandLevel = Math.round(bestLevel * 1000) / 1000;

  // ---- per-category calibration from the shipped LOO
  const catCal = new Map<string, { n: number; errs: number[]; inside: number }>();
  loo.forEach((r, i) => {
    const e = catCal.get(r.p.category) ?? { n: 0, errs: [], inside: 0 };
    e.n++; e.errs.push(Math.abs(shipped[i]));
    if (Math.abs(shipped[i]) <= q80 * diffs[i]) e.inside++;
    catCal.set(r.p.category, e);
  });

  // ---- final fit on all peers
  const fitOls = fitRegression(peers, false);
  const fitHub = fitRegression(peers, true);
  const st = e1Stats(peers);
  const finalAges = fitOls.ages;

  // ---- board composition: pre-token pool + the watchlist's own product rule
  const preToken = protos.filter((p) => p.gecko_id === null && p.symbol === null);
  const kept = preToken.filter((p) => !excludedByRule(p));
  const keptSlugs = new Set(kept.map((p) => p.slug));
  const watch = new Set(snap.watchlist);
  let forced = 0;
  for (const slug of snap.watchlist) {
    if (!keptSlugs.has(slug)) {
      const p = protos.find((x) => x.slug === slug);
      assert(!!p, `watchlist slug ${slug} missing from snapshot`);
      kept.push(p as Proto); keptSlugs.add(slug); forced++;
    }
  }

  interface Row {
    p: Proto; value: number; low: number; high: number; e1: number; e2: number; e3: number;
    conf: string; flags: string[]; orphan: boolean; steps: string[];
  }
  const rows: Row[] = kept.map((p) => {
    const orphan = !st.cats.has(p.category);
    const e1l = predictE1(p, st, finalAges, null, false);
    const e2l = predictReg(fitOls, p);
    const e3l = predictReg(fitHub, p);
    const vLog = useR5 ? median([e1l, e2l, e3l]) : e1l;
    const value = Math.max(1, Math.round(Math.pow(10, vLog)));
    const h = q80 * difficulty(p, orphan);
    return {
      p, value,
      low: Math.max(1, Math.round(value / Math.pow(10, h))),
      high: Math.round(value * Math.pow(10, h)),
      e1: Math.round(Math.pow(10, e1l)), e2: Math.round(Math.pow(10, e2l)), e3: Math.round(Math.pow(10, e3l)),
      conf: confidence(p, peerCatCount.get(p.category) ?? 0),
      flags: riskFlags(p, orphan), orphan, steps: farmSteps(p),
    };
  });
  rows.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  for (let i = 1; i < rows.length; i++) if (rows[i].value > rows[i - 1].value) rows[i].value = rows[i - 1].value;

  // ---- calibration object (shared by board.json + dashboard)
  const catTable = [...catCal.entries()]
    .map(([cat, e]) => ({
      category: cat, n: e.n, median_abs_log10_error: round4(median(e.errs)),
      coverage_pct: round1((e.inside / e.n) * 100),
      beta_cat: round4(st.cats.get(cat)?.beta ?? st.betaGlobal),
    }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  const calibration = {
    peers: peers.length,
    shipped_config: useR5 ? "round-5 ensemble (median of E1 pure multiple / E2 OLS / E3 Huber)" : "round-4-equivalent (single multiple, global beta)",
    round5: { median_abs_log10_error: round4(s5.med), factor: round3(Math.pow(10, s5.med)), p75: round4(s5.p75), p90: round4(s5.p90) },
    round5_literal_variant: { note: "per-category beta plus centred adjustments on E1 — fitted, back-tested, not shipped", median_abs_log10_error: round4(sLit.med), factor: round3(Math.pow(10, sLit.med)), p75: round4(sLit.p75), p90: round4(sLit.p90) },
    round4_equivalent: { median_abs_log10_error: round4(s4.med), factor: round3(Math.pow(10, s4.med)), p75: round4(s4.p75), p90: round4(s4.p90) },
    band: { quantile_level: bandLevel, q_log10: round4(q80), scaled_coverage_pct: round1(coverage * 100) },
    global: {
      beta: round4(st.betaGlobal), multiple: round3(st.multGlobal),
      gamma_chain: round4(fitOls.coef[2]), delta_age: round4(fitOls.coef[3]), eta_growth: round4(fitOls.coef[4]),
    },
    categories: catTable,
    loo_peers: loo.map((r, i) => ({
      slug: r.p.slug, name: r.p.name, category: r.p.category,
      actual_usd: r.p.mcap_usd, loo_estimate_usd: Math.round(r.predShip),
      abs_log10_error: round4(Math.abs(shipped[i])),
    })),
  };

  // ---- board.json
  const boardRows = rows.map((r, i) => ({
    slug: r.p.slug, name: r.p.name, rank: i + 1, implied_value_usd: r.value, farm_steps: r.steps,
  }));
  const board = { rows: boardRows, calibration };

  // ---- data.js for the dashboard (compact keys; full detail lives here)
  const dataRows = rows.map((r, i) => {
    const c = st.cats.get(r.p.category);
    return {
      s: r.p.slug, n: r.p.name, c: r.p.category, ch: r.p.chains, tvl: r.p.tvl_usd,
      g: r.p.change_7d, v: r.value, lo: r.low, hi: r.high, cf: r.conf, w: watch.has(r.p.slug) ? 1 : 0,
      e1: r.e1, e2: r.e2, e3: r.e3, mult: round3(c ? c.mult : st.multGlobal), beta: round3(st.betaGlobal),
      bcat: round3(c ? c.beta : st.betaGlobal),
      cc: round3(fitOls.coef[2] * chainTerm(r.p)), ca: round3(fitOls.coef[3] * ageYears(r.p, finalAges.cat, finalAges.global)),
      cg: round3(fitOls.coef[4] * growthTerm(r.p)), fl: r.flags, st: r.steps, la: r.p.listed_at,
    };
  });
  const data = {
    meta: {
      peers: peers.length, rows: rows.length, asOf: AS_OF,
      medFactor: round3(Math.pow(10, shippedStats.med)), medAbs: round4(shippedStats.med),
      p75: round4(shippedStats.p75), p90: round4(shippedStats.p90),
      coverage: round1(coverage * 100), level: bandLevel,
      r4Factor: round3(Math.pow(10, s4.med)), r4Med: round4(s4.med),
      beta: round4(st.betaGlobal), mult: round3(st.multGlobal),
      gamma: round4(fitOls.coef[2]), delta: round4(fitOls.coef[3]), eta: round4(fitOls.coef[4]),
      shipped: calibration.shipped_config,
    },
    rows: dataRows,
    cats: [...new Set(rows.map((r) => r.p.category))].sort(),
    calCats: catTable,
    loo: calibration.loo_peers,
  };

  // ---- self-checks (fail loud)
  assert(boardRows.length >= 100 && boardRows.length <= 4000, `board rows ${boardRows.length} out of 100..4000`);
  const onBoard = new Set(boardRows.map((r) => r.slug));
  assert(snap.watchlist.every((s) => onBoard.has(s)), "watchlist coverage < 40/40");
  boardRows.forEach((r, i) => {
    assert(r.rank === i + 1, "ranks not 1..N");
    assert(Number.isInteger(r.implied_value_usd) && r.implied_value_usd > 0, `bad value ${r.slug}`);
    if (i > 0) assert(r.implied_value_usd <= boardRows[i - 1].implied_value_usd, "values increase");
    assert(r.farm_steps.length >= 3 && r.farm_steps.length <= 12, `farm_steps count ${r.slug}`);
    for (const s of r.farm_steps) { const t = s.trim(); assert(t.length >= 20 && t.length <= 600, `farm step length ${t.length} in ${r.slug}: ${t.slice(0, 60)}`); }
  });
  assert(!JSON.stringify(board).includes("NaN") && !JSON.stringify(board).includes("Infinity"), "NaN/Infinity in board");
  assert(new Set(boardRows.map((r) => r.implied_value_usd)).size > 1, "all values equal");

  // ---- write outputs
  mkdirSync(outDir, { recursive: true });
  cpSync(join(repoRoot, "dashboard"), join(outDir, "dashboard"), { recursive: true });
  cpSync(join(repoRoot, "screenshots"), join(outDir, "screenshots"), { recursive: true });
  const dashFiles = readdirSync(join(outDir, "dashboard"));
  assert(dashFiles.includes("index.html"), "dashboard/index.html missing");
  assert(dashFiles.some((f) => f.endsWith(".css")), "dashboard css missing");
  assert(dashFiles.some((f) => f.endsWith(".js")), "dashboard js missing");
  let dashBytes = 0;
  for (const f of dashFiles) dashBytes += statSync(join(outDir, "dashboard", f)).size;
  assert(dashBytes < 60000, `dashboard source ${dashBytes} >= 60000`);
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board));
  writeFileSync(join(outDir, "data.js"), `window.RADAR=${JSON.stringify(data)};\n`);
  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  assert(dossier.length <= 1.5 * 1024 * 1024, `dossier ${dossier.length} > 1.5 MiB`);
  writeFileSync(join(outDir, "dossier.json"), dossier);

  console.log(`peers=${peers.length} pretoken=${preToken.length} board=${rows.length} forced_watchlist=${forced}`);
  console.log(`LOO r5 med=${s5.med.toFixed(4)} (x${Math.pow(10, s5.med).toFixed(2)}) p75=${s5.p75.toFixed(4)} p90=${s5.p90.toFixed(4)} | r5literal med=${sLit.med.toFixed(4)} (x${Math.pow(10, sLit.med).toFixed(2)}) | r4eq med=${s4.med.toFixed(4)} (x${Math.pow(10, s4.med).toFixed(2)}) p75=${s4.p75.toFixed(4)} p90=${s4.p90.toFixed(4)} | shipped=${useR5 ? "r5" : "r4eq"}`);
  console.log(`band level=${bandLevel} q=${q80.toFixed(4)} scaled_coverage=${(coverage * 100).toFixed(1)}%`);
  console.log(`checks OK: watchlist 40/40, ranks 1..${rows.length}, values non-increasing, dashboard ${dashBytes} B, dossier ${dossier.length} B`);
  console.log(`top5: ${boardRows.slice(0, 5).map((r) => `${r.slug}=$${fmtInt(r.implied_value_usd)}`).join(" ")}`);
}
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const round3 = (x: number): number => Math.round(x * 1000) / 1000;
const round1 = (x: number): number => Math.round(x * 10) / 10;
main();
