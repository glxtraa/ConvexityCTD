const state = { basket: [], market: null, result: null, basketSource: "", marketAsOf: "" };
const $ = (id) => document.getElementById(id);
const number = (x, digits = 3) => Number.isFinite(Number(x)) ? Number(x).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : "—";
const pct = (x, digits = 1) => `${(100 * Number(x)).toFixed(digits)}%`;
const isoToday = () => new Date().toISOString().slice(0, 10);

function tenorYield(years, market) {
  const x = [10, 20, 30];
  const y = [market.dgs10, market.dgs20, market.dgs30];
  if (years <= x[0]) return y[0];
  if (years >= x[2]) return y[2];
  const i = years <= 20 ? 0 : 1;
  return y[i] + (y[i + 1] - y[i]) * ((years - x[i]) / (x[i + 1] - x[i]));
}

function realizedHorizonVol(points, field, endDate, deliveryDate) {
  const cutoff = new Date(endDate);
  const recent = points.filter((p) => new Date(p.date) <= cutoff).slice(-61);
  if (recent.length < 10) return field === "dgs20" ? 45 : 20;
  const changes = [];
  for (let i = 1; i < recent.length; i++) {
    const prev = field === "slope" ? recent[i - 1].dgs30 - recent[i - 1].dgs10 : recent[i - 1][field];
    const curr = field === "slope" ? recent[i].dgs30 - recent[i].dgs10 : recent[i][field];
    changes.push((curr - prev) * 100);
  }
  const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / (changes.length - 1);
  const horizon = Math.max(1 / 365, (new Date(deliveryDate) - new Date(endDate)) / (365.25 * 24 * 60 * 60 * 1000));
  return Math.sqrt(variance) * Math.sqrt(252 * horizon);
}

async function loadData() {
  const [basketResponse, marketResponse] = await Promise.all([
    fetch(`/api/basket/${encodeURIComponent($("delivery-month").value)}`),
    fetch("/api/market"),
  ]);
  if (!basketResponse.ok) throw new Error((await basketResponse.json()).error || "Unable to load CME basket");
  if (!marketResponse.ok) throw new Error((await marketResponse.json()).error || "Unable to load Treasury yields");
  const basketData = await basketResponse.json();
  const marketData = await marketResponse.json();
  state.basket = basketData.basket;
  state.basketSource = basketData.source;
  state.market = marketData.points;
  state.marketAsOf = marketData.as_of;
  $("market-asof").textContent = marketData.as_of;
  $("basket-status").textContent = `${state.basket.length} issues · ${basketData.source}`;
  $("data-source").textContent = `${marketData.source} · basket from ${basketData.source}`;
  seedYields();
  renderYieldChart();
  renderBasket();
  await calculate();
}

function seedYields() {
  const latest = state.market[state.market.length - 1];
  const valuation = isoToday();
  const delivery = `${$("delivery-month").value}-01`;
  state.basket = state.basket.map((b) => {
    const years = (new Date(b.maturity) - new Date(valuation)) / (365.25 * 24 * 60 * 60 * 1000);
    return { ...b, yield_pct: tenorYield(years, latest), yield_source: "Treasury curve proxy" };
  });
  const lv = realizedHorizonVol(state.market, "dgs20", valuation, delivery);
  const sv = realizedHorizonVol(state.market, "slope", valuation, delivery);
  $("level-vol").value = Math.max(1, Math.round(lv));
  $("slope-vol").value = Math.max(1, Math.round(sv));
}

