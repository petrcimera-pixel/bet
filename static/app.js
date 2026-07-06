"use strict";
// ⚽ KurzAnalytik – frontend logika

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const fmt = n => (Math.round(n * 100) / 100).toLocaleString("cs-CZ");
const pct = x => (x * 100).toFixed(1) + "%";

// Kdy se zápas hraje – "04.07. 19:00", nebo jen datum/čas když druhé chybí
function matchWhen(date, time) {
  if (!date && !time) return "";
  const d = date ? `${date.slice(8, 10)}.${date.slice(5, 7)}.` : "";
  return `📅 ${d}${date && time ? " " : ""}${time || ""}`.trim();
}

const PREFS = JSON.parse(localStorage.getItem("ka_prefs") || "{}");
const savePrefs = () => localStorage.setItem("ka_prefs", JSON.stringify({
  days: STATE.days, sortBy: STATE.sortBy, valueOnly: STATE.valueOnly,
  collapsed: [...STATE.collapsed], sport: STATE.sport, slip: STATE.slip
}));

let STATE = {
  date: new Date().toISOString().slice(0, 10),
  days: PREFS.days || 7,
  sport: PREFS.sport || "soccer",
  sortBy: PREFS.sortBy || "time",
  valueOnly: !!PREFS.valueOnly,
  collapsed: new Set(PREFS.collapsed || []),
  slip: PREFS.slip || [],
  data: null,
  bank: null,
  currency: "Kč",
};
const LBL = { home: "1", draw: "X", away: "2" };
const keysFor = m => m.two_way ? ["home", "away"] : ["home", "draw", "away"];
let CUR = null;
let _liveTimer = null;

// ---------- inicializace ----------
window.addEventListener("DOMContentLoaded", () => {
  $("#datePicker").value = STATE.date;
  $("#window").value = STATE.days;
  $("#sortBy").value = STATE.sortBy;
  $("#valueOnly").checked = STATE.valueOnly;
  $("#datePicker").addEventListener("change", e => { STATE.date = e.target.value; loadAll(); });
  $("#prevDay").onclick = () => shiftDay(-STATE.days);
  $("#nextDay").onclick = () => shiftDay(STATE.days);
  $("#window").addEventListener("change", e => { STATE.days = +e.target.value; savePrefs(); loadAll(); });
  $("#refreshBtn").onclick = () => loadMatches(true);

  $$(".tab").forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  $("#search").addEventListener("input", renderMatches);
  $("#leagueFilter").addEventListener("change", renderMatches);
  $("#valueOnly").addEventListener("change", e => { STATE.valueOnly = e.target.checked; savePrefs(); renderMatches(); });
  $("#sortBy").addEventListener("change", e => { STATE.sortBy = e.target.value; savePrefs(); renderMatches(); });
  $("#collapseAll").onclick = toggleCollapseAll;

  $("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeModal(); closeHelp(); $("#slipPanel").classList.add("hidden"); }
    if (e.key === "ArrowLeft" && !e.target.matches("input,select,textarea")) shiftDay(-STATE.days);
    if (e.key === "ArrowRight" && !e.target.matches("input,select,textarea")) shiftDay(STATE.days);
  });
  $("#saveBank").onclick = saveBankSettings;
  $("#autoSettle").onclick = autoSettle;
  $("#setKelly").addEventListener("input", e => $("#kellyVal").textContent = e.target.value);
  $("#runCalib").onclick = runCalib;
  $("#saveOddsKey").onclick = saveOddsKey;
  $("#helpBtn").onclick = () => openHelp();
  $("#help").addEventListener("click", e => { if (e.target.id === "help") closeHelp(); });

  // plovoucí tlačítko „zpět nahoru"
  const btt = document.createElement("button");
  btt.className = "back-top hidden"; btt.textContent = "↑"; btt.title = "Zpět nahoru";
  btt.onclick = () => window.scrollTo({ top: 0, behavior: "smooth" });
  document.body.appendChild(btt);
  window.addEventListener("scroll", () => btt.classList.toggle("hidden", window.scrollY < 500), { passive: true });

  initSidebar();
  initSettingsPage();
  applyAppearance();   // okamžitě, ať není flash výchozího vzhledu
  loadSports();
  loadOddsStatus();
  updateSlipBtn();
  loadAll();
  loadSettings();
  _agentAutoRun();   // zapnutý agent automaticky vsadí zítřejší ostré tipy
  startSettlePolling();   // automatická kontrola výsledků na pozadí

  if (!localStorage.getItem("ka_seen_intro")) {
    localStorage.setItem("ka_seen_intro", "1");
    setTimeout(() => openHelp(true), 600);
  }
});

// ---------- NÁPOVĚDA ----------
const help = (txt, right) => `<span class="help${right ? " r" : ""}" data-tip="${txt.replace(/"/g, "&quot;")}">?</span>`;

const GLOSSARY = [
  ["Predikce", "Nejpravděpodobnější výsledek podle modelu (síla týmů + statistika gólů)."],
  ["1 / X / 2", "Sázka na výhru domácích (1), remízu (X) nebo výhru hostů (2). U basketu/hokeje/NFL jen 1/2."],
  ["Kurz", "Kolik vyhraješ za 1 vsazenou jednotku. Kurz 2.00 = zdvojnásobení vkladu při výhře."],
  ["Jistota (confidence)", "Jak moc si je model jistý svou predikcí (0–100 %). Vyšší = jasnější favorit."],
  ["Value 💎", "Sázka, kde je kurz vyšší, než odpovídá skutečné pravděpodobnosti — dlouhodobě výhodná."],
  ["EV (očekávaná hodnota)", "Průměrný zisk na 1 jednotku. +10 % EV = v průměru vyděláš 0,10 na každou vsazenou 1."],
  ["Konsenzus", "Průměrný názor všech sázkovek po odečtení jejich marže — 'férová' tržní pravděpodobnost."],
  ["Sharp sázkovka ★", "Sázkovka s nejpřesnějšími kurzy a nízkou marží (např. Pinnacle). Dobrý referenční bod."],
  ["Over / Under", "Sázka na to, jestli padne VÍCE (Over) nebo MÉNĚ (Under) gólů/bodů než daná hranice."],
  ["BTTS", "'Both Teams To Score' — dají gól oba týmy? Ano/Ne. Jen u fotbalu."],
  ["Bank (bankroll)", "Tvůj virtuální rozpočet na sázení. Sázej jen jeho rozumnou část."],
  ["Kelly kritérium", "Vzorec pro optimální výši sázky podle výhody a kurzu. Frakční Kelly (¼) snižuje riziko."],
  ["ROI", "Návratnost — zisk dělený celkovou vsazenou částkou. +10 % ROI = z 1000 vsazených máš +100."],
  ["CLV", "Closing Line Value — jestli jsi vzal lepší kurz než tržní konsenzus. Kladné CLV = dobré sázení."],
  ["Brier score", "Míra přesnosti pravděpodobností (0 = perfektní, níž = líp). Porovnává predikci s realitou."],
  ["Elo rating", "Číslo síly týmu. Roste/klesá podle výsledků — engine se tak učí."],
  ["Akumulátor (tiket)", "Více sázek v jednom tiketu. Kurzy se násobí — vyšší výhra, ale musí vyjít všechny."],
  ["Dixon-Coles", "Pokročilá korekce Poisson modelu: opravuje pravděpodobnosti nízkých skóre (0-0, 1-0, …). Zvyšuje přesnost o ~5 %."],
];

function helpContent(welcome) {
  return `
    <button class="modal-close" onclick="closeHelp()">×</button>
    <h2>${welcome ? "👋 Vítej v KurzAnalytiku" : "❓ Nápověda"}</h2>
    <div class="sub">${welcome ? "Krátký průvodce, ať se hned vyznáš. Otevřeš ho kdykoliv tlačítkem ❓ nahoře." : "Jak appka funguje a co znamenají pojmy."}</div>

    <div class="help-sec">
      <h3>Co appka dělá</h3>
      <p class="hint">Načítá zápasy z celého světa, modelem (<b>Dixon-Coles Poisson + Elo</b>) předpovídá výsledky,
      simuluje kurzy více sázkovek a hledá <b>value</b> — sázky, kde je kurz vyšší, než odpovídá realitě.
      Vše je <b>virtuální a pro zábavu/vzdělávání</b>, nesází se skutečné peníze.</p>
    </div>

    <div class="help-sec">
      <h3>Jak na to – 4 kroky</h3>
      <div class="help-step"><div class="n">1</div><div class="tx"><b>Vyber sport a den.</b> Nahoře přepneš sport a časové okno (1–14 dní). Šipky ← → na klávesnici přesunou okno. Velké ligy jsou nahoře.</div></div>
      <div class="help-step"><div class="n">2</div><div class="tx"><b>Najdi value 💎.</b> Zaškrtni „jen value" nebo se podívej na <b>Tip dne</b>. Klikni na zápas pro detail s kurzy všech sázkovek a heatmapou skóre.</div></div>
      <div class="help-step"><div class="n">3</div><div class="tx"><b>Vsaď (virtuálně).</b> V detailu klikni na kurz, nech si poradit výši přes <b>🎯 Kelly</b> a dej Vsadit — nebo přidej víc výběrů <b>do tiketu</b>.</div></div>
      <div class="help-step"><div class="n">4</div><div class="tx"><b>Sleduj výsledky.</b> V <b>Bankrollu</b> vidíš zisk, ROI a graf. V <b>Kalibraci</b> ověříš, jak přesný model je.</div></div>
    </div>

    <div class="help-sec">
      <h3>Slovníček pojmů</h3>
      <div class="gloss">${GLOSSARY.map(([t, d]) =>
        `<div class="term"><div class="t"><span class="em">${esc(t)}</span></div><div class="d">${esc(d)}</div></div>`).join("")}</div>
    </div>

    <div class="help-warn">⚠️ <b>Sázej zodpovědně.</b> Žádná predikce nezaručuje výhru. Tato aplikace slouží
      ke vzdělávacím a analytickým účelům s virtuálním bankem. Skutečné sázení nese riziko ztráty. <b>18+</b></div>`;
}
function openHelp(welcome) { $("#helpBox").innerHTML = helpContent(welcome); $("#help").classList.remove("hidden"); }
function closeHelp() { $("#help").classList.add("hidden"); }

async function loadOddsStatus() {
  try {
    const d = await (await fetch("/api/odds/status")).json();
    $("#oddsStatus").innerHTML = d.enabled
      ? '<span style="color:var(--acc)">● aktivní</span>'
      : '<span style="color:var(--dim)">○ vypnuto (model)</span>';
  } catch (e) { /* ignore */ }
}
async function saveOddsKey() {
  const key = $("#oddsKey").value.trim();
  const d = await (await fetch("/api/odds/key", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key })
  })).json();
  toast(d.enabled ? "Reálné kurzy zapnuty ✓ (obnov zápasy)" : "Klíč smazán – jede model.");
  loadOddsStatus();
}

let SPORTS_LIST = [];
async function loadSports() {
  try {
    const d = await (await fetch("/api/sports")).json();
    SPORTS_LIST = d.sports;
    $("#sportBar").innerHTML = d.sports.map(s =>
      `<button class="${s.id === STATE.sport ? "active" : ""}" onclick="setSport('${s.id}')">${s.label}</button>`).join("");
    if ($("#setDefaultSport").children.length === 0) {
      $("#setDefaultSport").innerHTML = d.sports.map(s => `<option value="${s.id}">${s.label}</option>`).join("");
    }
  } catch (e) { /* ignore */ }
}
function setSport(id) {
  if (id === STATE.sport) return;
  STATE.sport = id; savePrefs();
  loadSports();
  loadAll();
}

function toggleCollapseAll() {
  if (!STATE.data) return;
  const allCollapsed = STATE.data.leagues.every(l => STATE.collapsed.has(l.league));
  if (allCollapsed) STATE.collapsed.clear();
  else STATE.data.leagues.forEach(l => STATE.collapsed.add(l.league));
  savePrefs(); renderMatches();
}

function shiftDay(d) {
  const dt = new Date(STATE.date);
  dt.setDate(dt.getDate() + d);
  STATE.date = dt.toISOString().slice(0, 10);
  $("#datePicker").value = STATE.date;
  loadAll();
}

function switchTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tabpane").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "tickets") loadTickets();
  if (name === "alerts") loadAlerts();
  if (name === "bankroll") loadBankroll();
  if (name === "calib") { if (!$("#calibResult").innerHTML) runCalib(); }
  if (name === "tips") loadTips();
  if (name === "tomorrow") loadTomorrow();
  if (name === "analytics") loadAnalytics();
  if (name === "settings" && !APP_SETTINGS) loadSettings();
  // na mobilu zavřít vysunutou boční lištu po výběru sekce
  $("#sidebar").classList.remove("mobile-open");
  document.body.classList.remove("nav-backdrop");
}

// ---------- BOČNÍ NAVIGACE ----------
function initSidebar() {
  const sidebar = $("#sidebar");
  if (localStorage.getItem("ka_sidebar_collapsed") === "1") sidebar.classList.add("collapsed");
  $("#sidebarToggle").onclick = () => {
    const collapsed = sidebar.classList.toggle("collapsed");
    localStorage.setItem("ka_sidebar_collapsed", collapsed ? "1" : "0");
  };
  $("#mobileNavBtn").onclick = () => {
    sidebar.classList.toggle("mobile-open");
    document.body.classList.toggle("nav-backdrop", sidebar.classList.contains("mobile-open"));
  };
  document.body.addEventListener("click", e => {
    // klik mimo vysunutou boční lištu na mobilu ji zavře
    if (document.body.classList.contains("nav-backdrop") && !sidebar.contains(e.target) && e.target !== $("#mobileNavBtn")) {
      sidebar.classList.remove("mobile-open");
      document.body.classList.remove("nav-backdrop");
    }
  });
}

async function loadAll() {
  updateDayLabel();
  await loadBankroll();
  await loadMatches();
  loadAlerts();
}

// ---------- LIVE DETECTION ----------
const isLive = m => !!m.live;

function _startLiveRefresh() {
  if (_liveTimer) return;
  const sec = (APP_SETTINGS && APP_SETTINGS.model && APP_SETTINGS.model.live_refresh_sec) || 120;
  _liveTimer = setInterval(() => {
    if (STATE.data) {
      const hasLive = STATE.data.leagues.some(l => l.matches.some(isLive));
      if (hasLive) loadMatches(true);
      else { clearInterval(_liveTimer); _liveTimer = null; }
    }
  }, sec * 1000);
}

// ---------- ZÁPASY ----------
async function loadMatches(refresh = false) {
  $("#leagues").innerHTML = '<div class="loader">⚽ Načítám zápasy z celého světa…' +
    '<br><span style="font-size:13px">(první načtení okna může trvat ~20 s)</span></div>' +
    Array(6).fill('<div class="skel"></div>').join("");
  $("#tipBanner").innerHTML = "";
  try {
    const r = await fetch(`/api/matches?date=${STATE.date}&days=${STATE.days}&sport=${STATE.sport}${refresh ? "&refresh=1" : ""}`);
    STATE.data = await r.json();
  } catch (e) {
    $("#leagues").innerHTML = '<div class="empty">Nepodařilo se načíst data.</div>';
    return;
  }
  const lf = $("#leagueFilter");
  lf.innerHTML = '<option value="">Všechny ligy</option>' +
    STATE.data.leagues.map(l => `<option value="${esc(l.league)}">${l.flag} ${esc(l.league)} (${l.matches.length})</option>`).join("");
  renderStats();
  renderTip();
  renderMatches();

  // Automatický refresh live zápasů
  const allMatches = STATE.data.leagues.flatMap(l => l.matches);
  if (allMatches.some(isLive)) _startLiveRefresh();
}

