"use strict";
const D = window.RADAR, M = D.meta, ROWS = D.rows;
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const commas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function money(n) {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "K";
  return "$" + commas(n);
}
const pct = (g) => g === null ? "—" : (g >= 0 ? "+" : "") + g.toFixed(1) + "%";
const confRank = { High: 0, Medium: 1, Low: 2 };
let sortK = "rank", sortDir = 1, curSlug = ROWS[0].s;

$("#banner").innerHTML = [
  [M.peers, "live-token peers fitted"], ["×" + M.medFactor.toFixed(2), "LOO median error (ensemble)"],
  ["×" + M.r4Factor.toFixed(2), "LOO median error (round-4 style)"], [M.coverage.toFixed(1) + "%", "scaled band coverage (target 80%)"],
  [M.rows, "protocols on the board"], ["β " + M.beta.toFixed(2), "global size exponent"],
].map((x) => `<div class="metric"><b>${x[0]}</b><span>${x[1]}</span></div>`).join("");
$("#asof").textContent = M.asOf;
const fcat = $("#fcat");
D.cats.forEach((c) => { const o = document.createElement("option"); o.textContent = c; fcat.appendChild(o); });

function filtered() {
  const q = $("#q").value.trim().toLowerCase(), cat = fcat.value, cf = $("#fconf").value,
    ch = $("#fchains").value, w = $("#fwatch").checked;
  return ROWS.filter((r) =>
    (!q || r.n.toLowerCase().includes(q) || r.s.includes(q)) &&
    (!cat || r.c === cat) && (!cf || r.cf === cf) &&
    (!ch || (ch === "1" ? r.ch.length === 1 : ch === "2" ? r.ch.length === 2 : r.ch.length >= 3)) &&
    (!w || r.w === 1));
}
function sortRows(rows) {
  const key = {
    rank: (r) => ROWS.indexOf(r), n: (r) => r.n, c: (r) => r.c, chains: (r) => r.ch.length,
    tvl: (r) => r.tvl, g: (r) => (r.g === null ? -1e9 : r.g), v: (r) => r.v,
    band: (r) => Math.log10(r.hi) - Math.log10(r.lo), cf: (r) => confRank[r.cf],
  }[sortK];
  return [...rows].sort((a, b) => {
    const x = key(a), y = key(b);
    const c = typeof x === "string" ? (x < y ? -1 : x > y ? 1 : 0) : x - y;
    return c * sortDir || (ROWS.indexOf(a) - ROWS.indexOf(b));
  });
}
function renderBoard() {
  const rows = sortRows(filtered());
  $("#shown").textContent = rows.length + " shown";
  $("#boardtbl tbody").innerHTML = rows.map((r) => {
    const rank = ROWS.indexOf(r) + 1;
    return `<tr data-s="${r.s}"><td class="num">${rank}</td><td>${esc(r.n)}${r.w ? '<span class="wtag">watchlist</span>' : ""}</td>` +
      `<td>${esc(r.c)}</td><td class="num">${r.ch.length}</td><td class="num">${money(r.tvl)}</td>` +
      `<td class="num ${r.g === null ? "" : r.g >= 0 ? "pos" : "neg"}">${pct(r.g)}</td>` +
      `<td class="num"><b>${money(r.v)}</b></td><td class="num">${money(r.lo)} – ${money(r.hi)}</td>` +
      `<td><span class="dot ${r.cf}"></span> ${r.cf}</td></tr>`;
  }).join("");
  $("#boardtbl tbody").querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => { location.hash = "#detail/" + tr.dataset.s; }));
}
document.querySelectorAll("#boardtbl th").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.k;
  if (sortK === k) sortDir *= -1; else { sortK = k; sortDir = k === "n" || k === "c" ? 1 : -1; }
  renderBoard();
}));
["q", "fconf", "fchains", "fwatch"].forEach((id) => $("#" + id).addEventListener("input", renderBoard));
fcat.addEventListener("input", renderBoard);

