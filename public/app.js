/* Analyzer Mac e Windows — trading manuale
   Motore statistico / Monte Carlo / Prop Simulator adattato dal vecchio
   Analyzer (NinjaTrader) alla registrazione manuale giorno-per-giorno.
   Nessuna dipendenza esterna: canvas disegnato a mano, fetch verso /api/*.
*/
(() => {
"use strict";

// ---------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const css = getComputedStyle(document.documentElement);
const cvar = name => css.getPropertyValue(name).trim();

function fmtMoney(v, opts={}) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  const sign = v < 0 ? "-" : (opts.plus ? "+" : "");
  return sign + "$" + Math.abs(v).toLocaleString("it-IT", {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtPct(v, digits=1) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toFixed(digits) + "%";
}
function fmtNum(v, digits=2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toFixed(digits);
}
function fmtR(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  if (v === 0) return "BE";
  return v.toFixed(2) + "R";
}
function partialsBadge(t) {
  if (!t.use_partials || !Array.isArray(t.partials) || !t.partials.length) return "";
  const detail = t.partials.map(p => `${Number(p.pct).toFixed(0)}%@${fmtR(Number(p.r))}`).join(", ");
  return ` <span class="pill" title="Parziali: ${escapeHtml(detail)}" style="cursor:help">P</span>`;
}
function fmtSample(v) {
  return v === "oos"
    ? '<span class="pill" style="color:var(--s2); border-color:var(--s2)">OOS</span>'
    : '<span class="pill" style="color:var(--s1); border-color:var(--s1)">IS</span>';
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function dowOf(dateStr) { return new Date(dateStr + "T00:00:00").getDay(); }
const MONTH_ABBR = ["Gen","Feb","Mar","Apr","Mag","Giu","Lug","Ago","Set","Ott","Nov","Dic"];
function fmtMonthLabel(key) {
  const [y,m] = key.split("-");
  return `${MONTH_ABBR[Number(m)-1]} '${y.slice(2)}`;
}
function monthKeyOf(dateStr) { return dateStr.slice(0,7); }
function isBusinessDay(dateStr) { const d = dowOf(dateStr); return d !== 0 && d !== 6; }

function toast(msg) {
  let el = $("#toastEl");
  if (!el) { el = document.createElement("div"); el.id = "toastEl"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.style.display = "none", 2600);
}

async function api(path, opts={}) {
  const res = await fetch(path, {
    headers: {"Content-Type": "application/json"},
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error || msg; } catch(_) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}
const apiGet = p => api(p);
const apiPost = (p,body) => api(p, {method:"POST", body: JSON.stringify(body)});
const apiPut = (p,body) => api(p, {method:"PUT", body: JSON.stringify(body)});
const apiDelete = p => api(p, {method:"DELETE"});

// Min/max senza spread: su array grandi (es. path Monte Carlo con decine di
// migliaia di punti) Math.max(...arr) supera lo stack limit del motore JS.
function arrMin(arr) { let m=Infinity; for (let i=0;i<arr.length;i++) if (arr[i]<m) m=arr[i]; return m; }
function arrMax(arr) { let m=-Infinity; for (let i=0;i<arr.length;i++) if (arr[i]>m) m=arr[i]; return m; }

function quantile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  if (sortedArr[base+1] !== undefined) return sortedArr[base] + rest * (sortedArr[base+1] - sortedArr[base]);
  return sortedArr[base];
}
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0; }
function stdev(arr, sample=true) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const sq = arr.reduce((a,b)=>a+(b-m)*(b-m),0);
  return Math.sqrt(sq / (arr.length - (sample?1:0)));
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--) { const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function wilsonCI(successes, n, z=1.96) {
  if (n === 0) return [0,0];
  const p = successes/n;
  const denom = 1 + z*z/n;
  const center = (p + z*z/(2*n)) / denom;
  const half = (z * Math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / denom;
  return [Math.max(0,center-half)*100, Math.min(1,center+half)*100];
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  backtests: [],
  currentId: null,
  current: null,
  trades: [],
  schemas: [],
  settings: {},
  presets: {futures:[], cfd:[]},
  selectedDate: todayStr(),
  dir: "long",
  sampleType: "is", // "is" (in-sample) o "oos" (out-of-sample)
  analisiFilter: "all", // "all" | "is" | "oos" — vista Analisi Dati
  schemaSel: null,
  instruments: [],
  instrumentSel: null,
  tradesCache: {}, // backtest_id -> trades[]
  sort: {allTrades: {key:"date", dir:1}},
  editingId: null,
  propCategory: "futures", // "futures" ($ fissi) o "cfd" (% sul conto)
  usePartials: false,
  partials: [], // [{pct, r}] — usati solo se usePartials è true
  chunkSize: 50,
  analisiFilteredTrades: [], // cache dei trade filtrati nella tab Analisi, per la Chunk Optimization
  analisiSection: "overview", // "overview" | "chunk" — sezione attiva nella tab Analisi Dati
};

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
$$("nav.tabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    $$("nav.tabs button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    $$(".tabpane").forEach(p=>p.classList.remove("active"));
    $("#tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "analisi") renderAnalisi();
    if (btn.dataset.tab === "mc") renderPickers("mcPicker");
    if (btn.dataset.tab === "prop") { renderPickers("propPicker", state.propPickerPersist); renderPresetSelect(); updateUnitLabels(); }
    if (btn.dataset.tab === "settings") renderSettings();
  });
});

// ---------------------------------------------------------------------
// Chart engine (canvas, no deps)
// ---------------------------------------------------------------------
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  // La larghezza va letta dal contenitore (.chart-wrap), non dal canvas
  // stesso: il canvas ha uno style.width inline impostato QUI SOTTO, quindi
  // il suo stesso getBoundingClientRect() rifletterebbe il valore scelto
  // all'ultimo disegno invece dello spazio realmente disponibile — un
  // contenitore temporaneamente stretto al primo render (es. durante il
  // layout iniziale) resterebbe altrimenti "bloccato" per sempre.
  const parent = canvas.parentElement;
  const w = Math.max(280, (parent && parent.clientWidth) || canvas.getBoundingClientRect().width || 400);
  const h = canvas.classList.contains("chart") ? 240 : (canvas.getBoundingClientRect().height || 240);
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.width = w + "px"; canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  return {ctx, w, h};
}
function niceTicks(min, max, count=5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  let step;
  if (norm < 1.5) step = 1*mag; else if (norm < 3) step = 2*mag; else if (norm < 7) step = 5*mag; else step = 10*mag;
  const niceMin = Math.floor(min/step)*step, niceMax = Math.ceil(max/step)*step;
  const ticks = [];
  for (let v=niceMin; v<=niceMax+1e-9; v+=step) ticks.push(v);
  return ticks;
}
const PAD = {l:58, r:14, t:12, b:22};

function drawFrame(ctx, w, h, yTicks, yFmt) {
  ctx.strokeStyle = cvar("--grid"); ctx.fillStyle = cvar("--muted");
  ctx.font = "11px system-ui"; ctx.lineWidth = 1;
  const min = yTicks[0], max = yTicks[yTicks.length-1];
  const y = v => PAD.t + (1 - (v-min)/(max-min || 1)) * (h-PAD.t-PAD.b);
  yTicks.forEach(t => {
    const yy = y(t);
    ctx.beginPath(); ctx.moveTo(PAD.l, yy); ctx.lineTo(w-PAD.r, yy); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(yFmt(t), PAD.l-8, yy);
  });
  ctx.strokeStyle = cvar("--baseline");
  ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, h-PAD.b); ctx.lineTo(w-PAD.r, h-PAD.b); ctx.stroke();
  return y;
}