function renderStats() {
  const d = STATE.data, b = STATE.bank || {};
  const profUp = (b.profit || 0) >= 0;
  const allMatches = d.leagues.flatMap(l => l.matches);
  const liveCount = allMatches.filter(isLive).length;
  const liveBadge = liveCount > 0
    ? `<div class="stat" style="border-color:rgba(255,93,108,.3)"><span class="ic">🔴</span><div><div class="v" style="color:var(--bad)">${liveCount}</div><div class="l">live${help("Právě probíhající zápasy. Automaticky se obnovují každou minutu.")}</div></div></div>`
    : "";
  $("#statsbar").innerHTML = `
    <div class="stat"><span class="ic">⚽</span><div><div class="v">${d.total_matches}</div><div class="l">zápasů</div></div></div>
    <div class="stat"><span class="ic">🌍</span><div><div class="v">${d.total_leagues}</div><div class="l">lig</div></div></div>
    <div class="stat val"><span class="ic">💎</span><div><div class="v">${d.value_count}</div><div class="l">value sázek${help("Sázky, kde je kurz vyšší, než odpovídá skutečné pravděpodobnosti — dlouhodobě výhodné.")}</div></div></div>
    ${liveBadge}
    <div class="stat"><span class="ic">💰</span><div><div class="v">${fmt(b.balance || 0)} ${STATE.currency}</div><div class="l">volný bank${help("Disponibilní zůstatek – peníze, které nejsou vázané v otevřených sázkách.")}</div></div></div>
    <div class="stat"><span class="ic">⏳</span><div><div class="v">${fmt(b.open_stake || 0)} ${STATE.currency}</div><div class="l">v riziku (${b.open_count || 0})${help("Otevřená expozice: součet vkladů v dosud nevyhodnocených sázkách. Profesionál ji sleduje vedle zůstatku.")}</div></div></div>
    <div class="stat ${profUp ? "good" : "bad"}"><span class="ic">${profUp ? "📈" : "📉"}</span><div><div class="v">${profUp ? "+" : ""}${fmt(b.profit || 0)}</div><div class="l">zisk · ROI ${b.roi || 0}%${help("Realizovaný zisk z vyhodnocených sázek. ROI = zisk / vsazená částka.", true)}</div></div></div>`;
  animateNums($("#statsbar"));
}

function renderTip() {
  const t = STATE.data.tip;
  const el = $("#tipBanner");
  if (!t) { el.innerHTML = ""; return; }
  const bv = t.best_value;
  el.innerHTML = `
    <div class="tipbanner" onclick='openTip()'>
      <span class="tip-ic">💎</span>
      <div class="tip-main">
        <div class="tip-k">Tip dne · nejvyšší value</div>
        <div class="tip-match">${esc(t.home)} – ${esc(t.away)}</div>
        <div class="tip-sub">${esc(t.league)} · ${t.date} ${t.time} · sázka: <b>${esc(bv.name)}</b> u ${esc(bv.best_book)}</div>
      </div>
      <div class="tip-odds"><div class="o">${bv.best_odds}</div><div class="ev">+${Math.round(bv.ev * 100)}% EV</div></div>
    </div>`;
}
function openTip() { if (STATE.data && STATE.data.tip) openMatch(STATE.data.tip); }

function renderMatches() {
  if (!STATE.data) return;
  const q = $("#search").value.toLowerCase().trim();
  const lgFilter = $("#leagueFilter").value;
  const cont = $("#leagues");
  cont.innerHTML = "";

  let leagues = STATE.data.leagues;
  if (lgFilter) leagues = leagues.filter(l => l.league === lgFilter);

  // Live bar pokud existují živé zápasy
  const allMs = leagues.flatMap(l => l.matches);
  const liveCount = allMs.filter(isLive).length;
  if (liveCount > 0) {
    const bar = document.createElement("div");
    bar.className = "live-bar";
    bar.innerHTML = `<span class="dot-live"></span> ${liveCount} živých zápasů – obnovuje se každou minutu`;
    cont.appendChild(bar);
  }

  let shown = 0;
  leagues.forEach(lg => {
    let ms = lg.matches.filter(m => {
      if (STATE.valueOnly && !m.best_value.is_value) return false;
      if (q && !(`${m.home} ${m.away} ${lg.league}`.toLowerCase().includes(q))) return false;
      return true;
    });
    if (!ms.length) return;
    ms = sortMatches(ms, STATE.sortBy);
    shown += ms.length;
    const nVal = ms.filter(m => m.best_value.is_value).length;
    const nLive = ms.filter(isLive).length;
    const collapsed = STATE.collapsed.has(lg.league);

    const el = document.createElement("div");
    el.className = "league" + (collapsed ? " collapsed" : "");
    const head = document.createElement("div");
    head.className = "league-head";
    const livePill = nLive ? `<span class="badge-n" style="color:var(--bad)">🔴 ${nLive}</span>` : "";
    head.innerHTML = `<span class="fl">${lg.flag}</span>
      <h2>${esc(lg.league)}</h2>
      <span class="cnt">${esc(lg.country)}
        ${nVal ? `<span class="badge-n" style="color:var(--val)">${nVal} 💎</span>` : ""}
        ${livePill}
        <span class="badge-n">${ms.length}</span>
        <span class="chev">▼</span></span>`;
    head.onclick = () => toggleLeague(lg.league);
    el.appendChild(head);
    const body = document.createElement("div");
    body.className = "league-body";
    ms.forEach(m => body.appendChild(matchEl(m)));
    el.appendChild(body);
    cont.appendChild(el);
  });
  if (!shown) cont.innerHTML += '<div class="empty">Žádné zápasy neodpovídají filtru.</div>';

  const allCol = leagues.length && leagues.every(l => STATE.collapsed.has(l.league));
  $("#collapseAll").textContent = allCol ? "⊞ Rozbalit" : "⊟ Sbalit";
}

function toggleLeague(name) {
  if (STATE.collapsed.has(name)) STATE.collapsed.delete(name);
  else STATE.collapsed.add(name);
  savePrefs(); renderMatches();
}

function sortMatches(ms, by) {
  const c = [...ms];
  // Live zápasy vždy nahoru
  if (by === "confidence") c.sort((a, b) => (isLive(b) - isLive(a)) || b.confidence - a.confidence);
  else if (by === "value") c.sort((a, b) => (isLive(b) - isLive(a)) || b.best_value.ev - a.best_value.ev);
  else c.sort((a, b) => (isLive(b) - isLive(a)) || ((a.date || "") + (a.time || "")).localeCompare((b.date || "") + (b.time || "")));
  return c;
}

function matchEl(m) {
  const el = document.createElement("div");
  const live = isLive(m);
  el.className = "match" + (m.best_value.is_value ? " val" : "") + (m.result ? " done" : "") + (live ? " live-match" : "");
  el.onclick = () => openMatch(m);

  const ks = keysFor(m);
  const p = m.probs;

  // Pravděpodobnostní bar (1/X/2 nebo 1/2)
  const phPct = (p.home * 100).toFixed(1);
  const pxPct = p.draw ? (p.draw * 100).toFixed(1) : null;
  const paPct = (p.away * 100).toFixed(1);
  const probTip = pxPct
    ? `1: ${phPct}% | X: ${pxPct}% | 2: ${paPct}%`
    : `1: ${phPct}% | 2: ${paPct}%`;
  const probBar = `<div class="probbar" title="${probTip}">
    <span class="pb-h" style="width:${phPct}%"></span>
    ${pxPct ? `<span class="pb-x" style="width:${pxPct}%"></span>` : ""}
    <span class="pb-a" style="width:${paPct}%"></span>
  </div>`;

  // Live nebo výsledek
  const liveBadge = live
    ? `<span class="live-badge">LIVE</span>`
    : (m.result ? `<span class="res">${m.result.home}:${m.result.away}</span>` : "");
  const dchip = STATE.days > 1 && m.date
    ? `<span class="dchip">${m.date.slice(8, 10)}.${m.date.slice(5, 7)}.</span>` : "";

  // Trend šipky
  const trendH = m.form?.home_trend;
  const trendA = m.form?.away_trend;
  const trendEl = t => t === "up" ? `<span class="trend up">▲</span>` : t === "down" ? `<span class="trend dn">▼</span>` : "";

  // Odds boxy
  const oddBox = k => {
    const v = m.value[k];
    const cls = "odd" + (m.pick === k ? " pick" : "") + (v.is_value ? " value" : "");
    const ev = v.is_value ? `<div class="ev">+${Math.round(v.ev * 100)}%</div>` : "";
    // implikovaná pravděpodobnost modelu pod kurzem – klíčový kontext pro sázkaře
    const imp = `<div class="imp">${Math.round((m.probs[k] || 0) * 100)}%</div>`;
    return `<div class="${cls}"><div class="k">${LBL[k] || k}</div><div class="o">${v.best_odds}</div>${imp}${ev}</div>`;
  };

  el.innerHTML = `
    <div class="m-time">${dchip}${live ? "" : (m.time || "--:--")}${liveBadge}
      ${live && m.status ? `<span style="font-size:10px;color:var(--bad)">${esc(m.status)}</span>` : ""}
    </div>
    <div class="m-teams">
      <div class="t ${m.pick === "home" ? "win" : ""}">${avatarEl(m.home)}${trendEl(trendH)} ${esc(m.home)} ${formEl(m.form?.home)}</div>
      <div class="t ${m.pick === "away" ? "win" : ""}">${avatarEl(m.away)}${trendEl(trendA)} ${esc(m.away)} ${formEl(m.form?.away)}</div>
      ${probBar}
      <div class="conf"><span>jistota ${m.confidence}%</span>
        <div class="bar"><span class="${m.confidence >= 55 ? "hi" : m.confidence >= 35 ? "md" : "lo"}" style="width:${m.confidence}%"></span></div></div>
    </div>
    <div class="m-odds">${ks.map(oddBox).join("")}</div>`;
  return el;
}

function formEl(form) {
  if (!form || !Array.isArray(form)) return "";
  return `<span class="form">${form.map(f => `<i class="${f}">${f}</i>`).join("")}</span>`;
}

// ---------- VYCHYTÁVKY UI ----------
// Barevný avatar týmu – deterministický odstín z názvu, iniciály ze dvou slov
const _hue = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; };
function avatarEl(name) {
  const parts = (name || "?").trim().split(/\s+/);
  const ini = ((parts[0][0] || "?") + (parts[1] ? parts[1][0] : (parts[0][1] || ""))).toUpperCase();
  return `<span class="avat" style="--h:${_hue(name)}">${esc(ini)}</span>`;
}

// Animované počítadlo hodnot ve stat kartách
function animateNums(root) {
  if (!root) return;
  root.querySelectorAll(".stat .v").forEach(el => {
    const txt = el.textContent;
    const mm = txt.match(/-?\d[\d\s]*(?:[.,]\d+)?/);
    if (!mm) return;
    const raw = mm[0];
    const num = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
    if (isNaN(num) || Math.abs(num) > 1e7) return;
    const dec = (raw.match(/[.,](\d+)/) || [, ""])[1].length;
    const t0 = performance.now(), dur = 550;
    const step = t => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);   // ease-out
      el.textContent = txt.replace(raw, (num * e).toFixed(dec).replace(".", ","));
      if (p < 1) requestAnimationFrame(step); else el.textContent = txt;
    };
    requestAnimationFrame(step);
  });
}

// Chip s relativním dnem vedle date pickeru
const _WDAYS = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
function updateDayLabel() {
  const el = $("#dayLabel");
  if (!el) return;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sel = new Date(STATE.date + "T00:00:00");
  const diff = Math.round((sel - today) / 86400000);
  let label = _WDAYS[sel.getDay()];
  if (diff === 0) label = "Dnes";
  else if (diff === 1) label = "Zítra";
  else if (diff === -1) label = "Včera";
  el.textContent = label;
  el.style.color = diff === 0 ? "var(--pos)" : diff > 0 ? "var(--acc2)" : "var(--mut)";
}

// ---------- TIPSPORT (rozcestník – uživatel sází sám ve svém účtu) ----------
// ESPN dává reprezentace anglicky, Tipsport je má česky – bez překladu vyhledání nic nenajde.
// Kluby se většinou jmenují mezinárodně stejně, takže stačí mapa zemí.
const CZ_COUNTRY = {
  "england":"Anglie","scotland":"Skotsko","wales":"Wales","northern ireland":"Severní Irsko",
  "ireland":"Irsko","france":"Francie","germany":"Německo","spain":"Španělsko","italy":"Itálie",
  "portugal":"Portugalsko","netherlands":"Nizozemsko","belgium":"Belgie","croatia":"Chorvatsko",
  "serbia":"Srbsko","switzerland":"Švýcarsko","austria":"Rakousko","poland":"Polsko",
  "czech republic":"Česko","czechia":"Česko","slovakia":"Slovensko","hungary":"Maďarsko",
  "romania":"Rumunsko","bulgaria":"Bulharsko","greece":"Řecko","turkey":"Turecko","türkiye":"Turecko",
  "denmark":"Dánsko","sweden":"Švédsko","norway":"Norsko","finland":"Finsko","iceland":"Island",
  "russia":"Rusko","ukraine":"Ukrajina","belarus":"Bělorusko","slovenia":"Slovinsko",
  "bosnia and herzegovina":"Bosna a Hercegovina","north macedonia":"Severní Makedonie",
  "albania":"Albánie","montenegro":"Černá Hora","kosovo":"Kosovo","moldova":"Moldavsko",
  "georgia":"Gruzie","armenia":"Arménie","azerbaijan":"Ázerbájdžán","estonia":"Estonsko",
  "latvia":"Lotyšsko","lithuania":"Litva","luxembourg":"Lucembursko","malta":"Malta",
  "cyprus":"Kypr","israel":"Izrael","faroe islands":"Faerské ostrovy","gibraltar":"Gibraltar",
  "brazil":"Brazílie","argentina":"Argentina","uruguay":"Uruguay","chile":"Chile",
  "colombia":"Kolumbie","peru":"Peru","ecuador":"Ekvádor","paraguay":"Paraguay","bolivia":"Bolívie",
  "venezuela":"Venezuela","mexico":"Mexiko","united states":"USA","usa":"USA","canada":"Kanada",
  "costa rica":"Kostarika","honduras":"Honduras","panama":"Panama","jamaica":"Jamajka",
  "japan":"Japonsko","south korea":"Jižní Korea","korea republic":"Jižní Korea",
  "north korea":"Severní Korea","china":"Čína","china pr":"Čína","australia":"Austrálie",
  "new zealand":"Nový Zéland","saudi arabia":"Saúdská Arábie","iran":"Írán","iraq":"Irák",
  "qatar":"Katar","united arab emirates":"Spojené arabské emiráty","jordan":"Jordánsko",
  "uzbekistan":"Uzbekistán","india":"Indie","thailand":"Thajsko","vietnam":"Vietnam",
  "indonesia":"Indonésie","egypt":"Egypt","morocco":"Maroko","algeria":"Alžírsko","tunisia":"Tunisko",
  "nigeria":"Nigérie","senegal":"Senegal","ghana":"Ghana","cameroon":"Kamerun",
  "ivory coast":"Pobřeží slonoviny","mali":"Mali","south africa":"Jihoafrická republika",
  "dr congo":"DR Kongo","burkina faso":"Burkina Faso","cape verde":"Kapverdy","angola":"Angola",
};
const _AGE_SUFFIX = /\s+(U1[5-9]|U2[0-3]|W|B)$/i;