function renderYieldChart() {
  const points = state.market;
  const traces = [
    { name: "10-year", y: points.map((p) => p.dgs10), line: { color: "#89a9bf", width: 1.4 } },
    { name: "20-year", y: points.map((p) => p.dgs20), line: { color: "#2878a8", width: 2 } },
    { name: "30-year", y: points.map((p) => p.dgs30), line: { color: "#43a88b", width: 1.4 } },
  ].map((t) => ({ ...t, x: points.map((p) => p.date), mode: "lines", type: "scatter", hovertemplate: "%{x|%d %b %Y}<br>%{y:.3f}%<extra>%{fullData.name}</extra>" }));
  Plotly.newPlot("yield-chart", traces, {
    margin: { l: 42, r: 15, t: 7, b: 35 }, paper_bgcolor: "transparent", plot_bgcolor: "transparent",
    font: { family: "DM Sans, sans-serif", color: "#718196", size: 9 }, hovermode: "x unified",
    xaxis: { showgrid: false, zeroline: false, tickfont: { size: 8 }, rangeslider: { visible: false } },
    yaxis: { title: { text: "%", font: { size: 9 } }, gridcolor: "#edf1f4", zeroline: false, tickfont: { size: 8 } },
    legend: { orientation: "h", y: 1.18, x: 0, font: { size: 9 } },
  }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}

function renderBasket() {
  const rows = state.result?.current_rows || [];
  const sortByCusip = rows.length ? rows : state.basket;
  $("bond-count").textContent = `${sortByCusip.length} eligible bonds`;
  $("basket-rows").innerHTML = sortByCusip.map((b) => {
    const isCtd = b.cusip === state.result?.current_ctd;
    return `<tr class="${isCtd ? "ctd-row" : ""}">
      <td>${b.cusip}${isCtd ? " · CTD" : ""}</td><td>${Number(b.coupon_pct).toFixed(3)}%</td><td>${b.maturity}</td>
      <td>${Number(b.conversion_factor).toFixed(4)}</td>
      <td><input class="yield-edit" aria-label="${b.cusip} yield percent" data-cusip="${b.cusip}" type="number" step="0.001" value="${Number(b.yield_pct).toFixed(3)}"></td>
      <td><span class="source-pill ${b.yield_source === "CUSIP quote" ? "upload" : ""}">${b.yield_source || "Treasury curve proxy"}</span></td>
      <td>${b.dirty_price == null ? "—" : number(b.dirty_price, 3)}</td><td>${b.adjusted_delivery_cost == null ? "—" : number(b.adjusted_delivery_cost, 3)}</td>
      <td>${b.net_basis_points == null ? "—" : number(b.net_basis_points, 1)}</td></tr>`;
  }).join("");
  document.querySelectorAll(".yield-edit").forEach((input) => input.addEventListener("change", () => {
    const bond = state.basket.find((b) => b.cusip === input.dataset.cusip);
    if (!bond) return;
    bond.yield_pct = Number(input.value);
    bond.yield_source = "CUSIP quote";
    calculate();
  }));
}

function requestPayload(overrides = {}) {
  const deliveryMonth = $("delivery-month").value;
  const valuationDate = isoToday();
  return {
    valuation_date: valuationDate,
    delivery_date: `${deliveryMonth}-01`,
    futures_price: Number($("futures-price").value),
    discount_rate_pct: Number($("discount-rate").value),
    level_vol_bp: Number($("level-vol").value),
    slope_vol_bp: Number($("slope-vol").value),
    correlation: Number($("correlation").value),
    n_scenarios: Number($("scenarios").value),
    basket: state.basket,
    ...overrides,
  };
}

async function callModel(payload) {
  const response = await fetch("/api/calculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Calculation failed");
  return result;
}

async function calculate() {
  const button = $("calculate");
  const error = $("calc-error");
  button.disabled = true;
  error.classList.remove("visible");
  try {
    const result = await callModel(requestPayload());
    state.result = result;
    renderResults();
    renderBasket();
    $("model-tag").textContent = `${result.model_version.toUpperCase()} · ${result.summary.scenario_count.toLocaleString()} SCENARIOS`;
  } catch (err) {
    error.textContent = err.message;
    error.classList.add("visible");
  } finally {
    button.disabled = false;
  }
}

function renderResults() {
  const result = state.result;
  const summary = result.summary;
  $("metric-ctd").textContent = result.current_ctd;
  $("metric-ctd-detail").textContent = `${number(result.current_ctd_adjusted_dirty_cost, 3)} adjusted dirty cost`;
  $("metric-option").textContent = `$${number(summary.option_pv_per_100_par, 4)}`;
  $("metric-switch").textContent = pct(summary.probability_current_ctd_is_not_cheapest);
  $("metric-diversity").textContent = result.ctd_probabilities.filter((p) => p.probability > 0.005).length;
  const candidates = result.ctd_probabilities.filter((p) => p.probability > 0).sort((a, b) => b.probability - a.probability);
  Plotly.newPlot("ctd-chart", [{
    type: "bar", x: candidates.map((p) => p.cusip), y: candidates.map((p) => 100 * p.probability),
    marker: { color: candidates.map((p) => p.cusip === result.current_ctd ? "#2c9b80" : "#5291b1") },
    hovertemplate: "%{x}<br>%{y:.1f}%<extra></extra>",
  }], { margin: { l: 40, r: 8, t: 7, b: 65 }, paper_bgcolor: "transparent", plot_bgcolor: "transparent",
    font: { family: "DM Sans, sans-serif", color: "#718196", size: 9 }, xaxis: { tickangle: -45, showgrid: false, tickfont: { size: 8 } },
    yaxis: { title: { text: "%", font: { size: 9 } }, gridcolor: "#edf1f4", rangemode: "tozero", tickfont: { size: 8 } } },
  { responsive: true, displaylogo: false });
  const hist = result.payoff_histogram;
  Plotly.newPlot("payoff-chart", [{
    type: "bar", x: hist.edges.slice(0, -1).map((x, i) => (x + hist.edges[i + 1]) / 2), y: hist.counts,
    width: hist.edges.slice(1).map((x, i) => x - hist.edges[i]), marker: { color: "#d28a51" },
    hovertemplate: "Payoff %{x:.3f}<br>Scenarios %{y}<extra></extra>",
  }], { margin: { l: 42, r: 8, t: 7, b: 40 }, paper_bgcolor: "transparent", plot_bgcolor: "transparent",
    font: { family: "DM Sans, sans-serif", color: "#718196", size: 9 }, xaxis: { title: { text: "$ / 100 par", font: { size: 9 } }, gridcolor: "#edf1f4", tickfont: { size: 8 } },
    yaxis: { title: { text: "Scenarios", font: { size: 9 } }, gridcolor: "#edf1f4", tickfont: { size: 8 } } },
  { responsive: true, displaylogo: false });
}

function downloadBasket() {
  const rows = state.result?.current_rows || state.basket;
  const columns = ["cusip", "coupon_pct", "issue_date", "maturity", "conversion_factor", "yield_pct", "yield_source", "clean_price", "dirty_price", "adjusted_delivery_cost", "net_basis_points"];
  const csv = [columns.join(","), ...rows.map((row) => columns.map((col) => row[col] ?? "").join(","))].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  link.download = `ZB_${$("delivery-month").value}_ctd_analysis.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

$("calculate").addEventListener("click", calculate);
$("download-csv").addEventListener("click", downloadBasket);
$("delivery-month").addEventListener("change", async () => {
  try { await loadData(); } catch (err) { $("calc-error").textContent = err.message; $("calc-error").classList.add("visible"); }
});
loadData().catch((err) => {
  $("market-asof").textContent = "Data unavailable";
  $("basket-status").textContent = "Check the deployment or data connection";
  $("basket-rows").innerHTML = `<tr><td colspan="9" class="loading-row">${err.message}</td></tr>`;
  $("calc-error").textContent = err.message;
  $("calc-error").classList.add("visible");
});