function ruler(r) {
  const lo = Math.log10(r.lo), hi = Math.log10(r.hi), v = Math.log10(r.v);
  const pad = (hi - lo) * 0.35, a = lo - pad, b = hi + pad;
  const X = (x) => ((x - a) / (b - a) * 100).toFixed(1) + "%";
  return `<div class="ruler"><div class="fill" style="left:${X(lo)};width:${(X(hi).slice(0, -1) - X(lo).slice(0, -1)).toFixed(1)}%"></div>` +
    `<div class="pt" style="left:${X(v)}"></div><span style="left:${X(lo)}">${money(r.lo)}</span>` +
    `<span style="left:${X(v)};color:var(--tx)"><b>${money(r.v)}</b></span><span style="left:${X(hi)}">${money(r.hi)}</span></div>`;
}
function renderDetail(slug) {
  const r = ROWS.find((x) => x.s === slug) || ROWS[0];
  curSlug = r.s;
  const rank = ROWS.indexOf(r) + 1, c = Math.round((1 - (rank - 1) / ROWS.length) * 100);
  const peers = D.loo.filter((p) => p.category === r.c);
  $("#view-detail").innerHTML =
    `<h2>${esc(r.n)} <span class="muted">· ${esc(r.c)} · rank #${rank} of ${ROWS.length} (percentile ${c} by value)</span></h2>` +
    `<p class="muted">Chains: ${r.ch.map(esc).join(", ")} · TVL <span class="mono">${money(r.tvl)}</span> · 7d <span class="${r.g === null ? "" : r.g >= 0 ? "pos" : "neg"}">${pct(r.g)}</span> · Listed ${r.la || "unknown — age imputed"}${r.w ? ' · <span class="wtag">watchlist</span>' : ""}</p>` +
    `<div class="card"><span class="muted">Implied value if a token were issued on today's record</span><div class="big">$${commas(r.v)}</div>${ruler(r)}` +
    `<p class="muted" style="margin-top:22px">Calibration band ${money(r.lo)} – ${money(r.hi)} · Confidence: <span class="dot ${r.cf}"></span> ${r.cf}</p>` +
    (r.fl.length ? `<p>${r.fl.map((f) => `<span class="flag">${esc(f)}</span>`).join("")}</p>` : "") + `</div>` +
    `<div class="card"><h2 style="margin-top:0">Model breakdown</h2><div class="grid">` +
    [["E1 — category multiple", money(r.e1)], ["E2 — log regression", money(r.e2)], ["E3 — Huber regression", money(r.e3)],
     ["Category multiple (shrunk)", "×" + r.mult.toFixed(3)], ["β used by E1 (global)", r.beta.toFixed(3)],
     ["β category (fitted, not shipped)", r.bcat.toFixed(3)],
     ["E2 chain term", (r.cc >= 0 ? "+" : "") + r.cc.toFixed(3) + " log₁₀"],
     ["E2 age term", (r.ca >= 0 ? "+" : "") + r.ca.toFixed(3) + " log₁₀"],
     ["E2 growth term", (r.cg >= 0 ? "+" : "") + r.cg.toFixed(3) + " log₁₀"]]
      .map((x) => `<div class="kv"><b>${x[0]}</b><span class="mono">${x[1]}</span></div>`).join("") + `</div>` +
    `<p class="muted">Published value is the median of E1/E2/E3 in log space. Global fit: γ chain ${M.gamma}, δ age ${M.delta}, η growth ${M.eta}.</p></div>` +
    `<div class="card"><h2 style="margin-top:0">Farm plan — what a farmer does here</h2><ol class="steps">${r.st.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>` +
    `<div class="card"><h2 style="margin-top:0">Category peers — actual vs leave-one-out estimate</h2>` +
    (peers.length ? `<table><thead><tr><th>Peer</th><th>Actual mcap</th><th>LOO estimate</th><th>|log₁₀ err|</th></tr></thead><tbody>` +
      peers.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${money(p.actual_usd)}</td><td class="num">${money(p.loo_estimate_usd)}</td><td class="num">${p.abs_log10_error.toFixed(3)}</td></tr>`).join("") +
      `</tbody></table>` : `<p class="muted">No live-token peer in this category — this row is uncalibrated and uses global parameters.</p>`) + `</div>`;
}
function renderCal() {
  const pts = D.loo, W = 860, H = 520, P = 56;
  let mn = 1e18, mx = 0;
  pts.forEach((p) => { mn = Math.min(mn, p.actual_usd, p.loo_estimate_usd); mx = Math.max(mx, p.actual_usd, p.loo_estimate_usd); });
  const a = Math.floor(Math.log10(mn)), b = Math.ceil(Math.log10(mx));
  const X = (v) => P + (Math.log10(v) - a) / (b - a) * (W - 2 * P);
  const Y = (v) => H - P - (Math.log10(v) - a) / (b - a) * (H - 2 * P);
  const line = (f) => `<line x1="${X(Math.pow(10, a))}" y1="${Y(Math.pow(10, a) * f)}" x2="${X(Math.pow(10, b))}" y2="${Y(Math.pow(10, b) * f)}" stroke="${f === 1 ? "#00d4aa" : "#24314d"}" stroke-width="${f === 1 ? 2 : 1}"/>`;
  let grid = "";
  for (let e = a; e <= b; e++) grid += `<text x="${X(Math.pow(10, e))}" y="${H - P + 18}" text-anchor="middle">$1e${e}</text><text x="${P - 8}" y="${Y(Math.pow(10, e)) + 4}" text-anchor="end">$1e${e}</text>`;
  $("#scatter").innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:var(--sf);border:1px solid var(--bd);border-radius:10px">` +
    line(2) + line(1) + line(0.5) + grid +
    pts.map((p) => `<circle cx="${X(p.actual_usd).toFixed(1)}" cy="${Y(p.loo_estimate_usd).toFixed(1)}" r="3.5" fill="#00d4aa" fill-opacity="0.65"><title>${esc(p.name)}: actual ${money(p.actual_usd)}, LOO ${money(p.loo_estimate_usd)}</title></circle>`).join("") +
    `<text x="${W / 2}" y="${H - 8}" text-anchor="middle">actual market cap (log)</text><text x="14" y="${H / 2}" transform="rotate(-90 14 ${H / 2})" text-anchor="middle">LOO estimate (log)</text></svg>` +
    `<p class="muted">Median |log₁₀ error| ${M.medAbs} (×${M.medFactor.toFixed(2)}) · p75 ${M.p75} · p90 ${M.p90} · band quantile level ${M.level} · scaled coverage ${M.coverage.toFixed(1)}% · shipped: ${esc(M.shipped)}</p>`;
  $("#caltable").innerHTML = `<table><thead><tr><th>Category</th><th>Peers</th><th>Median |log₁₀ err|</th><th>Band coverage</th><th>β category</th></tr></thead><tbody>` +
    D.calCats.map((c) => `<tr><td>${esc(c.category)}</td><td class="num">${c.n}</td><td class="num">${c.median_abs_log10_error.toFixed(3)}</td><td class="num">${c.coverage_pct.toFixed(0)}%</td><td class="num">${c.beta_cat.toFixed(3)}</td></tr>`).join("") + `</tbody></table>`;
}
function route() {
  const h = location.hash || "#board";
  let view = "board";
  if (h.startsWith("#detail/")) { view = "detail"; renderDetail(decodeURIComponent(h.slice(9).split("?")[0])); }
  else if (h.startsWith("#cal")) { view = "cal"; if (!$("#scatter").innerHTML) renderCal(); }
  else {
    const qi = h.indexOf("?cat=");
    if (qi >= 0) { fcat.value = decodeURIComponent(h.slice(qi + 5)); renderBoard(); }
  }
  ["board", "detail", "cal"].forEach((v) => {
    $("#view-" + v).hidden = v !== view;
    document.querySelector(`.tab[data-view="${v}"]`).classList.toggle("on", v === view);
  });
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  location.hash = t.dataset.view === "detail" ? "#detail/" + curSlug : "#" + t.dataset.view;
}));
window.addEventListener("hashchange", route);
renderBoard();
route();