function lineChart(canvas, points, opts={}) {
  const {ctx, w, h} = setupCanvas(canvas);
  if (!points.length) { emptyMsg(ctx,w,h); return; }
  const vals = points.map(p=>p.y);
  const yTicks = niceTicks(Math.min(0,...vals), Math.max(0,...vals), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v => opts.money ? "$"+Math.round(v).toLocaleString("it-IT") : v.toFixed(0));
  const n = points.length;
  const xFn = i => PAD.l + (n<=1?0:(i/(n-1)) * (w-PAD.l-PAD.r));
  if (opts.splitZero) {
    const zero = yFn(0);
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, PAD.t, w-PAD.l-PAD.r, zero-PAD.t); ctx.clip();
    drawFill(ctx, points, xFn, yFn, h, cvar("--good"));
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.l, zero, w-PAD.l-PAD.r, (h-PAD.b)-zero); ctx.clip();
    drawFill(ctx, points, xFn, yFn, h, cvar("--critical"));
    ctx.restore();
  } else {
    drawFill(ctx, points, xFn, yFn, h, opts.color || cvar("--s1"));
  }
  ctx.strokeStyle = opts.color || cvar("--s1"); ctx.lineWidth = 1.6;
  ctx.beginPath();
  points.forEach((p,i) => { const x=xFn(i), y=yFn(p.y); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.stroke();
  bindHover(canvas, points, xFn, opts.tip || (p=>fmtMoney(p.y)));
}
function drawFill(ctx, points, xFn, yFn, h, color) {
  ctx.beginPath();
  points.forEach((p,i) => { const x=xFn(i), y=yFn(p.y); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
  ctx.lineTo(xFn(points.length-1), h-PAD.b); ctx.lineTo(xFn(0), h-PAD.b); ctx.closePath();
  ctx.fillStyle = color + "22"; ctx.fill();
}

// Equity curve unica, ma colorata a segmenti in base a sampleType (In-Sample
// blu, Out-of-Sample arancio): l'equity NON riparte da zero al passaggio,
// continua esattamente da dove è arrivata l'In-Sample. Aggiunge anche una
// linea verticale tratteggiata nel punto di passaggio.
function sampleSplitChart(canvas, points, opts={}) {
  const {ctx, w, h} = setupCanvas(canvas);
  if (!points.length) { emptyMsg(ctx,w,h); return; }
  const vals = points.map(p=>p.y);
  const yTicks = niceTicks(Math.min(0,...vals), Math.max(0,...vals), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v => opts.money ? "$"+Math.round(v).toLocaleString("it-IT") : v.toFixed(0));
  const n = points.length;
  const xFn = i => PAD.l + (n<=1?0:(i/(n-1)) * (w-PAD.l-PAD.r));
  const colorFor = t => t==="oos" ? cvar("--s2") : cvar("--s1");

  // Disegna un segmento (riempimento + linea) alla volta, cambiando colore
  // quando cambia sampleType (il punto di congiunzione è condiviso da
  // entrambi i segmenti, così la linea resta continua senza salti).
  let segStart = 0;
  for (let i=1;i<=n;i++) {
    const changed = i===n || points[i].sampleType !== points[segStart].sampleType;
    if (changed) {
      const segPoints = points.slice(segStart, i);
      const segXFn = j => xFn(segStart + j);
      drawFill(ctx, segPoints, segXFn, yFn, h, colorFor(points[segStart].sampleType));
      ctx.strokeStyle = colorFor(points[segStart].sampleType); ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let j=segStart; j<i; j++) { const x=xFn(j), y=yFn(points[j].y); j===segStart?ctx.moveTo(x,y):ctx.lineTo(x,y); }
      ctx.stroke();
      segStart = i-1;
    }
  }

  const splitIdx = points.findIndex(p => p.sampleType==="oos");
  if (splitIdx > 0) {
    const x = xFn(splitIdx);
    ctx.save();
    ctx.setLineDash([4,4]); ctx.strokeStyle = cvar("--ink-2"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h-PAD.b); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = cvar("--muted"); ctx.font = "10px system-ui"; ctx.textAlign = "left";
    ctx.fillText("OOS →", x+4, PAD.t+10);
  }
  bindHover(canvas, points, xFn, opts.tip || (p=>`${fmtMoney(p.y)} (${p.sampleType==="oos"?"OOS":"IS"})`));
}
function barChart(canvas, cats, vals, opts={}) {
  const {ctx, w, h} = setupCanvas(canvas);
  if (!cats.length) { emptyMsg(ctx,w,h); return; }
  // Il colore della barra segue il segno di colorBy[i] se fornito (es. il
  // valore $ del bucket in un istogramma di conteggi, che è sempre >=0 e
  // quindi non potrebbe mai indicare da solo "negativo"); altrimenti segue
  // il segno del valore stesso (comportamento di default: pnl per barra).
  const colorRef = opts.colorBy || vals;
  const yTicks = niceTicks(Math.min(0,...vals), Math.max(0,...vals), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v => opts.money ? "$"+Math.round(v).toLocaleString("it-IT") : v.toFixed(0));
  const bw = (w-PAD.l-PAD.r) / cats.length;
  const zero = yFn(0);
  vals.forEach((v,i) => {
    const x = PAD.l + i*bw + bw*0.15;
    const y = yFn(v);
    ctx.fillStyle = colorRef[i]>=0 ? cvar("--good") : cvar("--critical");
    ctx.fillRect(x, Math.min(y,zero), bw*0.7, Math.abs(zero-y));
  });
  ctx.fillStyle = cvar("--muted"); ctx.font = "10px system-ui"; ctx.textAlign = "center";
  // Con molte barre le etichette si sovrappongono: ne salta quante bastano
  // a lasciare respiro, mostrando sempre la prima e l'ultima.
  const widest = cats.reduce((a,c) => Math.max(a, ctx.measureText(String(c)).width), 0);
  const stride = Math.max(1, Math.ceil((widest+10) / bw));
  cats.forEach((c,i) => {
    if (i % stride === 0 || i === cats.length-1) ctx.fillText(String(c), PAD.l + i*bw + bw/2, h-6);
  });
  bindHoverBars(canvas, cats, vals, PAD.l, bw, opts.tip || ((c,v)=>c+": "+fmtMoney(v)));
}
function donutChart(canvas, segs, opts={}) {
  const {ctx, w, h} = setupCanvas(canvas);
  const total = segs.reduce((a,s)=>a+s.value,0);
  if (!total) { emptyMsg(ctx,w,h); return; }
  const cx = w*0.32, cy = h/2, R = Math.min(w*0.28, h*0.42), r = R*0.6;
  let ang = -Math.PI/2;
  segs.forEach(s => {
    const frac = s.value/total, a2 = ang + frac*Math.PI*2;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,R,ang,a2); ctx.closePath();
    ctx.fillStyle = s.color; ctx.fill();
    ang = a2;
  });
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  if (opts.centerLabel) {
    ctx.fillStyle = cvar("--ink"); ctx.font = "600 18px system-ui";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(opts.centerLabel, cx, cy-7);
    if (opts.centerDetail) {
      ctx.fillStyle = cvar("--muted"); ctx.font = "11px system-ui";
      ctx.fillText(opts.centerDetail, cx, cy+12);
    }
  }
  let ly = cy - segs.length*9;
  ctx.font = "12px system-ui"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  segs.forEach(s => {
    ctx.fillStyle = s.color; ctx.fillRect(w*0.6, ly-6, 10, 10);
    ctx.fillStyle = cvar("--ink-2");
    ctx.fillText(`${s.label}: ${s.value} (${(s.value/total*100).toFixed(0)}%)`, w*0.6+16, ly);
    ly += 20;
  });
}
function emptyMsg(ctx,w,h) {
  ctx.fillStyle = cvar("--muted"); ctx.font = "13px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("Dati insufficienti", w/2, h/2);
}
function bindHover(canvas, points, xFn, tipFn) {
  const tip = $("#tooltip");
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best=0, bd=Infinity;
    points.forEach((p,i) => { const d=Math.abs(xFn(i)-mx); if (d<bd) { bd=d; best=i; } });
    const p = points[best];
    tip.style.display = "block";
    tip.style.left = (e.clientX+12)+"px"; tip.style.top = (e.clientY+12)+"px";
    tip.textContent = (p.label ? p.label+" — " : "") + tipFn(p);
  };
  canvas.onmouseleave = () => { tip.style.display = "none"; };
}
function bindHoverBars(canvas, cats, vals, left, bw, tipFn) {
  const tip = $("#tooltip");
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let i = Math.floor((mx-left)/bw);
    if (i<0 || i>=cats.length) { tip.style.display="none"; return; }
    tip.style.display = "block";
    tip.style.left = (e.clientX+12)+"px"; tip.style.top = (e.clientY+12)+"px";
    tip.textContent = tipFn(cats[i], vals[i]);
  };
  canvas.onmouseleave = () => { tip.style.display = "none"; };
}
function fanChart(canvas, paths, bands) {
  const {ctx, w, h} = setupCanvas(canvas);
  if (!paths.length) { emptyMsg(ctx,w,h); return; }
  const allVals = bands.p10.concat(bands.p90);
  const yTicks = niceTicks(Math.min(...allVals,0), Math.max(...allVals,0), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v => "$"+Math.round(v).toLocaleString("it-IT"));
  const steps = bands.p50.length;
  const xFn = i => PAD.l + (i/(steps-1)) * (w-PAD.l-PAD.r);
  ctx.strokeStyle = cvar("--s1")+"18"; ctx.lineWidth = 1;
  paths.slice(0,250).forEach(path => {
    ctx.beginPath();
    path.forEach((v,i) => { const x=xFn(i), y=yFn(v); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
  });
  const band = (arr,color,alpha) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
    arr.forEach((v,i) => { const x=xFn(i), y=yFn(v); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
  };
  band(bands.p10, cvar("--critical"));
  band(bands.p90, cvar("--good"));
  band(bands.p50, cvar("--s1"));
}

// ---------------------------------------------------------------------
// Backtests: load / select / create / delete
// ---------------------------------------------------------------------
async function loadBacktests(selectId=null) {
  state.backtests = await apiGet("/api/backtests");
  const sel = $("#btSelect");
  sel.innerHTML = "";
  if (!state.backtests.length) {
    sel.innerHTML = '<option value="">— nessun backtest —</option>';
  } else {
    state.backtests.forEach(b => {
      const opt = document.createElement("option");
      opt.value = b.id; opt.textContent = `${b.name} (${b.market_type.toUpperCase()}, ${b.trade_count} trade)`;
      sel.appendChild(opt);
    });
  }
  const lastId = state.settings.last_backtest_id;
  const lastStillExists = lastId && state.backtests.some(b=>b.id===lastId);
  const wanted = selectId || state.currentId || (lastStillExists ? lastId : (state.backtests[0] && state.backtests[0].id));
  if (wanted) { sel.value = wanted; await selectBacktest(wanted); }
  else { state.currentId = null; state.current = null; state.trades = []; renderBacktestTab(); }
}

async function selectBacktest(id) {
  id = Number(id);
  state.currentId = id;
  state.current = state.backtests.find(b => b.id === id) || null;
  if (!state.current) { state.trades = []; renderBacktestTab(); return; }
  state.trades = await apiGet(`/api/backtests/${id}/trades`);
  state.tradesCache[id] = state.trades;
  $("#btInfo").textContent = `${state.current.market_type.toUpperCase()} · conto $${Number(state.current.account_size).toLocaleString("it-IT")}`;
  renderBacktestTab();
  renderAnalisi();
  fillPropAccountFromBacktest();
}

$("#btSelect").addEventListener("change", async e => {
  await selectBacktest(e.target.value);
  state.settings.last_backtest_id = state.currentId;
  apiPost("/api/settings", {last_backtest_id: state.currentId}).catch(()=>{});
});

$("#btnNewBacktest").addEventListener("click", () => openModal(`
  <h3>Nuovo Backtest</h3>
  <div class="field"><label>Nome</label><input type="text" id="mName" placeholder="es. ORB manuale NQ"></div>
  <div class="field"><label>Tipo mercato</label>
    <select id="mMarket"><option value="futures">Futures</option><option value="cfd">CFD</option></select>
  </div>
  <div class="field"><label>Size account ($)</label><input type="number" id="mAccount" value="50000"></div>
  <div class="field"><label>Strumenti</label>
    <select id="mInstrumentMode">
      <option value="fixed">Strumento fisso</option>
      <option value="multi">Multi-strumento (scegli per ogni trade)</option>
    </select>
  </div>
  <div class="field" id="mInstrumentFixedWrap"><label>Strumento</label><input type="text" id="mInstrument" placeholder="es. NQ, EURUSD..."></div>
  <div class="field" style="color:var(--muted); font-size:12px" id="mInstrumentMultiHint">
    Userai la lista strumenti configurata in Impostazioni → Strumenti (aggiungine se non l'hai ancora fatto).
  </div>
  <div class="field"><label>Note</label><textarea id="mNotes"></textarea></div>
  <div class="actions">
    <button class="btn" id="mCancel">Annulla</button>
    <button class="btn primary" id="mCreate">Crea</button>
  </div>
`, () => {
  const syncMode = () => {
    const multi = $("#mInstrumentMode").value === "multi";
    $("#mInstrumentFixedWrap").classList.toggle("hidden", multi);
    $("#mInstrumentMultiHint").classList.toggle("hidden", !multi);
  };
  $("#mInstrumentMultiHint").classList.add("hidden");
  $("#mInstrumentMode").addEventListener("change", syncMode);
  $("#mCancel").onclick = closeModal;
  $("#mCreate").onclick = async () => {
    const name = $("#mName").value.trim();
    if (!name) { toast("Inserisci un nome"); return; }
    $("#mCreate").disabled = true;
    try {
      const b = await apiPost("/api/backtests", {
        name, market_type: $("#mMarket").value,
        account_size: Number($("#mAccount").value)||0,
        instrument_mode: $("#mInstrumentMode").value,
        instrument: $("#mInstrument").value, notes: $("#mNotes").value,
      });
      closeModal();
      await loadBacktests(b.id);
      toast("Backtest creato");
    } catch (err) {
      $("#mCreate").disabled = false;
      toast("Errore nella creazione: " + err.message);
    }
  };
}));

$("#btnDeleteBacktest").addEventListener("click", () => {
  if (!state.current) return;
  openModal(`
    <h3>Eliminare "${escapeHtml(state.current.name)}"?</h3>
    <p style="color:var(--muted)">Tutti i trade associati verranno eliminati. Azione non reversibile.</p>
    <div class="actions">
      <button class="btn" id="mCancel">Annulla</button>
      <button class="btn danger" id="mConfirm">Elimina</button>
    </div>
  `, () => {
    $("#mCancel").onclick = closeModal;
    $("#mConfirm").onclick = async () => {
      await apiDelete(`/api/backtests/${state.currentId}`);
      closeModal();
      state.currentId = null;
      await loadBacktests();
      toast("Backtest eliminato");
    };
  });
});

function openModal(html, after) {
  $("#modalRoot").innerHTML = `<div class="modal-backdrop" id="mBackdrop"><div class="modal">${html}</div></div>`;
  $("#mBackdrop").addEventListener("click", e => { if (e.target.id === "mBackdrop") closeModal(); });
  if (after) after();
}
function closeModal() { $("#modalRoot").innerHTML = ""; }
function escapeHtml(s) { return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

// ---------------------------------------------------------------------
// Backtest tab: quick entry + day table + all trades table
// ---------------------------------------------------------------------
function renderBacktestTab() {
  const has = !!state.current;
  $("#btEmpty").classList.toggle("hidden", has);
  $("#btContent").classList.toggle("hidden", !has);
  $("#btnDeleteBacktest").classList.toggle("hidden", !has);
  if (!has) return;
  $("#fDate").value = state.selectedDate;
  updateDayLabel();
  renderSchemaChips();
  $("#instrumentField").classList.toggle("hidden", state.current.instrument_mode !== "multi");
  renderInstrumentSelect();
  updateRiskHint();
  renderDayTable();
  renderAllTradesTable();
  renderBtSummary();
}

function renderSchemaChips() {
  const box = $("#schemaChips");
  box.innerHTML = "";
  const none = document.createElement("div");
  none.className = "chip" + (state.schemaSel===null ? " active" : "");
  none.textContent = "Nessuno";
  none.onclick = () => { state.schemaSel = null; renderSchemaChips(); };
  box.appendChild(none);
  state.schemas.forEach(s => {
    const chip = document.createElement("div");
    chip.className = "chip" + (state.schemaSel===s.id ? " active" : "");
    chip.style.borderColor = s.color;
    if (state.schemaSel===s.id) { chip.style.background = s.color; chip.style.color = "#fff"; }
    chip.textContent = s.name;
    chip.onclick = () => { state.schemaSel = s.id; renderSchemaChips(); };
    box.appendChild(chip);
  });
}

// Menù a tendina (come una convalida dati di Google Sheets): comodo quando
// sono configurati molti strumenti, a differenza dei chip che occupano spazio.
function renderInstrumentSelect() {
  const sel = $("#fInstrument");
  if (!sel) return;
  const cur = state.instrumentSel;
  sel.innerHTML = '<option value="">Nessuno</option>' +
    state.instruments.map(ins => `<option value="${ins.id}">${escapeHtml(ins.name)}</option>`).join("");
  sel.value = cur || "";
}
$("#fInstrument").addEventListener("change", () => {
  state.instrumentSel = $("#fInstrument").value ? Number($("#fInstrument").value) : null;
});
function instrumentName(id) {
  if (!id) return "—";
  const ins = state.instruments.find(x=>x.id===id);
  return ins ? ins.name : "—";
}

$$("#dirToggle button").forEach(b => b.addEventListener("click", () => {
  state.dir = b.dataset.dir;
  $$("#dirToggle button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
}));
$$("#sampleToggle button").forEach(b => b.addEventListener("click", () => {
  state.sampleType = b.dataset.sample;
  $$("#sampleToggle button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
}));

function updateRiskHint() {
  const acc = state.current ? Number(state.current.account_size)||0 : 0;
  const pct = Number($("#fRiskPct").value)||0;
  const amt = acc * pct/100;
  $("#riskHint").textContent = `= ${fmtMoney(amt)} su conto ${fmtMoney(acc)}`;
  updatePnlPreview();
}
function updatePnlPreview() {
  const acc = state.current ? Number(state.current.account_size)||0 : 0;
  const pct = Number($("#fRiskPct").value)||0;
  const amt = acc * pct/100;
  if (state.usePartials) {
    const res = computePartialsR(state.partials);
    if (res.valid) $("#fPnl").value = (amt*res.r).toFixed(2);
    $("#beHint").classList.add("hidden");
    return;
  }
  const r = Number($("#fR").value);
  $("#beHint").classList.toggle("hidden", $("#fR").value === "" || r !== 0);
  if (!isNaN(r)) $("#fPnl").value = (amt*r).toFixed(2);
}
$("#fRiskPct").addEventListener("input", updateRiskHint);
$("#fR").addEventListener("input", updatePnlPreview);

// ---------------------------------------------------------------------
// Parziali (TP multipli / breakeven parziale)
// ---------------------------------------------------------------------
// R complessivo = media dei R ottenuti su ogni tranche, pesata sulla % di
// posizione chiusa in quella tranche. Es: 50% a +1R, 25% a +2R, 25% a
// breakeven (0R) -> 0.5*1 + 0.25*2 + 0.25*0 = +1R. Corretto perché il P&L
// totale è proporzionale alla somma (dimensione_i * R_i), e l'R
// complessivo è quel totale diviso per la dimensione piena (100%).
function computePartialsR(partials) {
  if (!partials.length) return {valid:false, r:0, totalPct:0, error:"Aggiungi almeno un parziale"};
  let totalPct = 0;
  for (const p of partials) {
    const pct = Number(p.pct);
    if (p.pct === "" || isNaN(pct) || pct <= 0) return {valid:false, r:0, totalPct, error:"% non valida"};
    totalPct += pct;
  }
  if (Math.abs(totalPct - 100) > 0.01) {
    return {valid:false, r:0, totalPct, error:`Somma % = ${totalPct.toFixed(2)} (deve essere 100)`};
  }
  let r = 0;
  for (const p of partials) {
    const pct = Number(p.pct), pr = Number(p.r);
    if (p.r === "" || isNaN(pr)) return {valid:false, r:0, totalPct, error:"R non valido"};
    r += (pct/100) * pr;
  }
  return {valid:true, r, totalPct, error:null};
}

function renderPartialsEditor() {
  const wrap = $("#partialsRows");
  wrap.innerHTML = "";
  state.partials.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "partial-row";
    row.innerHTML = `<span class="p-idx">${i+1}.</span>
      <label>% chiusa</label>
      <input type="number" step="0.01" min="0" max="100" class="p-pct" value="${p.pct}">
      <label>R ottenuto</label>
      <input type="number" step="0.01" class="p-r" value="${p.r}">
      <button type="button" class="btn small danger p-remove">✕</button>`;
    row.querySelector(".p-pct").addEventListener("input", e => { p.pct = e.target.value; refreshPartialsSummary(); });
    row.querySelector(".p-r").addEventListener("input", e => { p.r = e.target.value; refreshPartialsSummary(); });
    row.querySelector(".p-remove").addEventListener("click", () => {
      state.partials.splice(i,1);
      renderPartialsEditor();
    });
    wrap.appendChild(row);
  });
  refreshPartialsSummary();
}
function refreshPartialsSummary() {
  const el = $("#partialsSummary");
  const res = computePartialsR(state.partials);
  if (res.valid) {
    el.textContent = `Totale % ${res.totalPct.toFixed(2)} → R complessivo: ${fmtR(res.r)}`;
    el.className = "partials-summary ok";
  } else {
    el.textContent = res.error;
    el.className = "partials-summary err";
  }
  updatePnlPreview();
}
function togglePartialsUI(on) {
  state.usePartials = on;
  $("#partialsBox").classList.toggle("hidden", !on);
  $("#fRWrap").classList.toggle("hidden", on);
  $("#fR").required = !on;
  if (on && !state.partials.length) { state.partials.push({pct:"", r:""}); }
  if (on) renderPartialsEditor();
  updatePnlPreview();
}
$("#fUsePartials").addEventListener("change", e => togglePartialsUI(e.target.checked));
$("#btnAddPartial").addEventListener("click", () => {
  state.partials.push({pct:"", r:""});
  renderPartialsEditor();
});

$("#datePrev").addEventListener("click", () => { state.selectedDate = addDays(state.selectedDate,-1); $("#fDate").value = state.selectedDate; updateDayLabel(); renderDayTable(); });
$("#dateNext").addEventListener("click", () => { state.selectedDate = addDays(state.selectedDate,1); $("#fDate").value = state.selectedDate; updateDayLabel(); renderDayTable(); });
$("#dateToday").addEventListener("click", () => { state.selectedDate = todayStr(); $("#fDate").value = state.selectedDate; updateDayLabel(); renderDayTable(); });
$("#fDate").addEventListener("change", e => { state.selectedDate = e.target.value; updateDayLabel(); renderDayTable(); });

function updateDayLabel() {
  $("#dayLabel").textContent = state.selectedDate;
}

// Invio esplicito su Enter in qualsiasi campo del form: alcuni browser/webview
// non attivano l'invio implicito nativo su input numerici, quindi lo forziamo.
$$("#entryForm input").forEach(inp => inp.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("#entryForm").requestSubmit(); }
}));

$("#entryForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!state.current) return;
  const acc = Number(state.current.account_size)||0;
  const riskPct = Number($("#fRiskPct").value)||0;
  const riskAmt = acc*riskPct/100;

  let r, partialsPayload = [];
  if (state.usePartials) {
    const res = computePartialsR(state.partials);
    if (!res.valid) { toast("Parziali: " + res.error); return; }
    r = res.r;
    partialsPayload = state.partials.map(p => ({pct: Number(p.pct), r: Number(p.r)}));
  } else {
    r = Number($("#fR").value);
    if (isNaN(r)) { toast("Inserisci il risultato in R"); return; }
  }
  const pnl = state.usePartials ? riskAmt*r : ($("#fPnl").value !== "" ? Number($("#fPnl").value) : riskAmt*r);
  const payload = {
    date: state.selectedDate, time: $("#fTime").value, direction: state.dir, schema_id: state.schemaSel,
    instrument_id: state.current.instrument_mode==="multi" ? state.instrumentSel : null,
    risk_percent: riskPct, risk_amount: riskAmt, r_multiple: r, sample_type: state.sampleType, pnl,
    use_partials: state.usePartials, partials: partialsPayload,
    notes: $("#fNotes").value,
  };
  try {
    if (state.editingId) {
      await apiPut(`/api/trades/${state.editingId}`, payload);
      exitEditMode();
    } else {
      await apiPost(`/api/backtests/${state.currentId}/trades`, payload);
      $("#fR").value = ""; $("#fPnl").value = ""; $("#fNotes").value = ""; $("#fTime").value = "";
      $("#beHint").classList.add("hidden");
      $("#fUsePartials").checked = false;
      togglePartialsUI(false);
      state.partials = [];
    }
    state.trades = await apiGet(`/api/backtests/${state.currentId}/trades`);
    state.tradesCache[state.currentId] = state.trades;
    await refreshBacktestRow();
    renderDayTable(); renderAllTradesTable(); renderBtSummary();
    $("#fR").focus();
  } catch(err) { toast("Errore: "+err.message); }
});