function _czTeam(name) {
  // oddělí mládežnický/ženský přívlastek (U19, W…), přeloží zemi, přívlastek vrátí zpět
  let suffix = "";
  let base = (name || "").trim();
  const mt = base.match(_AGE_SUFFIX);
  if (mt) { suffix = " " + mt[1].toUpperCase(); base = base.replace(_AGE_SUFFIX, "").trim(); }
  const cz = CZ_COUNTRY[base.toLowerCase()];
  return (cz || base) + suffix;
}
function tipsportUrl(home, away) {
  // Tipsport má vyhledávání jako JS aplikaci, která nečte parametr z URL – přímý
  // odkaz na jejich search proto nefunguje. Spolehlivě zápas najde Google s klíčovým
  // slovem „tipsport" (Tipsport dá nahoru, ale stránka není prázdná ani u neindexovaného
  // zápasu). Reprezentace překládáme do CZ, ať Google trefí správný zápas.
  const q = `${_czTeam(home)} ${_czTeam(away)} tipsport`;
  return "https://www.google.com/search?q=" + encodeURIComponent(q);
}
function tipsportBtn(home, away, label) {
  // obyčejný odkaz – otevře se až po kliknutí uživatele; přes Google najde zápas na Tipsportu
  return `<a class="tipsport-btn" href="${tipsportUrl(home, away)}" target="_blank" rel="noopener noreferrer"
    title="Najde zápas na Tipsport.cz přes Google (jejich vlastní vyhledávání neumí přímý odkaz). Klikni na výsledek, přihlas se a sázku potvrdíš sám – appka nic neodesílá.">🎯 ${esc(label || "Najít na Tipsportu")} ↗</a>`;
}

// ---------- DETAIL ZÁPASU ----------
function openMatch(m) {
  const p = m.probs;
  const ks = keysFor(m);

  // Pravděpodobnostní vizualizace (velký bar)
  const probViz = ks.map(k => {
    const segCls = k === "home" ? "pv-h" : k === "draw" ? "pv-x" : "pv-a";
    const lbl = m.bets[k].label;
    return `<div class="pv-seg ${segCls}" style="flex:${p[k]}">
      <span class="pv-lbl">${lbl}</span>
      <span class="pv-pct">${pct(p[k])}</span>
    </div>`;
  }).join("");

  const books = m.books.map(b => {
    const cell = k => {
      const isBest = b.odds[k] === m.value[k].best_odds;
      return `<td class="${isBest ? "best" : ""}">${b.odds[k]}</td>`;
    };
    return `<tr class="${b.sharp ? "sharp" : ""}"><td>${esc(b.name)}${b.sharp ? " ★" : ""}</td>
      ${ks.map(cell).join("")}</tr>`;
  }).join("");

  const mlLabel = m.two_way ? "Vítěz (1/2)" : "Výsledek 1X2";
  const betGroups = [
    [mlLabel, ks],
    [`Více / méně ${m.unit}`, m.goal_lines.flatMap(g => [`over${g.line}`, `under${g.line}`])],
  ];
  if (!m.two_way) betGroups.push(["Oba dají gól (BTTS)", ["btts_yes", "btts_no"]]);
  const betOpts = betGroups.map(([gname, keys]) =>
    `<optgroup label="${gname}">` + keys.map(k => {
      const b = m.bets[k];
      return `<option value="${k}">${esc(b.name)} @ ${b.best_odds} (${esc(b.best_book)})${b.is_value ? " 💎" : ""}</option>`;
    }).join("") + "</optgroup>").join("");

  const ouCell = (o, key) =>
    `<td class="ou-cell ${o.is_value ? "value" : ""}" onclick="selectBet('${key}')" title="klikni pro vsazení">
       <div class="ou-o">${o.best_odds}</div><div class="ou-p">${pct(o.prob)}</div>
       ${o.is_value ? `<div class="ou-ev">+${Math.round(o.ev * 100)}%</div>` : ""}</td>`;
  const goalRows = m.goal_lines.map(g =>
    `<tr><td class="ou-line">${g.line}</td>${ouCell(g.over, "over" + g.line)}${ouCell(g.under, "under" + g.line)}</tr>`).join("");

  const probBoxes = ks.map(k =>
    `<div class="mbox"><div class="l">${m.bets[k].name}</div><div class="v">${pct(p[k])}</div></div>`).join("");

  const expBox = m.two_way
    ? `<div class="mbox"><div class="l">Očekávaný součet ${m.unit}</div><div class="v">${m.exp_total}</div></div>`
    : `<div class="mbox"><div class="l">Očekávané góly</div><div class="v">${m.exp_goals.home} : ${m.exp_goals.away}</div></div>`;

  const bttsHtml = m.two_way ? "" : `
    <div class="mrow" style="margin-top:10px">
      <div class="mbox ${m.bets.btts_yes.is_value ? "valbox" : ""}" style="cursor:pointer" onclick="selectBet('btts_yes')">
        <div class="l">Oba dají gól – Ano</div><div class="v">${m.bets.btts_yes.best_odds} <span style="font-size:12px;color:var(--mut)">${pct(m.bets.btts_yes.prob)}</span></div></div>
      <div class="mbox ${m.bets.btts_no.is_value ? "valbox" : ""}" style="cursor:pointer" onclick="selectBet('btts_no')">
        <div class="l">Oba dají gól – Ne</div><div class="v">${m.bets.btts_no.best_odds} <span style="font-size:12px;color:var(--mut)">${pct(m.bets.btts_no.prob)}</span></div></div>
    </div>`;

  // Score heatmap (jen pro fotbal)
  const heatmapHtml = (m.score_matrix && m.score_matrix.length) ? _scoreHeatmap(m) : "";

  const consHint = ks.map(k => `${m.bets[k].label} ${pct(m.consensus[k])}`).join(" · ");
  const oddsBadge = m.odds_source === "real"
    ? ' <span style="background:rgba(255,92,92,.18);color:var(--bad);font-size:11px;padding:2px 8px;border-radius:8px;vertical-align:middle">🔴 reálné kurzy</span>'
    : ' <span style="background:rgba(255,255,255,.05);color:var(--mut);font-size:11px;padding:2px 8px;border-radius:8px;vertical-align:middle">modelované kurzy</span>';
  const liveBadgeModal = isLive(m)
    ? ` <span style="background:var(--bad);color:#fff;font-size:11px;padding:2px 8px;border-radius:8px;animation:livepulse 1.4s infinite">🔴 LIVE ${m.status ? "· " + m.status : ""}</span>`
    : "";

  CUR = m;
  $("#modalBox").innerHTML = `
    <button class="modal-close" onclick="closeModal()">×</button>
    <h2><span class="teamlink" onclick="openTeam(0)">${esc(m.home)}</span>
      <span style="color:var(--mut)"> vs </span>
      <span class="teamlink" onclick="openTeam(1)">${esc(m.away)}</span></h2>
    <div class="sub">${esc(m.league)} · ${m.date} ${m.time} · Elo ${m.rating_home} – ${m.rating_away}${oddsBadge}${liveBadgeModal}</div>

    <div class="tipsport-row">
      ${tipsportBtn(m.home, m.away, "Najít na Tipsportu")}
      <span class="hint">Přes Google najde zápas na Tipsport.cz (jejich vlastní vyhledávání neumí přímý odkaz). Klikni na výsledek, přihlas se a sázku potvrdíš sám. Appka nic neodesílá.</span>
    </div>

    <div class="prob-viz">${probViz}</div>

    <div class="mrow">
      <div class="mbox"><div class="l">Predikce${help("Nejpravděpodobnější výsledek podle Dixon-Coles Poisson modelu.")}</div><div class="v">${m.bets[m.pick].name}</div></div>
      <div class="mbox"><div class="l">Jistota${help("Entropická jistota 0–99 %. Vyšší = jasnější favorit (méně nejistoty v distribuci).")}</div><div class="v">${m.confidence}%</div></div>
      ${expBox}
    </div>
    <div class="mrow">${probBoxes}</div>

    <div id="formArea"></div>

    ${heatmapHtml}

    <h3 style="margin:18px 0 6px">📊 Více / méně ${m.unit} (Over / Under)${help("Sázka na to, jestli celkem padne víc nebo míň " + m.unit + " než daná hranice.")}</h3>
    <table class="goaltable"><thead><tr><th>hranice</th>
      <th>📈 Více (Over)</th><th>📉 Méně (Under)</th></tr></thead>
      <tbody>${goalRows}</tbody></table>
    ${bttsHtml}
    <p class="hint">Klikni na kurz pro vsazení. 💎 = value (kurz nad férovou cenou modelu).</p>

    <h3 style="margin:18px 0 4px">Kurzy sázkových kanceláří ${m.two_way ? "(1/2)" : "1X2"} (★ = sharp${help("Sharp = sázkovka s nejpřesnějšími kurzy a nízkou marží, např. Pinnacle.")})</h3>
    <table class="booktable"><thead><tr><th>Sázkovka</th>${ks.map(k => `<th>${m.bets[k].label}</th>`).join("")}</tr></thead>
      <tbody>${books}</tbody></table>
    <p class="hint">Zvýrazněný kurz = nejlepší na trhu. Konsenzus: ${consHint}.</p>

    ${m.result && !isLive(m) ? `
    <div class="finished-note">
      🏁 Zápas skončil <b>${m.result.home}:${m.result.away}</b> – nelze na něj vsadit ani znovu zadat výsledek (engine se z něj už naučil).
    </div>` : `
    <div class="betform">
      <label>Sázka na<select id="betOutcome">${betOpts}</select></label>
      <label>Kurz<input type="number" id="betOdds" step="0.01" value="${m.bets[m.pick].best_odds}"></label>
      <label>Vklad (${STATE.currency})<input type="number" id="betStake" step="10"></label>
      <button class="ghost" type="button" onclick="suggestKelly()"
        style="border:1px solid var(--line);border-radius:9px;padding:9px 12px;background:var(--surf2);color:var(--txt)">🎯 Kelly</button>
      <button class="addslip" type="button" onclick="addToSlip()">➕ do tiketu</button>
      <button class="primary" type="button" onclick="placeBet()">Vsadit</button>
    </div>

    <div class="resform">
      <span class="hint" style="margin-right:auto">Znáš výsledek? Engine se z něj naučí (Elo):</span>
      <input type="number" id="resH" placeholder="dom" min="0">:
      <input type="number" id="resA" placeholder="host" min="0">
      <button class="ghost" type="button" onclick="reportResult()"
        style="border:1px solid var(--line);border-radius:9px;padding:8px 12px;background:var(--surf2);color:var(--txt)">Uložit výsledek</button>
    </div>`}`;

  if ($("#betOutcome")) $("#betOutcome").onchange = () => { $("#betOdds").value = CUR.bets[$("#betOutcome").value].best_odds; };
  $("#modal").classList.remove("hidden");
  loadRealForm(m);
}
function closeModal() { $("#modal").classList.add("hidden"); }

// ---------- SCORE HEATMAP ----------
function _scoreHeatmap(m) {
  const mx = m.score_matrix;  // 4x4 array [home_goals][away_goals]
  const maxP = Math.max(...mx.flat());
  if (maxP <= 0) return "";

  const cell = (homeG, awayG) => {
    const p = mx[homeG][awayG];
    const intensity = maxP > 0 ? p / maxP : 0;
    // Barva: tmavá → červená pro nejvyšší pravděpodobnost
    const r = Math.round(30 + intensity * 180);
    const g = Math.round(40 + intensity * 60);
    const b = Math.round(55 + intensity * 20);
    const alpha = 0.25 + intensity * 0.65;
    const isTop = p === maxP;
    return `<td class="hm-cell ${isTop ? "value" : ""}"
      style="background:rgba(${r},${g},${b},${alpha.toFixed(2)})"
      onclick="selectBet('over2.5')" title="${homeG}:${awayG} – ${p}%">
      <div class="hc-score">${homeG}:${awayG}</div>
      <div class="hc-pct">${p}%</div>
    </td>`;
  };

  let rows = "";
  for (let h = 0; h < 4; h++) {
    rows += "<tr>";
    for (let a = 0; a < 4; a++) rows += cell(h, a);
    rows += "</tr>";
  }

  return `
    <h3 style="margin:18px 0 6px">🎯 Pravděpodobnost skóre${help("Heatmapa nejpravděpodobnějších výsledků (Dixon-Coles model). Tmavší = pravděpodobnější.")}</h3>
    <p class="hint" style="margin-bottom:8px">Řádky = góly domácích (0–3), sloupce = góly hostů (0–3). Nejpravděpodobnější skóre svítí.</p>
    <div class="score-heatmap">
      <table class="hm-table">
        <thead><tr>
          <th class="hm-head"></th>
          ${[0,1,2,3].map(a => `<th class="hm-head">hosté ${a}</th>`).join("")}
        </tr></thead>
        <tbody>
          ${[0,1,2,3].map(h => `<tr>
            <td class="hm-head">dom. ${h}</td>
            ${[0,1,2,3].map(a => cell(h, a)).join("")}
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

async function loadRealForm(m) {
  const area = $("#formArea");
  if (!area) return;
  if (!m.home_id && !m.away_id) return;
  area.innerHTML = '<p class="hint">Načítám skutečnou formu z ESPN…</p>';
  let d;
  try {
    d = await (await fetch(`/api/form?sport=${m.sport}&slug=${encodeURIComponent(m.slug)}` +
      `&home_id=${m.home_id}&away_id=${m.away_id}&home=${encodeURIComponent(m.home)}&away=${encodeURIComponent(m.away)}`)).json();
  } catch (e) { area.innerHTML = ""; return; }
  if (CUR !== m) return;
  const col = (title, games) => `<div class="formcol"><div class="ttl">${esc(title)}
    ${games.length ? `<span style="color:var(--mut);font-weight:400">${games.map(g => g.res).join(" ")}</span>` : ""}</div>
    ${games.length ? games.map(g => `<div class="fgame"><span class="rb ${g.res}">${g.res}</span>
      <span>${g.home ? "🏠" : "✈️"} ${esc(g.opp)}</span><span class="sc">${g.gf}:${g.ga}</span>
      <span style="color:var(--dim)">${g.date.slice(5)}</span></div>`).join("")
      : '<span class="hint">Nedostupné</span>'}</div>`;
  const h2hHtml = d.h2h && d.h2h.length ? `<div class="h2hbox"><div class="ttl" style="font-weight:700;margin-bottom:6px">⚔️ Vzájemné zápasy</div>
    ${d.h2h.map(g => `<div class="fgame"><span class="rb ${g.res}">${g.res}</span>
      <span>${esc(m.home)} vs ${esc(g.opp)}</span><span class="sc">${g.gf}:${g.ga}</span>
      <span style="color:var(--dim)">${g.date.slice(0, 4)}</span></div>`).join("")}</div>` : "";
  area.innerHTML = `<h3 style="margin:6px 0 8px">🔥 Skutečná forma (posledních ${Math.max(d.home.length, d.away.length)})</h3>
    ${h2hHtml}<div class="formrow">${col(m.home, d.home)}${col(m.away, d.away)}</div>`;
}

function selectBet(key) {
  if (!CUR.bets[key]) return;
  $("#betOutcome").value = key;
  $("#betOdds").value = CUR.bets[key].best_odds;
  $("#betStake").focus();
  toast("Vybráno: " + CUR.bets[key].name + " @ " + CUR.bets[key].best_odds);
}

async function suggestKelly() {
  const b = CUR.bets[$("#betOutcome").value];
  const odds = parseFloat($("#betOdds").value);
  const r = await fetch(`/api/kelly?prob=${b.prob}&odds=${odds}`);
  const d = await r.json();
  $("#betStake").value = d.stake;
  if (d.stake <= 0) toast("Kelly nedoporučuje sázku (žádná výhoda).", true);
  else toast(`Kelly doporučuje ${fmt(d.stake)} ${STATE.currency} (${Math.round(d.fraction*100)}% frakce).`);
}

async function placeBet() {
  const k = $("#betOutcome").value;
  const b = CUR.bets[k];
  const odds = parseFloat($("#betOdds").value);
  const stake = parseFloat($("#betStake").value);
  if (!stake || stake <= 0) return toast("Zadej výši vkladu.", true);
  const cons = b.market_prob ? 1 / b.market_prob : null;
  const r = await fetch("/api/bet", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ match_id: CUR.id, label: b.label, outcome: k, odds, prob: b.prob,
      stake, home: CUR.home, away: CUR.away, consensus_odds: cons,
      match_date: CUR.date, match_time: CUR.time })
  });
  const d = await r.json();
  if (d.error) return toast(d.error, true);
  STATE.bank = d.stats; renderStats(); updateBankChip();
  toast(`Vsazeno ${fmt(stake)} ${STATE.currency} @ ${odds} ✓`);
  closeModal();
}