function loadTradeIntoForm(t) {
  state.editingId = t.id;
  state.selectedDate = t.date; $("#fDate").value = t.date; updateDayLabel();
  $("#fTime").value = t.time || "";
  state.dir = t.direction;
  $$("#dirToggle button").forEach(b => b.classList.toggle("active", b.dataset.dir===t.direction));
  state.sampleType = t.sample_type || "is";
  $$("#sampleToggle button").forEach(b => b.classList.toggle("active", b.dataset.sample===state.sampleType));
  state.schemaSel = t.schema_id; renderSchemaChips();
  state.instrumentSel = t.instrument_id; renderInstrumentSelect();
  $("#fRiskPct").value = t.risk_percent; updateRiskHint();
  $("#fR").value = t.r_multiple; $("#fPnl").value = t.pnl; $("#fNotes").value = t.notes||"";
  $("#beHint").classList.toggle("hidden", t.r_multiple !== 0);
  const hasPartials = !!(t.use_partials && Array.isArray(t.partials) && t.partials.length);
  state.partials = hasPartials ? t.partials.map(p => ({pct:p.pct, r:p.r})) : [];
  $("#fUsePartials").checked = hasPartials;
  togglePartialsUI(hasPartials);
  $("#btnSaveTrade").textContent = "Aggiorna trade";
  $("#cancelEditWrap").classList.remove("hidden");
  renderDayTable();
  $("#entryForm").scrollIntoView({behavior:"smooth", block:"start"});
  $("#fR").focus();
}
function exitEditMode() {
  state.editingId = null;
  $("#btnSaveTrade").textContent = "Salva trade";
  $("#cancelEditWrap").classList.add("hidden");
  $("#fR").value = ""; $("#fPnl").value = ""; $("#fNotes").value = ""; $("#fTime").value = "";
  state.partials = [];
  $("#fUsePartials").checked = false;
  togglePartialsUI(false);
}
$("#btnCancelEdit").addEventListener("click", () => { exitEditMode(); renderDayTable(); });

async function refreshBacktestRow() {
  const bts = await apiGet("/api/backtests");
  state.backtests = bts;
  state.current = bts.find(b=>b.id===state.currentId);
  const sel = $("#btSelect");
  const opt = Array.from(sel.options).find(o=>Number(o.value)===state.currentId);
  if (opt) opt.textContent = `${state.current.name} (${state.current.market_type.toUpperCase()}, ${state.current.trade_count} trade)`;
}

function schemaName(id) { const s = state.schemas.find(x=>x.id===id); return s ? s.name : "—"; }

function renderDayTable() {
  const rows = state.trades.filter(t=>t.date===state.selectedDate)
    .slice().sort((a,b) => (a.time||"99:99").localeCompare(b.time||"99:99"));
  const tbody = $("#dayTable tbody");
  tbody.innerHTML = "";
  let total = 0;
  rows.forEach(t => {
    total += t.pnl;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(t.time || "—")}</td>
      <td>${t.direction==="long"?"Long":"Short"}</td><td>${escapeHtml(schemaName(t.schema_id))}</td>
      <td>${escapeHtml(instrumentName(t.instrument_id))}</td>
      <td>${fmtPct(t.risk_percent)}</td><td>${fmtR(t.r_multiple)}${partialsBadge(t)}</td>
      <td class="${t.pnl>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(t.pnl,{plus:true})}</td>
      <td><button class="btn small" data-edit="${t.id}">✎</button></td>
      <td><button class="btn small danger" data-id="${t.id}">✕</button></td>`;
    tbody.appendChild(tr);
  });
  $("#dayTotal").textContent = rows.length ? fmtMoney(total,{plus:true}) : "";
  $("#dayTotal").className = "day-total " + (total>=0?"pnl-pos":"pnl-neg");
  $$("#dayTable button[data-id]").forEach(b => b.onclick = () => deleteTrade(Number(b.dataset.id)));
  $$("#dayTable button[data-edit]").forEach(b => b.onclick = () => {
    const t = state.trades.find(x=>x.id===Number(b.dataset.edit)); if (t) loadTradeIntoForm(t);
  });
}

async function deleteTrade(id) {
  if (state.editingId === id) exitEditMode();
  await apiDelete(`/api/trades/${id}`);
  state.trades = await apiGet(`/api/backtests/${state.currentId}/trades`);
  state.tradesCache[state.currentId] = state.trades;
  await refreshBacktestRow();
  renderDayTable(); renderAllTradesTable(); renderBtSummary(); renderAnalisi();
}

function renderAllTradesTable() {
  const key = state.sort.allTrades.key, dir = state.sort.allTrades.dir;
  const rows = state.trades.slice().sort((a,b) => {
    let av=a[key], bv=b[key];
    if (key==="schema") { av=schemaName(a.schema_id); bv=schemaName(b.schema_id); }
    if (key==="instrument") { av=instrumentName(a.instrument_id); bv=instrumentName(b.instrument_id); }
    if (typeof av === "string") return av.localeCompare(bv)*dir;
    return (av-bv)*dir;
  });
  $("#allCount").textContent = `(${rows.length})`;
  const tbody = $("#allTradesTable tbody");
  tbody.innerHTML = "";
  rows.forEach(t => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${t.date}</td><td>${escapeHtml(t.time || "—")}</td><td>${t.direction==="long"?"Long":"Short"}</td>
      <td>${fmtSample(t.sample_type)}</td>
      <td>${escapeHtml(schemaName(t.schema_id))}</td>
      <td>${escapeHtml(instrumentName(t.instrument_id))}</td>
      <td>${fmtPct(t.risk_percent)}</td>
      <td>${fmtMoney(t.risk_amount)}</td><td>${fmtR(t.r_multiple)}${partialsBadge(t)}</td>
      <td class="${t.pnl>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(t.pnl,{plus:true})}</td>
      <td>${escapeHtml(t.notes||"")}</td>
      <td><button class="btn small" data-edit="${t.id}">✎</button></td>
      <td><button class="btn small danger" data-id="${t.id}">✕</button></td>`;
    tbody.appendChild(tr);
  });
  $$("#allTradesTable button[data-id]").forEach(b => b.onclick = () => deleteTrade(Number(b.dataset.id)));
  $$("#allTradesTable button[data-edit]").forEach(b => b.onclick = () => {
    const t = state.trades.find(x=>x.id===Number(b.dataset.edit)); if (t) loadTradeIntoForm(t);
  });
}
$$("#allTradesTable th[data-k]").forEach(th => th.addEventListener("click", () => {
  const k = th.dataset.k;
  const s = state.sort.allTrades;
  s.dir = (s.key===k) ? -s.dir : 1;
  s.key = k;
  renderAllTradesTable();
}));

function renderBtSummary() {
  const stats = computeStats(state.trades);
  const grid = $("#btSummaryGrid");
  grid.innerHTML = "";
  const items = [
    ["Net profit", fmtMoney(stats.netProfit,{plus:true}), stats.netProfit>=0],
    ["Trade totali", stats.n, true],
    ["Win rate", fmtPct(stats.winRate), stats.winRate>=50],
    ["Profit factor", stats.pf===Infinity?"∞":fmtNum(stats.pf), stats.pf>=1],
    ["Giorni di trading", stats.tradingDays, true],
    ["Max drawdown", fmtMoney(stats.maxDD), false],
  ];
  items.forEach(([label,val,pos]) => {
    const div = document.createElement("div"); div.className = "kpi";
    div.innerHTML = `<div class="label">${label}</div><div class="value ${pos?'pos':'neg'}">${val}</div>`;
    grid.appendChild(div);
  });
}

function fillPropAccountFromBacktest() {
  if (state.current) $("#pAccount").value = state.current.account_size;
}