async function reportResult() {
  const hs = $("#resH").value, as = $("#resA").value;
  if (hs === "" || as === "") return toast("Zadej obě skóre.", true);
  await fetch("/api/result", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ home: CUR.home, away: CUR.away, league: CUR.league,
      home_score: hs, away_score: as })
  });
  toast("Výsledek uložen, engine aktualizoval ratingy. ✓");
  closeModal();
  loadMatches(false);
}

// ---------- TIKET (košík) ----------
function addToSlip() {
  const k = $("#betOutcome").value;
  const b = CUR.bets[k];
  const odds = parseFloat($("#betOdds").value) || b.best_odds;
  if (STATE.slip.some(l => l.match_id === CUR.id && l.outcome === k))
    return toast("Tento výběr už v tiketu je.", true);
  if (STATE.slip.some(l => l.match_id === CUR.id))
    return toast("Z jednoho zápasu jde do tiketu jen jeden výběr.", true);
  STATE.slip.push({ match_id: CUR.id, match: `${CUR.home} – ${CUR.away}`,
    outcome: k, name: b.name, odds, prob: b.prob, date: CUR.date, time: CUR.time });
  savePrefs(); updateSlipBtn(); renderSlip();
  toast("Přidáno do tiketu ✓");
}
function removeLeg(i) { STATE.slip.splice(i, 1); savePrefs(); updateSlipBtn(); renderSlip(); }
function clearSlip() { STATE.slip = []; savePrefs(); updateSlipBtn(); renderSlip(); }
function updateSlipBtn() {
  const n = STATE.slip.length;
  $("#slipBtn").classList.toggle("hidden", n === 0);
  $("#slipCount").textContent = n;
  if (n === 0) $("#slipPanel").classList.add("hidden");
}
function toggleSlip() { $("#slipPanel").classList.toggle("hidden"); renderSlip(); }
function renderSlip() {
  const panel = $("#slipPanel");
  if (panel.classList.contains("hidden")) return;
  if (!STATE.slip.length) { panel.innerHTML = '<div class="empty">Tiket je prázdný.</div>'; return; }
  let odds = 1, prob = 1;
  STATE.slip.forEach(l => { odds *= l.odds; prob *= l.prob; });
  const ev = odds * prob - 1;
  panel.innerHTML = `
    <h3>🧾 Tiket <button onclick="clearSlip()">vymazat</button></h3>
    ${STATE.slip.map((l, i) => `<div class="slip-leg">
      <button class="x" onclick="removeLeg(${i})">×</button>
      <span>${esc(l.name)}<br><span style="color:var(--mut);font-size:11px">${esc(l.match)}</span></span>
      <span class="od">${l.odds}</span></div>`).join("")}
    <div class="slip-sum"><span>Kombinovaný kurz</span><b>${(Math.round(odds*100)/100)}</b></div>
    <div class="slip-sum" style="font-size:13px;color:var(--mut)">
      <span>Pravděpodobnost ${(prob*100).toFixed(1)}%</span>
      <span class="tag-ev">EV ${ev>=0?"+":""}${Math.round(ev*100)}%</span></div>
    <input type="number" id="slipStake" placeholder="Vklad (${STATE.currency})" step="10">
    <button class="primary" style="width:100%" onclick="placeAcca()">Vsadit tiket (${STATE.slip.length})</button>`;
}
async function placeAcca() {
  const stake = parseFloat($("#slipStake").value);
  if (!stake || stake <= 0) return toast("Zadej výši vkladu.", true);
  const r = await fetch("/api/bet/acca", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ legs: STATE.slip, stake })
  });
  const d = await r.json();
  if (d.error) return toast(d.error, true);
  STATE.bank = d.stats; renderStats(); updateBankChip();
  toast(`Tiket vsazen @ ${d.bet.odds} ✓ (najdeš ho v záložce Tikety dne → Moje tikety)`);
  clearSlip();
  if ($("#tab-tickets").classList.contains("active")) loadMyTickets();
}

// ---------- TIKETY ----------
async function loadTickets() {
  loadMyTickets();
  const c = $("#tickets");
  c.innerHTML = '<div class="loader">Sestavuji tikety dne…</div>';
  const r = await fetch(`/api/tickets?date=${STATE.date}&days=${STATE.days}&sport=${STATE.sport}`);
  const d = await r.json();
  if (!d.tickets.length) { c.innerHTML = '<div class="empty">Pro tento den nejsou žádné tikety.</div>'; return; }
  c.innerHTML = d.tickets.map(t => `
    <div class="ticket">
      <h3>${t.name}</h3><div class="desc">${t.desc}</div>
      ${t.legs.map(l => `<div class="leg">
        <span class="pill">${l.label}</span>
        <span>${esc(l.match)}<br><span class="bk">${esc(l.league)} · ${esc(l.book)}</span></span>
        <span class="od">${l.odds}</span></div>`).join("")}
      <div class="ticket-foot">
        <div><div class="hint">Celkový kurz</div><div class="big">${t.total_odds}</div></div>
        <div><div class="hint">Pravděpodobnost</div><div class="big" style="color:var(--acc2)">${(t.combined_prob*100).toFixed(1)}%</div></div>
        <span class="tag-ev">EV ${t.ev>=0?"+":""}${Math.round(t.ev*100)}%</span>
      </div>
    </div>`).join("");
}

// Moje vsazené tikety (akumulátory z banku)
async function loadMyTickets() {
  const c = $("#myTickets");
  if (!c) return;
  let bets;
  try {
    bets = (await (await fetch("/api/bankroll")).json()).bets || [];
  } catch (e) { c.innerHTML = '<div class="empty">Nepodařilo se načíst tikety.</div>'; return; }
  const accas = bets.filter(b => b.outcome === "acca");
  if (!accas.length) {
    c.innerHTML = '<div class="empty">Zatím nemáš žádný vsazený tiket. Sestav si ho v 🧾 košíku (přidej výběry „➕ do tiketu" v detailu zápasu) a vsaď.</div>';
    return;
  }
  c.innerHTML = accas.map(b => {
    const st = b.status;
    const statusBadge = st === "open"
      ? `<button onclick="settle('${b.id}','won')" class="tk-set won">✓ Vyhrál</button><button onclick="settle('${b.id}','lost')" class="tk-set lost">✗ Prohrál</button>`
      : `<span class="badge ${st}">${st === "won" ? "výhra" : st === "lost" ? "prohra" : "void"}</span>`;
    const pnlCls = b.pnl > 0 ? "pnl-pos" : (b.pnl < 0 ? "pnl-neg" : "");
    const pnl = st === "open" ? "" : `<span class="${pnlCls}" style="font-weight:700">${b.pnl >= 0 ? "+" : ""}${fmt(b.pnl)} ${STATE.currency}</span>`;
    const legs = (b.legs || []).map(l => {
      const w = matchWhen(l.date, l.time);
      return `<div class="leg">
        <span>${esc(l.name)}<br><span class="bk">${esc(l.match)}${w ? " · " + esc(w) : ""}</span></span>
        <span class="od">${l.odds}</span></div>`;
    }).join("");
    const firstWhen = matchWhen(b.match_date, b.match_time);
    return `<div class="ticket myticket">
      <h3>${esc(b.label)} <span class="hint" style="font-weight:400">· vklad ${fmt(b.stake)} ${STATE.currency}${firstWhen ? " · první výkop " + esc(firstWhen) : ""}</span></h3>
      ${legs}
      <div class="ticket-foot">
        <div><div class="hint">Kombinovaný kurz</div><div class="big">${b.odds}</div></div>
        <div><div class="hint">Možná výhra</div><div class="big" style="color:var(--pos)">${fmt(b.stake * b.odds)} ${STATE.currency}</div></div>
        <span style="display:flex;gap:8px;align-items:center;margin-left:auto">${pnl}${statusBadge}</span>
      </div>
    </div>`;
  }).join("");
}

// ---------- ALERTY ----------
async function loadAlerts() {
  const r = await fetch(`/api/alerts?date=${STATE.date}&days=${STATE.days}&sport=${STATE.sport}`);
  const d = await r.json();
  $("#alertDot").classList.toggle("hidden", !d.alerts.some(a => a.level === "high"));
  const c = $("#alerts");
  if (!c) return;
  const ic = { value: "💎", corner_value: "🚩", movement: "📈", confidence: "🎯" };
  c.innerHTML = d.alerts.length ? d.alerts.map(a => `
    <div class="alert ${a.level}"><span class="ic">${ic[a.type] || "🔔"}</span>
      <div><div>${esc(a.text)}</div><div class="mt">${esc(a.match)}</div></div></div>`).join("")
    : '<div class="empty">Žádné alerty pro tento den.</div>';
}

// ---------- BANKROLL ----------
async function loadBankroll() {
  const r = await fetch("/api/bankroll");
  const d = await r.json();
  STATE.bank = d.stats;
  STATE.currency = d.stats.currency;
  updateBankChip();
  $("#setBalance").value = d.stats.start_balance;
  $("#setCurrency").value = d.stats.currency;
  $("#setKelly").value = d.stats.kelly_fraction;
  $("#kellyVal").textContent = d.stats.kelly_fraction;
  renderBankStats(d.stats);
  drawEquity(d.stats.equity || []);
  renderBets(d.bets);
  if (STATE.data) renderStats();
}

function renderBankStats(s) {
  const el = $("#bankStats");
  if (!el) return;
  const profUp = s.profit >= 0;
  el.innerHTML = `
    <div class="stat ${profUp ? "good" : "bad"}"><span class="ic">💰</span><div><div class="v">${fmt(s.balance)} ${s.currency}</div><div class="l">aktuální bank</div></div></div>
    <div class="stat ${profUp ? "good" : "bad"}"><span class="ic">${profUp ? "📈" : "📉"}</span><div><div class="v">${profUp ? "+" : ""}${fmt(s.profit)}</div><div class="l">celkový zisk</div></div></div>
    <div class="stat"><span class="ic">🎯</span><div><div class="v">${s.roi}%</div><div class="l">ROI${help("Návratnost = zisk / celková vsazená částka.")}</div></div></div>
    <div class="stat"><span class="ic">✅</span><div><div class="v">${s.win_rate}%</div><div class="l">úspěšnost (${s.won_count}/${s.settled_count})</div></div></div>
    <div class="stat ${s.avg_clv != null && s.avg_clv >= 0 ? "good" : (s.avg_clv != null ? "bad" : "")}"><span class="ic">🎲</span><div><div class="v">${s.avg_clv == null ? "–" : (s.avg_clv >= 0 ? "+" : "") + s.avg_clv + "%"}</div><div class="l">CLV${help("Vzal jsi lepší kurz než tržní konsenzus? Kladné CLV = dobré sázení.", true)}</div></div></div>
    <div class="stat"><span class="ic">⏳</span><div><div class="v">${s.open_count}</div><div class="l">otevřené (${fmt(s.open_stake)} ${s.currency})</div></div></div>`;
}

async function autoSettle() {
  const btn = $("#autoSettle");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "⏳ Kontroluji výsledky… (může trvat ~1 min)"; btn.disabled = true; }
  try {
    const r = await fetch("/api/bet/autosettle", { method: "POST" });
    const d = await r.json();
    STATE.bank = d.stats;
    let msg = d.settled ? `Vyhodnoceno ${d.settled} sázek podle čerstvých výsledků ✓` : "Žádné nové výsledky – zápasy ještě neskončily nebo jsou vyhodnocené.";
    if (d.more_pending) msg += " Zbývá starší záloha – klikni znovu.";
    toast(msg, !d.settled);
    loadBankroll();
    if ($("#tab-tomorrow").classList.contains("active")) loadAgentPanel();
  } catch (e) {
    toast("Kontrola výsledků se nezdařila.", true);
  } finally {
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

function drawEquity(eq) {
  const el = $("#equityChart");
  if (!el) return;
  if (eq.length < 2) {
    el.innerHTML = '<div class="empty" style="padding:30px">Zatím žádná historie. Vsaď a vyhodnoť tip, ať se nakreslí křivka.</div>';
    return;
  }
  const W = 600, H = 220, pad = 34;
  const min = Math.min(...eq), max = Math.max(...eq);
  const span = (max - min) || 1;
  const x = i => pad + i * (W - 2 * pad) / (eq.length - 1);
  const y = v => H - pad - (v - min) * (H - 2 * pad) / span;
  const start = eq[0];
  const pts = eq.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${pad},${H - pad} ${pts} ${x(eq.length - 1)},${H - pad}`;
  const last = eq[eq.length - 1];
  const up = last >= start;
  const col = up ? "var(--pos)" : "var(--bad)";
  const baseY = y(start);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${up ? "rgba(54,213,125,.35)" : "rgba(255,92,92,.35)"}"/>
        <stop offset="100%" stop-color="transparent"/></linearGradient></defs>
      <line x1="${pad}" y1="${baseY}" x2="${W - pad}" y2="${baseY}" stroke="var(--line2)" stroke-dasharray="4 4"/>
      <polygon points="${area}" fill="url(#eg)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${x(eq.length - 1)}" cy="${y(last)}" r="4.5" fill="${col}"/>
      <text x="${pad}" y="16" fill="var(--mut)" font-size="12">${fmt(max)}</text>
      <text x="${pad}" y="${H - 6}" fill="var(--mut)" font-size="12">${fmt(min)}</text>
      <text x="${W - pad}" y="${y(last) - 10}" fill="${col}" font-size="13" font-weight="700" text-anchor="end">${fmt(last)} ${STATE.currency}</text>
    </svg>`;
}

function updateBankChip() {
  if (!STATE.bank) return;
  $("#bankChip").textContent = `${fmt(STATE.bank.balance)} ${STATE.currency}`;
  const rc = $("#riskChip");
  if (rc) rc.textContent = `V riziku ${fmt(STATE.bank.open_stake || 0)} ${STATE.currency} · ${STATE.bank.open_count || 0}×`;
}

function renderBets(bets) {
  const c = $("#betHistory");
  if (!bets.length) { c.innerHTML = '<div class="empty">Zatím žádné tipy.</div>'; return; }
  c.innerHTML = bets.map(b => {
    const pnlCls = b.pnl > 0 ? "pnl-pos" : (b.pnl < 0 ? "pnl-neg" : "");
    const pnl = b.status === "open" ? "" : `<span class="${pnlCls}">${b.pnl>=0?"+":""}${fmt(b.pnl)}</span>`;
    const actions = b.status === "open"
      ? `<button onclick="settle('${b.id}','won')">✓ Vyhrál</button>
         <button onclick="settle('${b.id}','lost')">✗ Prohrál</button>`
      : `<span class="badge ${b.status}">${b.status==="won"?"výhra":b.status==="lost"?"prohra":"void"}</span>`;
    const clv = b.clv != null ? ` · CLV ${b.clv>=0?"+":""}${Math.round(b.clv*100)}%` : "";
    const sub = b.outcome === "acca" && b.legs
      ? b.legs.map(l => l.name).join(" + ")
      : `${fmt(b.stake)} ${STATE.currency} @ ${b.odds}${clv}`;
    const agentMark = b.tag === "bet-agent"
      ? '<span title="Bet agent sázka" style="margin-right:4px">🤖</span>' : "";
    const when = matchWhen(b.match_date, b.match_time);
    const whenHtml = when ? ` <span style="color:var(--dim)">· ${esc(when)}</span>` : "";
    return `<div class="bet">${agentMark}<span class="pill" style="background:var(--surf);padding:3px 8px;border-radius:6px;font-weight:700">${b.label}</span>
      <span>${esc(b.match)}<br><span style="font-size:12px;color:var(--mut)">${esc(sub)}${whenHtml}</span></span>
      <span class="st">${pnl}${actions}</span></div>`;
  }).join("");
}

async function settle(id, result) {
  const r = await fetch("/api/bet/settle", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bet_id: id, result })
  });
  const d = await r.json();
  if (d.error) return toast(d.error, true);
  STATE.bank = d.stats; toast(result === "won" ? "Výhra připsána ✓" : "Tip vyhodnocen.");
  loadBankroll();
  if ($("#tab-tickets").classList.contains("active")) loadMyTickets();
}

async function saveBankSettings() {
  const body = {
    start_balance: parseFloat($("#setBalance").value),
    currency: $("#setCurrency").value || "Kč",
    kelly_fraction: parseFloat($("#setKelly").value),
  };
  await fetch("/api/bankroll/settings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  toast("Nastavení uloženo ✓");
  loadBankroll();
}

// ---------- KALIBRACE ----------
async function runCalib() {
  const days = $("#calibDays").value;
  const c = $("#calibResult");
  c.innerHTML = '<div class="loader">Přehrávám predikce a porovnávám s realitou…</div>';
  let d;
  try { d = await (await fetch(`/api/backtest?sport=${STATE.sport}&days=${days}`)).json(); }
  catch (e) { c.innerHTML = '<div class="empty">Test se nezdařil.</div>'; return; }
  if (!d.n) { c.innerHTML = '<div class="empty">V tomto okně nejsou odehrané zápasy. Zkus delší okno.</div>'; return; }
  const skillGood = d.skill >= 0;
  const roiTxt = d.value_roi == null ? "–" : `${d.value_roi >= 0 ? "+" : ""}${d.value_roi}%`;
  c.innerHTML = `
    <div class="statsbar" style="padding:0 0 16px">
      <div class="stat"><span class="ic">🎬</span><div><div class="v">${d.n}</div><div class="l">zápasů v testu</div></div></div>
      <div class="stat good"><span class="ic">🎯</span><div><div class="v">${d.accuracy}%</div><div class="l">trefa favorita</div></div></div>
      <div class="stat"><span class="ic">📏</span><div><div class="v">${d.brier}</div><div class="l">Brier${help("Přesnost pravděpodobností: 0 = perfektní, níž = líp.")}</div></div></div>
      <div class="stat ${skillGood ? "good" : "bad"}"><span class="ic">🧠</span><div><div class="v">${d.skill}%</div><div class="l">náskok nad náhodou${help("O kolik je model lepší než náhodné hádání. Kladné = má smysl.")}</div></div></div>
      <div class="stat ${d.value_roi != null && d.value_roi >= 0 ? "good" : "bad"}"><span class="ic">💎</span><div><div class="v">${roiTxt}</div><div class="l">ROI value sázek (${d.value_bets})${help("Kdybys vsadil 1 jednotku na každou value příležitost za nejlepší kurz.", true)}</div></div></div>
    </div>
    <div class="bankgrid">
      <div class="card"><h3>📐 Kalibrace (predikováno vs. realita)</h3>${calibChart(d.bins)}
        <p class="hint">Body na úhlopříčce = perfektně kalibrovaný model (když řekne 60 %, vyhraje to v 60 % případů).</p></div>
      <div class="card"><h3>Co znamenají čísla</h3>
        <p class="hint"><b>Brier ${d.brier}</b> vs. náhodný tip ${d.brier_uniform} → model je o <b>${d.skill}%</b> lepší než hádání.<br><br>
        <b>Trefa favorita ${d.accuracy}%</b> = jak často nejpravděpodobnější výsledek skutečně nastal.<br><br>
        <b>ROI value sázek ${roiTxt}</b> = kdybys vsadil 1 jednotku na každou value příležitost (${d.value_bets} sázek) za nejlepší kurz.<br><br>
        Model: <b>Dixon-Coles Poisson + Elo</b>. Liga-specifické parametry. Entropická jistota.<br>
        Okno: ${d.start} – ${d.end}.</p></div>
    </div>`;
}

function calibChart(bins) {
  const W = 460, H = 300, pad = 40;
  const x = v => pad + v * (W - 2 * pad);
  const y = v => H - pad - v * (H - 2 * pad);
  const grid = [0, .2, .4, .6, .8, 1].map(t =>
    `<line x1="${x(t)}" y1="${pad}" x2="${x(t)}" y2="${H - pad}" stroke="var(--line)" stroke-width="1"/>
     <line x1="${pad}" y1="${y(t)}" x2="${W - pad}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/>
     <text x="${x(t)}" y="${H - pad + 16}" fill="var(--mut)" font-size="10" text-anchor="middle">${Math.round(t*100)}</text>
     <text x="${pad - 8}" y="${y(t) + 3}" fill="var(--mut)" font-size="10" text-anchor="end">${Math.round(t*100)}</text>`).join("");
  const dots = bins.map(b =>
    `<circle cx="${x(b.pred)}" cy="${y(b.obs_rate)}" r="${Math.min(11, 4 + b.count * 0.6)}"
      fill="var(--acc2)" fill-opacity="0.75" stroke="var(--acc2)"/>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
    ${grid}
    <line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--gold)" stroke-dasharray="5 5" stroke-width="2"/>
    ${dots}
    <text x="${W/2}" y="${H-6}" fill="var(--mut)" font-size="11" text-anchor="middle">predikovaná pravděpodobnost (%)</text>
  </svg>`;
}

// ---------- DETAIL TÝMU ----------
async function openTeam(idx) {
  const m = CUR;
  const which = idx === 0 ? "home" : "away";
  const name = m[which], teamId = m[which + "_id"];
  $("#modalBox").innerHTML = `<button class="modal-close" onclick="reopenMatch()">×</button>
    <h2>${esc(name)}</h2><div class="sub">${esc(m.league)}</div>
    <div class="loader">Načítám detail týmu…</div>`;
  let d;
  try {
    d = await (await fetch(`/api/team?sport=${m.sport}&slug=${encodeURIComponent(m.slug)}` +
      `&team_id=${teamId}&name=${encodeURIComponent(name)}&league=${encodeURIComponent(m.league)}`)).json();
  } catch (e) { reopenMatch(); return; }
  const formHtml = d.form.length ? d.form.map(g => `<div class="fgame">
    <span class="rb ${g.res}">${g.res}</span><span>${g.home ? "🏠" : "✈️"} ${esc(g.opp)}</span>
    <span class="sc">${g.gf}:${g.ga}</span><span style="color:var(--dim)">${g.date.slice(5)}</span></div>`).join("")
    : '<span class="hint">Forma nedostupná (demo data).</span>';
  const upHtml = d.upcoming.length ? d.upcoming.map(g => `<div class="fgame">
    <span style="color:var(--dim)">${g.date.slice(5)}</span><span>${g.home ? "🏠 vs" : "✈️ u"} ${esc(g.opp)}</span></div>`).join("")
    : '<span class="hint">Žádné nadcházející zápasy.</span>';
  // Win rate bar
  const wr = d.win_rate;
  const wrColor = wr >= 55 ? "var(--pos)" : wr >= 40 ? "var(--warn)" : "var(--bad)";
  $("#modalBox").innerHTML = `
    <button class="modal-close" onclick="reopenMatch()">×</button>
    <h2>${esc(name)}</h2>
    <div class="sub">${esc(m.league)} · ← klikni × pro návrat na zápas</div>
    <div class="mrow">
      <div class="mbox"><div class="l">Elo rating${help("Číslo síly týmu. 1700+ = světová špička, 1400 = průměr.")}</div><div class="v">${d.rating}</div></div>
      <div class="mbox"><div class="l">Úspěšnost (${d.played} her)</div><div class="v" style="color:${wrColor}">${d.win_rate}%</div></div>
      <div class="mbox"><div class="l">Ø vstřelené</div><div class="v">${d.avg_for == null ? "–" : d.avg_for}</div></div>
      <div class="mbox"><div class="l">Ø obdržené</div><div class="v">${d.avg_against == null ? "–" : d.avg_against}</div></div>
    </div>
    <div class="formrow">
      <div class="formcol"><div class="ttl">🔥 Forma (posledních ${d.form.length})</div>${formHtml}</div>
      <div class="formcol"><div class="ttl">📅 Příští zápasy</div>${upHtml}</div>
    </div>`;
}
function reopenMatch() { if (CUR) openMatch(CUR); }

// ---------- TIPY MODELU ----------
async function loadTips() {
  const status = $("#tipsFilter") ? $("#tipsFilter").value : "";
  await Promise.all([loadTipsStats(), loadTipsList(status)]);
  if ($("#tipsAutoSettle")) $("#tipsAutoSettle").onclick = autoSettleTips;
  if ($("#tipsFilter")) $("#tipsFilter").onchange = () => loadTipsList($("#tipsFilter").value);
}

async function loadTipsStats() {
  let s;
  try { s = await (await fetch(`/api/tips/stats?sport=${STATE.sport}`)).json(); }
  catch (e) { return; }
  renderTipsStats(s);
}

function renderTipsStats(s) {
  const acc = s.accuracy == null ? "–" : s.accuracy + "%";
  const roi = s.value_roi == null ? "–" : `${s.value_roi >= 0 ? "+" : ""}${s.value_roi}%`;
  const roiGood = s.value_roi != null && s.value_roi >= 0;
  const streakTxt = s.streak > 0 && s.streak_type
    ? (s.streak_type === "won" ? `🔥 ${s.streak}× výhra` : `❄️ ${s.streak}× prohra`)
    : "–";

  const goalAcc = s.goal_accuracy == null ? "–" : s.goal_accuracy + "%";
  const cornerAcc = s.corner_accuracy == null ? "–" : s.corner_accuracy + "%";
  const sharpAcc = s.sharp_accuracy == null ? "–" : s.sharp_accuracy + "%";
  const dcAcc = s.dc_accuracy == null ? "–" : s.dc_accuracy + "%";
  const cornerUnverifHelp = s.corner_unverifiable
    ? ` · ${s.corner_unverifiable} neověřitelných (liga bez detailní statistiky)` : "";

  const el = $("#tipsStats");
  if (!el) return;
  el.innerHTML = `
    <div class="stat"><span class="ic">📋</span><div><div class="v">${s.total}</div><div class="l">celkem tipů</div></div></div>
    <div class="stat"><span class="ic">⏳</span><div><div class="v">${s.open}</div><div class="l">otevřené</div></div></div>
    <div class="stat ${s.sharp_accuracy != null && s.sharp_accuracy >= 50 ? "good" : (s.sharp_tips ? "bad" : "")}">
      <span class="ic">🎯</span><div><div class="v">${sharpAcc}</div><div class="l">ostré tipy (${s.sharp_won}/${s.sharp_tips})${help("Trefa jen u tipů s reálnou konvikcí (favorit ≥55 % nebo value) – bez coin-flipů. Skutečná síla modelu.")}</div></div></div>
    <div class="stat ${s.accuracy != null && s.accuracy >= 45 ? "good" : (s.settled ? "bad" : "")}">
      <span class="ic">📊</span><div><div class="v">${acc}</div><div class="l">všechny 1X2 (${s.won}/${s.settled})${help("Trefa favorita přes VŠECHNY tipy včetně nejistých coin-flipů. Nižší, protože model musí tipnout i zápasy, kde není favorit.")}</div></div></div>
    <div class="stat ${s.dc_accuracy != null && s.dc_accuracy >= 60 ? "good" : (s.dc_tips ? "bad" : "")}">
      <span class="ic">🎲</span><div><div class="v">${dcAcc}</div><div class="l">dvojtip (${s.dc_won}/${s.dc_tips})${help("Trefa dvojtipu (1X/12/X2) u nejistých zápasů, kde ho model doporučil. Kryje dva výsledky = vyšší trefovost.")}</div></div></div>
    <div class="stat ${s.goal_accuracy != null && s.goal_accuracy >= 50 ? "good" : (s.goal_tips ? "bad" : "")}">
      <span class="ic">⚽</span><div><div class="v">${goalAcc}</div><div class="l">trefa góly (${s.goal_won}/${s.goal_tips})${help("Tip na více/méně gólů – model vybere linii, ve které je nejjistější.")}</div></div></div>
    <div class="stat ${s.corner_accuracy != null && s.corner_accuracy >= 50 ? "good" : (s.corner_tips ? "bad" : "")}">
      <span class="ic">🚩</span><div><div class="v">${cornerAcc}</div><div class="l">trefa rohy (${s.corner_won}/${s.corner_tips})${help("Tip na více/méně rohů. Ověřuje se přes ESPN boxscore – dostupné jen u některých lig." + cornerUnverifHelp)}</div></div></div>
    <div class="stat ${roiGood ? "good" : (s.value_tips ? "bad" : "")}">
      <span class="ic">💎</span><div><div class="v">${roi}</div><div class="l">ROI value (${s.value_tips})</div></div></div>
    <div class="stat"><span class="ic">⚡</span><div><div class="v">${streakTxt}</div><div class="l">aktuální série</div></div></div>`;
  animateNums(el);

  // Kalibrace jistoty
  const confEl = $("#tipsConfChart");
  if (confEl && s.conf_bins) {
    confEl.innerHTML = s.conf_bins.map(b => {
      const pct = b.accuracy != null ? b.accuracy : null;
      const barW = pct != null ? pct : 0;
      const col = pct != null && pct >= 55 ? "var(--pos)" : pct != null && pct >= 40 ? "var(--warn)" : "var(--bad)";
      return `<div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
          <span style="color:var(--mut)">${b.label}</span>
          <span>${pct != null ? pct + "%" : "–"} <span style="color:var(--dim)">(${b.count} tipů)</span></span>
        </div>
        <div style="height:8px;background:var(--bg2);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${barW}%;background:${col};border-radius:4px;transition:width .5s"></div>
        </div>
      </div>`;
    }).join("");
  }

  // ROI křivka
  const roiEl = $("#tipsRoiChart");
  if (roiEl) drawRoiCurve(roiEl, s.roi_curve, s.acc_curve);

  // Trend přesnosti (kumulativní %, 0–100)
  const accEl = $("#tipsAccChart");
  if (accEl) drawAccTrend(accEl, s.acc_curve);

  // Ligy
  const lgEl = $("#tipsLeagues");
  if (lgEl && s.leagues.length) {
    lgEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="color:var(--mut);border-bottom:1px solid var(--line)">
        <th style="padding:6px 4px;text-align:left">Liga</th>
        <th style="padding:6px 4px;text-align:right">Tipy</th>
        <th style="padding:6px 4px;text-align:right">Výhry</th>
        <th style="padding:6px 4px;text-align:right">Přesnost</th>
        <th style="padding:6px 4px"></th>
      </tr></thead>
      <tbody>${s.leagues.map(l => {
        const col = l.accuracy >= 55 ? "var(--pos)" : l.accuracy >= 40 ? "var(--warn)" : "var(--bad)";
        return `<tr style="border-bottom:1px solid var(--line2)">
          <td style="padding:7px 4px">${esc(l.league)}</td>
          <td style="padding:7px 4px;text-align:right;color:var(--mut)">${l.count}</td>
          <td style="padding:7px 4px;text-align:right">${l.won}</td>
          <td style="padding:7px 4px;text-align:right;color:${col};font-weight:600">${l.accuracy}%</td>
          <td style="padding:7px 4px">
            <div style="height:5px;background:var(--bg2);border-radius:3px;width:80px;overflow:hidden">
              <div style="height:100%;width:${l.accuracy}%;background:${col};border-radius:3px"></div>
            </div>
          </td>
        </tr>`;
      }).join("")}</tbody></table>`;
  } else if (lgEl) {
    lgEl.innerHTML = '<div class="empty">Zatím žádné vyhodnocené tipy.</div>';
  }
}

function drawRoiCurve(el, roiCurve, accCurve) {
  const data = roiCurve;
  if (!data || data.length < 2) {
    el.innerHTML = '<div class="empty" style="padding:30px">Zatím nedostatek dat. Value tipy se vyhodnotí automaticky po odehrání zápasů.</div>';
    return;
  }
  const W = 600, H = 220, pad = 38;
  const min = Math.min(0, ...data), max = Math.max(0, ...data);
  const span = (max - min) || 1;
  const x = i => pad + i * (W - 2 * pad) / (data.length - 1);
  const y = v => H - pad - (v - min) * (H - 2 * pad) / span;
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`;
  const last = data[data.length - 1];
  const up = last >= 0;
  const col = up ? "var(--pos)" : "var(--bad)";
  const baseY = y(0);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
      <defs><linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${up ? "rgba(54,213,125,.3)" : "rgba(255,92,92,.3)"}"/>
        <stop offset="100%" stop-color="transparent"/></linearGradient></defs>
      <line x1="${pad}" y1="${baseY}" x2="${W - pad}" y2="${baseY}" stroke="var(--line2)" stroke-dasharray="4 4" stroke-width="1.5"/>
      <polygon points="${area}" fill="url(#rg)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${x(data.length-1)}" cy="${y(last)}" r="4.5" fill="${col}"/>
      <text x="${pad+4}" y="16" fill="var(--mut)" font-size="11">+${fmt(max)} j.</text>
      <text x="${pad+4}" y="${H - 6}" fill="var(--mut)" font-size="11">${fmt(min)} j.</text>
      <text x="${W - pad}" y="${y(last) - 10}" fill="${col}" font-size="13" font-weight="700" text-anchor="end">
        ${last >= 0 ? "+" : ""}${fmt(last)} j.
      </text>
      <text x="${W/2}" y="${H - 4}" fill="var(--mut)" font-size="11" text-anchor="middle">value sázky (1 j. každá)</text>
    </svg>`;
}

function drawAccTrend(el, accCurve) {
  const data = accCurve;
  if (!data || data.length < 3) {
    el.innerHTML = '<div class="empty" style="padding:30px">Zatím nedostatek vyhodnocených tipů pro trend (potřeba aspoň pár).</div>';
    return;
  }
  const W = 600, H = 200, pad = 34;
  const x = i => pad + i * (W - 2 * pad) / (data.length - 1);
  const y = v => H - pad - (v / 100) * (H - 2 * pad);
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = data[data.length - 1];
  const good = last >= 50;
  const col = good ? "var(--pos)" : "var(--bad)";
  const half = y(50);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
      <line x1="${pad}" y1="${half}" x2="${W - pad}" y2="${half}" stroke="var(--line2)" stroke-dasharray="4 4" stroke-width="1.5"/>
      <text x="${pad+4}" y="${half - 5}" fill="var(--dim)" font-size="10">50 % (náhoda u 1X2)</text>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${x(data.length-1)}" cy="${y(last)}" r="4.5" fill="${col}"/>
      <text x="${pad+4}" y="16" fill="var(--mut)" font-size="11">100 %</text>
      <text x="${pad+4}" y="${H - 6}" fill="var(--mut)" font-size="11">0 %</text>
      <text x="${W - pad}" y="${y(last) - 10}" fill="${col}" font-size="13" font-weight="700" text-anchor="end">${last}%</text>
      <text x="${W/2}" y="${H - 4}" fill="var(--mut)" font-size="11" text-anchor="middle">pořadí vyhodnocených tipů</text>
    </svg>`;
}

// Kumulativní zisk agenta v Kč (start 0, zelená nad nulou / červená pod)
function drawAgentProfit(el, curve) {
  if (!el) return;
  const data = curve || [];
  if (data.length < 2) {
    el.innerHTML = '<div class="empty" style="padding:24px">Křivka zisku se vykreslí po vyhodnocení prvních sázek agenta (⚡ Zkontrolovat výsledky).</div>';
    return;
  }
  const W = 600, H = 190, pad = 36;
  const min = Math.min(0, ...data), max = Math.max(0, ...data);
  const span = (max - min) || 1;
  const x = i => pad + i * (W - 2 * pad) / (data.length - 1);
  const y = v => H - pad - (v - min) * (H - 2 * pad) / span;
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${y(0)} ${pts} ${x(data.length - 1)},${y(0)}`;
  const last = data[data.length - 1];
  const up = last >= 0;
  const col = up ? "var(--pos)" : "var(--bad)";
  const baseY = y(0);
  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:6px">
      <defs><linearGradient id="agp" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${up ? "rgba(34,197,139,.25)" : "rgba(239,83,104,.25)"}"/>
        <stop offset="100%" stop-color="transparent"/></linearGradient></defs>
      <line x1="${pad}" y1="${baseY}" x2="${W - pad}" y2="${baseY}" stroke="var(--line2)" stroke-dasharray="4 4" stroke-width="1.5"/>
      <polygon points="${area}" fill="url(#agp)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="${x(data.length-1)}" cy="${y(last)}" r="4.5" fill="${col}"/>
      <text x="${pad+4}" y="15" fill="var(--dim)" font-size="10.5">+${fmt(max)} ${STATE.currency}</text>
      <text x="${pad+4}" y="${H - 6}" fill="var(--dim)" font-size="10.5">${fmt(min)} ${STATE.currency}</text>
      <text x="${W - pad}" y="${y(last) - 10}" fill="${col}" font-size="13" font-weight="700" text-anchor="end">${last >= 0 ? "+" : ""}${fmt(last)} ${STATE.currency}</text>
      <text x="${W/2}" y="${H - 4}" fill="var(--dim)" font-size="10.5" text-anchor="middle">pořadí vyhodnocených sázek agenta</text>
    </svg>`;
}

async function loadTipsList(status) {
  const el = $("#tipsList");
  if (!el) return;
  el.innerHTML = '<div class="loader">Načítám tipy…</div>';
  let d;
  try {
    d = await (await fetch(`/api/tips?sport=${STATE.sport}&status=${status || ""}&limit=150`)).json();
  } catch (e) { el.innerHTML = '<div class="empty">Chyba načítání.</div>'; return; }
  renderTipsList(d.tips);
}

function renderTipsList(tips, target) {
  const el = target || $("#tipsList");
  if (!el) return;
  if (!tips.length) { el.innerHTML = '<div class="empty">Žádné tipy v tomto filtru. Tipy se ukládají automaticky při načtení zápasů.</div>'; return; }
  el.innerHTML = tips.map(t => {
    const res = t.pick_result;
    const cls = res === "won" ? "pnl-pos" : res === "lost" ? "pnl-neg" : "";
    const badge = res
      ? `<span class="badge ${res}">${res === "won" ? "✓ výhra" : "✗ prohra"}</span>`
      : `<span style="color:var(--mut);font-size:11px;white-space:nowrap">⏳ otevřeno</span>`;
    const score = t.result ? `${t.result.home}:${t.result.away}` : "";
    const scoreHtml = score
      ? `<span style="color:var(--txt);font-weight:700;margin-left:6px">${score}</span>` : "";
    const valHtml = t.has_value && t.value_name
      ? `<div style="font-size:12px;color:var(--val);margin-top:6px">💎 value sázka: <b>${esc(t.value_name)}</b> @ ${t.value_odds} (+${t.value_ev}% EV)
          ${t.value_result ? `<span style="${t.value_result === "won" ? "color:var(--pos)" : "color:var(--bad)"}">[${t.value_result === "won" ? "✓ vyšla" : "✗ nevyšla"}]</span>` : ""}
        </div>` : "";
    const confColor = t.confidence >= 70 ? "var(--pos)" : t.confidence >= 50 ? "var(--warn)" : "var(--mut)";
    // Tip modelu – plný název (např. "1 · Algeria"), fallback na pick_label u starších tipů
    const pickName = t.pick_name || `${esc(t.pick_label)} · ${esc(t.pick === "home" ? t.home : t.pick === "away" ? t.away : "remíza")}`;
    const oddsHtml = t.pick_odds != null
      ? ` @ kurz <b>${t.pick_odds}</b>${t.pick_book ? ` <span style="color:var(--dim)">(${esc(t.pick_book)})</span>` : ""}`
      : "";

    // Tip na góly – více / méně (nejjistější linie)
    let goalHtml = "";
    if (t.goal_outcome) {
      const goalRes = t.goal_result;
      const goalCls = goalRes === "won" ? "color:var(--pos)" : goalRes === "lost" ? "color:var(--bad)" : "color:var(--mut)";
      const goalBadge = goalRes
        ? `<span style="${goalCls};font-weight:700">[${goalRes === "won" ? "✓ vyšlo" : "✗ nevyšlo"}]</span>`
        : `<span style="color:var(--mut);font-size:11px">⏳</span>`;
      const goalOddsHtml = t.goal_odds != null
        ? ` @ kurz <b>${t.goal_odds}</b>${t.goal_book ? ` <span style="color:var(--dim)">(${esc(t.goal_book)})</span>` : ""}`
        : "";
      const goalProbHtml = t.goal_prob != null ? ` <span style="color:var(--mut)">(${pct(t.goal_prob)})</span>` : "";
      goalHtml = `<div style="font-size:13px;margin-top:6px;padding:6px 10px;background:var(--bg2);border-radius:8px;border-left:3px solid ${t.goal_side === "over" ? "var(--acc2)" : "var(--val)"}">
          ⚽ Tip góly: <b>${esc(t.goal_name)}</b>${goalOddsHtml}${goalProbHtml}
          ${t.goal_is_value ? `<span style="color:var(--val)"> 💎 +${t.goal_ev}% EV</span>` : ""}
          <span style="margin-left:6px">${goalBadge}</span>
        </div>`;
    }

    // Tip na rohy – více / méně (nejjistější linie); ověřuje se přes ESPN boxscore
    let cornerHtml = "";
    if (t.corner_outcome) {
      const cornerRes = t.corner_result;
      const cornerCls = cornerRes === "won" ? "color:var(--pos)" : cornerRes === "lost" ? "color:var(--bad)" : "color:var(--mut)";
      let cornerBadge;
      if (cornerRes === "won") cornerBadge = `<span style="${cornerCls};font-weight:700">[✓ vyšlo]</span>`;
      else if (cornerRes === "lost") cornerBadge = `<span style="${cornerCls};font-weight:700">[✗ nevyšlo]</span>`;
      else if (cornerRes === "unverifiable") cornerBadge = `<span style="color:var(--dim);font-size:11px" title="ESPN nemá k této lize detailní boxscore statistiky">[neověřitelné]</span>`;
      else cornerBadge = `<span style="color:var(--mut);font-size:11px">⏳</span>`;
      const cornerOddsHtml = t.corner_odds != null
        ? ` @ kurz <b>${t.corner_odds}</b>${t.corner_book ? ` <span style="color:var(--dim)">(${esc(t.corner_book)})</span>` : ""}`
        : "";
      const cornerProbHtml = t.corner_prob != null ? ` <span style="color:var(--mut)">(${pct(t.corner_prob)})</span>` : "";
      cornerHtml = `<div style="font-size:13px;margin-top:6px;padding:6px 10px;background:var(--bg2);border-radius:8px;border-left:3px solid ${t.corner_side === "over" ? "var(--acc2)" : "var(--val)"}">
          🚩 Tip rohy: <b>${esc(t.corner_name)}</b>${cornerOddsHtml}${cornerProbHtml}
          <span style="color:var(--dim);font-size:11px" title="Rohy nejsou v lehkém ESPN feedu – predikce vychází z ligového průměru škálovaného tempem zápasu, ne z reálných týmových dat o rozích.">(odhad)</span>
          ${t.corner_is_value ? `<span style="color:var(--val)"> 💎 +${t.corner_ev}% EV</span>` : ""}
          <span style="margin-left:6px">${cornerBadge}</span>
        </div>`;
    }

    // Dvojtip (double-chance) – zobraz jen když ho model doporučil (nejistý zápas)
    let dcHtml = "";
    if (t.dc_recommended && t.dc_outcome) {
      const dcRes = t.dc_result;
      const dcCls = dcRes === "won" ? "color:var(--pos)" : dcRes === "lost" ? "color:var(--bad)" : "color:var(--mut)";
      const dcBadge = dcRes
        ? `<span style="${dcCls};font-weight:700">[${dcRes === "won" ? "✓ vyšlo" : "✗ nevyšlo"}]</span>`
        : `<span style="color:var(--mut);font-size:11px">⏳</span>`;
      const dcProbHtml = t.dc_prob != null ? ` <span style="color:var(--mut)">(${pct(t.dc_prob)})</span>` : "";
      dcHtml = `<div style="font-size:13px;margin-top:6px;padding:6px 10px;background:var(--bg2);border-radius:8px;border-left:3px solid var(--pos)">
          🛡️ Jistější dvojtip: <b>${esc(t.dc_outcome)} · ${esc(t.dc_name)}</b>${dcProbHtml}
          <span style="margin-left:6px">${dcBadge}</span>
        </div>`;
    }

    // Odznak ostrého tipu (reálná konvikce, ne coin-flip)
    const sharp = (t.is_sharp != null ? t.is_sharp : ((t.pick_prob || 0) >= 0.55 || t.has_value));
    const sharpBadge = sharp
      ? `<span style="background:rgba(55,147,255,.16);color:var(--acc2);font-size:10px;font-weight:700;padding:2px 7px;border-radius:6px;margin-left:6px">🎯 OSTRÝ</span>`
      : `<span style="background:rgba(255,255,255,.05);color:var(--dim);font-size:10px;padding:2px 7px;border-radius:6px;margin-left:6px" title="Nejistý zápas (coin-flip) – model nemá jasného favorita">◦ nejistý</span>`;

    return `<div class="bet" style="align-items:flex-start;flex-wrap:wrap">
      <span class="pill" style="background:var(--surf2);border:1px solid var(--line2);padding:4px 10px;border-radius:8px;font-weight:700;min-width:26px;text-align:center">${esc(t.pick_label)}</span>
      <span style="flex:1;min-width:220px">
        <div><b>${esc(t.home)} – ${esc(t.away)}</b>${scoreHtml}${sharpBadge}</div>
        <div style="font-size:12px;color:var(--mut);margin-top:2px">${esc(t.league)} · ${t.date}</div>
        <div style="font-size:13px;margin-top:6px;padding:6px 10px;background:var(--bg2);border-radius:8px;border-left:3px solid var(--acc)">
          🎯 Tip modelu: <b>${pickName}</b>${oddsHtml}
          <span style="color:${confColor};margin-left:6px">(jistota ${t.confidence}%)</span>
        </div>
        ${dcHtml}
        ${goalHtml}
        ${cornerHtml}
        ${valHtml}
        ${res ? "" : `<div style="margin-top:8px">${tipsportBtn(t.home, t.away, "Najít na Tipsportu")}</div>`}
      </span>
      <span class="st"><span class="${cls}">${badge}</span></span>
    </div>`;
  }).join("");
}

async function autoSettleTips() {
  const btn = $("#tipsAutoSettle");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "⏳ Vyhodnocuji… (může trvat ~1 min)"; btn.disabled = true; }
  try {
    const r = await fetch("/api/tips/settle", { method: "POST" });
    const d = await r.json();
    let msg = d.settled ? `Vyhodnoceno ${d.settled} tipů modelu ✓` : "Žádné nové výsledky k vyhodnocení.";
    if (d.more_pending) msg += " Zbývá ještě starší záloha – klikni znovu.";
    toast(msg, !d.settled);
    loadTips();
  } catch (e) {
    toast("Vyhodnocení se nezdařilo.", true);
  } finally {
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

// ---------- ZÍTŘEK + AUTOMATICKÝ AGENT ----------
let AGENT = null;   // poslední známý stav agenta {settings, stats, bets, balance}

async function _agentAutoRun() {
  // tichý běh při startu: když je agent zapnutý, vsadí zítřejší ostré tipy
  try {
    await loadAgentPanel();   // stav + zelená tečka v boční liště
    if (!AGENT || !AGENT.settings.enabled) return;
    const d = await (await fetch("/api/agent/run", { method: "POST" })).json();
    if (d.placed) {
      toast(`🤖 Agent automaticky vsadil ${d.placed} zítřejších tiketů ✓`);
      loadBankroll();
      loadAgentPanel();
    }
  } catch (e) { /* tichý běh – bez hlášek */ }
}

function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function loadTomorrow() {
  await loadAgentPanel();
  loadTomorrowTips();
  const chk = $("#tomorrowSharpOnly");
  if (chk && !chk._wired) { chk._wired = true; chk.addEventListener("change", loadTomorrowTips); }
}

async function loadAgentPanel() {
  try {
    AGENT = await (await fetch("/api/agent")).json();
  } catch (e) { return; }
  const s = AGENT.settings, st = AGENT.stats;

  // ovládání
  setSegActive($("#agentToggle"), s.enabled ? "on" : "off");
  setSegActive($("#agentBetToday"), s.bet_today !== false ? "on" : "off");
  setSegActive($("#agentStakeMode"), s.stake_mode || "kelly");
  $("#agentFlatRow").classList.toggle("hidden", (s.stake_mode || "kelly") !== "flat");
  $("#agentKellyRow").classList.toggle("hidden", (s.stake_mode || "kelly") === "flat");
  $("#agentStake").value = s.stake;
  $("#agentKellyFraction").value = s.kelly_fraction != null ? s.kelly_fraction : 0.25;
  $("#agentKellyVal").textContent = $("#agentKellyFraction").value;
  $("#agentDailyCap").value = s.max_daily_stake_pct != null ? s.max_daily_stake_pct : 0.25;
  $("#agentDailyCapVal").textContent = Math.round($("#agentDailyCap").value * 100);
  $("#agentBalance").textContent = fmt(AGENT.balance) + " " + STATE.currency;
  $("#agentStakedToday").textContent = fmt(st.staked_today || 0) + " " + STATE.currency;
  $("#agentDot").classList.toggle("hidden", !s.enabled);
  if (!$("#agentToggle")._wired) {
    $("#agentToggle")._wired = true;
    $("#agentToggle").querySelectorAll("button").forEach(b => b.onclick = () => setSegActive($("#agentToggle"), b.dataset.val));
    $("#agentBetToday").querySelectorAll("button").forEach(b => b.onclick = () => setSegActive($("#agentBetToday"), b.dataset.val));
    $("#agentStakeMode").querySelectorAll("button").forEach(b => b.onclick = () => {
      setSegActive($("#agentStakeMode"), b.dataset.val);
      $("#agentFlatRow").classList.toggle("hidden", b.dataset.val !== "flat");
      $("#agentKellyRow").classList.toggle("hidden", b.dataset.val === "flat");
    });
    $("#agentKellyFraction").addEventListener("input", e => $("#agentKellyVal").textContent = e.target.value);
    $("#agentDailyCap").addEventListener("input", e => $("#agentDailyCapVal").textContent = Math.round(e.target.value * 100));
    $("#agentSaveBtn").onclick = saveAgentSettings;
    $("#agentRunBtn").onclick = runAgentNow;
    $("#agentCheckBtn").onclick = checkAgentResults;
    $("#agentExportBtn").onclick = exportAgentBetsCSV;
  }

  // statistiky výkonu
  const acc = st.accuracy == null ? "–" : st.accuracy + "%";
  const roi = st.roi == null ? "–" : `${st.roi >= 0 ? "+" : ""}${st.roi}%`;
  const profUp = st.profit >= 0;
  $("#agentStats").innerHTML = `
    <div class="stat"><span class="ic">🎫</span><div><div class="v">${st.placed}</div><div class="l">sázek (${st.open} otevř.)</div></div></div>
    <div class="stat ${st.accuracy != null && st.accuracy >= 50 ? "good" : (st.settled ? "bad" : "")}">
      <span class="ic">🎯</span><div><div class="v">${acc}</div><div class="l">trefa (${st.won}/${st.settled})</div></div></div>
    <div class="stat ${profUp ? "good" : "bad"}"><span class="ic">${profUp ? "📈" : "📉"}</span>
      <div><div class="v">${st.profit >= 0 ? "+" : ""}${fmt(st.profit)}</div><div class="l">zisk (${STATE.currency})</div></div></div>
    <div class="stat ${st.roi != null && st.roi >= 0 ? "good" : (st.settled ? "bad" : "")}">
      <span class="ic">💹</span><div><div class="v">${roi}</div><div class="l">ROI${help("Zisk / vsazená částka jen ze sázek agenta.")}</div></div></div>`;
  animateNums($("#agentStats"));
  drawAgentProfit($("#agentChart"), st.profit_curve);

  // liga performance
  const lgStats = AGENT.league_stats || {};
  if (Object.keys(lgStats).length > 0) {
    const lgHtml = `
      <div class="card" style="margin-bottom:16px">
        <h3>⚽ Výkon po ligách</h3>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <tr style="border-bottom:1px solid var(--line);text-align:left">
            <th style="padding:8px;font-weight:600">Liga</th>
            <th style="padding:8px;text-align:right">Sázky</th>
            <th style="padding:8px;text-align:right">Win%</th>
            <th style="padding:8px;text-align:right">P&L</th>
            <th style="padding:8px;text-align:right">ROI</th>
          </tr>
          ${Object.entries(lgStats).map(([lg, s]) => {
            const roiColor = s.roi >= 0 ? "var(--pos)" : "var(--bad)";
            const pnlColor = s.pnl >= 0 ? "var(--pos)" : "var(--bad)";
            return `<tr style="border-bottom:1px solid var(--line)">
              <td style="padding:8px"><b>${esc(lg)}</b></td>
              <td style="padding:8px;text-align:right">${s.settled}</td>
              <td style="padding:8px;text-align:right">${s.win_rate}%</td>
              <td style="padding:8px;text-align:right;color:${pnlColor};font-weight:600">${s.pnl >= 0 ? '+' : ''}${fmt(s.pnl)}</td>
              <td style="padding:8px;text-align:right;color:${roiColor};font-weight:600">${s.roi >= 0 ? '+' : ''}${s.roi}%</td>
            </tr>`;
          }).join('')}
        </table>
      </div>
    `;
    $("#agentBets").insertAdjacentHTML("beforebegin", lgHtml);
  }

  // sázky agenta
  const bc = $("#agentBets");
  if (!AGENT.bets.length) {
    bc.innerHTML = '<div class="empty">Agent zatím nic nevsadil. Zapni ho, nebo klikni „▶ Vsadit zítřejší tipy teď".</div>';
  } else {
    bc.innerHTML = AGENT.bets.map(b => {
      const pnlCls = b.pnl > 0 ? "pnl-pos" : (b.pnl < 0 ? "pnl-neg" : "");
      const stBadge = b.status === "open"
        ? '<span style="color:var(--mut);font-size:11px">⏳ otevřeno</span>'
        : `<span class="badge ${b.status}">${b.status === "won" ? "✓ výhra" : b.status === "lost" ? "✗ prohra" : "void"}</span>`;
      const pnl = b.status === "open" ? "" : `<span class="${pnlCls}" style="font-weight:700;margin-right:8px">${b.pnl >= 0 ? "+" : ""}${fmt(b.pnl)}</span>`;
      const when = matchWhen(b.match_date, b.match_time);
      const whenHtml = when ? ` <span style="color:var(--acc2);font-weight:600">· ${esc(when)}</span>` : "";
      const evColor = b.clv > 0 ? "var(--pos)" : "var(--bad)";
      const clvPct = (b.clv * 100).toFixed(1);
      return `<div class="bet" style="cursor:pointer" onclick="showBetDetail(${JSON.stringify(b)})">
        <span class="pill" style="background:var(--surf);padding:3px 8px;border-radius:6px;font-weight:700">${esc(b.label)}</span>
        <span style="flex:1"><b>${esc(b.match)}</b>${whenHtml}<br>
          <span style="font-size:12px;color:var(--mut)">${fmt(b.stake)} ${STATE.currency} @ ${b.odds} · ${esc(b.outcome)}</span>
          <span style="font-size:11px;color:${evColor};margin-left:6px">CLV ${clvPct}%</span></span>
        <span class="st">${pnl}${stBadge}</span>
      </div>`;
    }).join("");
  }
}

async function saveAgentSettings() {
  const enabled = !!$("#agentToggle").querySelector("button.active[data-val='on']");
  const bet_today = !!$("#agentBetToday").querySelector("button.active[data-val='on']");
  const stake_mode = $("#agentStakeMode").querySelector("button.active").dataset.val;
  const stake = Math.max(1, parseFloat($("#agentStake").value) || 10);
  const kelly_fraction = parseFloat($("#agentKellyFraction").value);
  const max_daily_stake_pct = parseFloat($("#agentDailyCap").value);
  await fetch("/api/agent/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, bet_today, stake_mode, stake, kelly_fraction, max_daily_stake_pct })
  });
  $("#agentDot").classList.toggle("hidden", !enabled);
  const modeTxt = stake_mode === "kelly" ? `Kelly (frakce ${kelly_fraction})` : `plochý ${fmt(stake)} ${STATE.currency}`;
  toast(enabled ? `Agent zapnut – vklad: ${modeTxt}, denní strop ${Math.round(max_daily_stake_pct*100)} % banku ✓` : "Agent vypnut.");
}

async function checkAgentResults() {
  // Stejný robustní endpoint jako Tipy modelu – natáhne čerstvé výsledky z ESPN
  // (mimo keš) a vyhodnotí i sázky agenta, i zápasy, které skončily dnes.
  const btn = $("#agentCheckBtn");
  const orig = btn.textContent;
  btn.textContent = "⏳ Kontroluji… (může trvat ~1 min)"; btn.disabled = true;
  try {
    const d = await (await fetch("/api/tips/settle", { method: "POST" })).json();
    let msg = d.settled_bets ? `Vyhodnoceno ${d.settled_bets} sázek podle čerstvých výsledků ✓` : "Žádné nové výsledky – zápasy ještě neskončily nebo jsou vyhodnocené.";
    if (d.more_pending) msg += " Zbývá starší záloha – klikni znovu.";
    toast(msg, !d.settled_bets);
    loadBankroll();
    loadAgentPanel();
  } catch (e) {
    toast("Kontrola výsledků se nezdařila.", true);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

async function runAgentNow() {
  const btn = $("#agentRunBtn");
  const orig = btn.textContent;
  btn.textContent = "⏳ Analyzuji zítřek a sázím…"; btn.disabled = true;
  try {
    const d = await (await fetch("/api/agent/run", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true })
    })).json();
    const capNote = d.skipped_daily_cap ? `, ${d.skipped_daily_cap} nad denní strop` : "";
    if (d.out_of_funds) toast("🤖 Bank nestačí na další sázky!", true);
    else if (d.placed) {
      toast(`🤖 Agent vsadil ${d.placed} tiketů ✓`);
      // Notifikace pro první 3 sázky
      if (d.placed <= 3) {
        const agent = AGENT;
        if (agent && agent.bets) {
          agent.bets.slice(0, d.placed).forEach((b, i) => {
            setTimeout(() => {
              toast(`  • ${esc(b.label)} ${esc(b.match)} @ ${b.odds}`, false);
            }, (i + 1) * 600);
          });
        }
      }
    }
    else if (d.skipped_daily_cap) toast(`Denní strop je vyčerpaný – ${d.skipped_daily_cap} tipů čeká na zítřek.`, true);
    else toast("Nic nového k vsazení – zítřejší ostré tipy už jsou vsazené nebo žádné nejsou.", true);
    loadBankroll();       // aktualizuj bank chip
    loadAgentPanel();
    loadTomorrowTips();
  } catch (e) {
    toast("Běh agenta selhal.", true);
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

async function loadTomorrowTips() {
  const el = $("#tomorrowTips");
  const tmr = tomorrowStr();
  $("#tomorrowDate").textContent = "· " + tmr;
  el.innerHTML = '<div class="loader">Načítám zítřejší zápasy… (první načtení může trvat ~20 s)</div>';
  try {
    // načtení zápasů zítřka zároveň auto-uloží tipy do databáze
    await fetch(`/api/matches?date=${tmr}&days=1&sport=${STATE.sport}`);
    const d = await (await fetch(`/api/tips?sport=${STATE.sport}&limit=2000`)).json();
    let tips = d.tips.filter(t => t.date === tmr);
    if ($("#tomorrowSharpOnly").checked) {
      tips = tips.filter(t => (t.is_sharp != null ? t.is_sharp : ((t.pick_prob || 0) >= 0.55 || t.has_value)));
    }
    if (!tips.length) {
      el.innerHTML = '<div class="empty">Na zítřek nejsou žádné ' + ($("#tomorrowSharpOnly").checked ? "ostré " : "") + 'tipy.</div>';
      return;
    }
    renderTipsList(tips, el);
  } catch (e) {
    el.innerHTML = '<div class="empty">Načtení zítřejších tipů se nezdařilo.</div>';
  }
}

// ---------- NASTAVENÍ ----------
let APP_SETTINGS = null;

function initSettingsPage() {
  // model slidery – live náhled hodnoty
  const sliderMap = [
    ["setDcRho", "valDcRho"], ["setHomeAdv", "valHomeAdv"],
    ["setEloK", "valEloK"], ["setR2g", "valR2g"],
  ];
  sliderMap.forEach(([sid, lid]) => {
    $("#" + sid).addEventListener("input", e => $("#" + lid).textContent = e.target.value);
  });
  $("#saveModelSettings").onclick = saveModelSettings;
  $("#resetSettings").onclick = resetAppSettings;

  // vzhled – přepínače se uloží a aplikují okamžitě
  $("#themeControl").querySelectorAll("button").forEach(b => b.onclick = () => {
    setSegActive($("#themeControl"), b.dataset.val);
    saveAppearance({ theme: b.dataset.val });
  });
  $("#densityControl").querySelectorAll("button").forEach(b => b.onclick = () => {
    setSegActive($("#densityControl"), b.dataset.val);
    saveAppearance({ density: b.dataset.val });
  });
  $("#accentControl").querySelectorAll("button").forEach(b => b.onclick = () => {
    $("#accentControl").querySelectorAll("button").forEach(x => x.classList.toggle("active", x === b));
    saveAppearance({ accent: b.dataset.val });
  });

  // správa dat
  $("#clearCacheBtn").onclick = async () => {
    const r = await fetch("/api/data/clear-cache", { method: "POST" });
    const d = await r.json();
    toast(`Keš vymazána (${d.cleared} souborů) ✓`);
  };
  $("#resetTipsBtn").onclick = async () => {
    if (!confirm("Opravdu nevratně vymazat celou databázi tipů a statistiky?")) return;
    await fetch("/api/data/reset-tips", { method: "POST" });
    toast("Databáze tipů vymazána.");
    if ($("#tab-tips").classList.contains("active")) loadTips();
  };
  $("#exportDataBtn").onclick = async () => {
    const d = await (await fetch("/api/data/export")).json();
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `kurzanalytik-zaloha-${STATE.date}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast("Záloha stažena ✓");
  };
  $("#importDataFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const r = await fetch("/api/data/import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error();
      toast("Data obnovena ze zálohy ✓");
      loadSettings(); loadBankroll(); if ($("#tab-tips").classList.contains("active")) loadTips();
    } catch (err) {
      toast("Import se nezdařil – neplatný soubor.", true);
    } finally {
      e.target.value = "";
    }
  });
}

function setSegActive(container, val) {
  container.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === val));
}

async function loadSettings() {
  try {
    APP_SETTINGS = await (await fetch("/api/settings")).json();
  } catch (e) { return; }
  const m = APP_SETTINGS.model, a = APP_SETTINGS.appearance;

  $("#setDcRho").value = m.dc_rho; $("#valDcRho").textContent = m.dc_rho;
  $("#setHomeAdv").value = m.home_adv; $("#valHomeAdv").textContent = m.home_adv;
  $("#setEloK").value = m.elo_k; $("#valEloK").textContent = m.elo_k;
  $("#setR2g").value = m.rating_to_goals; $("#valR2g").textContent = m.rating_to_goals;
  if ($("#setDefaultSport").children.length) $("#setDefaultSport").value = m.default_sport;
  $("#setDefaultWindow").value = m.default_window;
  $("#setLiveRefresh").value = m.live_refresh_sec;

  setSegActive($("#themeControl"), a.theme);
  setSegActive($("#densityControl"), a.density);
  $("#accentControl").querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.val === a.accent));

  applyAppearance();
}

function applyAppearance() {
  const a = (APP_SETTINGS && APP_SETTINGS.appearance) || {};
  document.body.classList.toggle("theme-light", a.theme === "light");
  document.body.classList.toggle("density-compact", a.density === "compact");
  ["violet", "green", "amber"].forEach(c => document.body.classList.toggle("accent-" + c, a.accent === c));
}

async function saveAppearance(values) {
  Object.assign(APP_SETTINGS.appearance, values);
  applyAppearance();
  try {
    await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section: "appearance", values })
    });
  } catch (e) { /* vzhled se i tak projevil lokálně */ }
}

async function saveModelSettings() {
  const values = {
    dc_rho: parseFloat($("#setDcRho").value),
    home_adv: parseInt($("#setHomeAdv").value),
    elo_k: parseInt($("#setEloK").value),
    rating_to_goals: parseFloat($("#setR2g").value),
    default_sport: $("#setDefaultSport").value,
    default_window: parseInt($("#setDefaultWindow").value),
    live_refresh_sec: parseInt($("#setLiveRefresh").value),
  };
  const r = await fetch("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section: "model", values })
  });
  APP_SETTINGS = await r.json();
  toast("Parametry modelu uloženy – predikce se přepočítají ✓");
}

async function resetAppSettings() {
  if (!confirm("Obnovit všechny parametry modelu a vzhled na výchozí hodnoty?")) return;
  APP_SETTINGS = await (await fetch("/api/settings/reset", { method: "POST" })).json();
  loadSettings();
  toast("Nastavení obnoveno na výchozí ✓");
}

// ---------- automatická kontrola výsledků (background settle) ----------
let _settleInterval = null;
async function pollSettleStatus() {
  try {
    const res = await fetch("/api/settle/status");
    const st = await res.json();
    const el = $("#settleProgress");

    if (st.in_progress) {
      el.style.display = "flex";
      const cnt = $("#settleCount");
      cnt.textContent = `${st.settled_so_far}/${st.total_pending}`;
    } else {
      el.style.display = "none";
      // Zastavit polling když je hotovo
      if (_settleInterval) {
        clearInterval(_settleInterval);
        _settleInterval = null;
      }
    }
  } catch (e) {
    // timeout či chyba – nic
  }
}

function startSettlePolling() {
  if (_settleInterval) return;
  // 3000ms polling + visibility API = v tahu záhy zastavit když tab není viditelný
  _settleInterval = setInterval(pollSettleStatus, 3000);
  pollSettleStatus();
}

// Zastavit polling když tab není viditelný
document.addEventListener("visibilitychange", () => {
  if (document.hidden && _settleInterval) {
    clearInterval(_settleInterval);
    _settleInterval = null;
  } else if (!document.hidden && !_settleInterval) {
    startSettlePolling();
  }
});

// ---------- AGENT EXPORT ----------
function exportAgentBetsCSV() {
  if (!AGENT || !AGENT.bets.length) {
    toast("Nemáš sázky k exportu", true);
    return;
  }

  const headers = ["Tým/Výběr", "Zápas", "Liga", "Datum", "Čas", "Typ", "Kurz", "Vklad", "Šance %", "Stav", "P&L", "CLV"];
  const rows = AGENT.bets.map(b => [
    esc(b.label),
    esc(b.match),
    esc(b.league || "—"),
    b.match_date || "—",
    b.match_time || "—",
    esc(b.outcome),
    b.odds,
    fmt(b.stake),
    (b.prob * 100).toFixed(1),
    b.status === "open" ? "Otevřeno" : b.status === "won" ? "VÝHRA" : b.status === "lost" ? "PROHRA" : "VOID",
    b.status === "open" ? "—" : fmt(b.pnl),
    (b.clv * 100).toFixed(2),
  ]);

  const csv = [headers, ...rows].map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")
  ).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.setAttribute("href", url);
  link.setAttribute("download", `agent-sazky-${new Date().toISOString().split('T')[0]}.csv`);
  link.click();
  URL.revokeObjectURL(url);
  toast("CSV exportován ✓");
}

// ---------- AGENT BET DETAILS ----------
function showBetDetail(bet) {
  const modal = $("#modal");
  const mbox = $("#modalBox");

  // Vypočítej fair odds z pravděpodobnosti
  const fairOdds = (1 / bet.prob).toFixed(2);
  const ev = ((bet.odds * bet.prob - 1) * 100).toFixed(2);
  const edge = ((bet.odds - 1 / bet.prob) / (1 / bet.prob) * 100).toFixed(2);

  // Barvy podle CLV
  const clvColor = bet.clv > 0 ? "var(--pos)" : bet.clv < 0 ? "var(--bad)" : "var(--mut)";
  const statusHtml = bet.status === "open"
    ? '<span style="color:var(--mut)">⏳ Čeká na výsledek</span>'
    : bet.status === "won"
    ? '<span style="color:var(--pos)">✓ VÝHRA</span>'
    : bet.status === "lost"
    ? '<span style="color:var(--bad)">✗ PROHRA</span>'
    : '<span style="color:var(--mut)">VOID</span>';

  mbox.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:20px">
      <h3 style="margin:0">${esc(bet.match)}</h3>
      <button onclick="$('#modal').classList.add('hidden')" style="background:none;border:none;font-size:20px;cursor:pointer">✕</button>
    </div>

    <div style="background:var(--surf);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div><span style="color:var(--mut);font-size:11px">ZápAS</span><br><b>${esc(bet.label)}</b></div>
        <div><span style="color:var(--mut);font-size:11px">ČAS</span><br><b>${esc(bet.match_date)} ${esc(bet.match_time)}</b></div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;border-top:1px solid var(--line);padding-top:12px">
        <div>
          <span style="color:var(--mut);font-size:11px">MODELOVANÁ ŠANCE</span><br>
          <span style="font-size:18px;font-weight:700;color:var(--acc)">${(bet.prob * 100).toFixed(1)}%</span>
        </div>
        <div>
          <span style="color:var(--mut);font-size:11px">FAIR KURZ</span><br>
          <span style="font-size:18px;font-weight:700">${fairOdds}</span>
        </div>
        <div>
          <span style="color:var(--mut);font-size:11px">VÁMI VYBRANÝ KURZ</span><br>
          <span style="font-size:18px;font-weight:700;color:${bet.odds > fairOdds ? 'var(--pos)' : 'var(--bad)'}">${bet.odds}</span>
        </div>
      </div>
    </div>

    <div style="background:var(--surf);border:1px solid var(--line);border-radius:var(--radius);padding:16px;margin-bottom:16px">
      <div style="font-weight:600;margin-bottom:12px">Metriky sázky</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px">
        <div><span style="color:var(--mut)">Vloženo</span><br><b>${fmt(bet.stake)} ${STATE.currency}</b></div>
        <div><span style="color:var(--mut)">Expected Value</span><br><b style="color:${ev >= 0 ? 'var(--pos)' : 'var(--bad)'}">${ev}%</b></div>
        <div><span style="color:var(--mut)">CLV (Closing Line Value)</span><br><b style="color:${clvColor}">${(bet.clv * 100).toFixed(2)}%</b></div>
        <div><span style="color:var(--mut)">Edge</span><br><b style="color:${edge >= 0 ? 'var(--pos)' : 'var(--bad)'}">${edge}%</b></div>
      </div>
    </div>

    ${bet.status !== "open" ? `
    <div style="background:var(--surf);border:1px solid var(--line);border-radius:var(--radius);padding:16px">
      <div style="font-weight:600;margin-bottom:12px">Výsledek</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><span style="color:var(--mut);font-size:11px">STATUS</span><br>${statusHtml}</div>
        <div><span style="color:var(--mut);font-size:11px">P&L</span><br><span style="font-size:18px;font-weight:700;color:${bet.pnl > 0 ? 'var(--pos)' : bet.pnl < 0 ? 'var(--bad)' : 'var(--mut)'}">${bet.pnl >= 0 ? '+' : ''}${fmt(bet.pnl)} ${STATE.currency}</span></div>
      </div>
    </div>
    ` : ''}
  `;

  modal.classList.remove("hidden");
}

// ---------- ANALYTICS ----------
async function loadAnalytics() {
  try {
    const res = await fetch("/api/analytics");
    const data = await res.json();

    $("#unitCount").textContent = (data.unit_count ?? 0).toFixed(2);
    $("#sharpeRatio").textContent = (data.sharpe_ratio ?? 0).toFixed(2);
    $("#totalProfit").textContent = (data.profit ?? 0).toFixed(2);
    $("#winRate").textContent = (data.win_rate ?? 0).toFixed(1) + "%";

    drawMonthlyPnL(data.monthly_pnl || {});
    drawLeagueTable(data.by_league || {});
  } catch (e) {
    console.error("loadAnalytics error:", e);
  }
}

function drawMonthlyPnL(monthly) {
  const el = $("#monthlyChart");
  if (!Object.keys(monthly).length) {
    el.innerHTML = "<p style='color:var(--dim)'>Žádné údaje</p>";
    return;
  }

  const entries = Object.entries(monthly);
  const values = entries.map(([_, v]) => v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const w = 800, h = 200, p = 40;
  let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:800px">`;

  entries.forEach((entry, i) => {
    const [month, val] = entry;
    const x = p + (i / (entries.length - 1 || 1)) * (w - 2 * p);
    const y = h - p - ((val - min) / range) * (h - 2 * p);
    const color = val >= 0 ? "var(--pos)" : "var(--bad)";

    svg += `<rect x="${x-8}" y="${Math.min(y, h-p)}" width="16" height="${Math.abs(y - (h-p))}" fill="${color}" opacity="0.3" rx="2"/>`;
    svg += `<text x="${x}" y="${h-p+20}" text-anchor="middle" font-size="11" fill="var(--mut)">${month}</text>`;
  });

  svg += `</svg>`;
  el.innerHTML = svg;
}

function drawLeagueTable(byLeague) {
  const el = $("#leagueTable");
  const entries = Object.entries(byLeague).sort((a, b) => b[1].pnl - a[1].pnl);

  if (!entries.length) {
    el.innerHTML = "<p style='color:var(--dim)'>Žádné údaje</p>";
    return;
  }

  let html = "<table style='width:100%;border-collapse:collapse'>";
  html += "<tr style='border-bottom:1px solid var(--line);text-align:left'>";
  html += "<th style='padding:12px;font-weight:600;font-size:12px'>Liga</th>";
  html += "<th style='padding:12px;text-align:right'>Sázky</th>";
  html += "<th style='padding:12px;text-align:right'>Vítězství</th>";
  html += "<th style='padding:12px;text-align:right'>Win %</th>";
  html += "<th style='padding:12px;text-align:right'>P&L</th>";
  html += "<th style='padding:12px;text-align:right'>ROI</th>";
  html += "</tr>";

  entries.forEach(([league, stats]) => {
    const pnlColor = stats.pnl >= 0 ? "var(--pos)" : "var(--bad)";
    html += `<tr style='border-bottom:1px solid var(--line)'>`;
    html += `<td style='padding:12px'>${esc(league)}</td>`;
    html += `<td style='padding:12px;text-align:right'>${stats.settled}</td>`;
    html += `<td style='padding:12px;text-align:right'>${stats.wins}</td>`;
    html += `<td style='padding:12px;text-align:right'>${stats.win_rate.toFixed(1)}%</td>`;
    html += `<td style='padding:12px;text-align:right;color:${pnlColor}'>${stats.pnl.toFixed(2)}</td>`;
    html += `<td style='padding:12px;text-align:right;color:${pnlColor}'>${stats.roi.toFixed(1)}%</td>`;
    html += `</tr>`;
  });

  html += "</table>";
  el.innerHTML = html;
}

// ---------- utils ----------
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
let toastTimer;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}