// ---------------------------------------------------------------------
// Stats engine (adattato da computeStats del vecchio Analyzer)
// ---------------------------------------------------------------------
function computeStats(trades) {
  const list = trades.slice().sort((a,b) => a.date.localeCompare(b.date) || a.id-b.id);
  const n = list.length;
  const empty = {n:0, netProfit:0, gp:0, gl:0, pf:0, winRate:0, avgTrade:0, avgWin:0, avgLoss:0,
    payoff:0, maxDD:0, maxW:0, maxL:0, daily:{}, dow:{}, month:{}, hour:{}, weekOfMonth:{}, tradingDays:0, avgDay:0,
    sharpe:0, sortino:0, top5Share:0, avgR:0, long:{n:0,pnl:0,winRate:0,pf:0}, short:{n:0,pnl:0,winRate:0,pf:0},
    bySchema:{}, byInstrument:{}, equitySeries:[], ddSeries:[], beCount:0, outcomes:{profit:0, loss:0, be:0}};
  if (!n) return empty;

  let eq=0, peak=0, maxDD=0, gp=0, gl=0, wins=0, losses=0, curW=0, curL=0, maxW=0, maxL=0;
  let beCount=0, rSumAll=0;
  const outcomes = {profit:0, loss:0, be:0};
  const daily={}, dow={}, month={}, hour={}, weekOfMonth={}, equitySeries=[], ddSeries=[];
  const bySchema = {}, byInstrument = {};
  list.forEach(t => {
    eq += t.pnl;
    rSumAll += (t.r_multiple||0);
    if ((t.r_multiple||0) === 0) beCount++;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq-peak);
    if (t.pnl>0) { gp+=t.pnl; wins++; curW++; curL=0; maxW=Math.max(maxW,curW); }
    else if (t.pnl<0) { gl+=t.pnl; losses++; curL++; curW=0; maxL=Math.max(maxL,curL); }
    if (t.pnl > 0) outcomes.profit++;
    else if (t.pnl < 0) outcomes.loss++;
    else outcomes.be++;
    equitySeries.push({label:t.date, y:eq, sampleType:t.sample_type||"is"});
    ddSeries.push({label:t.date, y:eq-peak, sampleType:t.sample_type||"is"});
    (daily[t.date] ??= {pnl:0,n:0,wins:0}); daily[t.date].pnl+=t.pnl; daily[t.date].n++; if(t.pnl>0) daily[t.date].wins++;
    const dw = dowOf(t.date);
    (dow[dw] ??= {pnl:0,n:0,wins:0}); dow[dw].pnl+=t.pnl; dow[dw].n++; if(t.pnl>0) dow[dw].wins++;
    const mk = monthKeyOf(t.date);
    (month[mk] ??= {pnl:0,n:0,wins:0}); month[mk].pnl+=t.pnl; month[mk].n++; if(t.pnl>0) month[mk].wins++;
    // Settimana del mese (1-4, aggregata su tutti i mesi): giorno 1-7 -> 1,
    // 8-14 -> 2, 15-21 -> 3, 22-fine mese -> 4.
    const wk = Math.min(4, Math.ceil(Number(t.date.slice(8,10)) / 7));
    (weekOfMonth[wk] ??= {pnl:0,n:0,wins:0}); weekOfMonth[wk].pnl+=t.pnl; weekOfMonth[wk].n++; if(t.pnl>0) weekOfMonth[wk].wins++;
    if (t.time) {
      const hk = Number(t.time.split(":")[0]);
      if (!isNaN(hk)) {
        (hour[hk] ??= {pnl:0,n:0,wins:0}); hour[hk].pnl+=t.pnl; hour[hk].n++; if(t.pnl>0) hour[hk].wins++;
      }
    }
    const sk = t.schema_id ?? "none";
    (bySchema[sk] ??= {n:0,pnl:0,wins:0,gp:0,gl:0,rSum:0});
    const bs = bySchema[sk];
    bs.n++; bs.pnl+=t.pnl; bs.rSum += (t.r_multiple||0);
    if (t.pnl>0) { bs.wins++; bs.gp+=t.pnl; } else if (t.pnl<0) bs.gl+=t.pnl;
    const ik = t.instrument_id ?? "none";
    (byInstrument[ik] ??= {n:0,pnl:0,wins:0,gp:0,gl:0,rSum:0});
    const bi = byInstrument[ik];
    bi.n++; bi.pnl+=t.pnl; bi.rSum += (t.r_multiple||0);
    if (t.pnl>0) { bi.wins++; bi.gp+=t.pnl; } else if (t.pnl<0) bi.gl+=t.pnl;
  });
  Object.values(bySchema).forEach(bs => {
    bs.winRate = 100*bs.wins/bs.n;
    bs.pf = bs.gl<0 ? bs.gp/-bs.gl : (bs.gp>0?Infinity:0);
    bs.avgR = bs.rSum/bs.n;
  });
  Object.values(byInstrument).forEach(bi => {
    bi.winRate = 100*bi.wins/bi.n;
    bi.pf = bi.gl<0 ? bi.gp/-bi.gl : (bi.gp>0?Infinity:0);
    bi.avgR = bi.rSum/bi.n;
  });

  const dayKeys = Object.keys(daily);
  const dailyVals = dayKeys.map(k=>daily[k].pnl);
  const avgDay = mean(dailyVals);
  const sdDay = stdev(dailyVals, true);
  const sharpe = sdDay ? (avgDay/sdDay)*Math.sqrt(252) : 0;
  const lossDays = dailyVals.filter(v=>v<0);
  const downsideSd = lossDays.length ? Math.sqrt(mean(lossDays.map(v=>v*v))) : 0;
  const sortino = downsideSd ? (avgDay/downsideSd)*Math.sqrt(252) : 0;

  const sortedPnl = list.map(t=>t.pnl).slice().sort((a,b)=>b-a);
  const top5n = Math.max(1, Math.round(n*0.05));
  const top5Share = gp>0 ? 100*sortedPnl.slice(0,top5n).reduce((a,b)=>a+Math.max(0,b),0)/gp : 0;

  function dirStats(dirName) {
    const rows = list.filter(t=>t.direction===dirName);
    const g = rows.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0);
    const l = rows.filter(t=>t.pnl<0).reduce((a,t)=>a+t.pnl,0);
    return {
      n: rows.length,
      pnl: rows.reduce((a,t)=>a+t.pnl,0),
      winRate: rows.length ? 100*rows.filter(t=>t.pnl>0).length/rows.length : 0,
      pf: l<0 ? g/-l : (g>0?Infinity:0),
    };
  }

  return {
    n, netProfit: eq, gp, gl, pf: gl<0 ? gp/-gl : (gp>0?Infinity:0),
    winRate: 100*wins/n, avgTrade: eq/n, avgWin: wins?gp/wins:0, avgLoss: losses?gl/losses:0,
    payoff: (losses && gl<0) ? (gp/wins)/(-gl/losses) : 0,
    maxDD, maxW, maxL, daily, dow, month, hour, weekOfMonth, tradingDays: dayKeys.length, avgDay, sharpe, sortino,
    top5Share, avgR: rSumAll/n, long: dirStats("long"), short: dirStats("short"), bySchema, byInstrument, equitySeries, ddSeries,
    beCount, outcomes,
  };
}

// ---------------------------------------------------------------------
// Analisi Dati tab
// ---------------------------------------------------------------------
function renderAnalisi() {
  const has = state.current && state.trades.length>0;
  $("#anEmpty").classList.toggle("hidden", has);
  $("#anContent").classList.toggle("hidden", !has);
  if (!has) return;

  const filter = state.analisiFilter;
  const filteredTrades = filter==="all" ? state.trades : state.trades.filter(t => (t.sample_type||"is")===filter);
  state.analisiFilteredTrades = filteredTrades;

  const isChunk = state.analisiSection === "chunk";
  $("#anOverview").classList.toggle("hidden", isChunk);
  $("#anChunkSection").classList.toggle("hidden", !isChunk);
  if (isChunk) { renderChunkSection(); return; }

  const hasOOS = state.trades.some(t => t.sample_type==="oos");
  $("#analisiFilterHint").textContent = hasOOS
    ? (filter==="all" ? "Curva unica: blu = In-Sample, arancio = Out-of-Sample, dalla linea in poi." : "")
    : "Nessun trade Out-of-Sample ancora — segna dei trade come Out-of-Sample nel form di inserimento per usare questa vista.";
  const s = computeStats(filteredTrades);

  const grid = $("#kpiGrid"); grid.innerHTML = "";
  const kpis = [
    ["Net profit", fmtMoney(s.netProfit,{plus:true}), s.netProfit>=0],
    ["Profit factor", s.pf===Infinity?"∞":fmtNum(s.pf), s.pf>=1],
    ["Win rate", fmtPct(s.winRate), s.winRate>=50],
    ["Trade totali", s.n, true],
    ["Avg trade", fmtMoney(s.avgTrade,{plus:true}), s.avgTrade>=0],
    ["Avg win / loss", `<span class="pnl-pos">${fmtMoney(s.avgWin)}</span> / <span class="pnl-neg">${fmtMoney(s.avgLoss)}</span>`, null],
    ["Payoff ratio", fmtNum(s.payoff), s.payoff>=1],
    ["Max drawdown", fmtMoney(s.maxDD), false],
    ["Max win/loss streak", `${s.maxW} / ${s.maxL}`, true],
    ["Giorni di trading", s.tradingDays, true],
    ["Avg P&L giornaliero", fmtMoney(s.avgDay,{plus:true}), s.avgDay>=0],
    ["Sharpe (ann.)", fmtNum(s.sharpe), s.sharpe>=0],
    ["Sortino (ann.)", fmtNum(s.sortino), s.sortino>=0],
    ["Top 5% share profitto", fmtPct(s.top5Share), true],
  ];
  if (s.beCount > 0) {
    kpis.push(["Trade in Breakeven", s.beCount, "be"]);
  }
  kpis.forEach(([label,val,status]) => {
    const div = document.createElement("div"); div.className="kpi";
    const valueClass = status === "be" ? "be" : (status ? "pos" : (status === null ? "" : "neg"));
    div.innerHTML = `<div class="label">${label}</div><div class="value ${valueClass}">${val}</div>`;
    grid.appendChild(div);
  });

  if (filter==="all" && hasOOS) {
    sampleSplitChart($("#chEquity"), s.equitySeries, {money:true});
    $("#equityLegend").innerHTML = '<span style="color:var(--s1)">■</span> In-Sample &nbsp; <span style="color:var(--s2)">■</span> Out-of-Sample';
  } else {
    lineChart($("#chEquity"), s.equitySeries, {money:true, splitZero:false, color: filter==="oos"?cvar("--s2"):cvar("--s1")});
    $("#equityLegend").textContent = "";
  }
  lineChart($("#chDrawdown"), s.ddSeries, {money:true, color: cvar("--critical")});

  const pnls = filteredTrades.map(t=>t.pnl);
  const buckets = 14;
  if (pnls.length) {
    const min = Math.min(...pnls), max = Math.max(...pnls);
    const w = (max-min)/buckets || 1;
    const counts = new Array(buckets).fill(0);
    pnls.forEach(v => { let i = Math.floor((v-min)/w); if (i>=buckets) i=buckets-1; if(i<0)i=0; counts[i]++; });
    const cats = counts.map((_,i) => Math.round(min+i*w));
    barChart($("#chHist"), cats, counts, {colorBy: cats, tip:(c,v)=>`~$${c}: ${v} trade`});
  } else barChart($("#chHist"), [], []);

  const dowNames = ["Dom","Lun","Mar","Mer","Gio","Ven","Sab"];
  const dowCats = [1,2,3,4,5].filter(d=>s.dow[d]).map(d=>dowNames[d]);
  const dowVals = [1,2,3,4,5].filter(d=>s.dow[d]).map(d=>s.dow[d].pnl);
  barChart($("#chDow"), dowCats, dowVals, {money:true});

  const monthKeys = Object.keys(s.month).sort();
  const monthCats = monthKeys.map(fmtMonthLabel);
  const monthVals = monthKeys.map(k=>s.month[k].pnl);
  barChart($("#chMonth"), monthCats, monthVals, {money:true});

  const hourKeys = Object.keys(s.hour).map(Number).sort((a,b)=>a-b);
  const hourCats = hourKeys.map(h=>String(h).padStart(2,"0")+":00");
  const hourVals = hourKeys.map(h=>s.hour[h].pnl);
  barChart($("#chHour"), hourCats, hourVals, {money:true, tip:(c,v) => {
    const h = hourKeys[hourCats.indexOf(c)];
    const hs = s.hour[h];
    return `${c} — ${fmtMoney(v,{plus:true})} (${hs.n} trade, WR ${fmtPct(100*hs.wins/hs.n)})`;
  }});

  const womCats = [1,2,3,4].map(w=>`Sett. ${w}`);
  const womVals = [1,2,3,4].map(w => s.weekOfMonth[w] ? s.weekOfMonth[w].pnl : 0);
  barChart($("#chWeekOfMonth"), womCats, womVals, {money:true, tip:(c,v) => {
    const w = [1,2,3,4][womCats.indexOf(c)];
    const ws = s.weekOfMonth[w];
    if (!ws) return `${c}: nessun trade`;
    return `${c} — ${fmtMoney(v,{plus:true})} (${ws.n} trade, WR ${fmtPct(100*ws.wins/ws.n)})`;
  }});

  donutChart($("#chLS"), [
    {label:`Long (${s.long.n})`, value: Math.max(0,s.long.n), color: cvar("--s1")},
    {label:`Short (${s.short.n})`, value: Math.max(0,s.short.n), color: cvar("--s2")},
  ]);

  const outcomeTotal = s.outcomes.profit + s.outcomes.loss + s.outcomes.be;
  $("#chOutcome").setAttribute("aria-label", `Esito di ${outcomeTotal} trade: ${s.outcomes.profit} in profitto, ${s.outcomes.loss} in loss, ${s.outcomes.be} in breakeven`);
  donutChart($("#chOutcome"), [
    {label:"Profitto", value:s.outcomes.profit, color:cvar("--good")},
    {label:"Loss", value:s.outcomes.loss, color:cvar("--critical")},
    {label:"Breakeven", value:s.outcomes.be, color:cvar("--warning")},
  ], {centerLabel:String(outcomeTotal), centerDetail:"trade"});

  const tbody = $("#schemaStatsTable tbody"); tbody.innerHTML = "";
  Object.entries(s.bySchema).forEach(([sid, bs]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(sid==="none"?"Nessuno":schemaName(Number(sid)))}</td><td>${bs.n}</td>
      <td>${fmtPct(bs.winRate)}</td><td>${bs.pf===Infinity?"∞":fmtNum(bs.pf)}</td>
      <td>${fmtNum(bs.avgR)}R</td><td class="${bs.pnl>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(bs.pnl,{plus:true})}</td>`;
    tbody.appendChild(tr);
  });

  const isMulti = state.current.instrument_mode === "multi";
  $("#instrumentStatsCard").classList.toggle("hidden", !isMulti);
  if (isMulti) {
    const itbody = $("#instrumentStatsTable tbody"); itbody.innerHTML = "";
    Object.entries(s.byInstrument).forEach(([iid, bi]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(iid==="none"?"Nessuno":instrumentName(Number(iid)))}</td><td>${bi.n}</td>
        <td>${fmtPct(bi.winRate)}</td><td>${bi.pf===Infinity?"∞":fmtNum(bi.pf)}</td>
        <td>${fmtNum(bi.avgR)}R</td><td class="${bi.pnl>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(bi.pnl,{plus:true})}</td>`;
      itbody.appendChild(tr);
    });
  }
}

// ---------------------------------------------------------------------
// Chunk Optimization: divide i trade (in ordine cronologico) in blocchi
// da N trade ciascuno e mostra le statistiche di ogni blocco, per vedere
// se la performance è consistente o degrada nel tempo.
// ---------------------------------------------------------------------
function renderChunkSection() {
  const trades = state.analisiFilteredTrades || [];
  const list = trades.slice().sort((a,b) => a.date.localeCompare(b.date) || a.id-b.id);
  const tbody = $("#chunkTable tbody"); tbody.innerHTML = "";
  if (!list.length) {
    $("#chunkHint").textContent = "";
    barChart($("#chChunk"), [], []);
    return;
  }
  const size = Math.max(1, Math.floor(Number($("#chunkSize").value) || 1));
  const chunks = [];
  for (let i=0; i<list.length; i+=size) chunks.push(list.slice(i, i+size));
  $("#chunkHint").textContent = `${chunks.length} chunk` +
    (chunks[chunks.length-1].length !== size ? ` (l'ultimo ha ${chunks[chunks.length-1].length} trade)` : "");

  const cats = [], vals = [];
  chunks.forEach((slice, idx) => {
    const cs = computeStats(slice);
    cats.push(`#${idx+1}`);
    vals.push(cs.netProfit);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>#${idx+1}</td><td>${slice[0].date} → ${slice[slice.length-1].date}</td>
      <td>${slice.length}</td><td>${fmtPct(cs.winRate)}</td>
      <td>${cs.pf===Infinity?"∞":fmtNum(cs.pf)}</td><td>${fmtNum(cs.avgR)}R</td>
      <td class="${cs.netProfit>=0?'pnl-pos':'pnl-neg'}">${fmtMoney(cs.netProfit,{plus:true})}</td>`;
    tbody.appendChild(tr);
  });
  barChart($("#chChunk"), cats, vals, {money:true, tip:(c,v)=>`Chunk ${c}: ${fmtMoney(v,{plus:true})}`});
}
$("#chunkSize").addEventListener("input", renderChunkSection);

$$("#analisiSectionToggle button").forEach(b => b.addEventListener("click", () => {
  state.analisiSection = b.dataset.section;
  $$("#analisiSectionToggle button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  renderAnalisi();
}));

$$("#analisiFilterToggle button").forEach(b => b.addEventListener("click", () => {
  state.analisiFilter = b.dataset.filter;
  $$("#analisiFilterToggle button").forEach(x=>x.classList.remove("active"));
  b.classList.add("active");
  renderAnalisi();
}));

// ---------------------------------------------------------------------
// Portfolio picker (multi-backtest, per MC e Prop)
// ---------------------------------------------------------------------
async function ensureTradesLoaded(id) {
  if (!state.tradesCache[id]) state.tradesCache[id] = await apiGet(`/api/backtests/${id}/trades`);
  return state.tradesCache[id];
}
function renderPickers(id, persisted) {
  const box = $("#"+id);
  box.innerHTML = "";
  state.backtests.forEach(b => {
    const checked = persisted ? persisted.ids.includes(b.id) : b.id===state.currentId;
    const mult = (persisted && persisted.mults && persisted.mults[b.id]!=null) ? persisted.mults[b.id] : 1;
    const row = document.createElement("div"); row.className = "picker-row";
    row.innerHTML = `<input type="checkbox" data-bid="${b.id}" ${checked?"checked":""}>
      <span class="name">${escapeHtml(b.name)} <small style="color:var(--muted)">(${b.trade_count} trade)</small></span>
      moltiplicatore <input type="number" step="0.1" value="${mult}" data-mult="${b.id}" style="width:60px">`;
    box.appendChild(row);
  });
}
function readPickerRaw(pickerId) {
  const box = $("#"+pickerId);
  const ids = []; const mults = {};
  $$(".picker-row", box).forEach(row => {
    const cb = $("input[type=checkbox]", row);
    const bid = Number(cb.dataset.bid);
    if (cb.checked) ids.push(bid);
    const mEl = $(`input[data-mult="${bid}"]`, row);
    if (mEl) mults[bid] = mEl.value;
  });
  return {ids, mults};
}
async function getSelection(pickerId) {
  const box = $("#"+pickerId);
  const rows = $$(".picker-row", box);
  const sel = [];
  for (const row of rows) {
    const cb = $("input[type=checkbox]", row);
    if (!cb.checked) continue;
    const bid = Number(cb.dataset.bid);
    const mult = Number($(`input[data-mult="${bid}"]`, row).value) || 1;
    const trades = await ensureTradesLoaded(bid);
    sel.push({bid, mult, trades});
  }
  return sel;
}
// Combina più backtest: somma i P&L per giorno (le giornate sovrapposte si sommano).
function buildCombinedDayMap(selection) {
  const dayMap = {};
  selection.forEach(({mult, trades}) => {
    trades.forEach(t => {
      (dayMap[t.date] ??= {pnl:0, seq:[]});
      dayMap[t.date].pnl += t.pnl*mult;
      dayMap[t.date].seq.push({pnl: t.pnl*mult});
    });
  });
  return dayMap;
}
function combinedTradePnls(selection) {
  const out = [];
  selection.forEach(({mult, trades}) => trades.forEach(t => out.push(t.pnl*mult)));
  return out;
}
function buildFullDayPool(dayMap) {
  const keys = Object.keys(dayMap).sort();
  if (!keys.length) return [];
  const pool = [];
  let cur = keys[0];
  const last = keys[keys.length-1];
  while (cur <= last) {
    if (isBusinessDay(cur)) pool.push(dayMap[cur] ? {date:cur, ...dayMap[cur]} : {date:cur, pnl:0, seq:[]});
    cur = addDays(cur,1);
  }
  return pool;
}

// ---------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------
$("#btnMC").addEventListener("click", async () => {
  const sel = await getSelection("mcPicker");
  if (!sel.length) { toast("Seleziona almeno una strategia"); return; }
  const dayMap = buildCombinedDayMap(sel);
  const tradePool = combinedTradePnls(sel);
  const dayPoolVals = Object.values(dayMap).map(d=>d.pnl);
  const unit = $("#mcUnit").value;
  const method = $("#mcMethod").value;
  const sims = Math.max(200, Math.min(20000, Number($("#mcSims").value)||2000));
  const pool = unit==="trade" ? tradePool : dayPoolVals;
  if (pool.length < 3) { toast("Servono più dati per la simulazione"); return; }
  runMC(pool, method, sims, tradePool);
});

function runMC(pool, method, sims, tradePoolForEV) {
  const n = pool.length;
  const CK = Math.min(n, 150);
  const checkpoints = Array.from({length:CK}, (_,i) => Math.round((i+1)*n/CK));
  const horizonsAll = [10,20,40,100,200,500,1000,2000,n];
  const horizons = [...new Set(horizonsAll.filter(h=>h<=n))];
  const finals = [], dds = [];
  const bandsAtCk = checkpoints.map(()=>[]);
  const horizonEq = {}; horizons.forEach(h=>horizonEq[h]=[]);
  const paths = [];
  const totalReal = pool.reduce((a,b)=>a+b,0);

  for (let s=0; s<sims; s++) {
    const seq = method==="reshuffle" ? shuffle(pool) : Array.from({length:n}, ()=>pool[(Math.random()*n)|0]);
    let eq=0, peak=0, dd=0;
    const path = s<250 ? new Array(CK) : null;
    let ckIdx=0;
    for (let i=0;i<n;i++) {
      eq += seq[i];
      peak = Math.max(peak, eq);
      dd = Math.min(dd, eq-peak);
      if (ckIdx<checkpoints.length && (i+1)===checkpoints[ckIdx]) {
        bandsAtCk[ckIdx].push(eq);
        if (path) path[ckIdx]=eq;
        ckIdx++;
      }
      if (horizonEq[i+1]!==undefined) horizonEq[i+1].push(eq);
    }
    finals.push(eq); dds.push(dd);
    if (path) paths.push(path);
  }
  finals.sort((a,b)=>a-b); dds.sort((a,b)=>a-b);
  const bands = {p10:[],p25:[],p50:[],p75:[],p90:[]};
  bandsAtCk.forEach(arr => {
    arr.sort((a,b)=>a-b);
    bands.p10.push(quantile(arr,.10)); bands.p25.push(quantile(arr,.25));
    bands.p50.push(quantile(arr,.50)); bands.p75.push(quantile(arr,.75)); bands.p90.push(quantile(arr,.90));
  });

  // Expected value bootstrap (sempre a livello di singolo trade)
  const evRes = expectedValueBootstrap(tradePoolForEV);

  renderMCResults({method, n, finals, dds, totalReal, horizons, horizonEq, evRes});
  fanChart($("#chMcFan") || createMcFanCanvas(), paths, bands);
}
function createMcFanCanvas() {
  const c = document.createElement("canvas"); c.className="chart"; c.id="chMcFan";
  return c;
}
function expectedValueBootstrap(pool) {
  if (!pool || pool.length<2) return null;
  const n = pool.length;
  const resamples = Math.max(500, Math.min(5000, n*5));
  const means = [];
  for (let i=0;i<resamples;i++) {
    let sum=0;
    for (let j=0;j<n;j++) sum += pool[(Math.random()*n)|0];
    means.push(sum/n);
  }
  means.sort((a,b)=>a-b);
  const ev = mean(means);
  const ci = [quantile(means,.025), quantile(means,.975)];
  const pNeg = means.filter(m=>m<=0).length/means.length;
  const losers = pool.filter(v=>v<0).map(v=>Math.abs(v));
  const oneR = losers.length ? mean(losers) : 1;
  return {ev, ci, pNeg, oneR, evR: ev/oneR};
}

function renderMCResults(r) {
  const box = $("#mcResults");
  const ddP = {p50:quantile(r.dds,.5), p75:quantile(r.dds,.75), p90:quantile(r.dds,.90), p95:quantile(r.dds,.95), p99:quantile(r.dds,.99), worst:r.dds[0]};
  const finP = {p50:quantile(r.finals,.5), p5:quantile(r.finals,.05), p95:quantile(r.finals,.95)};
  const pLoss = 100*r.finals.filter(f=>f<=0).length/r.finals.length;
  let html = `<div class="card"><h3>Risultati Monte Carlo <small>${r.method==="reshuffle"?"Reshuffle":"Bootstrap con reimmissione"} · ${r.n} unità</small></h3>
    <div class="kpi-grid">
      <div class="kpi"><div class="label">P&L reale backtest</div><div class="value">${fmtMoney(r.totalReal,{plus:true})}</div></div>
      <div class="kpi"><div class="label">P&L finale mediano</div><div class="value">${fmtMoney(finP.p50,{plus:true})}</div></div>
      <div class="kpi"><div class="label">P&L finale 5%–95%</div><div class="value">${fmtMoney(finP.p5)} / ${fmtMoney(finP.p95)}</div></div>
      <div class="kpi"><div class="label">Probabilità P&L ≤ 0</div><div class="value ${pLoss>30?'neg':'pos'}">${fmtPct(pLoss)}</div></div>
      <div class="kpi"><div class="label">Drawdown mediano</div><div class="value neg">${fmtMoney(ddP.p50)}</div></div>
      <div class="kpi"><div class="label">Drawdown 95° pct.</div><div class="value neg">${fmtMoney(ddP.p95)}</div></div>
      <div class="kpi"><div class="label">Drawdown peggiore</div><div class="value neg">${fmtMoney(ddP.worst)}</div></div>
    </div>`;
  if (r.evRes) {
    html += `<h3 style="margin-top:14px">Expected Value (per trade, bootstrap)</h3>
    <div class="kpi-grid">
      <div class="kpi"><div class="label">EV per trade</div><div class="value ${r.evRes.ev>=0?'pos':'neg'}">${fmtMoney(r.evRes.ev,{plus:true})}</div></div>
      <div class="kpi"><div class="label">EV 95% CI</div><div class="value">${fmtMoney(r.evRes.ci[0])} / ${fmtMoney(r.evRes.ci[1])}</div></div>
      <div class="kpi"><div class="label">P(EV ≤ 0)</div><div class="value ${r.evRes.pNeg>0.2?'neg':'pos'}">${fmtPct(r.evRes.pNeg*100)}</div></div>
      <div class="kpi"><div class="label">EV in R</div><div class="value ${r.evRes.evR>=0?'pos':'neg'}">${fmtNum(r.evRes.evR)}R</div></div>
    </div>`;
  }
  html += `<h3 style="margin-top:14px">Drawdown e P&L per orizzonte</h3>
    <div class="table-wrap"><table class="data"><thead><tr><th>Orizzonte</th><th>P&L mediano</th><th>P(perdita)</th></tr></thead><tbody>
    ${r.horizons.map(h => {
      const arr = r.horizonEq[h];
      const med = quantile(arr.slice().sort((a,b)=>a-b), .5);
      const pl = 100*arr.filter(v=>v<0).length/arr.length;
      return `<tr><td>${h}</td><td>${fmtMoney(med,{plus:true})}</td><td>${fmtPct(pl)}</td></tr>`;
    }).join("")}
    </tbody></table></div>
    <h3 style="margin-top:14px">Ventaglio scenari (grigio = simulazioni, blu = mediana, verde = 90° pct., rosso = 10° pct.)</h3>
    <div class="chart-wrap" id="mcFanWrap"></div>
    </div>`;
  box.innerHTML = html;
  const wrap = $("#mcFanWrap");
  const c = document.createElement("canvas"); c.className="chart"; c.id="chMcFan";
  wrap.appendChild(c);
}

// ---------------------------------------------------------------------
// Prop Simulator — stessa struttura e stessi calcoli del vecchio Analyzer
// (Regole della prop + Fase 2/Conto Funded, ciascuna con la propria
// simulazione indipendente), con l'aggiunta della categoria CFD in % del
// conto (il vecchio Analyzer, NinjaTrader/Futures, non l'aveva).
// ---------------------------------------------------------------------

function renderPresetSelect() {
  const sel = $("#propPreset");
  const isCfd = state.propCategory === "cfd";
  const list = isCfd ? state.presets.cfd : state.presets.futures;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— personalizzato —</option>' +
    list.map((p,i) => `<option value="${i}">${p.name}</option>`).join("");
  sel.value = list[Number(cur)] ? cur : "";
}
$("#propCategory").addEventListener("change", () => { setPropCategory($("#propCategory").value); savePropSettings(); });
$("#propPreset").addEventListener("change", () => {
  const idx = $("#propPreset").value;
  if (idx === "") return;
  const list = state.propCategory === "cfd" ? state.presets.cfd : state.presets.futures;
  const p = list[Number(idx)];
  if (p) (state.propCategory==="cfd" ? applyCfdPreset(p) : applyFuturesPreset(p));
});

// Le regole si esprimono in $ per i preset Futures (importi fissi indipendenti
// dalla size) e in % del conto per i preset CFD (così come dichiarati dalle
// prop) — l'interpretazione segue la categoria scelta.
function setPropCategory(cat) {
  state.propCategory = cat;
  $("#propCategory").value = cat;
  const isCfd = cat === "cfd";
  updateUnitLabels();
  renderPresetSelect();
}
function updateUnitLabels() {
  const isCfd = state.propCategory === "cfd";
  const acc = Number($("#pAccount").value)||0;
  const withHint = (base, fieldId) => {
    if (!isCfd) return base + " ($)";
    const v = Number($(fieldId).value)||0;
    return `${base} (%) — ${fmtMoney(acc*v/100)}`;
  };
  $("#lblPTarget").textContent = withHint("Target", "#pTarget");
  $("#lblPDD").textContent = withHint("Max Drawdown", "#pDD");
  $("#lblPDLL").textContent = isCfd
    ? `Daily Loss Limit (%, 0=nessuno) — ${fmtMoney(acc*(Number($("#pDLL").value)||0)/100)}`
    : "Daily Loss Limit ($, 0=nessuno)";
  $("#lblPDDStop").textContent = isCfd
    ? `Il trailing si ferma a BE+ (%, 0=mai) — ${fmtMoney(acc*(Number($("#pDDStop").value)||0)/100)}`
    : "Il trailing si ferma a BE+ ($, 0=mai)";
  $("#lblFMaxDD").textContent = withHint("Max Drawdown EOD", "#fMaxDD");
}
["#pAccount","#pTarget","#pDD","#pDLL","#pDDStop","#fMaxDD"].forEach(f => {
  $(f).addEventListener("input", updateUnitLabels);
});

function applyFuturesPreset(p) {
  setPropCategory("futures");
  $("#pAccount").value = p.account; $("#pTarget").value = p.target; $("#pDD").value = p.dd;
  $("#pDDMode").value = p.ddMode; $("#pDLL").value = p.dll; $("#pDDStop").value = p.ddStop||0;
  $("#pMinDays").value = p.minDays; $("#pMaxDays").value = p.maxDays;
  $("#pConsistency").value = p.consistency; $("#pFee").value = p.fee;
  // Conto Funded: valori indicativi (di solito la stessa trailing DD prosegue nel conto funded)
  $("#fMaxDD").value = p.dd; $("#fMinDays").value = p.minDays; $("#fDays").value = 30;
  $("#fProfitDays").value = 0; $("#fDayThr").value = 0; $("#fConsistency").value = p.consistency; $("#fSplit").value = 90;
  updateUnitLabels();
  toast(`Preset ${p.name} applicato`);
  savePropSettings();
}
function applyCfdPreset(p) {
  setPropCategory("cfd");
  const acc = Number($("#pAccount").value) || (state.current ? Number(state.current.account_size) : 50000);
  $("#pAccount").value = acc;
  $("#pFee").value = Math.round(acc*p.feePct/100);

  if (p.propType === "instant") {
    // Instant funding: nessuna valutazione, le regole della preset sono
    // direttamente quelle del conto funded — mostrate in % come dichiarate.
    $("#pTarget").value = 0; $("#pDD").value = 0; $("#pDLL").value = 0; $("#pDDStop").value = 0;
    $("#fMaxDD").value = p.ddPct;
    $("#fMinDays").value = p.minDays; $("#fDays").value = p.maxDays || 30;
    $("#fConsistency").value = p.consistency; $("#fSplit").value = 50;
    $("#fProfitDays").value = 0; $("#fDayThr").value = 0;
    updateUnitLabels();
    toast(`Preset ${p.name} applicato (Instant Funding — nessuna valutazione, solo Conto Funded)`);
    savePropSettings();
    return;
  }

  // Valori mostrati come percentuali dirette (come dichiarate dalla prop),
  // risolti in $ solo al momento della simulazione in base all'account.
  // Per le prop a 2 fasi le regole di Fase 1 e Fase 2 sono le stesse: qui si
  // imposta Fase 1, per Fase 2 basta rilanciare con i valori della verifica.
  $("#pTarget").value = p.targetPct;
  $("#pDD").value = p.ddPct;
  $("#pDDMode").value = p.ddMode;
  $("#pDLL").value = p.dllPct||0;
  $("#pDDStop").value = 0;
  $("#pMinDays").value = p.minDays; $("#pMaxDays").value = p.maxDays;
  $("#pConsistency").value = p.consistency;
  if (p.phase2) {
    $("#fMaxDD").value = p.phase2.ddPct;
    $("#fMinDays").value = p.phase2.minDays; $("#fDays").value = p.phase2.maxDays || 30;
  } else {
    $("#fMaxDD").value = p.ddPct; $("#fMinDays").value = p.minDays; $("#fDays").value = p.maxDays || 30;
  }
  $("#fProfitDays").value = 0; $("#fDayThr").value = 0; $("#fConsistency").value = 0; $("#fSplit").value = 80;
  updateUnitLabels();
  toast(`Preset ${p.name} applicato (valori in % del conto $${acc.toLocaleString("it-IT")})`);
  savePropSettings();
}

// Risolve un campo target/DD/DLL/BE+ nell'importo $ effettivo usato dal
// motore di simulazione: in categoria CFD il valore del campo è una
// percentuale del conto, in Futures è già un importo $ fisso.
function resolveAmount(fieldId) {
  const v = Number($(fieldId).value)||0;
  if (state.propCategory === "cfd") {
    const acc = Number($("#pAccount").value)||0;
    return acc * v/100;
  }
  return v;
}

function readPropCfg() {
  return {
    account: Number($("#pAccount").value)||0,
    target: resolveAmount("#pTarget"),
    dd: resolveAmount("#pDD"),
    ddMode: $("#pDDMode").value,
    dll: resolveAmount("#pDLL"),
    ddStop: resolveAmount("#pDDStop"),
    minDays: Number($("#pMinDays").value)||0,
    maxDays: Number($("#pMaxDays").value)||0,
    consistency: Number($("#pConsistency").value)||0,
    fee: Number($("#pFee").value)||0,
    sims: Math.max(200, Math.min(20000, Number($("#pSims").value)||3000)),
  };
}
function readFundedCfg() {
  return {
    days: Number($("#fDays").value)||30, minDays: Number($("#fMinDays").value)||0,
    profitDays: Number($("#fProfitDays").value)||0, dayThr: Number($("#fDayThr").value)||0,
    maxDD: resolveAmount("#fMaxDD"), split: (Number($("#fSplit").value)||80)/100,
    consistency: Number($("#fConsistency").value)||0,
    sims: Math.max(200, Math.min(20000, Number($("#fSims").value)||3000)),
  };
}

// ---------------------------------------------------------------------
// Persistenza configurazione Prop Simulator (in data/analyzer.db, via
// /api/settings) — così non si riparte da zero ogni volta che si riapre.
// ---------------------------------------------------------------------
function savePropSettings() {
  clearTimeout(savePropSettings._t);
  savePropSettings._t = setTimeout(async () => {
    const cfg = {
      category: state.propCategory, preset: $("#propPreset").value,
      account: $("#pAccount").value, fee: $("#pFee").value, sims: $("#pSims").value,
      pTarget: $("#pTarget").value, pDD: $("#pDD").value, pDDMode: $("#pDDMode").value,
      pDLL: $("#pDLL").value, pDDStop: $("#pDDStop").value,
      pMinDays: $("#pMinDays").value, pMaxDays: $("#pMaxDays").value, pConsistency: $("#pConsistency").value,
      fDays: $("#fDays").value, fMinDays: $("#fMinDays").value, fProfitDays: $("#fProfitDays").value,
      fDayThr: $("#fDayThr").value, fMaxDD: $("#fMaxDD").value, fSplit: $("#fSplit").value,
      fConsistency: $("#fConsistency").value, fSims: $("#fSims").value,
      picker: readPickerRaw("propPicker"),
    };
    state.settings.propSimConfig = cfg;
    try { await apiPost("/api/settings", {propSimConfig: cfg}); } catch(e) { /* non bloccante */ }
  }, 400);
}
function applyPropSettings(cfg) {
  state.propPickerPersist = (cfg && cfg.picker) || null;
  if (!cfg) { setPropCategory(state.propCategory); return; }
  setPropCategory(cfg.category || "futures");
  $("#pAccount").value = cfg.account ?? 50000; $("#pFee").value = cfg.fee ?? 0; $("#pSims").value = cfg.sims ?? 3000;
  $("#pTarget").value = cfg.pTarget ?? 3000; $("#pDD").value = cfg.pDD ?? 2500; $("#pDDMode").value = cfg.pDDMode || "trailing_intraday";
  $("#pDLL").value = cfg.pDLL ?? 0; $("#pDDStop").value = cfg.pDDStop ?? 0;
  $("#pMinDays").value = cfg.pMinDays ?? 1; $("#pMaxDays").value = cfg.pMaxDays ?? 0; $("#pConsistency").value = cfg.pConsistency ?? 0;
  $("#fDays").value = cfg.fDays ?? 30; $("#fMinDays").value = cfg.fMinDays ?? 4; $("#fProfitDays").value = cfg.fProfitDays ?? 0;
  $("#fDayThr").value = cfg.fDayThr ?? 0; $("#fMaxDD").value = cfg.fMaxDD ?? 2500; $("#fSplit").value = cfg.fSplit ?? 80;
  $("#fConsistency").value = cfg.fConsistency ?? 0; $("#fSims").value = cfg.fSims ?? 3000;
  renderPresetSelect();
  if (cfg.preset) $("#propPreset").value = cfg.preset;
  updateUnitLabels();
}
// Salvataggio automatico su qualunque modifica dei campi della tab Prop Simulator
// (debounced 400ms) — copre anche la selezione/moltiplicatori nel picker.
$("#tab-prop").addEventListener("change", savePropSettings);

// -------------------- motore di simulazione (Regole della prop) --------------------
function simulateOutcomes(dayPool, cfg) {
  const n = dayPool.length;
  const capDays = cfg.maxDays>0 ? cfg.maxDays : 365;
  let pass=0, bustDD=0, bustDaily=0, timeout=0;
  const daysToPass = [];
  const dds = []; // max drawdown raggiunto in ciascuna simulazione (per i percentili)
  for (let s=0;s<cfg.sims;s++) {
    let eq=0, peak=0, maxDayProfit=0, resolved=false, simDD=0;
    let floorLocked=false, lockedFloor=0;
    for (let d=0; d<capDays; d++) {
      const day = dayPool[(Math.random()*n)|0];
      let dayPnl = 0;
      const applyFloor = () => {
        let floor = peak - cfg.dd;
        if (cfg.ddStop>0) {
          if (!floorLocked && floor>=cfg.ddStop) { floorLocked=true; lockedFloor=cfg.ddStop; }
          if (floorLocked) floor = lockedFloor;
        }
        return floor;
      };
      if (cfg.ddMode==="trailing_intraday" && day.seq.length) {
        let bust=false;
        for (const tr of day.seq) {
          eq += tr.pnl; dayPnl += tr.pnl;
          peak = Math.max(peak, eq);
          simDD = Math.min(simDD, eq-peak);
          const floor = applyFloor();
          if (eq < floor) { bustDD++; resolved=true; bust=true; break; }
        }
        if (bust) break;
      } else {
        eq += day.pnl; dayPnl = day.pnl;
        peak = cfg.ddMode==="trailing_eod" ? Math.max(peak, eq) : peak;
        simDD = Math.min(simDD, eq-peak);
        const floor = cfg.ddMode==="trailing_eod" ? applyFloor() : -cfg.dd;
        if (eq < floor) { bustDD++; resolved=true; break; }
      }
      if (cfg.dll>0 && dayPnl <= -cfg.dll) { bustDaily++; resolved=true; break; }
      maxDayProfit = Math.max(maxDayProfit, dayPnl);
      const consistencyOk = cfg.consistency<=0 || eq<=0 || (100*maxDayProfit/eq <= cfg.consistency);
      if (eq >= cfg.target && (d+1) >= cfg.minDays && consistencyOk) {
        pass++; daysToPass.push(d+1); resolved=true; break;
      }
    }
    if (!resolved) timeout++;
    dds.push(simDD);
  }
  const total = cfg.sims;
  daysToPass.sort((a,b)=>a-b);
  dds.sort((a,b)=>a-b);
  return {
    pass, bustDD, bustDaily, timeout, total,
    passRate: 100*pass/total, wilson: wilsonCI(pass,total),
    avgDaysToPass: daysToPass.length ? mean(daysToPass) : null,
    daysToPass, dds,
  };
}

// Stress test: degrada le giornate (riduce il P&L e trasforma una quota di
// giornate vincenti in perdenti) per stimare quanto regge la probabilità di
// passaggio se il live rende peggio del backtest.
function applyDayDegradation(dayPool, degradeWR, degradePnl) {
  const loseDays = dayPool.filter(d=>d.pnl<0).map(d=>d.pnl);
  const winDays = dayPool.filter(d=>d.pnl>0).map(d=>d.pnl);
  const meanLoss = loseDays.length ? mean(loseDays) : -(winDays.length ? mean(winDays) : 100);
  return dayPool.map(d => {
    if (d.pnl>0 && Math.random()<degradeWR) {
      return {date:d.date, pnl: meanLoss, seq:[{pnl:meanLoss}]};
    }
    const scale = 1-degradePnl;
    return {date:d.date, pnl: d.pnl*scale, seq: d.seq.map(s=>({pnl:s.pnl*scale}))};
  });
}
const DEGRADATION_SCENARIOS = [
  {label:"Baseline (backtest così com'è)", wr:0, pnl:0},
  {label:"WR -3pp, P&L -10%", wr:0.03, pnl:0.10},
  {label:"WR -5pp, P&L -15%", wr:0.05, pnl:0.15},
  {label:"WR -5pp, P&L -25% (stress)", wr:0.05, pnl:0.25},
  {label:"WR -8pp, P&L -30% (worst)", wr:0.08, pnl:0.30},
];

// -------------------- motore di simulazione (Conto Funded / payout) --------------------
function simulateFunded(dayPool, cfg) {
  const n = dayPool.length;
  let qualify=0, blown=0, rulesUnmet=0;
  const payouts = [];
  for (let s=0;s<cfg.sims;s++) {
    let eq=0, hwm=0, profitDays=0, blownFlag=false, maxDayProfit=0;
    for (let d=0; d<cfg.days; d++) {
      const day = dayPool[(Math.random()*n)|0];
      eq += day.pnl;
      hwm = Math.max(hwm, eq);
      if (day.pnl > cfg.dayThr) profitDays++;
      maxDayProfit = Math.max(maxDayProfit, day.pnl);
      if (cfg.maxDD>0 && (hwm-eq) >= cfg.maxDD) { blownFlag=true; break; }
    }
    if (blownFlag) { blown++; continue; }
    const consistencyOk = cfg.consistency<=0 || eq<=0 || (100*maxDayProfit/eq <= cfg.consistency);
    const qualifies = (cfg.days>=cfg.minDays) && (profitDays>=cfg.profitDays) && eq>0 && consistencyOk;
    if (qualifies) { qualify++; payouts.push(eq*cfg.split); } else { rulesUnmet++; }
  }
  payouts.sort((a,b)=>a-b);
  return {
    qualify, blown, rulesUnmet, total: cfg.sims, qualifyRate: 100*qualify/cfg.sims,
    wilson: wilsonCI(qualify, cfg.sims),
    avgPayout: payouts.length ? mean(payouts) : 0,
    medPayout: payouts.length ? quantile(payouts,.5) : 0,
    payouts,
  };
}

// -------------------- grafici dedicati al Prop Simulator --------------------
function equityFanChart(canvas, dayPool, cfg, sampleSims=1500) {
  const n = dayPool.length;
  if (!n) { const {ctx,w,h} = setupCanvas(canvas); emptyMsg(ctx,w,h); return; }
  const capDays = Math.min(cfg.maxDays>0?cfg.maxDays:120, 120);
  const shown = Math.min(sampleSims, 1500);
  const paths = [];
  for (let s=0; s<shown; s++) {
    let eq=0; const path=[0];
    for (let d=0; d<capDays; d++) { eq += dayPool[(Math.random()*n)|0].pnl; path.push(eq); }
    paths.push(path);
  }
  const finals = paths.map(p=>p[p.length-1]);
  const order = paths.map((_,i)=>i).sort((a,b)=>finals[a]-finals[b]);
  const worstIdx = order[0], bestIdx = order[order.length-1], typicalIdx = order[Math.floor(order.length/2)];

  const {ctx, w, h} = setupCanvas(canvas);
  const allVals = paths.flat().concat([cfg.target, -cfg.dd]);
  const yTicks = niceTicks(arrMin(allVals), arrMax(allVals), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v => "$"+Math.round(v).toLocaleString("it-IT"));
  const xFn = i => PAD.l + (i/capDays) * (w-PAD.l-PAD.r);

  ctx.strokeStyle = cvar("--ink-2")+"20"; ctx.lineWidth = 1;
  paths.forEach(p => { ctx.beginPath(); p.forEach((v,i)=>{const x=xFn(i),y=yFn(v); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}); ctx.stroke(); });

  ctx.setLineDash([5,4]); ctx.strokeStyle = cvar("--critical"); ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(PAD.l, yFn(-cfg.dd)); ctx.lineTo(w-PAD.r, yFn(-cfg.dd)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = cvar("--good"); ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(PAD.l, yFn(cfg.target)); ctx.lineTo(w-PAD.r, yFn(cfg.target)); ctx.stroke();

  const drawPath = (idx, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); paths[idx].forEach((v,i)=>{const x=xFn(i),y=yFn(v); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);}); ctx.stroke();
  };
  drawPath(bestIdx, cvar("--good"));
  drawPath(typicalIdx, cvar("--s1"));
  drawPath(worstIdx, cvar("--critical"));
}

function hBarChart(canvas, items) {
  const {ctx, w, h} = setupCanvas(canvas);
  if (!items.length) { emptyMsg(ctx,w,h); return; }
  const rowH = h / items.length;
  const barMaxW = w - 100;
  ctx.font = "12px system-ui";
  items.forEach((it,i) => {
    const top = i*rowH + 8;
    ctx.fillStyle = cvar("--ink-2"); ctx.textAlign="left"; ctx.textBaseline="alphabetic";
    ctx.fillText(it.label, 2, top+10);
    const barY = top+16, barH = Math.max(10, rowH-34);
    ctx.fillStyle = cvar("--surface-2"); ctx.fillRect(2, barY, barMaxW, barH);
    const barW = Math.max(2, barMaxW * Math.min(1,it.value/100));
    ctx.fillStyle = it.color; ctx.fillRect(2, barY, barW, barH);
    ctx.fillStyle = cvar("--ink"); ctx.textAlign="left"; ctx.textBaseline="middle";
    ctx.fillText(fmtPct(it.value), barMaxW+10, barY+barH/2);
  });
}

function sizeSweepChart(canvas, mults, rates, opts={}) {
  const {ctx, w, h} = setupCanvas(canvas);
  if (!mults.length) { emptyMsg(ctx,w,h); return; }
  const yTicks = niceTicks(0, Math.max(...rates,10), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v=>v.toFixed(0)+"%");
  const bw = (w-PAD.l-PAD.r) / mults.length;
  const zero = yFn(0);
  mults.forEach((m,i) => {
    const x = PAD.l + i*bw + bw*0.15;
    const y = yFn(rates[i]);
    let color = m===1 ? cvar("--s1") : (m<1 ? cvar("--warning") : cvar("--critical"));
    if (opts.highlightIdx===i) color = cvar("--good");
    ctx.fillStyle = color;
    ctx.fillRect(x, y, bw*0.7, zero-y);
  });
  ctx.fillStyle = cvar("--muted"); ctx.font="10px system-ui"; ctx.textAlign="center";
  mults.forEach((m,i) => ctx.fillText(m+"×", PAD.l+i*bw+bw/2, h-6));
  bindHoverBars(canvas, mults.map(m=>m+"×"), rates, PAD.l, bw, (c,v)=>`${c}: ${fmtPct(v)}`);
}

function histogramFromValues(canvas, values, buckets=14, opts={}) {
  if (!values.length) { const {ctx,w,h}=setupCanvas(canvas); emptyMsg(ctx,w,h); return; }
  const min = arrMin(values), max = arrMax(values);
  const bw = (max-min)/buckets || 1;
  const counts = new Array(buckets).fill(0);
  values.forEach(v => { let i = Math.floor((v-min)/bw); if (i>=buckets) i=buckets-1; if(i<0) i=0; counts[i]++; });
  const bucketVals = counts.map((_,i) => min+i*bw);
  const cats = counts.map((_,i) => opts.intCats ? Math.round(min+i*bw) : "$"+Math.round(min+i*bw).toLocaleString("it-IT"));
  barChart(canvas, cats, counts, {colorBy: bucketVals, tip:(c,v)=>`${c}: ${v} simulazioni`});
}

// -------------------- render risultati: Regole della prop --------------------
$("#btnSimulate").addEventListener("click", async () => {
  const sel = await getSelection("propPicker");
  if (!sel.length) { toast("Seleziona almeno una strategia"); return; }
  const dayMap = buildCombinedDayMap(sel);
  const pool = buildFullDayPool(dayMap);
  if (pool.length < 5) { toast("Servono più giorni di dati"); return; }
  const cfg = readPropCfg();
  const res = simulateOutcomes(pool, cfg);
  renderPropResults(res, cfg, pool);
});

function renderPropResults(res, cfg, pool) {
  const box = $("#propResults");
  const p1 = res.passRate/100;
  const daysP10 = res.daysToPass.length ? quantile(res.daysToPass,.10) : 0;
  const daysP90 = res.daysToPass.length ? quantile(res.daysToPass,.90) : 0;
  const attemptsExpected = p1>0 ? 1/p1 : null;
  const expectedCostSingle = cfg.fee * (attemptsExpected ?? 1);

  let html = `
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Probabilità di passare</div><div class="value ${res.passRate>=40?'pos':'neg'}" style="font-size:26px">${fmtPct(res.passRate)}</div>
        <div class="risk-hint">CI 95% (Wilson): ${fmtPct(res.wilson[0])} – ${fmtPct(res.wilson[1])} · ${res.total} simulazioni</div></div>
      <div class="kpi"><div class="label">Bocciatura per drawdown</div><div class="value neg" style="font-size:26px">${fmtPct(100*res.bustDD/res.total)}</div></div>
      <div class="kpi"><div class="label">Giorni per passare (mediana)</div><div class="value" style="font-size:26px">${res.avgDaysToPass?fmtNum(res.daysToPass.length?quantile(res.daysToPass,.5):0,0):"—"}</div>
        <div class="risk-hint">p10 ${daysP10.toFixed(0)} · p90 ${daysP90.toFixed(0)}</div></div>
      <div class="kpi"><div class="label">Tentativi attesi</div><div class="value" style="font-size:26px">${attemptsExpected?fmtNum(attemptsExpected,1):"—"}</div>
        <div class="risk-hint">costo atteso ~${fmtMoney(expectedCostSingle)}</div></div>
    </div>

    <div class="card">
      <h3>Probabilità di passare entro N tentativi <small>riacquistando la challenge se fallisci</small></h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Tentativi</th><th>P(passa ≥1)</th><th>Costo totale</th></tr></thead><tbody>
        ${[1,2,3,4,5].map(nAtt => {
          const cum = 1-Math.pow(1-p1, nAtt);
          return `<tr><td>${nAtt} tentativo${nAtt>1?"i":""}</td><td class="pnl-pos">${fmtPct(cum*100)}</td><td>${fmtMoney(cfg.fee*nAtt)}</td></tr>`;
        }).join("")}
      </tbody></table></div>
    </div>

    <div class="card">
      <h3>Proiezione equity — ${cfg.sims} simulazioni <small>mostrate ${Math.min(1500,cfg.sims)} su ${cfg.sims}</small></h3>
      <div class="chart-wrap"><canvas class="chart" id="chPropEquity"></canvas></div>
      <p class="rules-note">
        <span style="color:var(--good)">■</span> caso migliore ·
        <span style="color:var(--s1)">■</span> caso più probabile ·
        <span style="color:var(--critical)">■</span> caso peggiore ·
        <span style="color:var(--good)">—</span> target ${fmtMoney(cfg.target)} ·
        <span style="color:var(--critical)">- -</span> max DD ${fmtMoney(-cfg.dd)}
      </p>
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Esiti delle simulazioni</h3>
        <div class="chart-wrap"><canvas class="chart" id="chPropOutcome"></canvas></div>
      </div>
      <div class="card">
        <h3>Distribuzione giorni per passare</h3>
        <div class="chart-wrap"><canvas class="chart" id="chPropDaysHist"></canvas></div>
      </div>
    </div>

    <div class="card">
      <h3>Max drawdown per simulazione <small>${res.total} simulazioni</small></h3>
      <div class="grid2">
        <div class="table-wrap"><table class="data"><tbody>
          <tr><td>50° percentile</td><td>${fmtMoney(quantile(res.dds,.5))}</td></tr>
          <tr><td>75° percentile</td><td>${fmtMoney(quantile(res.dds,.25))}</td></tr>
          <tr><td>90° percentile</td><td>${fmtMoney(quantile(res.dds,.10))}</td></tr>
          <tr><td>95° percentile</td><td>${fmtMoney(quantile(res.dds,.05))}</td></tr>
          <tr><td>99° percentile</td><td>${fmtMoney(quantile(res.dds,.01))}</td></tr>
          <tr><td>Media</td><td>${fmtMoney(mean(res.dds))}</td></tr>
          <tr><td>Peggiore</td><td>${fmtMoney(res.dds[0]||0)}</td></tr>
        </tbody></table></div>
        <div class="chart-wrap"><canvas class="chart" id="chPropDDHist"></canvas></div>
      </div>
    </div>

    <div class="card">
      <h3>Stress test — se il live è peggio del backtest <small>1000 simulazioni per scenario</small></h3>
      <div class="chart-wrap"><canvas class="chart" id="chPropStress" style="height:210px"></canvas></div>
      <p class="rules-note">Ogni scenario riduce il P&amp;L netto delle giornate e trasforma una quota di giornate vincenti in perdenti, per stimare quanto regge la probabilità di passaggio se la strategia rende meno live che nel backtest.</p>
    </div>

    <div class="card">
      <h3>Probabilità di passare per dimensione della posizione <small>× rischio attuale, 1000 simulazioni per punto</small></h3>
      <div class="chart-wrap"><canvas class="chart" id="chPropSizeSweep"></canvas></div>
      <p class="rules-note">1× = il moltiplicatore già impostato per le strategie selezionate. Aumentare la size alza la probabilità di passare più in fretta ma anche quella di essere bocciati per drawdown.</p>
    </div>
  `;
  box.innerHTML = html;

  equityFanChart($("#chPropEquity"), pool, cfg);
  donutChart($("#chPropOutcome"), [
    {label:`Passa (${fmtPct(res.passRate)})`, value: res.pass, color: cvar("--good")},
    {label:`Bocciata (${fmtPct(100-res.passRate)})`, value: res.total-res.pass, color: cvar("--critical")},
  ]);
  if (res.daysToPass.length && (arrMax(res.daysToPass)-arrMin(res.daysToPass)) <= 20) {
    const bucketedDays = {};
    res.daysToPass.forEach(d => { bucketedDays[d] = (bucketedDays[d]||0)+1; });
    const dayCats = Object.keys(bucketedDays).map(Number).sort((a,b)=>a-b);
    barChart($("#chPropDaysHist"), dayCats, dayCats.map(d=>bucketedDays[d]), {tip:(c,v)=>`giorno ${c}: ${v} simulazioni`});
  } else {
    histogramFromValues($("#chPropDaysHist"), res.daysToPass, 14, {intCats:true});
  }
  histogramFromValues($("#chPropDDHist"), res.dds, 14);

  const stressResults = DEGRADATION_SCENARIOS.map(sc => {
    const degPool = sc.wr===0 && sc.pnl===0 ? pool : applyDayDegradation(pool, sc.wr, sc.pnl);
    const r = simulateOutcomes(degPool, {...cfg, sims: 1000});
    return {label: sc.label, value: r.passRate};
  });
  hBarChart($("#chPropStress"), stressResults.map((s,i) => ({
    label: s.label, value: s.value,
    color: i===0 ? cvar("--s1") : (s.value >= stressResults[0].value*0.85 ? cvar("--warning") : cvar("--critical")),
  })));

  const mults = [0.3,0.5,0.7,1,1.3,1.5,2];
  const sweepRates = mults.map(m => {
    const scaledPool = pool.map(d => ({date:d.date, pnl:d.pnl*m, seq:d.seq.map(s=>({pnl:s.pnl*m}))}));
    return simulateOutcomes(scaledPool, {...cfg, sims: 1000}).passRate;
  });
  sizeSweepChart($("#chPropSizeSweep"), mults, sweepRates);
}

// -------------------- render risultati: Fase 2 / Conto Funded --------------------
$("#btnSimulateFunded").addEventListener("click", async () => {
  const sel = await getSelection("propPicker");
  if (!sel.length) { toast("Seleziona almeno una strategia"); return; }
  const dayMap = buildCombinedDayMap(sel);
  const pool = buildFullDayPool(dayMap);
  if (pool.length < 5) { toast("Servono più giorni di dati"); return; }
  const cfg = readFundedCfg();
  const res = simulateFunded(pool, cfg);
  renderFundedResults(res, cfg, pool);
});

function renderFundedResults(res, cfg, pool) {
  const box = $("#fundedResults");
  let html = `
    <div class="kpi-grid">
      <div class="kpi"><div class="label">Probabilità di arrivare al payout</div><div class="value ${res.qualifyRate>=40?'pos':'neg'}" style="font-size:26px">${fmtPct(res.qualifyRate)}</div>
        <div class="risk-hint">CI 95% (Wilson): ${fmtPct(res.wilson[0])} – ${fmtPct(res.wilson[1])} · ${res.total} simulazioni</div></div>
      <div class="kpi"><div class="label">Conto azzerato (drawdown)</div><div class="value neg" style="font-size:26px">${fmtPct(100*res.blown/res.total)}</div></div>
      <div class="kpi"><div class="label">Regole non rispettate</div><div class="value" style="font-size:26px">${fmtPct(100*res.rulesUnmet/res.total)}</div>
        <div class="risk-hint">giorni minimi / giorni con profitto non raggiunti</div></div>
      <div class="kpi"><div class="label">Payout medio</div><div class="value pos" style="font-size:26px">${fmtMoney(res.avgPayout)}</div>
        <div class="risk-hint">mediana ${fmtMoney(res.medPayout)}</div></div>
      <div class="kpi"><div class="label">Payout atteso</div><div class="value pos" style="font-size:26px">${fmtMoney(res.qualifyRate/100*res.avgPayout)}</div>
        <div class="risk-hint">probabilità × payout medio</div></div>
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Esiti della finestra di payout</h3>
        <div class="chart-wrap"><canvas class="chart" id="chFundedOutcome"></canvas></div>
      </div>
      <div class="card">
        <h3>Distribuzione payout</h3>
        <div class="chart-wrap"><canvas class="chart" id="chFundedHist"></canvas></div>
      </div>
    </div>

    <div class="card">
      <h3>Percentili del payout <small>solo simulazioni qualificate</small></h3>
      <div class="table-wrap"><table class="data"><tbody>
        <tr><td>10° percentile</td><td>${fmtMoney(res.payouts.length?quantile(res.payouts,.10):0)}</td></tr>
        <tr><td>25° percentile</td><td>${fmtMoney(res.payouts.length?quantile(res.payouts,.25):0)}</td></tr>
        <tr><td>50° percentile</td><td>${fmtMoney(res.medPayout)}</td></tr>
        <tr><td>75° percentile</td><td>${fmtMoney(res.payouts.length?quantile(res.payouts,.75):0)}</td></tr>
        <tr><td>90° percentile</td><td>${fmtMoney(res.payouts.length?quantile(res.payouts,.90):0)}</td></tr>
      </tbody></table></div>
    </div>

    <div class="card">
      <h3>Payout atteso per dimensione della posizione <small>× rischio attuale, 1000 simulazioni per punto</small></h3>
      <div class="chart-wrap"><canvas class="chart" id="chFundedSizeSweep"></canvas></div>
      <p class="rules-note" id="fundedSweepNote"></p>
    </div>
  `;
  box.innerHTML = html;

  donutChart($("#chFundedOutcome"), [
    {label:`Payout (${fmtPct(res.qualifyRate)})`, value: res.qualify, color: cvar("--good")},
    {label:`Azzerato (${fmtPct(100-res.qualifyRate)})`, value: res.total-res.qualify, color: cvar("--critical")},
  ]);
  histogramFromValues($("#chFundedHist"), res.payouts, 10);

  const mults = [0.3,0.5,0.7,1,1.3,1.5,2];
  let bestIdx = 0, bestExpected = -Infinity;
  const expectedByMult = mults.map((m,i) => {
    const scaledPool = pool.map(d => ({date:d.date, pnl:d.pnl*m, seq:d.seq.map(s=>({pnl:s.pnl*m}))}));
    const r = simulateFunded(scaledPool, {...cfg, sims: 1000});
    const expected = r.qualifyRate/100 * r.avgPayout;
    if (expected > bestExpected) { bestExpected = expected; bestIdx = i; }
    return {mult:m, expected, r};
  });
  sizeSweepValueChart($("#chFundedSizeSweep"), expectedByMult, bestIdx);
  const best = expectedByMult[bestIdx];
  $("#fundedSweepNote").textContent = `1× = il moltiplicatore già impostato nel picker. Ottimale in questo pool: ${best.mult}× → payout atteso ${fmtMoney(best.expected)} (qualifica ${fmtPct(best.r.qualifyRate)}, payout medio ${fmtMoney(best.r.avgPayout)}).`;
}

function sizeSweepValueChart(canvas, items, highlightIdx) {
  const {ctx, w, h} = setupCanvas(canvas);
  const vals = items.map(i=>i.expected);
  if (!vals.length) { emptyMsg(ctx,w,h); return; }
  const yTicks = niceTicks(0, Math.max(...vals,10), 5);
  const yFn = drawFrame(ctx, w, h, yTicks, v=>"$"+Math.round(v).toLocaleString("it-IT"));
  const bw = (w-PAD.l-PAD.r) / items.length;
  const zero = yFn(0);
  items.forEach((it,i) => {
    const x = PAD.l + i*bw + bw*0.15;
    const y = yFn(it.expected);
    ctx.fillStyle = i===highlightIdx ? cvar("--good") : cvar("--s1");
    ctx.fillRect(x, y, bw*0.7, zero-y);
  });
  ctx.fillStyle = cvar("--muted"); ctx.font="10px system-ui"; ctx.textAlign="center";
  items.forEach((it,i) => ctx.fillText(it.mult+"×", PAD.l+i*bw+bw/2, h-6));
  bindHoverBars(canvas, items.map(it=>it.mult+"×"), vals, PAD.l, bw, (c,v)=>`${c}: ${fmtMoney(v)} atteso`);
}

// ---------------------------------------------------------------------
// Impostazioni: schemi + preferenze
// ---------------------------------------------------------------------
async function loadSchemas() { state.schemas = await apiGet("/api/schemas"); }
async function loadInstruments() { state.instruments = await apiGet("/api/instruments"); }

function renderSettings() {
  const box = $("#schemaList");
  box.innerHTML = "";
  const s = computeStats(state.trades || []);
  state.schemas.forEach(sc => {
    const bs = s.bySchema[sc.id];
    const row = document.createElement("div"); row.className = "schema-row";
    row.innerHTML = `<div class="swatch" style="background:${sc.color}"></div>
      <div class="name">${escapeHtml(sc.name)}</div>
      <div class="stats">${bs ? `${bs.n} trade · WR ${fmtPct(bs.winRate)} · ${fmtMoney(bs.pnl,{plus:true})}` : "nessun trade sul backtest attuale"}</div>
      <button class="btn small danger" data-id="${sc.id}">✕</button>`;
    box.appendChild(row);
  });
  $$("#schemaList button[data-id]").forEach(b => b.onclick = async () => {
    await apiDelete(`/api/schemas/${b.dataset.id}`);
    await loadSchemas(); renderSettings(); renderSchemaChips();
  });
  $("#settDefaultRisk").value = state.settings.default_risk_pct ?? 1;

  const ibox = $("#instrumentList");
  ibox.innerHTML = "";
  state.instruments.forEach(ins => {
    const bi = s.byInstrument[ins.id];
    const row = document.createElement("div"); row.className = "schema-row";
    row.innerHTML = `<div class="swatch" style="background:${cvar('--s1')}"></div>
      <div class="name">${escapeHtml(ins.name)}</div>
      <div class="stats">${bi ? `${bi.n} trade · WR ${fmtPct(bi.winRate)} · ${fmtMoney(bi.pnl,{plus:true})}` : "nessun trade sul backtest attuale"}</div>
      <button class="btn small danger" data-id="${ins.id}">✕</button>`;
    ibox.appendChild(row);
  });
  $$("#instrumentList button[data-id]").forEach(b => b.onclick = async () => {
    await apiDelete(`/api/instruments/${b.dataset.id}`);
    await loadInstruments(); renderSettings(); renderInstrumentSelect();
  });
}

$("#btnAddSchema").addEventListener("click", async () => {
  const name = $("#newSchemaName").value.trim();
  if (!name) { toast("Inserisci un nome schema"); return; }
  await apiPost("/api/schemas", {name, color: $("#newSchemaColor").value});
  $("#newSchemaName").value = "";
  await loadSchemas(); renderSettings(); renderSchemaChips();
  toast("Schema aggiunto");
});

$("#btnAddInstrument").addEventListener("click", async () => {
  const name = $("#newInstrumentName").value.trim();
  if (!name) { toast("Inserisci un nome strumento"); return; }
  await apiPost("/api/instruments", {name});
  $("#newInstrumentName").value = "";
  await loadInstruments(); renderSettings(); renderInstrumentSelect();
  toast("Strumento aggiunto");
});

$("#btnSaveSettings").addEventListener("click", async () => {
  const val = Number($("#settDefaultRisk").value) || 1;
  await apiPost("/api/settings", {default_risk_pct: val});
  state.settings.default_risk_pct = val;
  $("#fRiskPct").value = val;
  updateRiskHint();
  toast("Impostazioni salvate");
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
async function init() {
  try {
    state.settings = await apiGet("/api/settings");
    state.presets = await apiGet("/api/presets");
    await loadSchemas();
    await loadInstruments();
    if (state.settings.default_risk_pct) $("#fRiskPct").value = state.settings.default_risk_pct;
    await loadBacktests();
    applyPropSettings(state.settings.propSimConfig);
  } catch (err) {
    toast("Errore di avvio: " + err.message);
    console.error(err);
  }
}
init();

})();
