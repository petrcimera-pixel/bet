// ============================================================================
// KurzAnalytik v3 — Frontend (kompletně přepsáno)
// ============================================================================

const STATE = { page: 'dashboard', sport: 'soccer', date: todayStr(), statusFilter: 'all', lastMatchesData: null, lastBetMap: {} };

document.addEventListener('DOMContentLoaded', () => {
  setupTheme();
  setupNav();
  setupMobileMenu();
  buildDateStrip();
  bindEvents();
  loadDashboard();
  setupNotifications();
  setupTeamSearch();
  setupLog();
  setupDoporucene();
  setupSbalitelneKarty();
  setupKlavesoveZkratky();
  setupStatusBar();
  // Po návratu na kartu dohnat skóre hned, ne až za celý interval
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshLiveMatches();
  });
});

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Záporná nula na kladnou. Python posílá -0.0 (např. round(-0.001, 2)),
 *  JSON ji zachová a Intl.NumberFormat ji vypíše jako "-0" – u sázkaře na
 *  nule se pak zobrazovalo "+-0" a "-0 %". `-0 === 0` je true, takže
 *  přiřazením literálu 0 se znaménko zahodí. */
function bezZaporneNuly(num) {
  return num === 0 ? 0 : num;
}
function fmt(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(bezZaporneNuly(num));
}
function pct(num, digits = 1) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  // cs-CZ: desetinná čárka + tenké mezerování před % kvůli konzistenci s fmt()
  return new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(bezZaporneNuly(num)) + ' %';
}
/** Číslo s českou desetinnou čárkou bez jednotky – pro místa jako "p.b.",
 *  kde pct() by jednotku zdvojil. */
function czNum(num, digits = 1) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(bezZaporneNuly(num));
}
/** České skloňování "gól" po čísle: 0/5+ gólů, 1 gól, 2–4 góly.
 *  Nečíselný vstup (např. "6+" bucket) vždy dá množné "gólů". */
function czGoly(n) {
  if (typeof n !== 'number') return `${n} gólů`;
  if (n === 1) return '1 gól';
  if (n >= 2 && n <= 4) return `${n} góly`;
  return `${n} gólů`;
}
function el(id) { return document.getElementById(id); }
function setText(id, text) { const e = el(id); if (e) e.textContent = text; }

async function api(path, opts = {}) {
  // Bez timeoutu tu appka na Render free tieru s vychladlou ESPN cache (po
  // deployi, po delší neaktivitě) vypadala jako navždy zaseknutá – žádný
  // fetch v appce neměl žádnou horní hranici čekání. Sdílený timeout tady
  // ochrání VŠECHNA volání /api/*, ne jen jednu stránku.
  const timeoutMs = opts.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { credentials: 'include', signal: controller.signal, ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Požadavek trvá příliš dlouho – zkus to prosím znovu.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function toast(msg, kind = 'ok', ms = 4000) {
  const box = el('toast');
  const item = document.createElement('div');
  item.className = `toast-item ${kind}`;
  item.textContent = msg;
  box.appendChild(item);
  setTimeout(() => item.remove(), ms);
}

// ---------------------------------------------------------------------------
// Živý log – co appka právě dělá
// ---------------------------------------------------------------------------
const LOG_INTERVAL_MS = 2000;
let _logTimer = null;
let _logSeq = 0;               // poslední viděné číslo záznamu
let _logZaznamy = [];          // co držíme v pohledu
let _logPozastaveno = false;
let _logSkryteKat = new Set(); // kategorie, které uživatel vypnul
const LOG_MAX_V_POHLEDU = 1000;

function startLogPolling() {
  if (_logTimer) return;
  nactiLog();
  _logTimer = setInterval(() => {
    if (STATE.page === 'log' && !_logPozastaveno && document.visibilityState === 'visible') {
      nactiLog();
    }
  }, LOG_INTERVAL_MS);
}

function stopLogPolling() {
  if (_logTimer) { clearInterval(_logTimer); _logTimer = null; }
}

async function nactiLog() {
  try {
    const d = await api(`/api/log?od=${_logSeq}`, { timeoutMs: 10000 });
    const nove = d.zaznamy || [];
    if (nove.length) {
      _logSeq = d.posledni_seq || _logSeq;
      _logZaznamy.push(...nove);
      if (_logZaznamy.length > LOG_MAX_V_POHLEDU) {
        _logZaznamy = _logZaznamy.slice(-LOG_MAX_V_POHLEDU);
      }
      vykresliKategorie(d.kategorie || []);
      vykresliLog(nove.length);
    }
    setText('logStatus', `${d.v_bufferu || 0} záznamů v paměti (strop ${d.strop || 0})`
      + (_logPozastaveno ? ' · pozastaveno' : ''));
  } catch (e) {
    setText('logStatus', 'log se nepodařilo načíst');
  }
}

function vykresliKategorie(vsechny) {
  const box = el('logKategorie');
  if (!box) return;
  // překreslit jen když přibyla nová kategorie, ať neblikají
  const soucasne = [...box.querySelectorAll('button')].map(b => b.dataset.kat).sort();
  if (JSON.stringify(soucasne) === JSON.stringify([...vsechny].sort())) return;
  box.innerHTML = vsechny.map(k => `
    <button class="pill clickable ${_logSkryteKat.has(k) ? '' : 'active'}" data-kat="${escAttr(k)}">
      ${k}
    </button>`).join('');
  box.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      const k = b.dataset.kat;
      if (_logSkryteKat.has(k)) _logSkryteKat.delete(k); else _logSkryteKat.add(k);
      b.classList.toggle('active', !_logSkryteKat.has(k));
      vykresliLog();
    });
  });
}

function vykresliLog() {
  const box = el('logVypis');
  if (!box) return;
  const dotaz = _fold((el('logSearch')?.value || '').trim());
  const videt = _logZaznamy.filter(z =>
    !_logSkryteKat.has(z.kat) && (!dotaz || _fold(z.text).includes(dotaz) || _fold(z.kat).includes(dotaz)));

  if (!videt.length) {
    box.innerHTML = `<div class="empty-state">${_logZaznamy.length
      ? 'Nic neodpovídá filtru.' : 'Zatím žádné záznamy.'}</div>`;
    return;
  }
  // Poznat, jestli byl uživatel dole PŘED překreslením – když si odscrolloval
  // nahoru číst starší řádek, nesmí ho nový záznam odtrhnout.
  const drzetDole = el('logAutoScroll')?.checked
    && (box.scrollHeight - box.scrollTop - box.clientHeight < 60 || box.scrollTop === 0);

  box.innerHTML = videt.map(z => `
    <div class="log-radek ${z.uroven}">
      <span class="log-cas">${new Date(z.ts * 1000).toLocaleTimeString('cs-CZ')}</span>
      <span class="log-kat">${esc(z.kat)}</span>
      <span class="log-text">${escAttr(z.text)}</span>
    </div>`).join('');
  if (drzetDole) box.scrollTop = box.scrollHeight;
}

function setupLog() {
  el('logPauseBtn')?.addEventListener('click', () => {
    _logPozastaveno = !_logPozastaveno;
    const b = el('logPauseBtn');
    b.textContent = _logPozastaveno ? '▶ Pokračovat' : '⏸ Pozastavit';
    b.classList.toggle('primary', !_logPozastaveno);
    if (!_logPozastaveno) nactiLog();
  });
  el('logClearBtn')?.addEventListener('click', () => {
    _logZaznamy = [];       // jen pohled; v paměti appky log zůstává
    vykresliLog();
  });
  el('logSearch')?.addEventListener('input', () => vykresliLog());
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------
/* Přepnutí stránky. Vytažené z click handleru, aby na stejnou cestu mohly
   i klávesové zkratky, odkazy ze zdravotního panelu a obnovení z URL. */
function goToPage(page) {
  const btn = document.querySelector(`.nav-btn[data-page="${page}"]`);
  if (!btn) return;
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-current', 'false');
  });
  btn.classList.add('active');
  btn.setAttribute('aria-current', 'page');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  el(`page-${page}`).classList.add('active');
  STATE.page = page;
  closeMobileMenu();

  // Stránka v URL: dřív se po F5 uživatel vždycky vrátil na Dashboard
  // a nešlo si uložit ani poslat odkaz na konkrétní kartu.
  if (location.hash !== `#${page}`) history.replaceState(null, '', `#${page}`);

  if (page !== 'matches') stopLivePolling();   // poller běží jen na Zápasech
  if (page !== 'search') stopSearchPolling();
  if (page !== 'log') stopLogPolling();        // log se netahá na pozadí
  if (page === 'log') startLogPolling();
  if (page === 'doporucene') loadDoporucene();
  if (page === 'dashboard') loadDashboard();
  if (page === 'matches') loadMatches();
  if (page === 'search') loadSearchPage();
  if (page === 'bettors') loadBettors();
  if (page === 'bankroll') { loadBankroll(); loadLigyVykon(); }
  if (page === 'learning') { loadMlLearning(); loadBacktest(); loadAgentBreakdown(); }
  if (page === 'settings') loadSettings();
}

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => goToPage(btn.dataset.page));
  });
  // Stránka z URL má přednost před výchozím Dashboardem.
  const zHash = (location.hash || '').replace('#', '');
  if (zHash && document.querySelector(`.nav-btn[data-page="${zHash}"]`)) goToPage(zHash);
}

/* Klávesové zkratky: 1-9 a 0 přepnou stránku v pořadí sidebaru,
   "?" ukáže nápovědu. Ve formulářových polích se ignorují, jinak by
   nešlo napsat číslo do filtru. */
function setupKlavesoveZkratky() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

    const strany = Array.from(document.querySelectorAll('.nav-btn')).map(b => b.dataset.page);
    if (/^[1-9]$/.test(e.key)) {
      const i = parseInt(e.key, 10) - 1;
      if (strany[i]) { e.preventDefault(); goToPage(strany[i]); }
    } else if (e.key === '0' && strany[9]) {
      e.preventDefault(); goToPage(strany[9]);
    } else if (e.key === '?') {
      e.preventDefault(); toast(`Zkratky: 1–9 a 0 přepínají stránky v pořadí menu (${strany.length} stránek).`);
    }
  });
}

function setupMobileMenu() {
  el('mobileMenuBtn')?.addEventListener('click', () => {
    el('sidebar').classList.add('open');
    el('sidebarOverlay').classList.add('show');
  });
  el('sidebarOverlay')?.addEventListener('click', closeMobileMenu);
}
function closeMobileMenu() {
  el('sidebar')?.classList.remove('open');
  el('sidebarOverlay')?.classList.remove('show');
}

function bindEvents() {
  el('runAgentBtn')?.addEventListener('click', runAgent);
  el('refreshMatchesBtn')?.addEventListener('click', () => loadMatches(true));
  el('saveSettingsBtn')?.addEventListener('click', saveAgentSettings);
  el('saveBankrollBtn')?.addEventListener('click', saveBankrollSettings);
  el('runBettorsBtn')?.addEventListener('click', runBettorsRound);
  el('retrainMlBtn')?.addEventListener('click', retrainMlModel);
  el('apifSaveBtn')?.addEventListener('click', saveApifKey);
  el('backfillBtn')?.addEventListener('click', runBackfill);
  el('backfillArchiveBtn')?.addEventListener('click', runBackfillArchive);
  el('benchmarkBtn')?.addEventListener('click', runBenchmark);
  el('savePerformanceBtn')?.addEventListener('click', savePerformanceSettings);
  el('clearCacheBtn')?.addEventListener('click', clearMatchCache);
  el('resetTipsBtn')?.addEventListener('click', resetTipsDb);
  el('exportSazekBtn')?.addEventListener('click', exportSazekCsv);
  el('exportDataBtn')?.addEventListener('click', exportBackup);
  el('importDataBtn')?.addEventListener('click', () => el('importDataFile').click());
  el('importDataFile')?.addEventListener('change', importBackup);
  el('refreshDiagBtn')?.addEventListener('click', loadAdvancedDiagnostics);
  el('newBettorBtn')?.addEventListener('click', openBettorWizard);
  el('generateBettorBtn')?.addEventListener('click', generateBettorFromData);
  el('wizCancel')?.addEventListener('click', () => { el('bettorWizard').style.display = 'none'; });
  el('wizCreate')?.addEventListener('click', createBettor);
  el('wizReroll')?.addEventListener('click', () => { el('wizName').value = ''; refreshWizPreview(); });
  el('depositCancel')?.addEventListener('click', () => { el('depositModal').style.display = 'none'; });
  el('depositConfirm')?.addEventListener('click', confirmDeposit);
  // klik mimo okno zavře modal
  ['bettorWizard', 'depositModal'].forEach(id => {
    el(id)?.addEventListener('click', (ev) => { if (ev.target.id === id) el(id).style.display = 'none'; });
  });
  document.querySelectorAll('#sportStrip .pill[data-sport]').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#sportStrip .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      STATE.sport = p.dataset.sport;
      loadMatches();
    });
  });
  document.querySelectorAll('#statusStrip .pill[data-status]').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#statusStrip .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      STATE.statusFilter = p.dataset.status;
      // Filtr je čistě klientský (data už máme) – není potřeba nový fetch.
      if (STATE.lastMatchesData) {
        renderMatchesSummary(STATE.lastMatchesData, el('matchesSummary'));
        renderMatchesLeagues(STATE.lastMatchesData.leagues || [], el('matchesContainer'), STATE.lastBetMap);
      }
    });
  });
  // Hledání v už načteném seznamu zápasů – taky čistě klientské.
  el('matchSearch')?.addEventListener('input', () => {
    if (STATE.lastMatchesData) {
      renderMatchesLeagues(STATE.lastMatchesData.leagues || [], el('matchesContainer'), STATE.lastBetMap);
    }
  });
}

// ---------------------------------------------------------------------------
// date strip (Zápasy)
// ---------------------------------------------------------------------------
function buildDateStrip() {
  const strip = el('dateStrip');
  if (!strip) return;
  const today = todayStr();
  const labels = ['−3', '−2', 'Včera', 'Dnes', 'Zítra', '+2', '+3'];
  strip.innerHTML = '';
  for (let i = -3; i <= 3; i++) {
    const d = addDays(today, i);
    const btn = document.createElement('button');
    btn.className = 'pill' + (i === 0 ? ' active' : '');
    btn.textContent = labels[i + 3] === 'Dnes' || labels[i + 3] === 'Včera' || labels[i + 3] === 'Zítra'
      ? labels[i + 3] : d.slice(5).replace('-', '.') + '.';
    btn.dataset.date = d;
    btn.addEventListener('click', () => {
      strip.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      STATE.date = d;
      loadMatches();
    });
    strip.appendChild(btn);
  }
}

// ---------------------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------------------
async function loadDashboard() {
  loadBankrollTiles();
  loadTipOfDay();
  loadAgentSummary();
  loadSettleStatus();
  loadStrategyInsight();
  loadKalibrace();
  loadZdravi();
}

async function loadStrategyInsight() {
  const card = el('insightCard');
  const box = el('insightContent');
  try {
    const d = await api('/api/bettors/insight', { timeoutMs: 15000 });
    if (!d.available) { card.style.display = 'none'; return; }
    card.style.display = 'block';

    const agentRoi = d.agent_stats?.roi;
    const agentLine = agentRoi !== null && agentRoi !== undefined
      ? `Agent má zatím ROI ${pct(agentRoi)} (${d.agent_stats.settled} vyřešeno).`
      : 'Agent zatím nemá dost vyřešených sázek pro srovnání.';

    const applyBtn = d.agent_settings
      ? `<button class="btn small" id="applyInsightBtn" style="margin-top:10px;">Použít toto nastavení na agenta</button>`
      : `<div class="muted" style="font-size:12px; margin-top:8px;">Tuhle strategii nejde na agenta 1:1 nastavit (řídí se jinak než agent umí) – jde jen o inspiraci.</div>`;

    box.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <span style="font-size:24px;">${d.emoji}</span>
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:700;">${esc(d.name)}</div>
          <div style="font-size:12px; color:var(--txt2);">${d.tagline}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700; color:var(--pos);">ROI ${pct(d.roi)}</div>
          <div style="font-size:11.5px; color:var(--txt2);">${pct(d.win_rate)} win rate · ${d.settled} vyřešeno</div>
        </div>
      </div>
      <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border); font-size:12.5px; color:var(--txt2);">${agentLine}</div>
      ${applyBtn}
    `;
    el('applyInsightBtn')?.addEventListener('click', applyStrategyInsight);
  } catch (e) {
    card.style.display = 'none';
  }
}

async function applyStrategyInsight() {
  const btn = el('applyInsightBtn');
  btn.disabled = true;
  btn.textContent = 'Aplikuji…';
  try {
    const data = await api('/api/bettors/insight/apply', { method: 'POST' });
    toast('Nastavení agenta aktualizováno podle vedoucí strategie.');
    loadStrategyInsight();
  } catch (e) {
    toast(`Nepodařilo se aplikovat: ${e.message}`, 'err');
    btn.disabled = false;
    btn.textContent = 'Použít toto nastavení na agenta';
  }
}

async function loadBankrollTiles() {
  try {
    const data = await api('/api/bankroll');
    const s = data.stats;
    setText('stBalance', `${fmt(s.balance)} ${s.currency || 'Kč'}`);
    // "od startu" mátlo: rozdíl proti startovnímu banku zahrnuje i vklady
    // zamrzlé v otevřených sázkách, takže vedle "zisk -10 Kč" svítilo
    // "-301 Kč od startu". Radši ukázat, kolik peněz je zrovna ve hře.
    setText('stBalanceHint', s.open_stake
      ? `${fmt(s.open_stake)} ${s.currency || 'Kč'} v otevřených sázkách`
      : 'žádné otevřené sázky');
    setText('stProfit', `${fmt(s.profit)} ${s.currency || 'Kč'}`);
    el('stProfit').className = 'value ' + (s.profit >= 0 ? 'pos' : 'bad');
    setText('stProfitHint', s.roi !== null && s.roi !== undefined ? `${pct(s.roi)} ROI` : '');
    setText('stWinRate', s.win_rate !== null ? pct(s.win_rate) : '—');
    setText('stWinHint', s.settled_count ? `${s.won_count || 0}/${s.settled_count} výher` : 'zatím žádná data');
    setText('stOpen', s.open_count ?? 0);
    loadTodayTile();
  } catch (e) { /* tichý fallback – tiles zůstanou na — */ }
}

/** Dlaždice "Dnes" – bilance jen z dnešních vyhodnocených sázek.
 *  Celkový zisk se hýbe pomalu, takže po jednom dni sázení není poznat,
 *  jestli šlo o dobrý nebo špatný den. */
async function loadTodayTile() {
  try {
    const d = await api('/api/bankroll/daily', { timeoutMs: 15000 });
    const dnes = todayStr();
    const z = (d.daily || {})[dnes];
    if (!z || !z.bets) {
      setText('stToday', '—');
      setText('stTodayHint', 'dnes zatím nic vyhodnoceného');
      el('stToday').className = 'value';
      return;
    }
    const pnl = z.pnl || 0;
    setText('stToday', `${pnl >= 0 ? '+' : ''}${fmt(pnl)} Kč`);
    el('stToday').className = 'value ' + (pnl >= 0 ? 'pos' : 'bad');
    setText('stTodayHint', `${z.wins || 0}/${z.bets} výher · ${pct(z.win_rate)}`);
  } catch (e) {
    setText('stTodayHint', '');
  }
}

async function loadTipOfDay() {
  const loadingEl = el('tipLoading');
  const contentEl = el('tipContent');
  loadingEl.style.display = 'flex';
  loadingEl.innerHTML = '<span class="spinner"></span> Hledám tutovku…';
  contentEl.style.display = 'none';

  // /api/dashboard stahuje čerstvá ESPN data SYNCHRONNĚ, když je cache
  // vychladlá (po deployi, po delší neaktivitě appky) – může to trvat
  // desítky sekund až přes minutu. Bez postupné zprávy to vypadá jako
  // appka je navždy zaseknutá.
  const t1 = setTimeout(() => { loadingEl.innerHTML = '<span class="spinner"></span> Stahuji čerstvá data z ESPN, může to chvíli trvat…'; }, 6000);
  const t2 = setTimeout(() => { loadingEl.innerHTML = '<span class="spinner"></span> Pořád stahuji – po delší neaktivitě appky to bývá pomalejší…'; }, 20000);

  try {
    const data = await dashboardData();
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
    const tips = (data.tips && data.tips.length) ? data.tips : (data.tip ? [data.tip] : []);
    if (!tips.length) {
      contentEl.innerHTML = `<div class="match" style="font-size:15px; color:var(--txt2); margin-top:8px;">
        Dnes žádná tutovka se skutečnými kurzy nesplňuje kritéria jistoty.</div>`;
      return;
    }
    // Nejjistější tip nahoře zůstává zvýrazněný (stejný vzhled jako dřív),
    // zbytek (max 4 další) jde pod něj jako menší řádky – jeden zápas =
    // jeden tip, ať to není jen kopie stejné jistoty pořád dokola.
    const [top, ...rest] = tips;
    contentEl.innerHTML = `
      <div class="match">${top.match}</div>
      <div class="meta">${top.league || ''} · ${(top.date || '').slice(5)} ${top.time || ''}</div>
      <div class="pick-line">
        <span class="pick-name">${top.name}</span>
        <span class="odds-chip">${top.odds.toFixed(2)}</span>
        <span class="conf-chip">${Math.round(top.prob * 100)} % jistota</span>
        ${tipsportBadge(top.home, top.tipsport)}
        ${(top.why && top.why.length) ? '<button class="btn small tip-why-btn" id="tipWhyBtn">💡 Proč tenhle tip? ▾</button>' : ''}
      </div>
      ${(top.why && top.why.length) ? `
        <div class="tip-why" id="tipWhyBox" style="display:none;">
          <ul>${top.why.map(w => `<li>${w}</li>`).join('')}</ul>
          <div class="tip-why-meta">
            ${top.from_candidates ? `Vybráno jako nejjistější z <strong>${top.from_candidates}</strong> dnešních zápasů, které prošly filtry.` : ''}
            ${(top.raw_prob != null && Math.abs(top.raw_prob - top.prob) >= 0.02)
              ? ` Syrový odhad modelu byl ${Math.round(top.raw_prob * 100)} %, kalibrace podle skutečné úspěšnosti ho posunula na ${Math.round(top.prob * 100)} %.`
              : ''}
            ${top.edge != null ? ` Náskok proti kurzu ${czNum(top.edge * 100)} p.b.${top.is_value ? ' – model vidí value.' : ''}` : ''}
          </div>
        </div>` : ''}
      ${rest.length ? `
        <div class="tip-more">
          ${rest.map(t => `
            <div class="tip-more-row">
              <span class="tip-more-match">${t.match}</span>
              <span class="tip-more-pick">${t.name}</span>
              <span class="odds-chip small">${t.odds.toFixed(2)}</span>
              <span class="conf-chip small">${Math.round(t.prob * 100)} %</span>
            </div>`).join('')}
        </div>` : ''}`;
    el('tipWhyBtn')?.addEventListener('click', () => {
      const box = el('tipWhyBox');
      const otevreno = box.style.display !== 'none';
      box.style.display = otevreno ? 'none' : 'block';
      el('tipWhyBtn').textContent = otevreno ? '💡 Proč tenhle tip? ▾' : '💡 Proč tenhle tip? ▴';
    });
  } catch (e) {
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
    contentEl.innerHTML = `<div class="match" style="color:var(--bad); font-size:14px;">
      Nepodařilo se načíst tip dne (${e.message}).
      <div style="margin-top:8px;"><button class="btn small" id="tipRetryBtn">Zkusit znovu</button></div>
    </div>`;
    el('tipRetryBtn')?.addEventListener('click', loadTipOfDay);
  } finally {
    clearTimeout(t1);
    clearTimeout(t2);
  }
}

async function loadAgentSummary() {
  try {
    const data = await api('/api/agent');
    const s = data.stats;
    const cfg = data.settings || {};
    STATE.agentCfg = cfg;

    // Stav a rozvrh: bez tohohle nebylo z dashboardu poznat, jestli agent
    // vůbec běží a kdy se chystá sázet – jen kolik už vsadil.
    const hodiny = String(cfg.auto_run_hours || '').split(',').map(h => parseInt(h, 10)).filter(h => !isNaN(h)).sort((a, b) => a - b);
    const ted = new Date();
    const dalsi = hodiny.find(h => h > ted.getHours());
    const rozvrh = !cfg.enabled ? 'agent je vypnutý'
      : !cfg.auto_run ? 'jen ruční spouštění'
      : hodiny.length ? `další kolo ${dalsi != null ? `dnes ${String(dalsi).padStart(2, '0')}:00` : `zítra ${String(hodiny[0]).padStart(2, '0')}:00`}`
      : 'rozvrh není nastavený';

    const radek = (popisek, hodnota, trida = '', tip = '') => `
      <div class="ag-row"${tip ? ` title="${escAttr(tip)}"` : ''}>
        <span class="muted">${popisek}</span><span class="${trida}">${hodnota}</span>
      </div>`;

    el('agentSummary').className = '';   // odstraň 'loading' padding, jinak se rozjede layout
    el('agentSummary').innerHTML = `
      <div class="ag-state ${cfg.enabled ? 'on' : 'off'}">
        <span class="ag-dot"></span>
        <span><strong>${cfg.enabled ? 'Zapnutý' : 'Vypnutý'}</strong> <span class="muted">· ${rozvrh}</span></span>
      </div>
      ${s.profit_curve && s.profit_curve.length > 2
        ? `<div class="ag-spark" title="Vývoj zisku agenta v pořadí vyhodnocení sázek">${sparklineSvg(s.profit_curve)}</div>` : ''}
      <div class="ag-rows">
        ${radek('Umístěno', s.placed, '', 'Kolik sázek agent celkem vytvořil')}
        ${radek('Otevřené', s.open ?? 0, '', 'Sázky, které ještě čekají na výsledek')}
        ${radek('Vyřešeno', `${s.settled} (${s.accuracy !== null ? pct(s.accuracy) : '—'})`, '', 'Vyhodnocené sázky a jejich úspěšnost')}
        ${radek('Zisk', `${s.profit >= 0 ? '+' : ''}${fmt(s.profit)} Kč`, s.profit >= 0 ? 'pos' : 'bad')}
        ${radek('ROI', s.roi !== null ? pct(s.roi) : '—', s.roi >= 0 ? 'pos' : 'bad', 'Zisk děleno celkem vsazeno')}
        ${radek('Vsazeno dnes', `${fmt(s.staked_today || 0)} Kč`, '',
                'Kolik agent prosázel dnes – proti dennímu stropu banku níž')}
      </div>
      ${data.tickets_blocked ? `
        <div class="ag-block" title="Pojistka v enginu, nezávislá na nastavení">
          🚫 <strong>AKO tikety pozastavené</strong><br>
          <span class="muted">${data.tickets_blocked}</span>
        </div>` : ''}
      <div class="ag-cfg">
        <span class="pill info" title="Minimální kalibrovaná jistota, aby agent tip vůbec zvážil">jistota ≥ ${Math.round((cfg.min_prob || 0) * 100)} %</span>
        <span class="pill info" title="Minimální kurz – pod ním se sázka nevyplatí">kurz ≥ ${cfg.min_odds ?? '—'}</span>
        <span class="pill info" title="Jak se počítá výše vkladu">${cfg.stake_mode === 'kelly' ? `Kelly ${cfg.kelly_fraction ?? ''}` : `plochých ${cfg.stake ?? ''} Kč`}</span>
        <span class="pill info" title="Strop: nejvýš tolik procent banku smí agent prosázet za jeden den">denně ≤ ${Math.round((cfg.max_daily_stake_pct || 0) * 100)} % banku</span>
      </div>`;
    renderRecentBets(data.bets || []);
  } catch (e) {
    el('agentSummary').innerHTML = `<div class="empty-state" style="padding:10px 0;">Chyba načítání</div>`;
    // Bez tohohle zůstane karta "Poslední tipy agenta" na věčném spinneru.
    chybaKarty('recentBets', 'Sázky agenta se nepodařilo načíst.', loadAgentSummary);
  }
}

function renderRecentBets(bets) {
  const box = el('recentBets');
  box.className = '';
  if (!bets.length) { box.innerHTML = `<div class="empty-state">Agent zatím nevsadil žádný tip</div>`; return; }
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Zápas</th><th>Kdy</th><th>Zápas stav</th><th>Tip</th><th>Kurz</th><th>Sázka</th><th>P&L</th><th></th></tr></thead>
    <tbody>${bets.slice(0, 12).map((b, i) => {
      const hasWhy = (b.why && b.why.length) || b.outcome === 'acca';
      const when = fmtWhen(b.match_date, b.match_time) || '—';
      const whyId = `betWhy${i}`;
      return `
      <tr>
        <td>${b.match || '—'} ${tipsportBetLink(b.match, b.status, b.tipsport)}</td>
        <td class="muted">${when}</td>
        <td>${matchStateHtml(b.match_date, b.match_time, b.status, b.result, b.live_result, b.live)}</td>
        <td>${b.label || '?'}</td>
        <td>${b.odds || 0}×</td>
        <td><span class="badge ${b.status}">${(b.status || 'open').toUpperCase()}</span></td>
        <td class="${b.status === 'open' ? 'muted' : (b.pnl || 0) > 0 ? 'pos' : 'bad'}">
          ${b.status === 'open' ? '—' : `${(b.pnl || 0) > 0 ? '+' : ''}${fmt(b.pnl || 0)} Kč`}
        </td>
        <td>${hasWhy ? `<button class="btn small bet-why-toggle" data-target="${whyId}">💡</button>` : ''}</td>
      </tr>
      ${hasWhy ? `
      <tr id="${whyId}" class="bet-why-row" style="display:none;">
        <td colspan="8" style="background:var(--panel-2);">
          ${b.outcome === 'acca'
            ? `<div style="font-size:12.5px; color:var(--txt2);"><strong>AKO tiket – nohy:</strong><ul style="margin:6px 0 0; padding-left:18px;">
                ${(b.legs || []).map(l => `<li>${esc(l.match)} ${tipsportBetLink(l.match, 'open', l.tipsport)}: <strong>${l.name}</strong> @ ${l.odds}× (${Math.round((l.prob || 0) * 100)}%)</li>`).join('')}
              </ul></div>`
            : `<ul style="margin:0; padding-left:18px; font-size:12.5px; color:var(--txt2);">${(b.why || []).map(w => `<li>${w}</li>`).join('')}</ul>`}
        </td>
      </tr>` : ''}`;
    }).join('')}</tbody>
  </table></div>`;

  box.querySelectorAll('.bet-why-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = el(btn.dataset.target);
      row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
    });
  });
}

function fmtTime(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderSettleDetail(s) {
  const box = el('settleDetail');
  if (!box) return;
  const lines = [];
  const t = fmtTime(s.last_check);
  if (t) {
    lines.push(`Poslední kontrola: <strong style="color:var(--txt2);">${t}</strong>${s.last_pass_duration_s != null ? ` (trvala ${s.last_pass_duration_s} s)` : ''}`);
    lines.push(`Zkontrolovaná dávka: <strong style="color:var(--txt2);">${s.batch_size ?? '—'}</strong> z ${s.total_targets ?? '—'} čekajících lig/dnů`);
    lines.push(`Nalezeno výsledků: <strong style="color:var(--txt2);">${s.results_found ?? 0}</strong>${s.n_stuck ? ` · ${s.n_stuck} požadavků nestihlo limit (zkusí se příští kolo)` : ''}`);
  } else {
    lines.push('Appka ještě neproběhla žádnou kontrolu výsledků (čeká na první cron tik nebo klikni na tlačítko).');
  }
  if (s.last_error) {
    lines.push(`<span style="color:var(--bad);">Poslední chyba: ${s.last_error.split('\n')[0]}</span>`);
  }
  box.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
}

// ---------------------------------------------------------------------------
// Dolní stavová lišta – kdy naposled proběhla kontrola výsledků
// ---------------------------------------------------------------------------
const STATUSBAR_POLL_MS = 60 * 1000;
const SYSBAR_POLL_MS = 4 * 1000;   // progres bary a RAM/CPU/síť – rychlejší, ať je vidět postup živě
const SETTLE_STALE_MIN = 30;   // od kdy je kontrola "dávno" (oranžová tečka)

function agoText(ts) {
  if (!ts) return null;
  const min = Math.floor((Date.now() / 1000 - ts) / 60);
  if (min < 1) return 'právě teď';
  if (min < 60) return `před ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  return `před ${d} ${d === 1 ? 'dnem' : d < 5 ? 'dny' : 'dny'}`;
}

async function updateStatusBar() {
  try {
    const s = await api('/api/settle/status', { timeoutMs: 15000 });
    const running = !!s.in_progress;
    const min = s.last_check ? (Date.now() / 1000 - s.last_check) / 60 : null;
    const dot = running ? 'running' : (min === null || min > SETTLE_STALE_MIN) ? 'stale' : '';
    const when = s.last_check
      ? `${fmtTime(s.last_check)} (${agoText(s.last_check)})`
      : 'zatím neproběhla';
    el('sbSettle').innerHTML = running
      ? `<span class="sb-dot running"></span>Kontrola výsledků právě běží…`
      : `<span class="sb-dot ${dot}"></span>Poslední kontrola výsledků: <strong>${when}</strong>`
        + (s.last_pass_duration_s ? ` · trvala ${s.last_pass_duration_s} s` : '')
        + (s.results_found != null ? ` · nalezeno ${s.results_found}` : '');

    const pending = (s.open_tips || 0) + (s.open_bets || 0) + (s.open_vb_bets || 0);
    setText('sbPending', pending ? `· čeká ${pending} položek` : '· fronta prázdná');
    if (s.last_error) {
      el('sbPending').innerHTML = `· <span class="bad">chyba: ${s.last_error}</span>`;
    }
  } catch (e) {
    el('sbSettle').innerHTML = '<span class="sb-dot stale"></span>Stav kontroly se nepodařilo načíst';
  }
  try {
    const a = await api('/api/agent', { timeoutMs: 15000 });
    const st = a.stats || {};
    setText('sbAgent', `Agent: ${st.open || 0} otevřených · ${st.settled || 0} vyřešeno · ROI ${st.roi != null ? pct(st.roi) : '—'}`);
  } catch (e) { /* lišta nesmí kvůli tomuhle zmizet */ }
}

function setupStatusBar() {
  el('sbCheckBtn')?.addEventListener('click', async () => {
    const btn = el('sbCheckBtn');
    btn.disabled = true; btn.textContent = 'Kontroluji…';
    try {
      await settleNow();
    } catch (e) {
      // chyba i toast už řeší settleNow()
    } finally {
      btn.disabled = false; btn.textContent = 'Zkontrolovat teď';
      updateStatusBar();
    }
  });
  updateStatusBar();
  updateSystemBar();
  setInterval(() => {
    if (document.visibilityState === 'visible') updateStatusBar();
  }, STATUSBAR_POLL_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') updateSystemBar();
  }, SYSBAR_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { updateStatusBar(); updateSystemBar(); }
  });
}

/** Progres bary (načítání zápasů, vyhodnocování) + RAM/CPU/síť ve stavové
 *  liště. Pollováno mnohem rychleji než zbytek lišty (viz SYSBAR_POLL_MS),
 *  ale odpověď je malá a levná (žádné počítání otevřených sázek), takže
 *  to nezatěžuje appku o nic víc, než ukazovat hodinky.*/
async function updateSystemBar() {
  let d;
  try {
    d = await api('/api/system/live', { timeoutMs: 8000 });
  } catch (e) {
    return;   // dočasný výpadek se prostě přeskočí, lišta zůstane na starém stavu
  }

  const fetchP = d.fetch || {};
  const fetchRow = el('sbFetchProgress');
  if (fetchRow) {
    if (fetchP.active && fetchP.total) {
      fetchRow.style.display = 'flex';
      const pct = Math.min(100, Math.round((fetchP.done / fetchP.total) * 100));
      el('sbFetchFill').style.width = pct + '%';
      el('sbFetchNum').textContent = `${fetchP.done}/${fetchP.total} lig`;
    } else {
      fetchRow.style.display = 'none';
    }
  }

  const settleP = d.settle || {};
  const settleRow = el('sbSettleProgress');
  if (settleRow) {
    if (settleP.active && settleP.total) {
      settleRow.style.display = 'flex';
      const pct = Math.min(100, Math.round((settleP.done / settleP.total) * 100));
      el('sbSettleFill').style.width = pct + '%';
      el('sbSettleNum').textContent = `${settleP.done}/${settleP.total}`;
    } else if (settleP.active) {
      // Vyhodnocování běží, ale zatím nevíme kolik toho celkem je (první
      // okamžiky běhu) – ukázat aspoň neurčitý stav, ne nic.
      settleRow.style.display = 'flex';
      el('sbSettleFill').style.width = '100%';
      el('sbSettleNum').textContent = '…';
    } else {
      settleRow.style.display = 'none';
    }
  }

  const progRow = el('sbProgressRow');
  if (progRow) {
    const anyActive = (fetchP.active && fetchP.total) || settleP.active;
    progRow.style.display = anyActive ? 'flex' : 'none';
  }

  const sys = d.sys || {};
  const sysEl = el('sbSys');
  if (sysEl) {
    if (!sys.available) {
      sysEl.textContent = '';
    } else {
      const cpuWarn = (sys.cpu_pct || 0) > 80 ? 'sb-sys-warn' : '';
      const parts = [
        `🧠 ${czNum(sys.rss_mb, 0)} MB`,
        `<span class="${cpuWarn}">⚙️ ${czNum(sys.cpu_pct, 0)} %</span>`,
      ];
      if (sys.net_up_kbps != null && sys.net_down_kbps != null) {
        parts.push(`📶 ↑${czNum(sys.net_up_kbps, 0)} ↓${czNum(sys.net_down_kbps, 0)} kB/s`);
      }
      sysEl.innerHTML = parts.join(' · ');
    }
  }
}

async function loadSettleStatus() {
  try {
    const s = await api('/api/settle/status');
    const bar = el('settleBar');
    const total = (s.open_tips || 0) + (s.open_bets || 0);
    if (total > 0) {
      bar.style.display = 'block';
      setText('settleText', `Čeká ${total} položek na vyhodnocení (${s.open_bets || 0} sázek, ${s.open_tips || 0} tipů).`);
      renderSettleDetail(s);
    } else {
      bar.style.display = 'none';
    }
  } catch (e) { /* nic */ }
}

/** Jediné místo, které spouští kontrolu výsledků – volané tlačítkem ve
 *  stavové liště (to je vidět na všech stránkách). Dřív existovalo druhé,
 *  identické tlačítko přímo v Dashboard kartě; teď ta karta jen pasivně
 *  ukazuje průběh (spinner, text), když se kontrola spustí odkudkoli. */
async function settleNow() {
  const spinner = el('settleSpinner');
  if (spinner) spinner.style.display = 'inline-block';
  setText('settleText', 'Stahuji čerstvé výsledky z ESPN pro čekající ligy…');
  try {
    const data = await api('/api/tips/settle', { method: 'POST', timeoutMs: 90000 });
    toast(`Vyhodnoceno: ${data.settled || 0} tipů, ${data.settled_bets || 0} sázek.`);
    if (STATE.page === 'dashboard') loadDashboard();
    return data;
  } catch (e) {
    toast(`Vyhodnocení selhalo: ${e.message}`, 'err');
    loadSettleStatus();
    throw e;
  } finally {
    if (spinner) spinner.style.display = 'none';
  }
}

async function runAgent() {
  const btn = el('runAgentBtn');
  btn.disabled = true;
  btn.textContent = 'Spouštím…';
  try {
    const data = await api('/api/agent/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    if (data.skipped) {
      toast('Agent je v Nastavení vypnutý.', 'err');
    } else {
      toast(`Agent vsadil ${data.placed || 0} tipů.`);
      loadDashboard();
    }
  } catch (e) {
    toast('Běh agenta selhal.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Spustit agenta teď';
  }
}

// ---------------------------------------------------------------------------
// MATCHES
// ---------------------------------------------------------------------------
async function loadMatches(refresh = false) {
  const container = el('matchesContainer');
  const summary = el('matchesSummary');
  container.innerHTML = '<div class="loading"><span class="spinner"></span> Načítání zápasů…</div>';
  summary.innerHTML = '';

  const loadingEl = container.querySelector('.loading');
  const t1 = setTimeout(() => { if (loadingEl) loadingEl.innerHTML = '<span class="spinner"></span> Stahuji čerstvá data z ESPN, může to chvíli trvat…'; }, 6000);
  const t2 = setTimeout(() => { if (loadingEl) loadingEl.innerHTML = '<span class="spinner"></span> Pořád stahuji – první návštěva dne bývá pomalejší…'; }, 20000);

  try {
    const url = `/api/matches?date=${STATE.date}&sport=${STATE.sport}&days=1${refresh ? '&refresh=1' : ''}`;
    const [data, betMap] = await Promise.all([
      api(url, { timeoutMs: 90000 }),
      loadMatchBetMap(),
    ]);
    STATE.lastMatchesData = data;
    STATE.lastBetMap = betMap;
    renderMatchesSummary(data, summary);
    renderMatchesLeagues(data.leagues || [], container, betMap);
    syncLivePolling(data);
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Chyba: ${e.message}
      <button class="btn small" id="matchesRetryBtn" style="margin-top:8px;">Zkusit znovu</button></div>`;
    el('matchesRetryBtn')?.addEventListener('click', () => loadMatches(refresh));
  } finally {
    clearTimeout(t1); clearTimeout(t2);
  }
}

// ---------------------------------------------------------------------------
// Vyhledávání týmu + rozbor zápasu
// ---------------------------------------------------------------------------
let _searchTimer = null;

function setupTeamSearch() {
  const input = el('teamSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const q = input.value.trim();
    // debounce – první hledání dne stahuje 14denní okno z ESPN (~20 s),
    // nemá smysl ho pouštět po každém písmenu
    _searchTimer = setTimeout(() => (q.length >= 2 ? runTeamSearch(q) : clearSearch()), 450);
  });
  el('teamSearchClear')?.addEventListener('click', () => { input.value = ''; clearSearch(); });
}

function clearSearch() {
  el('searchResults').innerHTML = '';
  el('matchAnalysis').style.display = 'none';
  el('teamSearchClear').style.display = 'none';
}

// Server drží zápasy v keši a po půl hodině si je sám obnoví na pozadí,
// takže tohle jen dotahuje výsledek – není to stahování z ESPN při každém tiku.
const SEARCH_POLL_MS = 5 * 60 * 1000;
let _searchPollTimer = null;

async function loadSearchPage() {
  loadLeagues();
  startSearchPolling();
}

function startSearchPolling() {
  if (_searchPollTimer) return;
  _searchPollTimer = setInterval(() => {
    if (STATE.page !== 'search' || document.visibilityState !== 'visible') return;
    // neobnovuj pod rukama: ne když je rozkliknutá liga, rozbor nebo hledání
    if (el('leaguesBackBtn')) return;
    if (el('matchAnalysis').style.display !== 'none') return;
    if ((el('teamSearch')?.value || '').trim().length >= 2) return;
    loadLeagues();
  }, SEARCH_POLL_MS);
}

function stopSearchPolling() {
  if (_searchPollTimer) { clearInterval(_searchPollTimer); _searchPollTimer = null; }
}

/** Přehled soutěží, ve kterých appka vidí nadcházející zápasy. */
async function loadLeagues() {
  const box = el('leaguesList');
  const sum = el('leaguesSummary');
  if (!box) return;
  box.innerHTML = '<div class="loading"><span class="spinner"></span> Načítám soutěže…</div>';
  try {
    const d = await api(`/api/leagues?sport=${STATE.sport}`, { timeoutMs: 120000 });
    if (!d.leagues || !d.leagues.length) {
      sum.innerHTML = '';
      box.innerHTML = '<div class="empty-state">Momentálně nevidím žádné nadcházející zápasy.</div>';
      return;
    }
    const apif = d.apifootball || {};
    const withOddsLeagues = d.leagues.filter(l => l.with_odds).length;
    sum.innerHTML = `
      <div class="pill-row" style="margin-bottom:10px;">
        <span class="pill info">${d.total_leagues} soutěží</span>
        <span class="pill info">${d.total_matches} zápasů</span>
        <span class="pill info">${d.total_with_odds} zápasů s kurzy</span>
        <span class="pill clickable" id="pillOnlyOdds"
              title="Kliknutím necháš jen soutěže s reálnými kurzy">💰 ${withOddsLeagues} soutěží s kurzy</span>
        <span class="pill info">okno ${d.days} dní</span>
        ${apif.enabled ? `<span class="pill info">+ doplňkové ligy (${apif.window_from} – ${apif.window_to})</span>` : ''}
      </div>
      <div class="toolbar-row" style="margin-bottom:12px;">
        <input type="text" id="leagueFilter" class="search-input" placeholder="Filtrovat soutěž nebo zemi…">
        <button class="btn small" id="leagueOnlyOdds">Jen s kurzy</button>
      </div>`;
    STATE.leaguesData = d.leagues;
    el('leagueFilter')?.addEventListener('input', renderLeagueRows);
    const toggleOnlyOdds = () => {
      _leagueOnlyOdds = !_leagueOnlyOdds;
      el('leagueOnlyOdds')?.classList.toggle('primary', _leagueOnlyOdds);
      el('pillOnlyOdds')?.classList.toggle('active', _leagueOnlyOdds);
      renderLeagueRows();
    };
    el('leagueOnlyOdds')?.addEventListener('click', toggleOnlyOdds);
    el('pillOnlyOdds')?.addEventListener('click', toggleOnlyOdds);
    renderLeagueRows();
  } catch (e) {
    box.className = '';
    box.innerHTML = `<div class="empty-state">Načtení soutěží selhalo: ${e.message}</div>`;
  }
}

// Filtr i řazení jsou čistě klientské – data už máme, není proč chodit na server.
let _leagueOnlyOdds = false;
let _leagueSort = { key: 'matches', dir: -1 };

function renderLeagueRows() {
  const box = el('leaguesList');
  const q = _fold(el('leagueFilter')?.value || '');
  let list = (STATE.leaguesData || []).filter(l =>
    (!_leagueOnlyOdds || l.with_odds > 0) &&
    (!q || _fold(l.league).includes(q) || _fold(l.country || '').includes(q)));
  const k = _leagueSort.key, dir = _leagueSort.dir;
  list = [...list].sort((a, b) => {
    const va = a[k], vb = b[k];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va ?? '').localeCompare(String(vb ?? ''), 'cs') * dir;
  });
  const arrow = key => _leagueSort.key === key ? (_leagueSort.dir < 0 ? ' ▾' : ' ▴') : '';
  {
    const rows = list.map(l => {
      // ligy z doplňkového zdroje nemají kurzy, takže na nich agent nesází
      const odds = l.with_odds
        ? `<span class="badge real">${l.with_odds}</span>`
        : '<span class="badge model">jen model</span>';
      const span = l.next_date === l.last_date
        ? fmtDateShort(l.next_date)
        : `${fmtDateShort(l.next_date)} – ${fmtDateShort(l.last_date)}`;
      return `<tr class="search-row-item league-row" data-league="${escAttr(l.league)}" data-country="${escAttr(l.country || '')}">
        <td>${l.flag || ''} ${l.league}</td>
        <td class="muted">${l.country || ''}</td>
        <td><strong>${l.matches}</strong></td>
        <td>${odds}</td>
        <td class="muted">${span}</td>
        <td><button class="btn small">Zápasy →</button></td>
      </tr>`;
    }).join('');
    box.className = '';
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr>
        <th class="lg-sort" data-key="league">Soutěž${arrow('league')}</th>
        <th class="lg-sort" data-key="country">Země${arrow('country')}</th>
        <th class="lg-sort" data-key="matches">Zápasů${arrow('matches')}</th>
        <th class="lg-sort" data-key="with_odds">S kurzy${arrow('with_odds')}</th>
        <th class="lg-sort" data-key="next_date">Kdy${arrow('next_date')}</th>
        <th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">Nic neodpovídá filtru</td></tr>'}</tbody></table></div>`;
    box.querySelectorAll('.league-row').forEach(tr => {
      tr.addEventListener('click', () => openLeagueMatches(tr.dataset.league, tr.dataset.country));
    });
    box.querySelectorAll('.lg-sort').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        _leagueSort = { key, dir: _leagueSort.key === key ? -_leagueSort.dir : -1 };
        renderLeagueRows();
      });
    });
  }
}

/** Text bez diakritiky – ať "plzen" najde "Plzeň" i ve filtru soutěží. */
function _fold(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Názvy soutěží chodí ze zdrojů dat, takže do atributu jen escapované. */
function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/* Kratší alias – escapuje & " < >, takže je bezpečný i pro textový obsah,
   ne jen pro atributy. Jméno sázkaře si uživatel zadává sám, názvy týmů
   a lig chodí z cizího API; obojí patří do šablony jen přes tuhle funkci. */
const esc = escAttr;

/* Jednotný chybový stav karty. Dřív si každá karta řešila chybu po svém
   a některé vůbec: když spadlo /api/agent, zůstala karta "Poslední tipy
   agenta" napořád na točícím se spinneru z index.html, protože její
   render se volal až PO úspěchu. Vedle sebe pak svítilo "Chyba načítání"
   a věčné kolečko. */
/* Sbalitelné karty si pamatují stav mezi návštěvami.
   Bez paměti by uživatel zavíral tutéž dlouhou kartu při každém otevření
   stránky, což je horší než ji nesbalovat vůbec. */
const SBALENO_KEY = 'sbaleneKarty';

function nactiSbaleni() {
  try { return JSON.parse(localStorage.getItem(SBALENO_KEY)) || {}; }
  catch (e) { return {}; }
}

function setupSbalitelneKarty() {
  const stav = nactiSbaleni();
  document.querySelectorAll('details.card[id]').forEach(d => {
    if (d.id in stav) d.open = stav[d.id];
    d.addEventListener('toggle', () => {
      const s = nactiSbaleni();
      s[d.id] = d.open;
      try { localStorage.setItem(SBALENO_KEY, JSON.stringify(s)); } catch (e) {}
    });
  });
}

function chybaKarty(id, zprava, znovu) {
  const box = el(id);
  if (!box) return;
  box.className = '';
  const btnId = `retry_${id}`;
  box.innerHTML = `<div class="empty-state">
      ${esc(zprava)}
      ${znovu ? `<button class="btn small" id="${btnId}" style="margin-top:10px;">Zkusit znovu</button>` : ''}
    </div>`;
  if (znovu) el(btnId)?.addEventListener('click', znovu);
}

/** Rozkliknutá soutěž – nahradí seznam soutěží jejími zápasy. */
async function openLeagueMatches(league, country) {
  const box = el('leaguesList');
  el('matchAnalysis').style.display = 'none';
  box.innerHTML = '<div class="loading"><span class="spinner"></span> Načítám zápasy soutěže…</div>';
  try {
    const d = await api(`/api/league/matches?league=${encodeURIComponent(league)}`
      + `&country=${encodeURIComponent(country || '')}&sport=${STATE.sport}`, { timeoutMs: 120000 });
    const rows = (d.matches || []).map(m => `
      <tr class="search-row-item" data-id="${escAttr(m.id)}" data-sport="${escAttr(m.sport)}">
        <td>${fmtWhen(m.date, m.time)}</td>
        <td><strong>${esc(m.home)}</strong> – ${esc(m.away)}</td>
        <td>${m.has_odds ? '<span class="badge real">kurzy</span>'
              : `<span class="badge model" title="${m.odds_expected ? 'Kurzy se obvykle objeví krátce před výkopem' : 'Takhle daleko dopředu ESPN kurzy nedává'}">jen model</span>`}</td>
        <td>${tipsportBadge(m.home, m.tipsport, { short: true, stopPropagation: true })}</td>
        <td><button class="btn small">Rozbor →</button></td>
      </tr>`).join('');
    box.innerHTML = `
      <div style="margin-bottom:12px;">
        <button class="btn small" id="leaguesBackBtn">← Zpět na soutěže</button>
      </div>
      <h4 style="margin:0 0 10px;">${d.flag || ''} ${d.league} <span class="muted">(${d.total} zápasů)</span></h4>
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th>Kdy</th><th>Zápas</th><th></th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
        : '<div class="empty-state">V téhle soutěži teď nevidím žádný nadcházející zápas.</div>'}`;
    el('leaguesBackBtn').addEventListener('click', loadLeagues);
    box.querySelectorAll('tr.search-row-item[data-id]').forEach(tr => {
      tr.addEventListener('click', () => openMatchAnalysis(tr.dataset.id, tr.dataset.sport));
    });
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Načtení zápasů selhalo: ${e.message}
      <button class="btn small" id="leaguesBackBtn" style="margin-top:8px;">← Zpět na soutěže</button></div>`;
    el('leaguesBackBtn')?.addEventListener('click', loadLeagues);
  }
}

async function runTeamSearch(q) {
  el('teamSearchClear').style.display = '';
  el('matchAnalysis').style.display = 'none';
  const box = el('searchResults');
  box.innerHTML = '<div class="card"><div class="loading"><span class="spinner"></span> Hledám zápasy… (první hledání dne stahuje data z ESPN)</div></div>';
  try {
    const d = await api(`/api/search?q=${encodeURIComponent(q)}&sport=${STATE.sport}`, { timeoutMs: 120000 });
    renderSearchResults(d, box);
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="empty-state">Hledání selhalo: ${e.message}</div></div>`;
  }
}

function renderSearchResults(d, box) {
  if (!d.matches || !d.matches.length) {
    box.innerHTML = `<div class="card"><div class="empty-state">Pro „${escAttr(d.query)}" jsem v příštích ${d.days || 14} dnech nenašel žádný zápas.</div></div>`;
    return;
  }
  // Klikatelné - zúží hledání na přesný název týmu (užitečné, když
  // obecnější dotaz jako "real" najde desítky různých "Real X" klubů
  // najednou a chceš zobrazit jen zápasy jednoho konkrétního).
  const teams = (d.teams || []).map(t =>
    `<button type="button" class="pill pill-team" data-team="${escAttr(t.name)}">${t.name} <span class="muted">(${t.matches})</span></button>`
  ).join('');
  const rows = d.matches.map(m => {
    // Kurzy ESPN dává až blízko výkopu – u vzdálenějších zápasů řekni rovnou,
    // že půjde jen o odhad modelu, ať to není překvapení až v rozboru
    const badge = m.has_odds
      ? '<span class="badge real">kurzy</span>'
      : `<span class="badge model" title="${m.odds_expected ? 'Kurzy se obvykle objeví krátce před výkopem' : 'Takhle daleko dopředu ESPN kurzy nedává – bude jen odhad modelu'}">jen model</span>`;
    return `<tr class="search-row-item" data-id="${escAttr(m.id)}" data-sport="${escAttr(m.sport)}">
      <td>${fmtWhen(m.date, m.time)}</td>
      <td><strong>${esc(m.home)}</strong> – ${esc(m.away)}</td>
      <td class="muted">${m.flag || ''} ${m.league}</td>
      <td>${badge}</td>
      <td>${tipsportBadge(m.home, m.tipsport, { short: true, stopPropagation: true })}</td>
      <td><button class="btn small">Rozbor →</button></td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="card">
      <h3>Nalezené týmy</h3>
      <div class="pill-row">${teams}</div>
    </div>
    <div class="card">
      <h3>Budoucí zápasy (${d.total}${d.total > d.matches.length ? `, zobrazeno ${d.matches.length}` : ''})</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Kdy</th><th>Zápas</th><th>Soutěž</th><th></th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  box.querySelectorAll('.search-row-item').forEach(tr => {
    tr.addEventListener('click', () => openMatchAnalysis(tr.dataset.id, tr.dataset.sport));
  });
  box.querySelectorAll('.pill-team').forEach(p => {
    p.addEventListener('click', () => {
      const team = p.dataset.team;
      el('teamSearch').value = team;
      clearTimeout(_searchTimer);
      runTeamSearch(team);
    });
  });
}

async function openMatchAnalysis(id, sport) {
  const box = el('matchAnalysis');
  box.style.display = '';
  box.innerHTML = '<div class="card"><div class="loading"><span class="spinner"></span> Počítám rozbor…</div></div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const d = await api(`/api/analysis/${encodeURIComponent(id)}?sport=${encodeURIComponent(sport || STATE.sport)}`, { timeoutMs: 120000 });
    renderAnalysis(d, box);
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="empty-state">Rozbor selhal: ${e.message}</div></div>`;
  }
}

function renderAnalysis(d, box) {
  const m = d.match;
  const pr = d.probs || {};
  const probRow = Object.keys(pr).length ? `
    <div class="grid-stats">
      ${['home', 'draw', 'away'].filter(k => pr[k] != null).map(k => `
        <div class="stat-tile">
          <div class="label">${k === 'home' ? '1 · ' + m.home : k === 'draw' ? 'X · remíza' : '2 · ' + m.away}</div>
          <div class="value">${pct(pr[k] * 100, 0)}</div>
        </div>`).join('')}
    </div>` : '';

  const rec = d.recommendation;
  // Bez reálných kurzů appka zásadně nedoporučuje sázku – jen ukáže odhad
  const recCard = !d.has_odds ? `
    <div class="card">
      <h3>💡 Doporučení</h3>
      <p class="muted">Pro tenhle zápas zatím nejsou reálné kurzy ESPN, takže nedoporučuju konkrétní sázku – appka si kurzy nevymýšlí. Níž je čistý odhad modelu. Kurzy se obvykle objeví krátce před výkopem.</p>
    </div>`
    : rec ? `
    <div class="card">
      <h3>💡 Doporučení</h3>
      <div class="pick-badge" style="display:inline-flex;">
        <span class="pl">${rec.label}</span><span class="pv">${(rec.odds || 0).toFixed(2)}×</span>
      </div>
      <p style="margin-top:10px;">
        <strong>${rec.name}</strong> — model ${Math.round((rec.prob || 0) * 100)} %,
        po kalibraci <strong>${Math.round((rec.cal_prob || 0) * 100)} %</strong>.
        ${rec.edge != null ? `Náskok proti kurzu ${czNum(rec.edge * 100, 1)} p.b.` : ''}
      </p>
      <p class="muted">Prošlo prahy agenta (jistota ≥ ${Math.round(d.thresholds.min_prob * 100)} %, kurz ≥ ${d.thresholds.min_odds}) — tohle by agent reálně vsadil.</p>
    </div>` : `
    <div class="card">
      <h3>💡 Doporučení</h3>
      <p class="muted">Žádný trh neprošel prahy agenta (jistota ≥ ${Math.round(d.thresholds.min_prob * 100)} % po kalibraci a kurz ≥ ${d.thresholds.min_odds}). Sázku nedoporučuju — níž jsou přesto všechny spočítané trhy.</p>
    </div>`;

  const cands = (d.candidates || []).map(c => `
    <tr class="${c.passes ? 'row-ok' : ''}">
      <td><strong>${c.label || c.outcome}</strong></td>
      <td>${c.odds ? c.odds.toFixed(2) + '×' : '<span class="muted">—</span>'}</td>
      <td>${pct((c.prob || 0) * 100, 0)}</td>
      <td>${c.cal_prob != null ? pct(c.cal_prob * 100, 0) : '—'}</td>
      <td>${c.edge != null ? czNum(c.edge * 100) + ' p.b.' : '—'}</td>
      <td>${c.passes ? '<span class="badge real">✓ tip</span>' : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const conf = d.rating_confidence;
  const coldWarn = (conf != null && conf < 0.3)
    ? `<p class="muted">⚠️ Rating těchhle týmů stojí na málo odehraných zápasech (jistota ${Math.round(conf * 100)} %), takže je predikce zploštělá k průměru a míň rozhodná. To je záměr — model radši přizná nejistotu, než aby si vymyslel jistotu.</p>` : '';

  box.innerHTML = `
    <div class="card">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div>
          <h2 style="margin:0 0 4px;">${esc(m.home)} – ${esc(m.away)}</h2>
          <p class="lead">${m.flag || ''} ${m.league} · ${fmtWhen(m.date, m.time)}</p>
        </div>
        ${tipsportBadge(m.home, m.tipsport)}
      </div>
      ${probRow}
      <p style="margin-top:10px;">
        Očekávané skóre <strong>${d.exp_goals ? `${czNum(d.exp_goals.home, 2)} : ${czNum(d.exp_goals.away, 2)}` : '—'}</strong>
        (celkem ${d.exp_total != null ? czNum(d.exp_total, 2) : '—'})
      </p>
      ${coldWarn}
    </div>
    ${renderFormAndH2H(d, m)}
    ${recCard}
    <div class="card">
      <h3>Všechny spočítané trhy</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Trh</th><th>Kurz</th><th>Model</th><th>Po kalibraci</th><th>Náskok</th><th></th></tr></thead>
        <tbody>${cands || '<tr><td colspan="6" class="muted">Žádné trhy s reálnými kurzy</td></tr>'}</tbody>
      </table></div>
    </div>
    ${renderExtraMarkets(d.extra_markets, d.top_scores, m)}`;
}

/** Rozšířené model-only odhady (přesný výsledek, marže, gólové trhy per
 *  tým, kdo dá první gól, poločasy). ESPN na ně kurzy nedává, takže se na
 *  ně NIKDY nesází – jen se zobrazí, ať je vidět, co model o zápase ví. */
/** Forma obou týmů (posledních 5 výsledků jako V/R/P ikony) + tabulka
 *  vzájemných zápasů. Odvozeno z historie výsledků, kterou appka stejně
 *  stahuje pro rating – prázdné, dokud appka daný tým poprvé nezaznamená. */
function renderFormAndH2H(d, m) {
  const fh = d.form_home || [], fa = d.form_away || [], h2h = d.h2h || [];
  if (!fh.length && !fa.length && !h2h.length) return '';

  const formIcons = (form) => form.length
    ? form.map(r => {
        const cls = r === 'W' ? 'pos' : r === 'L' ? 'bad' : '';
        const label = r === 'W' ? 'V' : r === 'L' ? 'P' : 'R';
        return `<span class="form-dot ${cls}">${label}</span>`;
      }).join('')
    : '<span class="muted">zatím žádná zaznamenaná historie</span>';

  const h2hRows = h2h.length ? h2h.map(g => {
    const cls = g.result === 'W' ? 'pos' : g.result === 'L' ? 'bad' : '';
    return `
      <div class="perf-row">
        <span class="perf-key muted">${(g.date || '').slice(0, 10)} · ${g.loc === 'home' ? m.home : m.away} doma</span>
        <span class="perf-nums"><strong class="${cls}">${g.gf}:${g.ga}</strong></span>
      </div>`;
  }).join('') : '<div class="empty-state" style="padding:10px 0;">Zatím žádný zaznamenaný vzájemný zápas</div>';

  return `
    <div class="card">
      <h3>Forma a vzájemné zápasy</h3>
      <div class="perf-grid">
        <div class="perf-block">
          <div class="perf-title">Forma – ${esc(m.home)}</div>
          <div class="form-row">${formIcons(fh)}</div>
        </div>
        <div class="perf-block">
          <div class="perf-title">Forma – ${esc(m.away)}</div>
          <div class="form-row">${formIcons(fa)}</div>
        </div>
        <div class="perf-block" style="grid-column: span 2;">
          <div class="perf-title">Posledních ${h2h.length || 0} vzájemných zápasů</div>
          <div class="perf-rows">${h2hRows}</div>
        </div>
      </div>
    </div>`;
}

function renderExtraMarkets(em, topScores, m) {
  if (!em) {
    // sport bez remízy (2way) nebo bez modelu – aspoň staré top_scores, když jsou
    if (!(topScores || []).length) return '';
    return `
      <div class="card">
        <h3>Nejpravděpodobnější výsledky <span class="badge model">jen model</span></h3>
        <div class="pill-row">${topScores.map(s => `<span class="pill">${s.score} <span class="muted">${pct(s.prob * 100)}</span></span>`).join('')}</div>
      </div>`;
  }
  const mg = em.margin || {};
  const fts = em.first_to_score || {};
  const ht = em.half_time || {};
  const tt = em.team_totals || {};

  const teamTotalRow = (label, lines) => (lines || []).map(l => `
    <div class="perf-row">
      <span class="perf-key">${label} přes ${String(l.line).replace('.', ',')}</span>
      <span class="perf-nums"><strong>${pct(l.over * 100)}</strong></span>
    </div>`).join('');

  return `
    <div class="card">
      <h3>Rozšířené odhady modelu <span class="badge model" title="ESPN na tyhle trhy kurzy nedává – nikdy se na ně nesází, jen ukazují, co model o zápase ví">jen model, nesázet</span></h3>

      <div style="margin-bottom:14px;">
        <div class="perf-title" style="margin-bottom:8px;">Nejpravděpodobnější výsledky</div>
        <div class="pill-row">${(em.correct_score || []).slice(0, 6).map(s => `<span class="pill">${s.score} <span class="muted">${pct(s.prob * 100)}</span></span>`).join('')}</div>
      </div>

      <div class="perf-grid">
        <div class="perf-block">
          <div class="perf-title">Gólový náskok vítěze</div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">Remíza</span><span class="perf-nums"><strong>${pct((mg.draw || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Rozdíl 1 gól</span><span class="perf-nums"><strong>${pct((mg.margin_1 || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Rozdíl 2 góly</span><span class="perf-nums"><strong>${pct((mg.margin_2 || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Rozdíl 3+ góly</span><span class="perf-nums"><strong>${pct((mg.margin_3plus || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Kdo dá první gól</div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">${esc(m.home)}</span><span class="perf-nums"><strong>${pct((fts.home || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">${esc(m.away)}</span><span class="perf-nums"><strong>${pct((fts.away || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Bez gólů</span><span class="perf-nums"><strong>${pct((fts.no_goals || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Góly týmu (přes linii)</div>
          <div class="perf-rows">
            ${teamTotalRow(m.home, tt.home)}
            ${teamTotalRow(m.away, tt.away)}
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Poločasy <span class="muted" title="${ht.assumption || ''}">ⓘ</span></div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">Víc gólů v 1. půli</span><span class="perf-nums"><strong>${pct((ht.more_goals_half?.first || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Víc gólů v 2. půli</span><span class="perf-nums"><strong>${pct((ht.more_goals_half?.second || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">1. půle přes 0,5</span><span class="perf-nums"><strong>${pct((ht.first_half?.[0]?.over || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">2. půle přes 0,5</span><span class="perf-nums"><strong>${pct((ht.second_half?.[0]?.over || 0) * 100)}</strong></span></div>
          </div>
        </div>
        <div class="perf-block">
          <div class="perf-title">Přesný počet gólů v zápase</div>
          <div class="perf-rows">
            ${(em.exact_total_goals || []).map(x => `
              <div class="perf-row"><span class="perf-key">${czGoly(x.goals)}</span><span class="perf-nums"><strong>${pct(x.prob * 100)}</strong></span></div>`).join('')}
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Sudý/lichý počet gólů</div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">Sudý</span><span class="perf-nums"><strong>${pct((em.odd_even?.even || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Lichý</span><span class="perf-nums"><strong>${pct((em.odd_even?.odd || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Přesný počet gólů týmu</div>
          <div class="perf-rows">
            ${(em.exact_team_goals?.home || []).slice(0, 3).map(x => `
              <div class="perf-row"><span class="perf-key">${esc(m.home)}: ${x.goals}</span><span class="perf-nums"><strong>${pct(x.prob * 100)}</strong></span></div>`).join('')}
            ${(em.exact_team_goals?.away || []).slice(0, 3).map(x => `
              <div class="perf-row"><span class="perf-key">${esc(m.away)}: ${x.goals}</span><span class="perf-nums"><strong>${pct(x.prob * 100)}</strong></span></div>`).join('')}
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">1. poločas – přesný počet gólů</div>
          <div class="perf-rows">
            ${(em.half_exact_goals?.first_half || []).map(x => `
              <div class="perf-row"><span class="perf-key">${czGoly(x.goals)}</span><span class="perf-nums"><strong>${pct(x.prob * 100)}</strong></span></div>`).join('')}
          </div>
        </div>
      </div>

      <div class="perf-grid" style="margin-top:12px;">
        <div class="perf-block">
          <div class="perf-title">Výsledek + počet gólů (přes 2,5)</div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">${esc(m.home)} a přes</span><span class="perf-nums"><strong>${pct((em.winner_and_total?.home_over25 || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Remíza a přes</span><span class="perf-nums"><strong>${pct((em.winner_and_total?.draw_over25 || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">${esc(m.away)} a přes</span><span class="perf-nums"><strong>${pct((em.winner_and_total?.away_over25 || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Výsledek + ${esc(m.home)} nad 1,5 gólu</div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">${esc(m.home)} vyhraje a nad 1,5</span><span class="perf-nums"><strong>${pct((em.winner_and_team_goals?.home_home_over || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Remíza a ${esc(m.home)} nad 1,5</span><span class="perf-nums"><strong>${pct((em.winner_and_team_goals?.draw_home_over || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Výsledek + kdo dal první gól <span class="muted" title="Aproximace – grid nezachycuje časové pořadí gólů, spočítáno jako P(výsledek) × P(první gól)">ⓘ</span></div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">${esc(m.home)} vyhraje a skóruje první</span><span class="perf-nums"><strong>${pct((em.winner_and_first_scorer?.home_home_first || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">${esc(m.away)} vyhraje a skóruje první</span><span class="perf-nums"><strong>${pct((em.winner_and_first_scorer?.away_away_first || 0) * 100)}</strong></span></div>
          </div>
        </div>
      </div>
      <p class="muted" style="font-size:11.5px; margin-top:4px;">${ht.assumption || ''}</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Auto-refresh živých zápasů
// ---------------------------------------------------------------------------
const LIVE_POLL_MS = 60 * 1000;
let _livePollTimer = null;
let _livePollInFlight = false;

function hasLiveMatches(data) {
  return (data?.leagues || []).some(lg => (lg.matches || []).some(m => m.live));
}

/** Tiché načtení dat bez rozbourání DOMu spinnerem – jen překreslí karty.
 *  Musí jít s refresh=1, protože serverová cache zápasů má TTL 12 h a bez
 *  vynuceného fetchnutí by se průběžné skóre nikdy nezměnilo. */
const IDLE_REFRESH_MS = 5 * 60 * 1000;   // bez živých zápasů stačí pomalejší tempo
let _lastIdleRefresh = 0;

async function refreshLiveMatches() {
  if (_livePollInFlight) return;                       // nepřekrývat requesty
  if (STATE.page !== 'matches') return;
  if (document.visibilityState !== 'visible') return;  // skrytá karta = neplýtvat ESPN
  if (STATE.date !== todayStr()) return;               // historii nemá smysl obnovovat

  // Živé zápasy potřebují průběžné skóre, takže se vynucuje čerstvý fetch.
  // Bez nich se jen občas dotáhne, co server mezitím sám obnovil na pozadí –
  // to je levné (jde z keše), tak se ESPN nevynucuje.
  const live = hasLiveMatches(STATE.lastMatchesData);
  if (!live) {
    if (Date.now() - _lastIdleRefresh < IDLE_REFRESH_MS) return;
    _lastIdleRefresh = Date.now();
  }

  _livePollInFlight = true;
  try {
    const url = `/api/matches?date=${STATE.date}&sport=${STATE.sport}&days=1${live ? '&refresh=1' : ''}`;
    const [data, betMap] = await Promise.all([
      api(url, { timeoutMs: 90000 }),
      loadMatchBetMap(),
    ]);
    // Mezitím mohl uživatel odejít na jinou stránku / přepnout den
    if (STATE.page !== 'matches' || STATE.date !== todayStr()) return;
    STATE.lastMatchesData = data;
    STATE.lastBetMap = betMap;
    renderMatchesSummary(data, el('matchesSummary'));
    renderMatchesLeagues(data.leagues || [], el('matchesContainer'), betMap);
    if (!hasLiveMatches(data)) stopLivePolling();       // dohráno → přestat pollovat
  } catch (e) {
    // Tiché selhání: auto-refresh je bonus, nesmí přepsat zobrazené zápasy chybou
  } finally {
    _livePollInFlight = false;
  }
}

function startLivePolling() {
  if (_livePollTimer) return;
  _livePollTimer = setInterval(refreshLiveMatches, LIVE_POLL_MS);
}

function stopLivePolling() {
  if (_livePollTimer) { clearInterval(_livePollTimer); _livePollTimer = null; }
}

/** Zapne/vypne poller podle toho, jestli je na stránce aspoň jeden živý zápas. */
function syncLivePolling(data) {
  // Poller běží na dnešku vždy – bez živých zápasů jen v klidnějším tempu
  // (viz IDLE_REFRESH_MS), aby se projevilo, co server obnovil na pozadí.
  if (STATE.page === 'matches' && STATE.date === todayStr()) startLivePolling();
  else stopLivePolling();
}

async function loadMatchBetMap() {
  // Proč byl zápas vsazen – spáruje zápasy s agentovými sázkami podle
  // match_id (jednotlivé tipy mají "why" zdůvodnění, nohy AKO tiketů ho
  // nemají, tak aspoň ukážeme, že jde o součást tiketu).
  const map = {};
  try {
    const data = await api('/api/agent', { timeoutMs: 15000 });
    for (const b of data.bets || []) {
      if (b.outcome === 'acca') {
        for (const leg of b.legs || []) {
          if (leg.match_id) map[leg.match_id] = { label: leg.name, why: null, ticket: b.match, status: b.status };
        }
      } else if (b.match_id) {
        map[b.match_id] = { label: b.label, why: b.why || null, ticket: null, status: b.status };
      }
    }
  } catch (e) { /* bez zdůvodnění, jen zápasy */ }
  return map;
}

// Když je pro model nový skoro každý tým (což na začátku platí), badge
// "⚠️ nový tým" u každé kartičky nic neříká a jen ruší – v takovém případě
// se místo něj ukáže jedna souhrnná informace nahoře.
let _coldstartIsNorm = false;

function renderMatchesSummary(data, box) {
  const all = (data?.leagues || []).flatMap(lg => lg.matches || []);
  const liveCount = all.filter(m => m.live).length;
  const cold = all.filter(m => m.rating_confidence != null && m.rating_confidence < 0.3).length;
  _coldstartIsNorm = all.length > 0 && cold / all.length > 0.6;
  const oddsCount = all.filter(m => m.odds_source === 'real').length;
  const f = STATE.statusFilter;
  box.innerHTML = `
    <div class="pill-row" style="margin-bottom:10px;">
      <span class="pill info">${data.total_matches} zápasů</span>
      <span class="pill info">${data.total_leagues} lig</span>
      <span class="pill clickable ${f === 'odds' ? 'active' : ''}" data-filter="odds"
            title="Kliknutím zobrazíš jen zápasy s reálným kurzem">💰 ${oddsCount} s kurzy</span>
      ${_coldstartIsNorm ? `<span class="pill info" title="Model má zatím málo odehraných zápasů, takže jsou predikce zploštělé k průměru">⚠️ ${Math.round(cold / all.length * 100)} % týmů model ještě nezná</span>` : ''}
      ${liveCount ? `<span class="pill clickable live-pill ${f === 'live' ? 'active' : ''}" data-filter="live"
            title="Kliknutím zobrazíš jen právě hrané zápasy – skóre se obnovuje samo">🔴 ${liveCount} živě · auto-obnova</span>` : ''}
      ${data.tip ? `<span class="pill clickable active" data-tip="${escAttr(data.tip.id)}"
            title="Kliknutím skočíš na zápas">💡 ${data.tip.home} – ${data.tip.away}</span>` : ''}
    </div>`;

  // Pilulky vypadají jako filtry, tak ať jimi taky jsou (info-pilulky jsou
  // vizuálně odlišené a neklikatelné).
  box.querySelectorAll('.pill.clickable[data-filter]').forEach(p => {
    p.addEventListener('click', () => {
      STATE.statusFilter = (STATE.statusFilter === p.dataset.filter) ? 'all' : p.dataset.filter;
      syncStatusStrip();
      renderMatchesSummary(data, box);
      renderMatchesLeagues(data.leagues || [], el('matchesContainer'), STATE.lastBetMap);
    });
  });
  box.querySelector('.pill.clickable[data-tip]')?.addEventListener('click', (ev) => {
    const card = el('matchesContainer')?.querySelector(`[data-match-id="${ev.currentTarget.dataset.tip}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
    }
  });
}

/** Drží horní přepínač (Vše / Jen s kurzy) v souladu s filtrem zvoleným jinde. */
function syncStatusStrip() {
  document.querySelectorAll('#statusStrip .pill[data-status]').forEach(x =>
    x.classList.toggle('active', x.dataset.status === STATE.statusFilter
      || (STATE.statusFilter === 'live' && x.dataset.status === 'all' && false)));
  if (!document.querySelector('#statusStrip .pill.active')) {
    document.querySelector('#statusStrip .pill[data-status="all"]')?.classList.add('active');
  }
}

function renderMatchesLeagues(leaguesIn, container, betMap = {}) {
  // "Jen s kurzy" = zápasy, kde ESPN dalo reálný kurz. Na ostatních appka
  // sázet stejně nebude (kurzy si nevymýšlí), takže je to jediný filtr, co
  // reálně mění, na co se dívat. Stav zápasu (nehráno/živě/konec) je vidět
  // přímo na kartičce, takže na to zvláštní filtr netřeba.
  const pass = {
    odds: m => m.odds_source === 'real',
    live: m => !!m.live,
    bet: m => !!betMap[m.id],
  }[STATE.statusFilter];
  // Textový filtr nad už načteným seznamem – stránka běžně ukazuje přes 300
  // zápasů a proklikat se k jednomu konkrétnímu jinak nešlo. Nejde o dotaz
  // na server (to umí stránka Hledat), jen o zúžení toho, co je na obrazovce.
  const dotaz = _fold((el('matchSearch')?.value || '').trim());
  const projde = m => (!pass || pass(m)) &&
    (!dotaz || _fold(m.home).includes(dotaz) || _fold(m.away).includes(dotaz)
     || _fold(m.league || '').includes(dotaz) || _fold(m.country || '').includes(dotaz));

  const vsechny = leaguesIn.flatMap(lg => lg.matches || []).length;
  const leagues = leaguesIn
    .map(lg => ({ ...lg, matches: (lg.matches || []).filter(projde) }))
    .filter(lg => lg.matches.length);
  const videt = leagues.reduce((a, lg) => a + lg.matches.length, 0);
  setText('matchSearchInfo', (dotaz || pass)
    ? `zobrazeno ${videt} z ${vsechny} zápasů`
    : '');

  container.className = '';   // odstraní 'loading' padding po naplnění daty
  if (!leagues.length) {
    container.innerHTML = `<div class="empty-state">
      ${dotaz ? `Nic neodpovídá hledání „${escAttr((el('matchSearch')?.value || '').trim())}".`
              : 'Žádné zápasy pro tento filtr'}</div>`;
    return;
  }
  container.innerHTML = leagues.map(lg => `
    <div class="league-group">
      <div class="league-head"><span class="flag">${lg.flag || ''}</span> ${esc(lg.league)} <span class="count">${lg.matches.length}</span></div>
      ${lg.matches.map(m => matchCardHtml(m, betMap[m.id])).join('')}
    </div>`).join('');

  // Rozbalení/sbalení zdůvodnění sázky ("Proč vsazeno")
  container.querySelectorAll('.why-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const box = btn.closest('.match-card').querySelector('.why-box');
      const open = box.style.display !== 'none';
      box.style.display = open ? 'none' : 'block';
      btn.textContent = open ? '💡 Proč vsazeno ▾' : '💡 Proč vsazeno ▴';
    });
  });
}

function fmtDateShort(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${d}.${m}.`;
}

// ---------------------------------------------------------------------------
// Čas zápasu
// ---------------------------------------------------------------------------
// Zdroje (ESPN i API-Football) dávají čas výkopu v UTC a appka ho dřív
// vypisovala tak, jak přišel – u nás to znamenalo každý zápas o 2 h vedle
// (zápas s výkopem v 10:00 se tvářil, že začíná v 08:00).
function matchDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T${(timeStr || '00:00')}:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

/** "30.07. 19:30" v místním čase (může přepadnout i přes půlnoc). */
function fmtWhen(dateStr, timeStr) {
  const d = matchDateTime(dateStr, timeStr);
  if (!d) return `${fmtDateShort(dateStr)} ${timeStr || ''}`.trim();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const LIVE_WINDOW_MIN = 150;   // ~2.5 h od výkopu, než se zápas počítá za dohraný

/** Stav ZÁPASU (ne sázky) odvozený z času výkopu – aby "OPEN" neznamenalo
 *  zároveň "je to za tři dny" i "dohrálo se a čeká na vyhodnocení". */
function matchStateHtml(dateStr, timeStr, betStatus, result, liveResult, isLive) {
  if (betStatus && betStatus !== 'open') {
    // u vyhodnocené sázky je zajímavější skóre než slovo "dohráno"
    return result && result.home != null
      ? `<strong>${result.home} : ${result.away}</strong>`
      : '<span class="muted">dohráno</span>';
  }
  // Otevřená sázka na zápas, který už začal – appka uloží finální skóre
  // až při vyhodnocení, ale průběžné skóre živého zápasu má appka
  // k dispozici hned (liveResult z /api/agent), takže ho místo pouhého
  // odznaku "hraje se" rovnou ukážeme.
  if (liveResult && liveResult.home != null) {
    const badge = isLive ? '<span class="badge live-pill">🔴</span> ' : '';
    return `${badge}<strong>${liveResult.home} : ${liveResult.away}</strong>`;
  }
  const d = matchDateTime(dateStr, timeStr);
  if (!d) return '<span class="muted">—</span>';
  const min = (Date.now() - d.getTime()) / 60000;
  if (min < 0) {
    const h = Math.round(-min / 60);
    if (-min < 60) return `<span class="muted">za ${Math.round(-min)} min</span>`;
    if (h < 24) return `<span class="muted">za ${h} h</span>`;
    const dni = Math.round(h / 24);
    return `<span class="muted">za ${dni} ${dni === 1 ? 'den' : dni < 5 ? 'dny' : 'dní'}</span>`;
  }
  if (min < LIVE_WINDOW_MIN) return '<span class="badge live-pill">🔴 hraje se</span>';
  return '<span class="badge model">čeká na výsledek</span>';
}

// Odkaz na vyhledávání konkrétního zápasu na Tipsportu (appka žádné
// zápasy tam nezadává ani nesází - jen otevře jejich vlastní vyhledávání
// s předvyplněným názvem domácího týmu, ať uživatel nemusí zápas sám
// hledat od nuly). Tipsport nemá stabilní/předvídatelné ID zápasu ve
// vlastním datovém zdroji appky, takže přesný deep-link na konkrétní
// zápas postavit nejde - hledání podle jednoho týmu ho ale spolehlivě
// vyhodí mezi prvními výsledky.
function tipsportSearchUrl(team) {
  return `https://www.tipsport.cz/hledani?textsFilter=${encodeURIComponent(team)}&fullTextResultsType=MATCHES`;
}

// Jednotný odznak/odkaz na Tipsport.cz - používá se na kartách zápasů,
// v detailu (rozboru), na Hledat, v přehledu soutěže i u řádků sázek.
// Bez naimportovaných dat (viz tipsport_import.py) je to prostý odkaz na
// jejich vyhledávání s předvyplněným názvem domácího týmu (appka sama
// nezadává žádné zápasy ani nesází - jen otevře jejich vyhledávání, ať
// uživatel nemusí zápas sám hledat od nuly). S daty je to přímý deep-link
// + zobrazené 1X2 kurzy pro srovnání s vlastním modelem.
// opts.short: jen 🔗/🎯 bez odds textu vedle (pro úzké sloupce v tabulkách).
function tipsportBadge(home, tipsport, opts = {}) {
  if (!home) return '';
  const odds = tipsport?.odds;
  const url = tipsport?.url ? `https://www.tipsport.cz${tipsport.url}` : tipsportSearchUrl(home);
  const title = odds
    ? `Tipsport: 1: ${odds.home ?? '—'} · X: ${odds.draw ?? '—'} · 2: ${odds.away ?? '—'}`
    : 'Najít tenhle zápas na Tipsportu (appka sama nesází, jen otevře jejich vyhledávání)';
  const label = odds
    ? `🔗 🎯${opts.short ? '' : ' ' + [odds.home, odds.draw, odds.away].filter(Boolean).join(' · ')}`
    : (opts.short ? '🔗' : '🔗 Tipsport');
  const stop = opts.stopPropagation ? ' onclick="event.stopPropagation()"' : '';
  return `<a class="tipsport-link" href="${url}" target="_blank" rel="noopener noreferrer" title="${escAttr(title)}"${stop}>${label}</a>`;
}

// Odkaz/odznak pro řádek sázky (tabulky sázek, tikety AKO/kombo apod.) -
// bere domácí tým z řetězce "Domácí – Hosté" a volitelná naimportovaná
// data z bt.tipsport (viz app.py _attach_tipsport). Ukazuje se jen dokud
// je sázka otevřená, na vyřešenou sázku už zápas hledat netřeba.
function tipsportBetLink(matchStr, status, tipsport) {
  if (status && status !== 'open') return '';
  if (!matchStr || !matchStr.includes(' – ')) return '';
  const home = matchStr.split(' – ')[0].trim();
  return tipsportBadge(home, tipsport, { short: true });
}

function matchCardHtml(m, bet) {
  // POZOR: m.result je naplněné i u právě hraných zápasů (ESPN vrací průběžné
  // skóre a goals_model ho propíše do result), takže "má skóre" != "dohráno" –
  // bez m.live guardu by se živé zápasy označovaly jako "Konec".
  const finished = m.result !== null && !m.live;
  // Datum + čas začátku ukázat VŽDY, i u odehraných/živých zápasů – dřív se
  // pro "Konec"/"ŽIVĚ" čas začátku vůbec nezobrazoval a u zápasů, které
  // ESPN vrátí pod jiným kalendářním dnem než vybraný filtr (kolem půlnoci
  // UTC), nebylo bez data poznat, kdy přesně začínají.
  const statusLabel = finished ? 'Konec' : m.live ? '🔴 ŽIVĚ' : 'Začátek';
  // U živých zápasů je ESPN shortDetail (m.status) aktuální minuta/půle
  // ("45'", "HT", "2nd Half") – užitečnější než jen "ŽIVĚ".
  const liveDetail = m.live && m.status ? `<span class="live-min">${m.status}</span>` : '';
  const startLabel = fmtWhen(m.date, m.time);
  const best = m.best_value || {};
  const hasPick = best.outcome && m.odds_source === 'real';

  // Víc typů trhů na kartičce, ne jen jeden "nejlepší" tip – gólové linie
  // (Over/Under) s reálnými kurzy, pokud je ESPN poskytlo.
  const marketChips = (m.goal_lines || [])
    .flatMap(gl => [
      { side: 'Over', ...gl.over, line: gl.line },
      { side: 'Under', ...gl.under, line: gl.line },
    ])
    .filter(x => x.real && x.odds)
    .slice(0, 4)
    .map(x => `<span class="badge real" title="${x.side} ${x.line}">${x.side[0]}${x.line} · ${x.odds.toFixed(2)}× · ${Math.round((x.prob || 0) * 100)}%</span>`)
    .join('');

  // Ručně importované kurzy z Tipsport.cz (viz tipsport_import.py) – reálná
  // sázková kurzovka pro srovnání s vlastním modelem, ne archivní benchmark.
  const tpOdds = m.tipsport?.odds;
  const tipsportChip = tpOdds ? `<span class="badge tipsport-odds" title="Kurzy Tipsport.cz">🎯 ${
    [tpOdds.home && `1: ${tpOdds.home}`, tpOdds.draw && `X: ${tpOdds.draw}`, tpOdds.away && `2: ${tpOdds.away}`]
      .filter(Boolean).join(' · ')
  }</span>` : '';

  const why = bet ? `
    <div class="why-box" style="display:none;">
      ${bet.ticket ? `Součást tiketu <strong>${bet.ticket}</strong> – tip <strong>${bet.label}</strong>.`
        : bet.why && bet.why.length ? `<strong>${bet.label}</strong><ul>${bet.why.map(w => `<li>${w}</li>`).join('')}</ul>`
        : `Vsazeno na <strong>${bet.label}</strong>.`}
    </div>` : '';

  const hasExtra = marketChips || bet || tipsportChip;

  return `
    <div class="match-card" data-match-id="${escAttr(m.id)}">
      <div class="mc-row">
        <div class="time ${m.live ? 'live' : ''}">
          <span class="status">${statusLabel}</span>
          ${liveDetail}
          <span>${startLabel}</span>
        </div>
        <div class="teams">
          <div class="team-row"><span>${esc(m.home)}</span>${m.result ? `<span class="score ${m.live ? 'live' : ''}">${m.result.home}</span>` : ''}</div>
          <div class="team-row"><span>${esc(m.away)}</span>${m.result ? `<span class="score ${m.live ? 'live' : ''}">${m.result.away}</span>` : ''}</div>
        </div>
        <div class="pick-col">
          ${finished ? '' : hasPick ? `
            <div class="pick-badge">
              <span class="pl">${best.label || '?'}</span>
              <span class="pv">${(best.odds || 0).toFixed(2)}</span>
            </div>
            <span class="badge ${best.is_value ? 'real' : 'model'}">${Math.round((best.prob || 0) * 100)}%</span>
          ` : `<span class="badge model">model ${m.confidence || Math.round((m.probs?.[m.pick] || 0) * 100)}%</span>`}
          ${(!finished && !_coldstartIsNorm && m.rating_confidence != null && m.rating_confidence < 0.3) ? `<span class="badge coldstart" title="Rating týmu/týmů stojí na málo odehraných zápasech - predikce je míň spolehlivá">⚠️ nový tým</span>` : ''}
          ${bet ? `<span class="badge ${bet.status}">💰 ${(bet.status || 'open').toUpperCase()}</span>` : ''}
          ${!finished ? tipsportBadge(m.home, m.tipsport) : ''}
        </div>
      </div>
      ${hasExtra ? `
      <div class="mc-extra">
        ${(marketChips || tipsportChip) ? `<div class="mc-markets">${marketChips}${tipsportChip}</div>` : ''}
        ${bet ? `
        <div class="mc-why-row">
          <button class="btn small why-toggle">💡 Proč vsazeno ▾</button>
        </div>
        ${why}` : ''}
      </div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// BANKROLL
// ---------------------------------------------------------------------------
async function loadBankroll() {
  try {
    const data = await api('/api/bankroll');
    const s = data.stats;
    setText('bStart', `${fmt(s.start_balance)} ${s.currency || 'Kč'}`);
    setText('bCurrent', `${fmt(s.balance)} ${s.currency || 'Kč'}`);
    // stejné rozlišení jako na dashboardu: zůstatek není ztráta, dokud jsou
    // peníze jen zamrzlé v otevřených sázkách
    setText('bOpenStake', s.open_stake
      ? `${fmt(s.open_stake)} ${s.currency || 'Kč'} v otevřených sázkách` : 'žádné otevřené sázky');
    setText('bProfit', `${fmt(s.profit)} ${s.currency || 'Kč'}`);
    el('bProfit').className = 'value ' + (s.profit >= 0 ? 'pos' : 'bad');
    setText('bProfitHint', `z ${s.settled_count || 0} vyhodnocených`);
    setText('bRoi', s.roi !== null && s.roi !== undefined ? pct(s.roi) : '—');
    setText('bWinRate', s.win_rate !== null ? pct(s.win_rate) : '—');

    // CLV se počítá v bankroll.stats() a posílá při každém požadavku, ale
    // zobrazovalo se jen u virtuálních sázkařů. U agenta je přitom
    // vypovídavější než zisk: na stovce sázek je zisk šum, CLV ne.
    const clvEl = el('bClv');
    if (clvEl) {
      if (s.avg_clv === null || s.avg_clv === undefined) {
        clvEl.textContent = '—';
        clvEl.className = 'value';
        setText('bClvHint', 'zatím bez uzavíracích kurzů');
      } else {
        const nad = s.avg_clv >= 1;
        clvEl.textContent = `${czNum(s.avg_clv, 2)}×`;
        clvEl.className = `value ${nad ? 'pos' : 'bad'}`;
        setText('bClvHint', nad
          ? 'bereme lepší cenu než trh'
          : 'sázíme za horší cenu, než má trh před výkopem');
      }
    }

    if (s.equity && s.equity.length > 1) {
      drawEquity(s.equity);
    } else {
      // Bez prázdného stavu zůstal rámeček 800×260 bez jediného slova
      // a vypadalo to jako rozbitý graf.
      const svg = el('equitySVG');
      if (svg) svg.innerHTML = `<text x="400" y="130" text-anchor="middle"
        fill="var(--txt3)" font-size="14">Zatím není z čeho kreslit – potřeba aspoň dvě vyhodnocené sázky</text>`;
    }
    renderBetsTable(data.bets || [], data.total);
    // Rozšířené analýzy – backend je uměl odjakživa (/api/bankroll/daily,
    // /summary, /streaks, /roi-by-odds), ale nic je nevolalo, takže stránka
    // ukazovala jen zůstatek a seznam sázek.
    loadBankrollAnalytics();
  } catch (e) {
    toast('Nepodařilo se načíst bankroll.', 'err');
  }
}

async function loadBankrollAnalytics() {
  loadDailyPnl();
  loadBankRecords();
  loadRoiByOdds();
}

/** Sloupcový graf denního zisku/ztráty. Equity křivka ukazuje součet,
 *  tohle jednotlivé dny – pozná se, jestli ztráta narůstala postupně,
 *  nebo za ni může jeden konkrétní den. */
async function loadDailyPnl() {
  const svg = el('dailyPnlSVG');
  if (!svg) return;
  try {
    const d = await api('/api/bankroll/daily', { timeoutMs: 15000 });
    const dny = Object.entries(d.daily || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (!dny.length) {
      svg.innerHTML = `<text x="400" y="110" text-anchor="middle" font-size="13" fill="var(--txt3)">Zatím žádné vyhodnocené sázky</text>`;
      return;
    }
    const W = 800, H = 220, padX = 44, padY = 24;
    const pw = W - 2 * padX, ph = H - 2 * padY;
    const maxAbs = Math.max(...dny.map(([, v]) => Math.abs(v.pnl || 0)), 1);
    const nula = padY + ph / 2;                       // nulová osa uprostřed
    const barW = Math.max(2, Math.min(28, pw / dny.length * 0.7));
    const krok = pw / dny.length;

    const sloupce = dny.map(([den, v], i) => {
      const pnl = v.pnl || 0;
      const x = padX + i * krok + (krok - barW) / 2;
      const vyska = Math.abs(pnl) / maxAbs * (ph / 2);
      const y = pnl >= 0 ? nula - vyska : nula;
      const barva = pnl >= 0 ? 'var(--pos)' : 'var(--bad)';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
                    height="${Math.max(1, vyska).toFixed(1)}" fill="${barva}" rx="2" opacity="0.9">
                <title>${den}: ${pnl >= 0 ? '+' : ''}${fmt(pnl)} Kč · ${v.bets} sázek · ${pct(v.win_rate)}</title>
              </rect>`;
    }).join('');

    // popisky jen u prvního a posledního dne, jinak by se slily
    const popisek = (i) => {
      const x = padX + i * krok + krok / 2;
      return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--txt3)">${fmtDateShort(dny[i][0])}</text>`;
    };
    svg.innerHTML = `
      <line x1="${padX}" y1="${nula}" x2="${W - padX}" y2="${nula}" stroke="var(--border)"/>
      <text x="${padX - 6}" y="${padY + 4}" text-anchor="end" font-size="10" fill="var(--txt3)">+${fmt(maxAbs)}</text>
      <text x="${padX - 6}" y="${H - padY}" text-anchor="end" font-size="10" fill="var(--txt3)">-${fmt(maxAbs)}</text>
      ${sloupce}
      ${popisek(0)}${dny.length > 1 ? popisek(dny.length - 1) : ''}`;

    const plus = dny.filter(([, v]) => (v.pnl || 0) > 0).length;
    const minus = dny.filter(([, v]) => (v.pnl || 0) < 0).length;
    setText('dailyPnlHint', `${dny.length} dní se sázkami · ${plus} ziskových, ${minus} ztrátových · najeď myší na sloupec pro detail`);
  } catch (e) {
    svg.innerHTML = `<text x="400" y="110" text-anchor="middle" font-size="13" fill="var(--txt3)">Denní přehled se nepodařilo načíst</text>`;
  }
}

/** Rekordy banku + série výher/proher (souhrn /summary a /streaks). */
async function loadBankRecords() {
  const box = el('bankRecords');
  if (!box) return;
  try {
    const d = await api('/api/bankroll/summary', { timeoutMs: 15000 });
    const s = d.summary || {};
    const st = s.streak_info || {};
    const akt = st.current_streak || {};
    const radek = (popisek, hodnota, trida = '', hint = '') => `
      <div class="rec-row">
        <span class="rec-label">${popisek}</span>
        <span class="rec-val ${trida}">${hodnota}${hint ? ` <span class="muted" style="font-weight:400;">${hint}</span>` : ''}</span>
      </div>`;
    box.className = '';
    box.innerHTML = `
      <div class="rec-list">
        ${radek('Nejvyšší stav banku', `${fmt(s.peak_balance)} Kč`, 'pos')}
        ${radek('Nejnižší stav banku', `${fmt(s.trough_balance)} Kč`, 'bad')}
        ${radek('Nejlepší den', `${s.best_day_pnl >= 0 ? '+' : ''}${fmt(s.best_day_pnl)} Kč`, 'pos')}
        ${radek('Nejhorší den', `${fmt(s.worst_day_pnl)} Kč`, 'bad')}
        ${radek('Ziskové dny', `${s.winning_days || 0}`, 'pos', `+${fmt(s.winning_pnl)} Kč`)}
        ${radek('Ztrátové dny', `${s.losing_days || 0}`, 'bad', `${fmt(s.losing_pnl)} Kč`)}
        ${radek('Právě běží', akt.length
            ? `${akt.length}× ${akt.type === 'win' ? 'výhra' : 'prohra'} v řadě`
            : '—', akt.type === 'win' ? 'pos' : akt.type ? 'bad' : '',
            akt.pnl != null ? `(${akt.pnl >= 0 ? '+' : ''}${fmt(akt.pnl)} Kč)` : '')}
        ${radek('Nejdelší šňůra výher', `${st.longest_win_streak || 0}×`, 'pos')}
        ${radek('Nejdelší šňůra proher', `${st.longest_loss_streak || 0}×`, 'bad')}
        ${radek('Celkem vsazeno', `${fmt(s.total_staked)} Kč`, '', `z ${s.total_bets || 0} sázek`)}
      </div>`;
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="empty-state">Rekordy se nepodařilo načíst.</div>';
  }
}

/** ROI podle pásma kurzu – ukáže, jestli ztráta pochází z konkrétního
 *  typu sázek (typicky vysoké kurzy) místo aby byla rozprostřená. */
async function loadRoiByOdds() {
  const box = el('roiByOdds');
  if (!box) return;
  try {
    const d = await api('/api/bankroll/roi-by-odds', { timeoutMs: 15000 });
    const pasma = Object.entries(d.roi_by_odds || {}).filter(([, v]) => (v.bets || 0) > 0);
    if (!pasma.length) {
      box.className = '';
      box.innerHTML = '<div class="empty-state">Zatím žádné vyhodnocené sázky.</div>';
      return;
    }
    const max = Math.max(...pasma.map(([, v]) => Math.abs(v.roi || 0)), 1);
    box.className = '';
    box.innerHTML = `
      <div class="perf-rows">
        ${pasma.map(([pasmo, v]) => `
          <div class="perf-row">
            <span class="perf-key" style="min-width:74px;">${pasmo.replace('-', ' – ')}</span>
            <span class="time-bar" title="ROI ${pct(v.roi)}">
              <i class="${(v.roi || 0) >= 0 ? 'pos' : 'bad'}" style="width:${(Math.abs(v.roi || 0) / max * 100).toFixed(0)}%"></i>
            </span>
            <span class="perf-nums">
              <span class="muted">${v.bets}× · ${pct(v.win_rate)}</span>
              <strong class="${(v.pnl || 0) >= 0 ? 'pos' : 'bad'}">${(v.pnl || 0) >= 0 ? '+' : ''}${fmt(v.pnl)} Kč</strong>
              <span class="${(v.roi || 0) >= 0 ? 'pos' : 'bad'}">${pct(v.roi)}</span>
            </span>
          </div>`).join('')}
      </div>
      <p class="muted" style="font-size:11.5px; margin:10px 0 0;">
        Pásma s pár sázkami nic neříkají – rozdíl je vidět až u desítek.
      </p>`;
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="empty-state">Rozbor se nepodařilo načíst.</div>';
  }
}

function drawEquity(equity) {
  const svg = el('equitySVG');
  const width = 800, height = 260, padding = 36;
  const pw = width - 2 * padding, ph = height - 2 * padding;
  const minV = Math.min(...equity), maxV = Math.max(...equity);
  const range = (maxV - minV) || 1;
  let path = '';
  equity.forEach((v, i) => {
    const x = padding + (i / (equity.length - 1)) * pw;
    const y = height - padding - ((v - minV) / range) * ph;
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  });
  const color = equity[equity.length - 1] >= equity[0] ? 'var(--pos)' : 'var(--bad)';
  svg.innerHTML = `
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)"/>
    <text x="${padding - 6}" y="${padding + 4}" text-anchor="end" font-size="11" fill="var(--txt2)">${maxV.toFixed(0)}</text>
    <text x="${padding - 6}" y="${height - padding + 4}" text-anchor="end" font-size="11" fill="var(--txt2)">${minV.toFixed(0)}</text>
    <path d="${path}" stroke="${color}" stroke-width="2.5" fill="none"/>`;
}

function renderBetsTable(bets, celkem) {
  const tbody = el('betsTable');
  if (!bets.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Zatím žádné sázky</td></tr>`; return; }
  // Když se historie ořízne, musí to být napsané – dřív uživatel se 108
  // sázkami viděl 50 a nikde se to nedozvěděl.
  const info = el('betsTableInfo');
  if (info) {
    info.textContent = (celkem && celkem > bets.length)
      ? `Zobrazeno ${bets.length} z ${celkem} sázek (nejnovější první).`
      : `${bets.length} ${bets.length === 1 ? 'sázka' : (bets.length < 5 ? 'sázky' : 'sázek')} celkem.`;
  }
  tbody.innerHTML = bets.map(b => `
    <tr>
      <td>${b.match || '—'} ${tipsportBetLink(b.match, b.status, b.tipsport)}</td>
      <td class="muted">${fmtWhen(b.match_date, b.match_time)}</td>
      <td>${matchStateHtml(b.match_date, b.match_time, b.status, b.result)}</td>
      <td>${b.label || '?'}</td>
      <td>${fmt(b.stake || 0)} Kč</td>
      <td>${b.odds || 0}×</td>
      <td><span class="badge ${b.status}">${(b.status || 'open').toUpperCase()}</span></td>
      <td class="${b.status === 'open' ? 'muted' : (b.pnl || 0) > 0 ? 'pos' : 'bad'}">
        ${b.status === 'open' ? '—' : `${(b.pnl || 0) > 0 ? '+' : ''}${fmt(b.pnl || 0)} Kč`}
      </td>
    </tr>`).join('');
}

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
async function loadServerInfo() {
  const box = el('serverInfo');
  if (!box) return;
  try {
    const d = await api('/api/server/info');
    const rows = (d.addresses || []).map(a => `
      <div class="srv-row">
        <code class="srv-url">${a.url}</code>
        <button class="btn small srv-copy" data-url="${escAttr(a.url)}">Kopírovat</button>
        ${a.recommended ? '<span class="badge real">doporučeno</span>'
                        : '<span class="muted" style="font-size:11.5px;">jiné síťové rozhraní</span>'}
      </div>`).join('');
    box.className = '';
    // Na připojení zvenčí musí sedět tři věci naráz (naslouchání na 0.0.0.0,
    // firewall, soukromý profil sítě). Když jedna chybí, spojení mlčky
    // nefunguje – proto se tu vypíše konkrétně, co brání a jak to spravit.
    const dg = d.diagnostics || { ok: true, problems: [] };
    const probs = dg.problems || [];
    const diagHtml = probs.length ? `
      <div class="srv-diag">
        <div style="font-weight:600; margin-bottom:6px;">⚠️ Zvenčí se teď nepřipojíš – brání tomu:</div>
        <ul style="margin:0 0 10px; padding-left:18px; line-height:1.7;">
          ${probs.map(p => `<li>${p.text}<br><span class="muted">Řešení: ${p.fix}</span></li>`).join('')}
        </ul>
        ${dg.can_autofix ? `
          <button class="btn small" id="fixNetBtn">Zkusit opravit automaticky</button>
          ${dg.is_admin ? '' : '<span class="muted" style="font-size:11.5px; margin-left:8px;">vyžaduje spuštění jako správce</span>'}
          <div id="fixNetResult" style="margin-top:8px;"></div>` : ''}
      </div>`
      : '<div class="srv-diag ok">✅ Síť je připravená – server je dostupný z ostatních zařízení.</div>';
    box.className = '';
    box.innerHTML = diagHtml + `
      <div class="srv-row">
        <code class="srv-url">${d.local_url}</code>
        <button class="btn small srv-copy" data-url="${escAttr(d.local_url)}">Kopírovat</button>
        <span class="muted" style="font-size:11.5px;">jen z tohoto počítače</span>
      </div>
      ${rows || '<div class="muted">Žádná síťová adresa nenalezena.</div>'}
      <div class="muted" style="font-size:11.5px; margin-top:10px; line-height:1.7;">
        Počítač: <strong>${d.hostname}</strong> · port <strong>${d.port}</strong> ·
        přihlášení stejné jako sem.<br>
        Adresy mimo 192.168.x.x často patří virtuálním adaptérům (WSL, Hyper-V) –
        na ty se zvenčí nepřipojíš. Aby se adresa po restartu neměnila, nastav
        serveru v routeru rezervaci IP.
      </div>`;
    el('fixNetBtn')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget, out = el('fixNetResult');
      btn.disabled = true; btn.textContent = 'Opravuji…';
      try {
        const r = await api('/api/server/fix-network', { method: 'POST', timeoutMs: 60000 });
        if (r.ok) {
          out.innerHTML = '<span class="pos">' + (r.done || []).join(' ') + '</span>';
          toast('Síť opravena.');
          setTimeout(loadServerInfo, 1200);
        } else {
          out.innerHTML = '<span class="bad">' + (r.error || (r.errors || []).join(' ')) + '</span>';
        }
      } catch (e) {
        out.innerHTML = '<span class="bad">Oprava selhala: ' + e.message + '</span>';
      } finally {
        btn.disabled = false; btn.textContent = 'Zkusit opravit automaticky';
      }
    });
    box.querySelectorAll('.srv-copy').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.url);
          const t = b.textContent; b.textContent = 'Zkopírováno';
          setTimeout(() => { b.textContent = t; }, 1500);
        } catch (e) { toast('Kopírování se nepovedlo – vyber adresu ručně.', 'err'); }
      });
    });
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="muted">Informace o serveru se nepodařilo načíst.</div>';
  }
}

async function loadRatingsStatus() {
  const box = el('ratingsStatus');
  if (!box) return;
  try {
    const r = await api('/api/ratings/status');
    const weak = r.median_games < 5;
    box.innerHTML = `
      <span class="badge ${weak ? 'model' : 'real'}">${weak ? 'málo dat' : 'v pořádku'}</span>
      Týmů s historií <strong>${r.teams_with_history}</strong> z ${r.teams} ·
      medián <strong>${r.median_games}</strong> zápasů, průměr ${r.avg_games} ·
      dobře známých (10+) <strong>${r.well_known}</strong>
      ${weak ? '<div class="muted" style="margin-top:4px;">Pod ~5 zápasy na tým jsou predikce zploštělé k průměru a model nenajde value.</div>' : ''}`;
  } catch (e) {
    box.innerHTML = '<span class="muted">Stav ratingů se nepodařilo načíst.</span>';
  }
}

async function runBackfill() {
  const btn = el('backfillBtn');
  const days = parseInt(el('backfillDays').value) || 60;
  btn.disabled = true; btn.textContent = 'Stahuji historii… (i pár minut)';
  try {
    const d = await api('/api/ratings/backfill', {
      method: 'POST', body: JSON.stringify({ days }), timeoutMs: 900000,
    });
    toast(`Zpracováno ${d.found} zápasů, započítáno ${d.applied}. Medián teď ${d.median_games} zápasů na tým.`);
    loadRatingsStatus();
  } catch (e) {
    toast('Natažení historie selhalo: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Natáhnout historii';
  }
}

async function runBackfillArchive() {
  const btn = el('backfillArchiveBtn');
  btn.disabled = true; btn.textContent = 'Stahuji archiv…';
  try {
    const d = await api('/api/ratings/backfill-archive', {
      method: 'POST', body: JSON.stringify({ seasons: 3 }), timeoutMs: 900000,
    });
    toast(`Archiv: ${d.found} zápasů, započítáno ${d.applied}. Medián teď ${d.median_games} zápasů na tým.`);
    loadRatingsStatus();
  } catch (e) {
    toast('Natažení archivu selhalo: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Natáhnout archiv (roky)';
  }
}

async function runBenchmark() {
  const btn = el('benchmarkBtn');
  const box = el('benchmarkResult');
  btn.disabled = true; btn.textContent = 'Počítám…';
  box.textContent = 'Porovnávám model se zavíracím kurzem na historických zápasech…';
  try {
    const d = await api('/api/model/benchmark?limit=1500', { timeoutMs: 600000 });
    if (!d.matches) { box.textContent = 'Zatím není dost historie – nejdřív natáhni archiv.'; return; }
    const better = d.model_beats_market;
    box.innerHTML = `
      <span class="badge ${better ? 'real' : 'model'}">${better ? 'model je lepší' : 'trh je lepší'}</span>
      Na <strong>${d.matches}</strong> zápasech: model <strong>${d.brier_model}</strong>
      vs zavírací kurz <strong>${d.brier_market}</strong>
      (rozdíl ${d.diff > 0 ? '+' : ''}${d.diff})
      <div class="muted" style="margin-top:4px;">${d.note}</div>`;
  } catch (e) {
    box.textContent = 'Porovnání selhalo: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Porovnat s trhem';
  }
}

async function loadApifStatus() {
  const box = el('apifStatus');
  if (!box) return;
  try {
    const s = await api('/api/apifootball/status');
    box.innerHTML = s.enabled
      ? `<span class="badge real">aktivní</span> Dnes využito <strong>${s.used_today}/${s.budget}</strong> dotazů (limit se obnoví o půlnoci UTC).`
      : '<span class="badge model">nezapojeno</span> Bez klíče jede appka jen na ESPN.';
  } catch (e) {
    box.innerHTML = '<span class="muted">Stav se nepodařilo načíst.</span>';
  }
}

async function saveApifKey() {
  const inp = el('apifKey');
  const btn = el('apifSaveBtn');
  btn.disabled = true; btn.textContent = 'Ukládám…';
  try {
    await api('/api/apifootball/key', { method: 'POST', body: JSON.stringify({ key: inp.value.trim() }) });
    inp.value = '';
    await loadApifStatus();
    // keše zápasů se na serveru pročistily, ať se doplněné ligy projeví hned
    if (STATE.page === 'matches') loadMatches();
  } catch (e) {
    alert('Uložení selhalo: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Uložit';
  }
}

async function loadSettings() {
  renderNotifStatus();
  loadApifStatus();
  loadRatingsStatus();
  loadServerInfo();
  try {
    const data = await api('/api/agent');
    const c = data.settings;
    el('cfgEnabled').checked = !!c.enabled;
    el('cfgAutoRun').checked = !!c.auto_run;
    // rozvrh brát z nastavení, ne natvrdo z šablony – dřív tu svítilo
    // "(8:00, 16:00)", i když se dávno jezdí 8/12/16/20
    const hrs = String(c.auto_run_hours || '8,12,16,20').split(',').map(h => h.trim()).filter(Boolean);
    setText('cfgAutoRunHours', hrs.length ? `(${hrs.map(h => h + ':00').join(', ')})` : '');
    el('cfgMinProb').value = Math.round((c.min_prob || 0.75) * 100);
    el('cfgMinOdds').value = c.min_odds || 1.2;
    el('cfgStakeMode').value = c.stake_mode || 'kelly';
    el('cfgDailyCap').value = Math.round((c.max_daily_stake_pct || 0.25) * 100);

    const bdata = await api('/api/bankroll');
    el('cfgStartBalance').value = bdata.stats.start_balance;
    el('cfgKellyFraction').value = bdata.stats.kelly_fraction || 0.25;

    const allSettings = await api('/api/settings');
    const perf = allSettings.performance || {};
    el('cfgFetchWorkers').value = perf.fetch_workers || 0;
    el('cfgSearchDays').value = perf.search_days || 14;

    const diag = await api('/api/settle/status');
    let calibHtml = '';
    try {
      const cal = await api('/api/calibration');
      if (cal.active) {
        const ex = cal.example || {};
        calibHtml = `<br><strong style="color:var(--txt2);">Kalibrace: AKTIVNÍ</strong> (${cal.n_samples} vzorků z tipů + arény sázkařů)<br>
          Model 60/75/85 % → reálně ${Math.round((ex['0.60'] ?? 0.6) * 100)}/${Math.round((ex['0.75'] ?? 0.75) * 100)}/${Math.round((ex['0.85'] ?? 0.85) * 100)} %
          (tutovky se vybírají podle TÉTO opravené hodnoty, ne podle syrového odhadu modelu)`;
      } else {
        calibHtml = `<br><strong style="color:var(--txt2);">Kalibrace: čeká na data</strong> (${cal.n_samples ?? 0} / 80 vzorků – míň se nepoužije, model by se přeučil na šum)`;
      }
    } catch (e) { /* kalibrace je bonus info, appku to nesmí shodit */ }
    el('diagInfo').innerHTML = `
      Tipů čeká na vyhodnocení: ${diag.open_tips ?? '—'}<br>
      Sázek čeká na vyhodnocení: ${diag.open_bets ?? '—'}<br>
      ${diag.rss_mb != null ? `Paměť procesu: ${diag.rss_mb} MB<br>` : ''}${calibHtml}`;
    loadAdvancedDiagnostics();
  } catch (e) {
    toast('Nepodařilo se načíst nastavení.', 'err');
  }
}

async function savePerformanceSettings() {
  const body = {
    fetch_workers: Number(el('cfgFetchWorkers').value) || 0,
    search_days: Number(el('cfgSearchDays').value) || 14,
  };
  try {
    await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'performance', values: body }) });
    toast('Nastavení výkonu uloženo.');
  } catch (e) {
    toast('Uložení selhalo.', 'err');
  }
}

async function clearMatchCache() {
  try {
    const r = await api('/api/data/clear-cache', { method: 'POST' });
    toast(`Keš smazána (${r.cleared} souborů).`);
  } catch (e) {
    toast('Smazání keše selhalo.', 'err');
  }
}

async function resetTipsDb() {
  if (!confirm('Smazat celou databázi tipů modelu? Ratingy týmů a sázky zůstanou zachované.')) return;
  try {
    await api('/api/data/reset-tips', { method: 'POST' });
    toast('Databáze tipů smazána.');
  } catch (e) {
    toast('Smazání selhalo.', 'err');
  }
}

async function exportBackup() {
  try {
    const data = await api('/api/data/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `kurzanalytik-zaloha-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Záloha stažena.');
  } catch (e) {
    toast('Export selhal.', 'err');
  }
}

async function importBackup(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  if (!confirm(`Importovat zálohu ze souboru "${file.name}"? Přepíše aktuální nastavení, bankroll, tipy a ratingy.`)) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await api('/api/data/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    toast('Záloha importována – appka se obnoví.');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    toast('Import selhal – zkontroluj, že je to platný soubor zálohy.', 'err');
  }
}

function fmtBytes(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

async function loadAdvancedDiagnostics() {
  const box = el('diagAdvanced');
  if (!box) return;
  box.innerHTML = '<span class="muted">Načítám…</span>';
  try {
    const d = await api('/api/diagnostics/advanced');
    // Stav zálohy do GitHub Gistu. Lokálně bývá vypnutá (token/gist id jsou
    // env proměnné jen na Renderu) – a je dobré to vědět: bez ní je jediná
    // záchrana dat commit v gitu, což dnešek ukázal až moc názorně.
    let zaloha = '';
    try {
      const p = await api('/api/persist/status', { timeoutMs: 8000 });
      const kdy = p.last_push ? new Date(p.last_push * 1000).toLocaleString('cs-CZ') : null;
      zaloha = p.enabled
        ? `<strong style="color:var(--txt2);">Záloha do Gistu:</strong> <span class="pos">zapnutá</span>
           ${kdy ? `· naposledy ${kdy}` : '· zatím neproběhla'} (${(p.files || []).length} souborů)<br>`
        : `<strong style="color:var(--txt2);">Záloha do Gistu:</strong> <span class="bad">vypnutá</span>
           <span class="muted">– chybí GITHUB_TOKEN / GIST_ID, takže data téhle instance nikam mimo tenhle
           počítač nechodí. Zálohou je jen commit v gitu.</span><br>`;
    } catch (e) { /* nepovinné – diagnostika kvůli tomu nespadne */ }
    const cache = d.cache || {};
    const th = d.threads || {};
    const bench = d.benchmark?.last;
    const tp = d.tipsport_import || {};
    const filesHtml = Object.entries(d.data_files_kb || {})
      .filter(([, kb]) => kb != null)
      .map(([name, kb]) => `<span class="muted">${name}: ${kb} KB</span>`)
      .join(' · ');
    box.innerHTML = `
      ${zaloha}
      <strong style="color:var(--txt2);">Keš zápasů:</strong>
      ${cache.memory_entries ?? '—'}/${cache.memory_max_entries ?? '—'} v paměti,
      databáze ${cache.match_store?.days ?? '—'} dní / ${cache.match_store?.matches ?? '—'} zápasů
      (${fmtBytes(cache.match_store?.db_bytes)})<br>
      <strong style="color:var(--txt2);">Background smyčky:</strong>
      ${th.canary_stale ? '<span class="bad">⚠️ NEODPOVÍDAJÍ</span>' : '<span class="pos">✓ běží</span>'}
      (tick #${th.canary_ticks ?? '—'}, naposledy před ${th.canary_age_s != null ? Math.round(th.canary_age_s) + ' s' : '—'})<br>
      <strong style="color:var(--txt2);">Benchmark vs. trh:</strong>
      ${bench ? `Brier ${bench.brier_model?.toFixed(3)} (trh ${bench.brier_market?.toFixed(3)}), ${d.benchmark.runs_logged} běhů v historii` : 'zatím nespuštěno'}<br>
      <strong style="color:var(--txt2);">Tipsport import:</strong>
      ${tp.matches_stored ? `${tp.matches_stored} zápasů, poslední import před ${Math.round((tp.last_imported_age_s || 0) / 60)} min` : 'zatím nic naimportováno'}<br>
      <strong style="color:var(--txt2);">Velikost datových souborů:</strong><br>${filesHtml}
    `;
  } catch (e) {
    box.innerHTML = '<span class="muted">Nepodařilo se načíst.</span>';
  }
}

async function saveAgentSettings() {
  const body = {
    enabled: el('cfgEnabled').checked,
    auto_run: el('cfgAutoRun').checked,
    min_prob: Number(el('cfgMinProb').value) / 100,
    min_odds: Number(el('cfgMinOdds').value),
    stake_mode: el('cfgStakeMode').value,
    max_daily_stake_pct: Number(el('cfgDailyCap').value) / 100,
  };
  try {
    await api('/api/agent/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Nastavení uloženo.');
  } catch (e) {
    toast('Uložení selhalo.', 'err');
  }
}

async function saveBankrollSettings() {
  const body = {
    start_balance: Number(el('cfgStartBalance').value),
    kelly_fraction: Number(el('cfgKellyFraction').value),
  };
  try {
    await api('/api/bankroll/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast('Bankroll uložen.');
  } catch (e) {
    toast('Uložení selhalo.', 'err');
  }
}

// ---------------------------------------------------------------------------
// BETTORS ARENA – 10 virtuálních sázkařů
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Správa sázkařů – vklad, smazání, průvodce vytvořením
// ---------------------------------------------------------------------------
let _depositTarget = null;
let _wizOptions = null;
let _wizPreviewTimer = null;

function openDeposit(id, name) {
  _depositTarget = id;
  setText('depositWho', name);
  el('depositAmount').value = 500;
  el('depositNote').value = '';
  el('depositModal').style.display = 'flex';
}

async function confirmDeposit() {
  const amount = parseFloat(el('depositAmount').value);
  if (!amount) { toast('Zadej nenulovou částku.', 'err'); return; }
  try {
    await api(`/api/bettors/${_depositTarget}/deposit`, {
      method: 'POST',
      body: JSON.stringify({ amount, note: el('depositNote').value.trim() }),
    });
    el('depositModal').style.display = 'none';
    toast(amount > 0 ? `Vloženo ${fmt(amount)} Kč.` : `Vybráno ${fmt(-amount)} Kč.`);
    loadBettors();
  } catch (e) {
    toast('Vklad se nepovedl: ' + e.message, 'err');
  }
}

async function deleteBettor(id, name) {
  if (!confirm(`Opravdu smazat sázkaře „${name}“?\n\nPřijdeš i o celou jeho historii sázek. Nejde to vrátit.`)) return;
  try {
    await api(`/api/bettors/${id}`, { method: 'DELETE' });
    toast(`Sázkař „${name}“ smazán.`);
    loadBettors();
  } catch (e) {
    toast('Smazání se nepovedlo: ' + e.message, 'err');
  }
}

async function resetOneBettor(id, name) {
  if (!confirm(`Resetovat sázkaře „${name}“?\n\nSmaže se mu celá historie sázek a bank se vrátí na start. Nejde to vrátit.`)) return;
  try {
    await api(`/api/bettors/${id}/reset`, { method: 'POST', timeoutMs: 20000 });
    toast(`Sázkař „${name}“ resetován.`);
    loadBettors();
  } catch (e) {
    toast('Reset se nepovedl: ' + e.message, 'err');
  }
}

async function retrainOneBettor(id, name) {
  try {
    toast(`Přetrénovávám „${name}“…`, 'info', 4000);
    const data = await api(`/api/bettors/${id}/retrain`, { method: 'POST', timeoutMs: 60000 });
    const extra = data.params_updated ? ' – parametry přeladěny podle nejnovějších dat.' : '';
    toast(`„${name}“ přetrénován${extra}`, 'ok', 6000);
    loadBettors();
  } catch (e) {
    toast('Přetrénování se nepovedlo: ' + e.message, 'err');
  }
}

async function runOneBettor(id, name) {
  try {
    const data = await api(`/api/bettors/${id}/run`, { method: 'POST', timeoutMs: 40000 });
    toast(data.placed ? `„${name}“ vsadil ${data.placed}×.` : `„${name}“ teď nenašel žádnou příležitost.`, 'ok');
    loadBettors();
  } catch (e) {
    toast('Vytvoření sázek se nepovedlo: ' + e.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Kontextové menu (pravé tlačítko myši) u karty sázkaře v aréně – Resetovat
// sázky / Přetrénovat / Vytvořit sázky. Jednoduché vlastní menu, appka
// žádné jiné nikde nemá, tak drženo minimální (jedna instance v DOM,
// zavírá se klikem mimo nebo Escapem).
// ---------------------------------------------------------------------------
let _ctxMenuEl = null;

function closeBettorContextMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
  document.removeEventListener('click', closeBettorContextMenu);
  document.removeEventListener('keydown', _ctxMenuEscHandler);
}

function _ctxMenuEscHandler(e) {
  if (e.key === 'Escape') closeBettorContextMenu();
}

function openBettorContextMenu(e, id, name) {
  e.preventDefault();
  closeBettorContextMenu();
  const items = [
    { label: '🔁 Resetovat sázky', fn: () => resetOneBettor(id, name) },
    { label: '🧬 Přetrénovat', fn: () => retrainOneBettor(id, name) },
    { label: '🎯 Vytvořit sázky', fn: () => runOneBettor(id, name) },
  ];
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it, i) => `<button data-i="${i}">${it.label}</button>`).join('');
  document.body.appendChild(menu);
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 200, mh = items.length * 36 + 8;
  menu.style.left = Math.min(e.clientX, vw - mw - 8) + 'px';
  menu.style.top = Math.min(e.clientY, vh - mh - 8) + 'px';
  menu.querySelectorAll('button').forEach((btn, i) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeBettorContextMenu();
      items[i].fn();
    });
  });
  _ctxMenuEl = menu;
  // otevřít na tenhle klik nezavře hned samo sebe – listener se přidá až v dalším tiku
  setTimeout(() => {
    document.addEventListener('click', closeBettorContextMenu);
    document.addEventListener('keydown', _ctxMenuEscHandler);
  }, 0);
}

function wizParams() {
  return {
    market: el('wizMarket').value,
    min_prob: (parseFloat(el('wizMinProb').value) || 60) / 100,
    min_odds: parseFloat(el('wizMinOdds').value) || 1.2,
    max_odds: parseFloat(el('wizMaxOdds').value) || 10,
    stake_mode: el('wizStakeMode').value,
    stake_pct: (parseFloat(el('wizStakePct').value) || 3) / 100,
    kelly_fraction: parseFloat(el('wizKelly').value) || 0.25,
    max_bets: parseInt(el('wizMaxBets').value) || 3,
    progression: el('wizProgression').value,
    pause_after_losses: parseInt(el('wizPause').value) || 0,
    one_per_league: el('wizOnePerLeague').checked,
  };
}

async function refreshWizPreview() {
  // Kelly a pevné % se vylučují – ukaž jen to pole, které se použije
  const kelly = el('wizStakeMode').value === 'kelly';
  el('wizKellyField').style.display = kelly ? '' : 'none';
  el('wizStakePctField').style.display = kelly ? 'none' : '';
  try {
    const d = await api('/api/bettors/preview', {
      method: 'POST', body: JSON.stringify({ params: wizParams() }), timeoutMs: 15000,
    });
    const custom = el('wizName').value.trim();
    el('wizPreview').innerHTML =
      `<div style="font-size:15px; font-weight:700;">${d.emoji} ${esc(custom || d.name)}</div>
       <div style="font-size:12.5px; color:var(--txt2); margin-top:4px;">${d.tagline}</div>`;
    el('wizPreview').dataset.emoji = d.emoji;
    el('wizPreview').dataset.name = d.name;
  } catch (e) {
    el('wizPreview').textContent = 'Náhled se nepodařilo načíst.';
  }
}

async function openBettorWizard() {
  if (!_wizOptions) {
    try { _wizOptions = await api('/api/bettors/options'); }
    catch (e) { toast('Nepodařilo se načíst nastavení průvodce.', 'err'); return; }
    const fill = (id, items) => {
      el(id).innerHTML = items.map(o => `<option value="${o.key}">${o.label}</option>`).join('');
    };
    fill('wizMarket', _wizOptions.markets);
    fill('wizProgression', _wizOptions.progressions);
    fill('wizStakeMode', _wizOptions.stake_modes);
    // náhled se přepočítá při každé změně
    ['wizMarket', 'wizMinProb', 'wizMinOdds', 'wizMaxOdds', 'wizStakeMode', 'wizStakePct',
     'wizKelly', 'wizMaxBets', 'wizProgression', 'wizPause', 'wizOnePerLeague', 'wizName']
      .forEach(id => el(id)?.addEventListener('input', () => {
        clearTimeout(_wizPreviewTimer);
        _wizPreviewTimer = setTimeout(refreshWizPreview, 250);
      }));
  }
  el('bettorWizard').style.display = 'flex';
  refreshWizPreview();
}

async function createBettor() {
  const btn = el('wizCreate');
  btn.disabled = true; btn.textContent = 'Vytvářím…';
  try {
    const b = await api('/api/bettors', {
      method: 'POST',
      body: JSON.stringify({
        params: wizParams(),
        name: el('wizName').value.trim() || null,
        emoji: el('wizPreview').dataset.emoji || null,
        start_balance: parseFloat(el('wizStart').value) || 1000,
      }),
    });
    el('bettorWizard').style.display = 'none';
    el('wizName').value = '';
    toast(`Sázkař ${b.emoji} ${esc(b.name)} vytvořen.`);
    loadBettors();
  } catch (e) {
    toast('Vytvoření se nepovedlo: ' + e.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Vytvořit sázkaře';
  }
}

async function loadBettors() {
  const box = el('bettorsContainer');
  box.innerHTML = '<div class="loading"><span class="spinner"></span> Načítání sázkařů…</div>';
  try {
    const [data, calib, ag, lastRun] = await Promise.all([
      api('/api/bettors', { timeoutMs: 20000 }),
      api('/api/bettors/calibration', { timeoutMs: 15000 }).catch(() => ({ buckets: [] })),
      api('/api/agent', { timeoutMs: 15000 }).catch(() => ({ settings: {} })),
      api('/api/bettors/status', { timeoutMs: 8000 }).catch(() => ({})),
    ]);
    _bettorGroups = data.groups || _bettorGroups;
    STATE.agentCfg = ag.settings || {};
    STATE.bettorsLastRun = lastRun || {};
    renderBettors(data.bettors || []);
    renderArenaHero(data.bettors || []);
    loadGroupCompare();
    drawCalibrationChart(calib.buckets || []);
    loadArenaTimeBreakdown();
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Chyba: ${e.message}</div>`;
  }
}

/** Rozklad výkonu celé arény podle dne v týdnu / denní doby výkopu.
 *  Endpoint /api/bettors/breakdown/time existoval, ale nikdo ho nevolal. */
async function loadArenaTimeBreakdown() {
  const box = el('arenaTimeBox');
  if (!box) return;
  try {
    const d = await api('/api/bettors/breakdown/time', { timeoutMs: 20000 });
    const bloky = [['weekday', 'Podle dne v týdnu'], ['hour', 'Podle denní doby výkopu']]
      .map(([klic, nadpis]) => {
        const rows = (d[klic] || []).filter(r => r.n > 0);
        if (!rows.length) return '';
        // Sloupce ROI se škálují proti nejsilnější hodnotě v bloku, ať je
        // rozdíl vidět i když jsou všechny hodnoty malé.
        const max = Math.max(...rows.map(r => Math.abs(r.roi || 0)), 1);
        return `
          <div class="perf-block">
            <div class="perf-title">${nadpis}</div>
            <div class="perf-rows">
              ${rows.map(r => `
                <div class="perf-row">
                  <span class="perf-key">${r.key}</span>
                  <span class="time-bar" title="ROI ${pct(r.roi)}">
                    <i class="${(r.roi || 0) >= 0 ? 'pos' : 'bad'}"
                       style="width:${(Math.abs(r.roi || 0) / max * 100).toFixed(0)}%"></i>
                  </span>
                  <span class="perf-nums">
                    <span class="muted">${r.n}× · ${pct(r.win_rate)}</span>
                    <strong class="${(r.pnl || 0) >= 0 ? 'pos' : 'bad'}">${(r.pnl || 0) >= 0 ? '+' : ''}${fmt(r.pnl)} Kč</strong>
                    <span class="${(r.roi || 0) >= 0 ? 'pos' : 'bad'}">${pct(r.roi)}</span>
                  </span>
                </div>`).join('')}
            </div>
          </div>`;
      }).join('');
    box.className = '';
    box.innerHTML = bloky
      ? `<div class="perf-grid">${bloky}</div>
         <p class="muted" style="font-size:11.5px; margin:10px 0 0;">
           Pozor na malé vzorky – řádek s pár sázkami neznamená vzorec, jen náhodu.
         </p>`
      : '<div class="empty-state">Zatím není dost vyhodnocených sázek.</div>';
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="empty-state">Rozklad se nepodařilo načíst.</div>';
  }
}

function renderArenaHero(bettors) {
  const box = el('arenaHeroKpis');
  if (!box) return;
  if (!bettors.length) {
    box.innerHTML = '<span class="arena-hero-kpi"><b>—</b><em>Zatím žádní sázkaři</em></span>';
    return;
  }
  const bank = bettors.reduce((a, b) => a + (b.balance || 0) + (b.open_stake || 0), 0);
  const zisk = bettors.reduce((a, b) => a + (b.profit || 0), 0);
  const vPlusu = bettors.filter(b => (b.profit || 0) > 0).length;
  const settled = bettors.reduce((a, b) => a + (b.settled || 0), 0);
  const nextRun = _nextRunLabel();
  const zzTrida = zisk >= 0 ? 'pos' : 'bad';
  const last = _lastRunLabel();

  box.innerHTML = `
    <span class="arena-hero-kpi"><b>${bettors.length}</b><em>Sázkařů</em></span>
    <span class="arena-hero-kpi"><b>${fmt(Math.round(bank))} Kč</b><em>Bank arény</em></span>
    <span class="arena-hero-kpi"><b class="${zzTrida}">${zisk >= 0 ? '+' : ''}${fmt(Math.round(zisk))} Kč</b><em>Realizovaný zisk (${fmt(settled)} sázek)</em></span>
    <span class="arena-hero-kpi"><b>${vPlusu} / ${bettors.length}</b><em>V plusu</em></span>
    <span class="arena-hero-kpi"><b>${last.value}</b><em>${last.label}</em></span>
    <span class="arena-hero-kpi"><b>${nextRun}</b><em>Další kolo</em></span>
  `;
}

/** Vrátí popis posledního kola – např. "12:04 · 33 tipů" nebo "zatím
 *  neproběhlo", pokud ještě není záznam. Ať uživatel z prvního pohledu
 *  vidí, že rozvrh se hýbe, a nemusí čekat na další automatické kolo. */
function _lastRunLabel() {
  const r = STATE.bettorsLastRun || {};
  if (!r.ts) return { value: '—', label: 'Poslední kolo zatím neproběhlo' };
  const d = new Date(r.ts * 1000);
  const dnes = new Date();
  const stejnyDen = d.toDateString() === dnes.toDateString();
  const cas = d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  const kdy = stejnyDen ? cas : d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' }) + ' ' + cas;
  const detail = r.total_placed ? `${r.active || '?'} sázelo · ${r.total_placed} tipů` : 'nikdo nezasadil';
  return { value: kdy, label: `Poslední kolo (${detail})` };
}

/** Kdy poběží další automatické kolo. Sázkaři jedou podle stejného
 *  rozvrhu jako auto-agent (auto_run_hours v Nastavení), typicky
 *  '8,12,16,20'. Když se hodinu propásne, dohoní se v další. */
function _nextRunLabel() {
  const cfg = STATE.agentCfg || {};
  const hoursRaw = cfg.auto_run_hours || (cfg.auto_run ? '8,12,16,20' : '');
  if (!cfg.auto_run) return 'ručně';
  const hours = String(hoursRaw).split(',').map(x => parseInt(x.trim(), 10)).filter(x => x >= 0 && x <= 23);
  if (!hours.length) return 'ručně';
  const now = new Date();
  const nowH = now.getHours(), nowM = now.getMinutes();
  const upcoming = hours.filter(h => h > nowH || (h === nowH && nowM < 5));
  const next = upcoming.length ? upcoming[0] : hours[0];
  const zejtra = !upcoming.length;
  return `${String(next).padStart(2, '0')}:00${zejtra ? ' zítra' : ''}`;
}

function sparklineSvg(equity) {
  if (!equity || equity.length < 2) return '';
  const w = 90, h = 32, pad = 2;
  const minV = Math.min(...equity), maxV = Math.max(...equity);
  const range = (maxV - minV) || 1;
  let path = '';
  equity.forEach((v, i) => {
    const x = pad + (i / (equity.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - minV) / range) * (h - 2 * pad);
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  });
  const color = equity[equity.length - 1] >= equity[0] ? 'var(--pos)' : 'var(--bad)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${path}" stroke="${color}" stroke-width="1.6" fill="none"/></svg>`;
}

let _bettorGroups = null;

const GROUP_COLORS = { single: 'var(--accent)', acca: 'var(--blue)', combo: 'var(--warn)' };

async function loadGroupCompare() {
  const box = el('groupCompare');
  if (!box) return;
  try {
    const d = await api('/api/bettors/groups', { timeoutMs: 20000 });
    const gs = d.groups || [];
    if (!gs.length) { box.className = ''; box.innerHTML = '<div class="empty-state">Zatím nic</div>'; return; }
    const all = gs.flatMap(g => g.curve || [0]);
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    const span = (hi - lo) || 1;
    const W = 600, H = 130;
    const path = g => (g.curve || []).map((v, i, a) => {
      const x = a.length > 1 ? (i / (a.length - 1)) * W : 0;
      const y = H - ((v - lo) / span) * H;
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const zeroY = H - ((0 - lo) / span) * H;
    box.className = '';
    box.innerHTML = `
      <div class="table-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:130px;">
          <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}"
                stroke="var(--border)" stroke-dasharray="4 4"/>
          ${gs.map(g => `<path d="${path(g)}" fill="none" stroke="${GROUP_COLORS[g.group] || 'var(--txt2)'}" stroke-width="2"/>`).join('')}
        </svg>
      </div>
      <div class="table-wrap" style="margin-top:10px;"><table>
        <thead><tr><th>Kategorie</th><th>Sázkařů</th><th>Zisk</th><th>ROI</th><th>Win rate</th><th>Vyřešeno</th><th>Ve hře</th></tr></thead>
        <tbody>${gs.map(g => `<tr>
          <td><span style="color:${GROUP_COLORS[g.group] || 'inherit'};">●</span> ${g.emoji} ${g.label}</td>
          <td>${g.bettors}</td>
          <td class="${g.pnl >= 0 ? 'pos' : 'bad'}">${g.pnl >= 0 ? '+' : ''}${fmt(g.pnl)} Kč</td>
          <td>${g.settled ? pct(g.roi) : '—'}</td>
          <td>${g.win_rate != null ? pct(g.win_rate) : '—'}</td>
          <td>${g.settled}</td>
          <td class="muted">${fmt(g.open_stake)} Kč</td>
        </tr>`).join('')}</tbody></table></div>
      <p style="font-size:11.5px; color:var(--txt3); margin:10px 0 0;">
        Kategorie s málo vyřešenými sázkami ještě nic neříká – křivka i ROI potřebují desítky tiketů.
      </p>`;
  } catch (e) {
    box.className = '';
    box.innerHTML = `<div class="empty-state">Srovnání se nepodařilo načíst: ${e.message}</div>`;
  }
}

/* Aréna: jedna kategorie naráz + seřaditelný žebříček.
   Původní návrh vypisoval všech 41 sázkařů jako velké karty pod sebou –
   stránka měla přes 5000 px a porovnat dva sázkaře šlo jen po paměti,
   přitom celá stránka je právě o tom, kdo je lepší. */

let _arenaAll = [];
let _arenaGroup = 'single';
let _arenaSort = { key: 'rank', dir: 1 };
let _arenaHledani = '';        // text z vyhledávacího políčka nad tabulkou
let _arenaFiltr = 'vse';       // vse | plus | minus | aktivni | bezSazek

const ARENA_SLOUPCE = [
  { key: null,         label: '',          cls: 'arena-caret' },
  { key: 'rank',       label: '#',         tip: 'Pořadí podle zisku. Klikni na jakýkoliv sloupec a seřadíš podle něj.' },
  { key: 'name',       label: 'Sázkař' },
  { key: null,         label: 'Vývoj',     cls: 'hide-sm', tip: 'Vývoj zůstatku v čase (posledních ~30 vyhodnocených sázek).' },
  { key: 'balance',    label: 'Zůstatek',  num: true, tip: 'Aktuální bank sázkaře. Každý začíná na 200 Kč.' },
  { key: 'profit',     label: 'Zisk',      num: true, tip: 'Realizovaný zisk – jen z vyhodnocených sázek, otevřené se nepočítají.' },
  { key: 'roi',        label: 'ROI',       num: true, tip: 'Návratnost: zisk / celkem vsazeno. Nezávislé na velikosti sázek, takže se dá srovnávat mezi sázkaři.' },
  { key: 'win_rate',   label: 'Úspěšnost', num: true, cls: 'hide-md', tip: 'Podíl vyhraných z vyhodnocených sázek. Vysoká úspěšnost ještě neznamená zisk – záleží na kurzech.' },
  { key: 'avg_clv',    label: 'CLV',       num: true, cls: 'hide-md', tip: 'Closing Line Value: o kolik lepší kurz sázkař chytil oproti kurzu těsně před výkopem. Kladné = má skutečnou výhodu. Na malém vzorku spolehlivější než zisk, protože nezávisí na štěstí ve výsledcích.' },
  { key: 'settled',    label: 'Sázek',     num: true, cls: 'hide-md', tip: 'Vyhodnocených / celkem vsazených. Rozdíl = sázky, které ještě čekají na výsledek.' },
  { key: 'open_stake', label: 'Ve hře',    num: true, cls: 'hide-sm', tip: 'Kolik Kč má sázkař právě rozehráno v nevyhodnocených sázkách.' },
  { key: null,         label: '' },
];

function renderBettors(bettors) {
  _arenaAll = bettors || [];
  const box = el('bettorsContainer');
  if (!_arenaAll.length) { box.innerHTML = '<div class="empty-state">Žádní sázkaři</div>'; return; }

  const groups = _bettorGroups || {};
  const order = ['single', 'acca', 'combo', 'ai'];
  const pocty = {};
  _arenaAll.forEach(b => { const g = b.group || 'single'; pocty[g] = (pocty[g] || 0) + 1; });
  // "vse" je vždycky platná volba, i kdyby kategorie z dat zmizela
  if (_arenaGroup !== 'vse' && !pocty[_arenaGroup]) _arenaGroup = order.find(g => pocty[g]) || 'single';

  box.className = '';
  box.innerHTML = `
    <div class="arena-tabs" id="arenaTabs">
      <button data-group="vse" class="${_arenaGroup === 'vse' ? 'on' : ''}"
              title="Všichni sázkaři napříč kategoriemi v jednom žebříčku">
        🏆 Vše <span class="cnt">${_arenaAll.length}</span>
      </button>
      ${order.filter(g => pocty[g]).map(g => {
        const info = groups[g] || { label: g, emoji: '' };
        return `<button data-group="${g}" class="${g === _arenaGroup ? 'on' : ''}">
                  ${info.emoji || ''} ${info.label} <span class="cnt">${pocty[g]}</span>
                </button>`;
      }).join('')}
    </div>
    <div id="arenaBody"></div>`;

  box.querySelectorAll('#arenaTabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      _arenaGroup = btn.dataset.group;
      box.querySelectorAll('#arenaTabs button').forEach(b => b.classList.toggle('on', b === btn));
      renderArenaBody();
    });
  });
  renderArenaBody();
}

function renderArenaBody() {
  const box = el('arenaBody');
  if (!box) return;
  const groups = _bettorGroups || {};
  const vseRezim = _arenaGroup === 'vse';
  const info = vseRezim
    ? { desc: 'Všichni sázkaři arény v jednom žebříčku, napříč kategoriemi – rovnou je vidět, která strategie celkově vede.' }
    : (groups[_arenaGroup] || {});
  // Souhrnné dlaždice počítej z CELÉ kategorie, ne z vyfiltrovaného výběru –
  // jinak by se "Zisk kategorie" měnil podle toho, co je zrovna napsané ve
  // vyhledávání, což by bylo zavádějící.
  const list = vseRezim ? _arenaAll : _arenaAll.filter(b => (b.group || 'single') === _arenaGroup);

  const zisk = list.reduce((a, x) => a + (x.profit || 0), 0);
  const veHre = list.reduce((a, x) => a + (x.open_stake || 0), 0);
  const vyresene = list.reduce((a, x) => a + (x.settled || 0), 0);
  const vyhry = list.reduce((a, x) => a + (x.settled || 0) * ((x.win_rate || 0) / 100), 0);
  const uspesnost = vyresene ? (vyhry / vyresene * 100) : null;
  const nejlepsi = list.reduce((a, x) => (!a || (x.profit || 0) > (a.profit || 0)) ? x : a, null);
  const vPlusu = list.filter(b => (b.profit || 0) > 0).length;
  // Vážený průměr CLV napříč sázkaři kategorie – nejspolehlivější ukazatel
  // skutečné výhody, nezávislý na krátkodobé smůle výsledků.
  const clvSum = list.reduce((a, x) => a + (x.avg_clv || 0) * (x.clv_n || 0), 0);
  const clvN = list.reduce((a, x) => a + (x.clv_n || 0), 0);
  const avgClv = clvN ? clvSum / clvN : null;

  // Hledání + rychlé filtry nad rámec kategorie (61 sázkařů se jinak
  // proklikává těžko). Diakritika nevadí – _fold sjednotí obě strany.
  const dotaz = _fold(_arenaHledani.trim());
  const filtry = {
    vse:      () => true,
    plus:     b => (b.profit || 0) > 0,
    minus:    b => (b.profit || 0) < 0,
    aktivni:  b => (b.open_count || 0) > 0,
    bezSazek: b => (b.placed || 0) === 0,
  };
  const projdeFiltrem = filtry[_arenaFiltr] || filtry.vse;
  const videt = list.filter(b =>
    projdeFiltrem(b) &&
    (!dotaz || _fold(b.name).includes(dotaz) || _fold(b.tagline || '').includes(dotaz)));

  const razeno = [...videt].sort((a, b) => {
    const k = _arenaSort.key;
    let va = a[k], vb = b[k];
    if (typeof va === 'string') return _arenaSort.dir * va.localeCompare(vb, 'cs');
    va = (va === null || va === undefined) ? -Infinity : va;
    vb = (vb === null || vb === undefined) ? -Infinity : vb;
    return _arenaSort.dir * (va - vb);
  });

  const pocetFiltru = k => list.filter(filtry[k]).length;
  const FILTR_POPISKY = [
    ['vse', 'Vše'], ['plus', 'V plusu'], ['minus', 'Ve ztrátě'],
    ['aktivni', 'Rozehrané'], ['bezSazek', 'Bez sázek'],
  ];

  box.innerHTML = `
    ${info.desc ? `<p class="arena-desc">${info.desc}</p>` : ''}

    <div class="grid-stats">
      <div class="stat-tile">
        <div class="label">${vseRezim ? 'Zisk arény' : 'Zisk kategorie'}</div>
        <div class="value ${zisk >= 0 ? 'pos' : 'bad'}">${zisk >= 0 ? '+' : ''}${fmt(zisk)} Kč</div>
        <div class="hint">${vPlusu} z ${list.length} v plusu</div>
      </div>
      <div class="stat-tile">
        <div class="label">Ve hře</div>
        <div class="value">${fmt(veHre)} Kč</div>
        <div class="hint">otevřené sázky</div>
      </div>
      <div class="stat-tile">
        <div class="label">Úspěšnost</div>
        <div class="value">${uspesnost !== null ? fmt(uspesnost) + '&nbsp;%' : '—'}</div>
        <div class="hint">${vyresene} vyhodnocených</div>
      </div>
      <div class="stat-tile">
        <div class="label">Vede</div>
        <div class="value" style="font-size:17px;">${nejlepsi ? nejlepsi.emoji + ' ' + nejlepsi.name : '—'}</div>
        <div class="hint">${nejlepsi ? ((nejlepsi.profit >= 0 ? '+' : '') + fmt(nejlepsi.profit) + ' Kč') : ''}</div>
      </div>
      <div class="stat-tile">
        <div class="label">Průměrné CLV</div>
        <div class="value ${avgClv !== null && avgClv >= 0 ? 'pos' : avgClv !== null ? 'bad' : ''}">${avgClv !== null ? (avgClv >= 0 ? '+' : '') + pct(avgClv) : '—'}</div>
        <div class="hint">${clvN ? `z ${clvN} sázek/noh` : 'zatím žádná data'}</div>
      </div>
    </div>

    ${_arenaGroup === 'ai' ? '<div id="aiTurnajBox" class="card"><div class="loading"><span class="spinner"></span></div></div>' : ''}

    <div class="card">
      <div class="arena-toolbar">
        <input type="text" id="arenaSearch" class="search-input arena-search"
               placeholder="🔍 Najít sázkaře podle jména nebo strategie…"
               value="${escAttr(_arenaHledani)}">
        <div class="arena-filters" id="arenaFilters">
          ${FILTR_POPISKY.map(([k, popisek]) => `
            <button class="pill clickable ${k === _arenaFiltr ? 'active' : ''}" data-filtr="${k}">
              ${popisek} <span class="cnt">${pocetFiltru(k)}</span>
            </button>`).join('')}
        </div>
      </div>
      <div class="table-wrap">
        <table class="arena-table">
          <thead><tr>${ARENA_SLOUPCE.map(c => `
            <th class="${c.num ? 'num ' : ''}${c.cls || ''} ${c.key ? 's' : ''} ${c.key && c.key === _arenaSort.key ? 'on' : ''}"
                ${c.tip ? `title="${escAttr(c.tip)}"` : ''}
                ${c.key ? `data-sort="${c.key}"` : ''}>${c.label}${c.tip ? '<span class="th-tip">?</span>' : ''}${c.key && c.key === _arenaSort.key ? (_arenaSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
          </tr></thead>
          <tbody>${razeno.length
            ? razeno.map(b => arenaRadek(b, veHre, vseRezim)).join('')
            : `<tr><td colspan="${ARENA_SLOUPCE.length}" class="empty-state">
                 Nic neodpovídá ${dotaz ? `hledání „${escAttr(_arenaHledani)}"` : 'zvolenému filtru'}.
               </td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  // Hledání nepřekresluje celou stránku, jen tělo arény – a políčko si
  // po překreslení vrátí kurzor, aby se dalo psát plynule.
  const hledaci = el('arenaSearch');
  if (hledaci) {
    hledaci.addEventListener('input', () => {
      _arenaHledani = hledaci.value;
      const pozice = hledaci.selectionStart;
      renderArenaBody();
      const nove = el('arenaSearch');
      if (nove) { nove.focus(); nove.setSelectionRange(pozice, pozice); }
    });
  }
  box.querySelectorAll('#arenaFilters button').forEach(btn => {
    btn.addEventListener('click', () => {
      _arenaFiltr = btn.dataset.filtr;
      renderArenaBody();
    });
  });

  box.querySelectorAll('th.s').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      // pořadí a jméno se čtou odshora, čísla dávají smysl od největšího
      if (_arenaSort.key === k) _arenaSort.dir *= -1;
      else _arenaSort = { key: k, dir: (k === 'rank' || k === 'name') ? 1 : -1 };
      renderArenaBody();
    });
  });
  wireBettorCards(box);
  if (_arenaGroup === 'ai') loadAiTurnaj();
}

/** AI turnaj: žebříček AI sázkařů podle CLV + evoluce AI Šampiona.
 *  Backend (/api/bettors/ai-tournament, /ai-champion/evolve) tohle uměl
 *  odjakživa a denní retrain cron evoluci sám spouští – jen to nikde
 *  nebylo vidět, takže uživatel netušil, že se AI kategorie sama vyvíjí. */
async function loadAiTurnaj() {
  const box = el('aiTurnajBox');
  if (!box) return;
  try {
    const d = await api('/api/bettors/ai-tournament');
    const rows = d.tournament || [];
    if (!rows.length) { box.innerHTML = '<div class="empty-state">Zatím žádní AI sázkaři.</div>'; return; }
    // Bez dost velkého vzorku CLV je pořadí jen podle zisku – ať je jasné,
    // kterým řádkům se dá věřit a kterým ještě ne.
    const radky = rows.map(r => {
      const maClv = (r.clv_n || 0) >= 5 && r.avg_clv !== null && r.avg_clv !== undefined;
      const sampion = r.id === 'ai_champion';
      return `
        <tr class="${sampion ? 'ai-champ-row' : ''}">
          <td class="arena-rank ${r.rank <= 3 ? 'medal' : ''}">${r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank}</td>
          <td><span class="face">${r.emoji}</span> <strong>${r.name}</strong>${sampion ? ' <span class="grp-badge">šampion</span>' : ''}</td>
          <td class="num ${maClv ? (r.avg_clv >= 0 ? 'pos' : 'bad') : 'muted'}">
            ${maClv ? (r.avg_clv >= 0 ? '+' : '') + pct(r.avg_clv) : '—'}
          </td>
          <td class="num muted">${r.clv_n || 0}</td>
          <td class="num ${(r.profit || 0) >= 0 ? 'pos' : 'bad'}">${(r.profit || 0) >= 0 ? '+' : ''}${fmt(Math.round(r.profit))} Kč</td>
          <td class="num muted">${r.settled || 0}</td>
        </tr>`;
    }).join('');
    box.innerHTML = `
      <h3>🤖 AI turnaj</h3>
      <p class="muted" style="font-size:12.5px; margin:0 0 12px; max-width:78ch;">
        AI sázkaři se řadí podle <strong>CLV</strong>, ne podle zisku – na malém vzorku je to
        spolehlivější ukazatel skutečné výhody, protože nezávisí na tom, jestli zrovna padl gól.
        Vítěz slouží jako předloha pro <strong>AI Šampiona</strong>: appka z něj vytvoří kopii
        s mírně pozměněným prahem jistoty, takže se kategorie postupně sama vylepšuje.
        Evoluce běží automaticky i v denním retrainu.
      </p>
      <div class="table-wrap"><table class="arena-table">
        <thead><tr>
          <th>#</th><th>AI sázkař</th>
          <th class="num" title="Closing Line Value – o kolik lepší kurz sázkař chytil oproti kurzu těsně před výkopem">CLV<span class="th-tip">?</span></th>
          <th class="num" title="Z kolika sázek/noh je CLV spočítané. Pod 5 vzorků se pořadí řídí ziskem.">Vzorků<span class="th-tip">?</span></th>
          <th class="num">Zisk</th><th class="num">Vyřešeno</th>
        </tr></thead>
        <tbody>${radky}</tbody>
      </table></div>
      <div class="toolbar-row" style="margin-top:12px;">
        <button class="btn" id="evolveAiBtn">🧬 Vyvinout AI Šampiona teď</button>
        <span class="muted" style="font-size:11.5px;">Přepíše nastavení stávajícího šampiona podle aktuálního vítěze – bank a historii mu nechá.</span>
      </div>`;
    el('evolveAiBtn')?.addEventListener('click', evolveAiSampion);
  } catch (e) {
    box.innerHTML = '<div class="empty-state">AI turnaj se nepodařilo načíst.</div>';
  }
}

async function evolveAiSampion() {
  const btn = el('evolveAiBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Vyvíjím…'; }
  try {
    const r = await api('/api/bettors/ai-champion/evolve', { method: 'POST', timeoutMs: 30000 });
    if (r.evolved) {
      toast(`AI Šampion vyvinut podle „${r.source}".`);
      loadBettors();          // překreslí i žebříček s novým taglinem šampiona
    } else {
      toast(r.reason === 'not_enough_data'
        ? 'Zatím málo dat – AI sázkaři potřebují víc vyhodnocených sázek s CLV.'
        : 'Evoluce neproběhla.', 'err');
      loadAiTurnaj();
    }
  } catch (e) {
    toast('Evoluce selhala.', 'err');
    loadAiTurnaj();
  }
}

/** Krátký popisek kategorie pro odznak v celkovém žebříčku. Bere ho ze
 *  stejného zdroje jako záložky (/api/bettors/groups), ať se nerozejdou. */
function arenaSkupinaPopisek(group) {
  const g = (_bettorGroups || {})[group || 'single'];
  return g ? `${g.emoji || ''} ${g.label}`.trim() : (group || 'single');
}

function arenaRadek(b, veHreCelkem, vseRezim) {
  const medaile = b.rank === 1 ? '🥇' : b.rank === 2 ? '🥈' : b.rank === 3 ? '🥉' : null;
  const tridaZisk = (b.profit || 0) >= 0 ? 'pos' : 'bad';
  const podil = veHreCelkem > 0 ? Math.min(100, (b.open_stake || 0) / veHreCelkem * 100) : 0;
  // Sázkař bez jediné sázky = jeho strategie žádnou vhodnou příležitost
  // nenašla. Bez indikátoru to vypadá, jako by aplikace nefungovala –
  // hlavně u sázkařů se silnými filtry (Ultra Jistá, Čtyřkombinace),
  // kteří občas nezasází celý den.
  const nesazi = (b.placed || 0) === 0;
  // Celý řádek je klikatelný – detail se rozbaluje kliknutím kamkoliv v něm.
  return `
    <tr class="bettor-row ${nesazi ? 'idle' : ''}" data-id="${b.id}">
      <td class="arena-caret"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></td>
      <td class="arena-rank ${medaile ? 'medal' : ''}">${medaile || b.rank}</td>
      <td>
        <div class="arena-who">
          <span class="face">${b.emoji}</span>
          <span>
            <div class="nm">${esc(b.name)}${nesazi ? ' <span class="idle-badge" title="Strategie zatím nenašla vhodnou příležitost">bez sázek</span>' : ''}${
              // v celkovém žebříčku není z ničeho poznat, do jaké kategorie
              // sázkař patří – odznak to doplní, aniž by zabral sloupec
              vseRezim ? ` <span class="grp-badge">${arenaSkupinaPopisek(b.group)}</span>` : ''}</div>
            <div class="tg" title="${escAttr(b.tagline || '')}">${b.tagline}</div>
          </span>
        </div>
      </td>
      <td class="hide-sm">${sparklineSvg(b.equity)}</td>
      <td class="num">
        <div class="arena-bal">${fmt(Math.round(b.balance))} Kč</div>
        ${b.deposited ? `<div class="arena-sub">vloženo ${fmt(Math.round(b.deposited))}</div>` : ''}
      </td>
      <td class="num ${tridaZisk}" style="font-weight:600;">${(b.profit || 0) >= 0 ? '+' : ''}${fmt(Math.round(b.profit))}</td>
      <td class="num ${tridaZisk}">${fmt(b.roi)}&nbsp;%</td>
      <td class="num hide-md">${b.win_rate !== null ? fmt(b.win_rate) + '&nbsp;%' : '—'}</td>
      <td class="num hide-md ${b.clv_n ? (b.avg_clv >= 0 ? 'pos' : 'bad') : ''}"
          title="${b.clv_n ? `z ${b.clv_n} sázek/noh` : 'zatím žádná data pro CLV'}">
        ${b.clv_n ? (b.avg_clv >= 0 ? '+' : '') + pct(b.avg_clv) : '—'}
      </td>
      <td class="num hide-md">${b.settled}<span class="arena-sub"> / ${b.placed}</span></td>
      <td class="num hide-sm">
        <div class="arena-open">
          <span>${b.open_stake ? fmt(Math.round(b.open_stake)) : '—'}</span>
          <span class="bar"><i style="width:${podil.toFixed(0)}%"></i></span>
        </div>
        ${b.open_count ? `<div class="arena-sub">${b.open_count} sázek</div>` : ''}
      </td>
      <td class="arena-acts-cell">
        <div class="arena-acts">
          <button class="btn small icon-only bettor-deposit" data-id="${b.id}" data-name="${escAttr(b.name)}" title="Vložit peníze do banku sázkaře">＋</button>
          <button class="btn small icon-only bettor-more" data-id="${b.id}" data-name="${escAttr(b.name)}"
                  title="Další akce – resetovat sázky, přetrénovat, vsadit teď">⋯</button>
          <button class="btn small icon-only bettor-delete" data-id="${b.id}" data-name="${escAttr(b.name)}" title="Smazat sázkaře">🗑</button>
        </div>
      </td>
    </tr>
    <tr class="arena-detail"><td colspan="${ARENA_SLOUPCE.length}">
      <div id="bettorDetail-${b.id}" style="display:none;"></div>
    </td></tr>`;
}

function wireBettorCards(box) {
  box.querySelectorAll('.bettor-deposit').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openDeposit(btn.dataset.id, btn.dataset.name); });
  });
  box.querySelectorAll('.bettor-delete').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteBettor(btn.dataset.id, btn.dataset.name); });
  });
  // Stejné menu jako pravé tlačítko myši, ale objevitelné – na pravý klik
  // nikdo sám od sebe nepřijde.
  box.querySelectorAll('.bettor-more').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBettorContextMenu(e, btn.dataset.id, btn.dataset.name);
    });
  });
  // Celý řádek otevírá detail – kliknutí kdekoliv mimo akční tlačítka
  // (Vklad / Smazat) rozbalí historii sázek. Dřív bylo tlačítko 'Detail'
  // schované úplně vzadu za horizontálním scrollem a na menších oknech
  // se k němu nedalo dostat.
  box.querySelectorAll('tr.bettor-row').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.arena-acts')) return;   // klik na akční tlačítko nic nerozbaluje
      toggleBettorDetail(tr.dataset.id, tr);
    });
    // Pravé tlačítko myši → menu (Resetovat sázky / Přetrénovat / Vytvořit sázky)
    tr.addEventListener('contextmenu', (e) => {
      const nameEl = tr.querySelector('.nm');
      const name = nameEl ? nameEl.textContent.replace(/\s*bez sázek\s*$/, '').trim() : tr.dataset.id;
      openBettorContextMenu(e, tr.dataset.id, name);
    });
  });
}

function drawCalibrationChart(buckets) {
  const svg = el('calibrationSVG');
  if (!svg) return;
  const withData = buckets.filter(b => b.n > 0);
  if (!withData.length) {
    svg.innerHTML = `<text x="350" y="130" text-anchor="middle" font-size="13" fill="var(--txt3)">Zatím nedostatek vyhodnocených sázek pro kalibraci</text>`;
    return;
  }
  const width = 700, height = 260, padding = 44;
  const pw = width - 2 * padding, ph = height - 2 * padding;
  const n = buckets.length;
  const barW = pw / n;

  // ideální kalibrace = diagonála (0% dole vlevo .. 100% nahoře vpravo v rámci 50-100% rozsahu zobrazení)
  const toY = pct => height - padding - (pct / 100) * ph;
  let idealPath = '';
  [50, 100].forEach((pct, i) => {
    const x = padding + (i === 0 ? 0 : pw);
    idealPath += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + toY(pct).toFixed(1);
  });

  const bars = buckets.map((b, i) => {
    const x = padding + i * barW;
    if (!b.n) {
      return `<text x="${(x + barW / 2).toFixed(1)}" y="${height - padding + 16}" text-anchor="middle" font-size="10" fill="var(--txt3)">${b.range}</text>`;
    }
    const actualY = toY(b.actual_win_rate);
    const barH = height - padding - actualY;
    const color = Math.abs(b.actual_win_rate - b.avg_predicted) <= 8 ? 'var(--pos)' : 'var(--warn)';
    return `
      <rect x="${(x + barW * 0.2).toFixed(1)}" y="${actualY.toFixed(1)}" width="${(barW * 0.6).toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="2" opacity="0.85"/>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(actualY - 6).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="var(--txt)">${pct(b.actual_win_rate)}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${height - padding + 16}" text-anchor="middle" font-size="10" fill="var(--txt3)">${b.range} (n=${b.n})</text>`;
  }).join('');

  svg.innerHTML = `
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)"/>
    <path d="${idealPath}" stroke="var(--blue)" stroke-width="1.5" stroke-dasharray="4,4" fill="none"/>
    <text x="${width - padding}" y="${(toY(100) - 6).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--blue)">ideál</text>
    ${bars}`;
}

async function toggleBettorDetail(id, sourceEl) {
  const box = el(`bettorDetail-${id}`);
  const row = sourceEl.closest('tr') || document.querySelector(`tr.bettor-row[data-id="${id}"]`);
  const opening = box.style.display === 'none';
  if (!opening) {
    box.style.display = 'none';
    row?.classList.remove('open');
    return;
  }
  row?.classList.add('open');
  box.style.display = 'block';
  box.innerHTML = '<div class="loading" style="padding:14px 0;"><span class="spinner"></span></div>';
  try {
    const data = await api(`/api/bettors/${id}`, { timeoutMs: 15000 });
    const bets = data.bets || [];
    const tx = (data.transactions || []).filter(t => t.type !== 'start');
    const txHtml = tx.length ? `
      <div style="margin-bottom:12px;">
        <div style="font-size:12px; color:var(--txt3); margin-bottom:6px;">POHYBY NA BANKU</div>
        ${tx.map(t => `<div style="font-size:12.5px; display:flex; gap:10px;">
            <span class="muted">${new Date(t.ts * 1000).toLocaleString('cs-CZ')}</span>
            <strong class="${t.amount > 0 ? 'pos' : 'bad'}">${t.amount > 0 ? '+' : ''}${fmt(t.amount)} Kč</strong>
            <span class="muted">${t.note || (t.amount > 0 ? 'vklad' : 'výběr')}</span>
          </div>`).join('')}
      </div>` : '';
    // Rozklad výkonu podle sportu / typu trhu / ligy – vidět, kde sázkař
    // vydělává a kde tratí. Sport blacklist v run_all se opírá o totéž.
    const bd = data.breakdown || {};
    const bl = data.blacklisted_sports || [];
    const perfTable = (rows, label) => {
      if (!rows || !rows.length) return '';
      return `
        <div class="perf-block">
          <div class="perf-title">${label}</div>
          <div class="perf-rows">
            ${rows.slice(0, 8).map(r => `
              <div class="perf-row">
                <span class="perf-key">${r.key}</span>
                <span class="perf-nums">
                  <span class="muted">${r.n}× · ${pct(r.win_rate)}</span>
                  <strong class="${r.pnl >= 0 ? 'pos' : 'bad'}">${r.pnl >= 0 ? '+' : ''}${fmt(r.pnl)} Kč</strong>
                  <span class="muted">${pct(r.roi)}</span>
                </span>
              </div>`).join('')}
          </div>
        </div>`;
    };
    const breakdownHtml = (bd.sport?.length || bd.market?.length) ? `
      <div class="perf-grid">
        ${perfTable(bd.sport, 'Podle sportu')}
        ${perfTable(bd.market, 'Podle typu trhu')}
        ${perfTable(bd.league?.slice(0, 6), 'Top ligy')}
        ${perfTable(bd.weekday, 'Podle dne v týdnu')}
        ${perfTable(bd.hour, 'Podle denní doby výkopu')}
      </div>
      ${bl.length ? `<div class="perf-blacklist">🚫 Automaticky vyřazené sporty: <b>${bl.join(', ')}</b> — sázkař na ně po ≥15 sázkách má záporné ROI a přestal na ně sázet.</div>` : ''}
    ` : '';
    // CLV (closing line value) - nejspolehlivější ukazatel skutečné výhody,
    // nezávislý na krátkodobé smůle výsledků. avg_clv > 0 = sázkař bere
    // lepší cenu, než jaká byla těsně před výkopem.
    const clvHtml = (data.clv_n > 0) ? `
      <div class="perf-clv">
        📐 Průměrné CLV: <strong class="${data.avg_clv >= 0 ? 'pos' : 'bad'}">${data.avg_clv >= 0 ? '+' : ''}${pct(data.avg_clv)}</strong>
        <span class="muted">(z ${data.clv_n} sázek/noh) – ${data.avg_clv >= 0 ? 'bere lepší cenu, než byla těsně před výkopem' : 'bere horší cenu, než byla těsně před výkopem'}</span>
      </div>` : '';
    // pohyby na banku se ukážou i u sázkaře, co ještě nestihl vsadit
    if (!bets.length) {
      box.innerHTML = txHtml + clvHtml + breakdownHtml + '<div class="empty-state" style="padding:14px 0;">Zatím žádné sázky</div>';
      return;
    }
    box.innerHTML = txHtml + clvHtml + breakdownHtml + `<div class="table-wrap"><table>
      <thead><tr><th>Zápas</th><th>Kdy</th><th>Zápas stav</th><th>Tip</th><th>Kurz</th><th>Vklad</th><th>Sázka</th><th>P&L</th></tr></thead>
      <tbody>${bets.map(bt => `
        <tr${bt.legs ? ' class="ticket-row"' : ''}>
          <td>${bt.legs ? `<span class="muted">${bt.kind === 'combo' ? '🔗' : '🎫'}</span> ` : ''}${esc(bt.match)} ${bt.legs ? '' : tipsportBetLink(bt.match, bt.status, bt.tipsport)}</td>
          <td class="muted">${fmtWhen(bt.match_date, bt.match_time)}</td>
          <td>${matchStateHtml(bt.match_date, bt.match_time, bt.status, bt.result)}</td>
          <td>${bt.label}</td>
          <td>${bt.odds}×</td>
          <td>${fmt(bt.stake)} Kč</td>
          <td><span class="badge ${bt.status}">${bt.status.toUpperCase()}</span></td>
          <td class="${bt.status === 'open' ? 'muted' : bt.pnl > 0 ? 'pos' : 'bad'}">
            ${bt.status === 'open' ? '—' : `${bt.pnl > 0 ? '+' : ''}${fmt(bt.pnl)} Kč`}
          </td>
        </tr>
        ${bt.legs ? `<tr class="ticket-legs"><td colspan="8">
          ${bt.legs.map(l => `<div class="leg">
              <span class="leg-res ${l.result || ''}">${l.result === 'won' ? '✓' : l.result === 'lost' ? '✕' : l.result === 'void' ? '∅' : '·'}</span>
              <strong>${l.label}</strong>
              <span class="muted">${esc(l.match)}</span> ${tipsportBetLink(l.match, l.result ? 'settled' : 'open', l.tipsport)}
              <span class="muted">${l.odds}×</span>
              ${l.score ? `<span class="muted">${l.score.home}:${l.score.away}</span>` : ''}
            </div>`).join('')}
        </td></tr>` : ''}`).join('')}</tbody>
    </table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state" style="padding:14px 0;">Chyba: ${e.message}</div>`;
  }
}

/** Shrnutí posledního kola – toast zmizí, tohle zůstane, ať je z UI vidět,
 *  co se stalo, a nemusí se to dohledávat v datech. */
function renderRoundResult(data) {
  const box = el('roundResult');
  if (!box) return;
  const n = data.total_placed || 0;
  box.style.display = '';
  if (!n) {
    box.innerHTML = `<div style="font-size:12.5px; color:var(--txt2);">
      Poslední kolo (${fmtTime(Date.now() / 1000)}): <strong>nikdo nevsadil</strong> –
      sázkaři už mají vsazeno na všechno, co prošlo jejich prahy, a na stejný zápas
      podruhé nesází.</div>`;
    return;
  }
  const rows = (data.detail || []).map(d =>
    `<span class="pill info">${esc(d.name)} <strong>${d.count}×</strong> · ${fmt(d.staked)} Kč</span>`).join('');
  box.innerHTML = `
    <div style="font-size:12.5px; color:var(--txt2); margin-bottom:8px;">
      Poslední kolo (${fmtTime(Date.now() / 1000)}): vsazeno <strong>${n}</strong>
      ${n === 1 ? 'sázka' : n < 5 ? 'sázky' : 'sázek'} za <strong>${fmt(data.total_staked || 0)} Kč</strong>
      ${data.detail?.length ? `napříč ${data.detail.length} sázkaři` : ''}.
    </div>
    <div class="pill-row" style="margin:0;">${rows}</div>`;
}

async function runBettorsRound() {
  const btn = el('runBettorsBtn');
  btn.disabled = true;
  btn.textContent = 'Spouštím…';
  try {
    const data = await api('/api/bettors/run', { method: 'POST', timeoutMs: 60000 });
    const n = data.total_placed ?? Object.values(data.placed || {}).reduce((a, b) => a + b, 0);
    toast(n > 0
      ? `Vsazeno ${n} ${n === 1 ? 'sázka' : n < 5 ? 'sázky' : 'sázek'} za ${fmt(data.total_staked || 0)} Kč.`
      : 'Nikdo nevsadil – na co se dalo, už mají vsazeno.');
    renderRoundResult(data);
    renderBettors(data.bettors || []);
  } catch (e) {
    toast('Kolo sázení selhalo.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Spustit kolo teď';
  }
}

/** Vygeneruje nového sázkaře z nasbírané historie – najde nejvýnosnější
 *  segment (kurz/jistota/trh) napříč VŠEMI dosavadními sázkami arény.
 *  Backend vrátí created=false s důvodem, když je dat zatím málo. */
async function generateBettorFromData() {
  const btn = el('generateBettorBtn');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> Analyzuji…';
  try {
    const data = await api('/api/bettors/generate', { method: 'POST', timeoutMs: 20000 });
    if (!data.created) {
      const msgs = {
        not_enough_data: `Zatím málo dat – potřeba aspoň 40 vyhodnocených sázek, teď je jich ${data.have || 0}.`,
        not_enough_bucket_data: `Data jsou moc rozptýlená napříč kurzy/jistotou, žádný segment nemá dost vzorku.`,
        no_profitable_segment: `Ani nejlepší nalezený segment zatím není v plusu (ROI ${data.best_odds_roi ?? '?'} % / ${data.best_prob_roi ?? '?'} %) – radši nevytvářet ztrátového sázkaře.`,
      };
      toast(msgs[data.reason] || 'Zatím se nepodařilo najít ziskový segment.', 'info', 8000);
      return;
    }
    const all = data.all_created || [data];
    if (all.length > 1) {
      toast(`Vytvořeno ${all.length} sázkařů: ${all.map(x => x.bettor.name).join(', ')}`, 'ok', 8000);
    } else {
      toast(`Vytvořen sázkař „${data.bettor.name}" – ${data.tagline}`, 'ok', 8000);
    }
    loadBettors();
  } catch (e) {
    toast(`Generování selhalo: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ---------------------------------------------------------------------------
// NOTIFIKACE – čistě klientské (Notification API), appka nemá server push.
// Musí zůstat otevřená karta v prohlížeči; kontroluje se periodicky, dokud
// běží. Nový tip dne a nově vyhodnocené sázky agenta = jedno upozornění.
// ---------------------------------------------------------------------------
const NOTIF_SEEN_BETS_KEY = 'kurzanalytik_notif_seen_bets';
const NOTIF_LAST_TIP_KEY = 'kurzanalytik_notif_last_tip';
const NOTIF_BETTOR_EXTREMES_KEY = 'kurzanalytik_notif_bettor_extremes';
const NOTIF_AI_READY_KEY = 'kurzanalytik_notif_ai_ready';
const NOTIF_ENABLED_KEY = 'kurzanalytik_notif_enabled';
const NOTIF_POLL_MS = 3 * 60 * 1000;

// Hlavní vypínač - nezávislý na oprávnění prohlížeče (to jednou udělené
// jde odebrat jen v nastavení prohlížeče, appka to programově nezvládne).
// Bez tohohle přepínače by appka i po "zablokování" dál sypala aspoň
// záložní toast upozornění v okně - vypnuto/zapnuto default true, ať
// stávající uživatelé nepřijdou o dosavadní chování beze změny.
function notifikaceZapnute() {
  return localStorage.getItem(NOTIF_ENABLED_KEY) !== 'false';
}

/** Systemove notifikace prohlizec pousti jen v "zabezpecenem kontextu",
 *  cili na HTTPS nebo na localhostu. Server v domaci siti bezi na http://
 *  s IP adresou, takze je prohlizec zablokuje rovnou a povolit je NEJDE -
 *  ani v nastaveni. Proto mame vlastni upozorneni primo v aplikaci. */
function systemNotifMozne() {
  return ('Notification' in window) && window.isSecureContext;
}

function renderNotifStatus() {
  const box = el('notifStatus');
  const btn = el('notifEnableBtn');
  const toggle = el('cfgNotifEnabled');
  if (!box) return;

  if (toggle) toggle.checked = notifikaceZapnute();

  if (!notifikaceZapnute()) {
    box.innerHTML = '<span class="badge lost">VYPNUTO</span> Upozornění jsou vypnutá vypínačem výš – appka je nebude posílat, ani v okně.';
    if (btn) btn.style.display = 'none';
    return;
  }

  if (!('Notification' in window)) {
    box.textContent = 'Tenhle prohlížeč notifikace nepodporuje.';
    if (btn) btn.style.display = 'none';
    return;
  }

  if (!window.isSecureContext) {
    box.innerHTML = '<span class="badge won">V APLIKACI</span> ' +
      'Upozornění se zobrazují přímo tady v okně.<br>' +
      '<span class="muted">Systémové notifikace prohlížeč na adrese ' +
      `<code>${location.protocol}//${location.host}</code> blokuje – ` +
      'povoluje je jen na HTTPS nebo na <code>localhost</code>. ' +
      'Povolit je v nastavení prohlížeče proto nejde.</span>';
    if (btn) btn.style.display = 'none';
    return;
  }

  if (Notification.permission === 'granted') {
    box.innerHTML = '<span class="badge won">POVOLENO</span>';
    if (btn) { btn.textContent = 'Notifikace jsou zapnuté'; btn.disabled = true; }
  } else if (Notification.permission === 'denied') {
    box.innerHTML = '<span class="badge lost">ZABLOKOVÁNO</span> – povol je v nastavení prohlížeče pro tuhle stránku. ' +
      '<span class="muted">Do té doby se upozornění zobrazují v okně aplikace.</span>';
    if (btn) btn.style.display = 'none';
  } else {
    box.innerHTML = '<span class="badge open">NEPOVOLENO</span>';
  }
}

/** Kolik upozorneni prislo, kdyz se uzivatel dival jinam. Pise se do
 *  titulku karty, aby si toho vsiml i pri prepnute zalozce. */
let _notifNeprectene = 0;
const _titulekPuvodni = document.title;

function oznacTitulek() {
  document.title = _notifNeprectene ? `(${_notifNeprectene}) ${_titulekPuvodni}` : _titulekPuvodni;
}

function notify(title, body) {
  if (!notifikaceZapnute()) return;
  if (systemNotifMozne() && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: undefined }); return; } catch (e) { /* spadneme do zalozni cesty */ }
  }
  // Zalozni cesta: upozorneni v okne aplikace
  toast(`${title} – ${body}`, 'info', 12000);
  if (document.visibilityState !== 'visible') {
    _notifNeprectene++;
    oznacTitulek();
  }
}

async function pollForNotifications() {
  // Skrytá karta = neplýtvat ESPN. Tenhle poller je nejdražší v appce
  // (čtyři requesty co 3 minuty) a jako jediný si viditelnost nehlídal,
  // takže zapomenutá karta na pozadí tahala data donekonečna.
  if (document.visibilityState !== 'visible') return;
  // Bez podminky na opravneni - kdyz systemove notifikace nejdou,
  // notify() to zobrazi v okne aplikace.

  // Nový tip dne
  try {
    const d = await dashboardData();
    if (d.tip) {
      const key = `${d.tip.match}|${d.tip.name}`;
      if (localStorage.getItem(NOTIF_LAST_TIP_KEY) !== key) {
        localStorage.setItem(NOTIF_LAST_TIP_KEY, key);
        notify('💡 Nový tip dne', `${d.tip.match} – ${d.tip.name} @ ${d.tip.odds.toFixed(2)}× (${Math.round(d.tip.prob * 100)} %)`);
      }
    }
  } catch (e) { /* nic */ }

  // Nově vyhodnocené sázky agenta
  try {
    const a = await api('/api/agent', { timeoutMs: 20000 });
    const seen = new Set(JSON.parse(localStorage.getItem(NOTIF_SEEN_BETS_KEY) || '[]'));
    const settled = (a.bets || []).filter(b => b.status === 'won' || b.status === 'lost');
    const fresh = settled.filter(b => !seen.has(b.id));
    // první běh po zapnutí notifikací: jen si zapamatuj, co už je vyřešené,
    // neposílej notifikaci za celou historii najednou
    if (seen.size > 0) {
      for (const b of fresh.slice(0, 5)) {
        const sign = b.status === 'won' ? '✅' : '❌';
        notify(`${sign} Sázka vyhodnocena`, `${b.match} – ${b.label} (${b.status === 'won' ? '+' : ''}${fmt(b.pnl || 0)} Kč)`);
      }
    }
    localStorage.setItem(NOTIF_SEEN_BETS_KEY, JSON.stringify(settled.map(b => b.id)));
  } catch (e) { /* nic */ }

  // Nové maximum/minimum banku u sázkaře v aréně
  try {
    const bd = await api('/api/bettors', { timeoutMs: 20000 });
    const extremes = JSON.parse(localStorage.getItem(NOTIF_BETTOR_EXTREMES_KEY) || '{}');
    let changed = false;
    for (const b of bd.bettors || []) {
      const prev = extremes[b.id];
      if (!prev) {
        // první běh po zapnutí – jen zapamatovat, ne hned troubit
        extremes[b.id] = { max: b.balance, min: b.balance };
        changed = true;
        continue;
      }
      if (b.balance > prev.max) {
        notify('📈 Nové maximum banku', `${b.emoji} ${esc(b.name)} – ${fmt(b.balance)} Kč (dřívější max ${fmt(prev.max)} Kč)`);
        prev.max = b.balance;
        changed = true;
      } else if (b.balance < prev.min) {
        notify('📉 Nové minimum banku', `${b.emoji} ${esc(b.name)} – ${fmt(b.balance)} Kč (dřívější min ${fmt(prev.min)} Kč)`);
        prev.min = b.balance;
        changed = true;
      }
    }
    if (changed) localStorage.setItem(NOTIF_BETTOR_EXTREMES_KEY, JSON.stringify(extremes));
  } catch (e) { /* nic */ }

  // AI sázkaři – upozornit, když natrénovaný model přestane být použitelný
  // (typicky ztráta po redeployi bez zálohy) – jinak by AI Adam/Karel/Klára
  // jen tiše přestali sázet a nikdo by nevěděl proč.
  try {
    const st = await api('/api/bettors/ai-status', { timeoutMs: 15000 });
    const prevReady = localStorage.getItem(NOTIF_AI_READY_KEY);
    if (prevReady === 'true' && !st.model_ready) {
      notify('🤖 AI sázkaři nemají model', 'ML model přestal být natrénovaný – AI Adam/Karel/Klára teď nebudou sázet, dokud se znovu nepřetrénuje.');
    }
    localStorage.setItem(NOTIF_AI_READY_KEY, String(!!st.model_ready));
  } catch (e) { /* nic */ }
}

function setupNotifications() {
  renderNotifStatus();
  el('cfgNotifEnabled')?.addEventListener('change', (e) => {
    localStorage.setItem(NOTIF_ENABLED_KEY, String(e.target.checked));
    renderNotifStatus();
    toast(e.target.checked ? 'Upozornění zapnutá.' : 'Upozornění vypnutá.');
  });
  el('notifEnableBtn')?.addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('Prohlížeč notifikace nepodporuje.', 'err'); return; }
    const perm = await Notification.requestPermission();
    renderNotifStatus();
    if (perm === 'granted') {
      toast('Notifikace zapnuté.');
      pollForNotifications();
    }
  });
  // Poll bezi vzdy - kdyz systemove notifikace nejdou, notify() to
  // ukaze v okne aplikace, takze upozorneni nikdo neztrati.
  pollForNotifications();
  setInterval(pollForNotifications, NOTIF_POLL_MS);

  // po navratu do okna smazat pocitadlo v titulku
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { _notifNeprectene = 0; oznacTitulek(); }
  });
}

// ---------------------------------------------------------------------------
// ML LEARNING
// ---------------------------------------------------------------------------
const ML_STATUS_CZ = {
  no_data: 'Čeká na data', not_trained: 'Netrénováno',
  trained: 'Natrénováno', error: 'Chyba',
};

async function loadAgentBreakdown() {
  const box = el('agentBreakdownBox');
  if (!box) return;
  try {
    const bd = await api('/api/agent/breakdown', { timeoutMs: 20000 });
    box.className = '';
    const table = (rows, label) => {
      if (!rows || !rows.length) return '';
      return `
        <div class="perf-block">
          <div class="perf-title">${label}</div>
          <div class="perf-rows">
            ${rows.slice(0, 6).map(r => `
              <div class="perf-row">
                <span class="perf-key">${r.key}</span>
                <span class="perf-nums">
                  <span class="muted">${r.n}× · ${pct(r.win_rate)}</span>
                  <strong class="${r.pnl >= 0 ? 'pos' : 'bad'}">${r.pnl >= 0 ? '+' : ''}${fmt(r.pnl)} Kč</strong>
                  <span class="muted">${pct(r.roi)}</span>
                </span>
              </div>`).join('')}
          </div>
        </div>`;
    };
    const hasAny = (bd.sport?.length || bd.market?.length || bd.league?.length);
    box.innerHTML = hasAny ? `
      <div class="perf-grid">
        ${table(bd.sport, 'Podle sportu')}
        ${table(bd.market, 'Podle typu trhu')}
        ${table(bd.league, 'Top ligy')}
      </div>` : '<div class="empty-state" style="padding:10px 0;">Agent zatím nemá dost vyhodnocených sázek</div>';
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="empty-state">Rozklad se nepodařilo načíst</div>';
  }
}

async function loadMlLearning() {
  // Každá karta se načítá samostatně. Dřív viselo všechno na jednom awaitu
  // na /api/learning/stats – ten při větším množství sázek trvá přes 20 s,
  // spadl na timeout a zbytek stránky (benchmark, rizikový profil) se pak
  // nespustil vůbec a zůstaly tam navždy spinnery.
  loadBenchmarkTrend();
  loadRiskProfile();
  try {
    // 45 s: endpoint reálně běží ~25 s a s rostoucí historií to poroste
    const s = await api('/api/learning/stats', { timeoutMs: 45000 });
    setText('mlStatus', ML_STATUS_CZ[s.model_status] || s.model_status || '—');
    setText('mlTotal', s.total_bets ?? 0);
    // Číslo roste jen tak rychle, jak reálně končí zápasy – většina fronty
    // čeká na budoucí utkání. Bez týhle poznámky vypadá stejné číslo
    // napříč obnoveními jako zaseknuté, přitom je to legitimní stav.
    setText('mlTotalHint', s.pending_settlement ? `${fmt(s.pending_settlement)} čeká na výsledek zápasu` : '');
    setText('mlAccuracy', s.model_accuracy ? pct(s.model_accuracy * 100) : '—');
    setText('mlAuc', s.model_auc ? s.model_auc.toFixed(3).replace('.', ',') : '—');
    renderMlFeatures(s.feature_importance || {});
  } catch (e) {
    // Ať po neúspěchu nezůstane věčný spinner – řekni, co se stalo.
    const box = el('mlFeatures');
    if (box) {
      box.className = '';
      box.innerHTML = '<div class="empty-state">Statistiky modelu se nepodařilo načíst (výpočet trvá dlouho). Zkus obnovit stránku.</div>';
    }
    ['mlStatus', 'mlTotal', 'mlAccuracy', 'mlAuc'].forEach(id => { if (el(id) && el(id).textContent === '—') setText(id, '—'); });
    toast('Statistiky ML modelu se nepodařilo načíst.', 'err');
  }
}

/** Vývoj Brierova skóre modelu proti zavíracímu kurzu trhu.
 *  Endpoint /api/model/benchmark/history se plnil při každém benchmarku
 *  (i z denního cronu), ale nikdy se nikde nezobrazoval – takže nebylo
 *  poznat, jestli se model v čase zlepšuje, nebo degraduje. */
async function loadBenchmarkTrend() {
  const box = el('benchmarkTrend');
  if (!box) return;
  try {
    const d = await api('/api/model/benchmark/history', { timeoutMs: 15000 });
    const h = (d.history || []).filter(x => x.brier_model != null);
    box.className = '';
    if (h.length < 1) {
      box.innerHTML = `<div class="empty-state">
        Benchmark ještě neproběhl. Spustí se sám v denním retrainu, nebo ho
        pustíš ručně v Nastavení → „Porovnat s trhem".</div>`;
      return;
    }
    const posl = h[h.length - 1];
    const lepsi = posl.brier_model < posl.brier_market;
    // graf jen když je co srovnávat (aspoň dva body)
    let graf = '';
    if (h.length >= 2) {
      const W = 760, H = 200, padX = 46, padY = 20;
      const pw = W - 2 * padX, ph = H - 2 * padY;
      const vals = h.flatMap(x => [x.brier_model, x.brier_market]);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const rozsah = (hi - lo) || 0.01;
      const X = i => padX + (h.length === 1 ? pw / 2 : i * pw / (h.length - 1));
      const Y = v => padY + ph - ((v - lo) / rozsah) * ph;
      const cesta = (klic) => h.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(x[klic]).toFixed(1)}`).join('');
      const body = (klic, barva) => h.map((x, i) =>
        `<circle cx="${X(i).toFixed(1)}" cy="${Y(x[klic]).toFixed(1)}" r="3" fill="${barva}">
           <title>${x.ts ? new Date(x.ts * 1000).toLocaleDateString('cs-CZ') : ''} · ${klic === 'brier_model' ? 'model' : 'trh'} ${czNum(x[klic], 3)}</title>
         </circle>`).join('');
      graf = `
        <div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" class="chart">
          <text x="${padX - 8}" y="${padY + 4}" text-anchor="end" font-size="10" fill="var(--txt3)">${czNum(hi, 3)}</text>
          <text x="${padX - 8}" y="${padY + ph}" text-anchor="end" font-size="10" fill="var(--txt3)">${czNum(lo, 3)}</text>
          <path d="${cesta('brier_market')}" stroke="var(--blue)" stroke-width="2" fill="none" stroke-dasharray="5,4"/>
          <path d="${cesta('brier_model')}" stroke="${lepsi ? 'var(--pos)' : 'var(--bad)'}" stroke-width="2.5" fill="none"/>
          ${body('brier_market', 'var(--blue)')}${body('brier_model', lepsi ? 'var(--pos)' : 'var(--bad)')}
        </svg></div>
        <div class="bench-legend">
          <span><i style="background:${lepsi ? 'var(--pos)' : 'var(--bad)'}"></i> model</span>
          <span><i class="dash" style="background:var(--blue)"></i> trh (Pinnacle)</span>
          <span class="muted">${h.length} měření · níž = přesnější</span>
        </div>`;
    }
    const rozdil = posl.brier_model - posl.brier_market;
    box.innerHTML = `
      ${graf}
      <div class="rec-list" style="margin-top:${graf ? '12px' : '0'};">
        <div class="rec-row">
          <span class="rec-label">Poslední měření</span>
          <span class="rec-val">model <b class="${lepsi ? 'pos' : 'bad'}">${czNum(posl.brier_model, 3)}</b>
            <span class="muted" style="font-weight:400;">vs trh ${czNum(posl.brier_market, 3)}
            (z ${fmt(posl.matches)} zápasů)</span></span>
        </div>
        <div class="rec-row">
          <span class="rec-label">Rozdíl proti trhu</span>
          <span class="rec-val ${lepsi ? 'pos' : 'bad'}">
            ${czNum(Math.abs(rozdil), 4)} ${lepsi ? 'lepší' : 'horší'}
          </span>
        </div>
        ${h.length >= 2 ? (() => {
          // Posun proti minulému měření. Menší Brier = lepší, takže záporná
          // změna je dobrá zpráva – bez tohohle řádku by "-0,047" vypadalo
          // jako zhoršení.
          const zmena = posl.brier_model - h[h.length - 2].brier_model;
          const lepsiNez = zmena < 0;
          return `<div class="rec-row">
            <span class="rec-label">Oproti minulému měření</span>
            <span class="rec-val ${lepsiNez ? 'pos' : zmena > 0 ? 'bad' : ''}">
              ${Math.abs(zmena) < 0.0005 ? 'beze změny'
                : `${czNum(Math.abs(zmena), 4)} ${lepsiNez ? 'lepší ↓' : 'horší ↑'}`}
            </span>
          </div>`;
        })() : ''}
      </div>
      <p class="muted" style="font-size:12px; margin:10px 0 0; max-width:82ch;">
        ${lepsi
          ? 'Model je přesnější než zavírací kurz trhu – to je vzácné a znamená to skutečnou výhodu.'
          : 'Model je zatím <strong>méně přesný než trh</strong>. Value, kterou hlásí, je proto spíš šum než výhoda – dokud se rozdíl nesrovná, dává smysl držet přísné filtry a malé sázky.'}
      </p>`;
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="empty-state">Vývoj benchmarku se nepodařilo načíst.</div>';
  }
}

/** Max. propad banku a Sharpe – kolik rizika si agent vybral za své ROI.
 *  Data z /api/backtest/agent-vs-manual, které se dosud nikde nevolalo. */
async function loadRiskProfile() {
  const box = el('riskProfile');
  if (!box) return;
  try {
    const d = await api('/api/backtest/agent-vs-manual', { timeoutMs: 20000 });
    const a = (d.results || {}).agent || {};
    box.className = '';
    if (!a.total_bets) {
      box.innerHTML = '<div class="empty-state">Zatím žádné vyhodnocené sázky agenta.</div>';
      return;
    }
    const dd = a.max_drawdown || 0;
    const sh = a.sharpe_ratio || 0;
    box.innerHTML = `
      <div class="grid-stats">
        <div class="stat-tile">
          <div class="label">Max. propad banku</div>
          <div class="value ${dd > 30 ? 'bad' : ''}">${pct(dd)}</div>
          <div class="hint">nejhorší pokles od vrcholu</div>
        </div>
        <div class="stat-tile">
          <div class="label">Sharpe ratio</div>
          <div class="value ${sh >= 0 ? 'pos' : 'bad'}">${czNum(sh, 2)}</div>
          <div class="hint">výnos na jednotku kolísání</div>
        </div>
        <div class="stat-tile">
          <div class="label">Vyhodnocených sázek</div>
          <div class="value">${a.total_bets}</div>
          <div class="hint">${a.wins || 0} výher · ${a.losses || 0} proher${a.voids ? ` · ${a.voids} void` : ''}</div>
        </div>
      </div>
      <p class="muted" style="font-size:12px; margin:12px 0 0; max-width:82ch;">
        <strong>Max. propad</strong> říká, o kolik bank spadl z nejvyššího bodu – ${pct(dd)}
        ${dd > 30 ? 'je hodně, takový propad se těžko vysedí.' : 'je zvládnutelné.'}
        <strong>Sharpe</strong> pod nulou znamená, že kolísání nebylo vykoupené výnosem;
        nad 1 se považuje za dobrý poměr.
      </p>`;
  } catch (e) {
    box.className = '';
    box.innerHTML = '<div class="empty-state">Rizikový profil se nepodařilo načíst.</div>';
  }
}

function renderMlFeatures(importance) {
  const box = el('mlFeatures');
  box.className = '';
  const entries = Object.entries(importance).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { box.innerHTML = '<div class="empty-state">Model ještě není natrénovaný</div>'; return; }
  const max = entries[0][1] || 1;
  box.innerHTML = entries.map(([name, val]) => `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
      <span style="width:150px; font-size:12px; color:var(--txt2); flex-shrink:0;">${name}</span>
      <div style="flex:1; background:var(--panel-2); border-radius:4px; height:8px; overflow:hidden;">
        <div style="width:${Math.max(2, val / max * 100)}%; height:100%; background:var(--accent);"></div>
      </div>
      <span style="width:55px; text-align:right; font-size:11.5px; color:var(--txt3);">${pct(val * 100)}</span>
    </div>`).join('');
}

async function loadBacktest() {
  const box = el('backtestBox');
  if (!box) return;
  try {
    const [best, worst, odds] = await Promise.all([
      api('/api/backtest/best-leagues', { timeoutMs: 20000 }).catch(() => ({ results: {} })),
      api('/api/backtest/worst-leagues', { timeoutMs: 20000 }).catch(() => ({ results: {} })),
      api('/api/backtest/odds-ranges', { timeoutMs: 20000 }).catch(() => ({ results: {} })),
    ]);
    const rows = (obj, label) => Object.entries(obj.results || {})
      .map(([k, v]) => `<tr>
          <td>${k}</td>
          <td class="${v.pnl >= 0 ? 'pos' : 'bad'}">${v.pnl >= 0 ? '+' : ''}${fmt(v.pnl)} Kč</td>
          <td>${pct(v.roi)}</td>
          <td>${pct(v.win_rate)}</td>
          <td>${v.total_bets}</td>
        </tr>`).join('') || `<tr><td colspan="5" class="muted">Zatím málo dat</td></tr>`;
    const tbl = (title, obj) => `
      <h4 style="margin:14px 0 6px; font-size:13px;">${title}</h4>
      <div class="table-wrap"><table>
        <thead><tr><th>${title.includes('kurz') ? 'Pásmo kurzu' : 'Liga'}</th><th>Zisk</th><th>ROI</th><th>Win rate</th><th>Sázek</th></tr></thead>
        <tbody>${rows(obj)}</tbody></table></div>`;
    box.className = '';
    box.innerHTML = tbl('Nejlepší ligy', best) + tbl('Nejhorší ligy', worst)
      + tbl('Podle pásma kurzu', odds)
      + `<p style="font-size:11.5px; color:var(--txt3); margin:10px 0 0;">
           Řádky s pár sázkami jsou šum – ROI potřebuje desítky vyhodnocených sázek.</p>`;
  } catch (e) {
    box.className = '';
    box.innerHTML = `<div class="empty-state">Rozbor se nepodařilo načíst: ${e.message}</div>`;
  }
}

async function retrainMlModel() {
  const btn = el('retrainMlBtn');
  btn.disabled = true;
  btn.textContent = 'Trénuji…';
  try {
    const data = await api('/api/learning/train', { method: 'POST', timeoutMs: 30000 });
    toast(data.success ? 'Model přetrénován.' : (data.message || 'Nedostatek dat pro trénink.'), data.success ? 'ok' : 'err');
    if (data.stats) {
      setText('mlStatus', ML_STATUS_CZ[data.stats.model_status] || data.stats.model_status || '—');
      setText('mlTotal', data.stats.total_bets ?? 0);
      setText('mlAccuracy', data.stats.model_accuracy ? pct(data.stats.model_accuracy * 100) : '—');
      setText('mlAuc', data.stats.model_auc ? data.stats.model_auc.toFixed(3).replace('.', ',') : '—');
      renderMlFeatures(data.stats.feature_importance || {});
    }
  } catch (e) {
    toast(`Trénink selhal: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Přetrénovat teď';
  }
}

/* ---------------------------------------------------------------- */
/* Světlé / tmavé téma                                              */
/* ---------------------------------------------------------------- */

/** Volba se drží v localStorage, takže je per zařízení – na mobilu
 *  můžeš mít světlé a na serveru tmavé. "auto" znamená řídit se
 *  systémem; atribut se pak nesmí nastavit vůbec, aby platila
 *  media query v CSS. */
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.dataset.theme = mode;
  } else {
    delete document.documentElement.dataset.theme;
  }
  document.querySelectorAll('#themePick button').forEach(b => {
    b.classList.toggle('on', b.dataset.themeSet === mode);
  });
}

function currentTheme() {
  try {
    const t = localStorage.getItem('theme');
    return (t === 'light' || t === 'dark') ? t : 'auto';
  } catch (e) { return 'auto'; }
}

function setupTheme() {
  applyTheme(currentTheme());
  document.querySelectorAll('#themePick button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.themeSet;
      try {
        if (mode === 'auto') localStorage.removeItem('theme');
        else localStorage.setItem('theme', mode);
      } catch (e) {}
      applyTheme(mode);
    });
  });
}

// ---------------------------------------------------------------------------
// Doporučené sázky
// ---------------------------------------------------------------------------
const DOP_PASMA = {
  tutovka: { stitek: 'Tutovka', trida: 'dop-tutovka',
             popis: 'Nejvyšší jistota, jakou model dnes nabízí.' },
  hodnota: { stitek: 'Hodnota', trida: 'dop-hodnota',
             popis: 'Kurz sázkovky je vyšší, než odpovídá odhadu modelu.' },
  solidni: { stitek: 'Solidní', trida: 'dop-solidni',
             popis: 'Nadprůměrná šance, ale bez výrazného náskoku proti kurzu.' },
};

async function loadDoporucene() {
  const box = el('dopVypis');
  const stav = el('dopStatus');
  if (!box) return;
  box.innerHTML = '<div class="empty-state">Načítám…</div>';
  if (stav) stav.textContent = 'počítám…';
  const prah = el('dopPrah')?.value || '0.55';
  const live = el('dopLive')?.checked ? '1' : '0';
  const dnu = el('dopDnu')?.value || '3';
  let d;
  try {
    d = await api(`/api/recommended?min_prob=${prah}&live=${live}&days=${dnu}`, { timeoutMs: 180000 });
  } catch (e) {
    box.innerHTML = `<div class="card"><div class="empty-state">Nepodařilo se načíst doporučení: ${escAttr(e.message)}</div></div>`;
    if (stav) stav.textContent = '';
    return;
  }
  vykresliDoporucene(d);
}

function vykresliDoporucene(d) {
  const box = el('dopVypis');
  const stav = el('dopStatus');
  const tipy = d.tips || [];
  if (stav) {
    stav.textContent = `posouzeno ${d.posuzovano} zápasů · prošlo ${d.prosla}`;
  }
  if (d.error) {
    box.innerHTML = `<div class="card"><div class="empty-state">Predikce se nepodařilo spočítat: ${escAttr(d.error)}</div></div>`;
    return;
  }
  const trychtyr = dopTrychtyrHtml(d);
  if (!tipy.length) {
    // Prázdno je legitimní výsledek, ne chyba – ale musí být poznat, kde
    // přesně se zápasy ztratily, jinak to vypadá jako porucha appky.
    const duvod = d.posuzovano
      ? `Ani jeden zápas neprošel až na konec. Nejčastější důvod není přísná laťka,
         ale chybějící kurzy sázkovky – rozpis níž ukazuje, kde se to láme.`
      : 'V tomhle okně nejsou žádné nadcházející zápasy. Zkus prodloužit horizont.';
    box.innerHTML = `${trychtyr}<div class="card"><div class="empty-state">${duvod}</div></div>`;
    return;
  }
  const radky = tipy.map(dopKartaHtml).join('');
  box.innerHTML = `
    ${trychtyr}
    <div class="card dop-legenda">
      <span class="muted">Zobrazují se jen tipy s pravděpodobností aspoň ${pct(d.min_prob * 100, 0)}
      a nezápornou očekávanou hodnotou. Jeden tip na zápas – víc trhů z jednoho utkání
      není víc příležitostí, jen víc řádků na tentýž výsledek.</span>
    </div>
    <div class="dop-mrizka">${radky}</div>`;
}

/** Kam se poděly zápasy – bez tohohle rozpisu vypadá prázdná karta jako chyba. */
function dopTrychtyrHtml(d) {
  const t = d.trychtyr;
  if (!t) return '';
  const kroky = [
    ['nadcházející zápasy', t.neodehranych, null],
    ['mají kurzy sázkovky', t.s_kurzy, 'appka kurzy nikdy nevymýšlí – bez kurzu sázkovky se nedá spočítat výhodnost'],
    [`šance ≥ ${pct(d.min_prob * 100, 0)}`, t.po_prob, 'model u zápasu nenašel dost pravděpodobný výsledek'],
    ['a zároveň kladná hodnota', t.doporuceno, 'kurz nepokrývá riziko – dlouhodobě ztrátový tip'],
  ];
  const html = kroky.map(([jmeno, n, tip], i) => {
    const pred = i > 0 ? kroky[i - 1][1] : null;
    const ztrata = pred !== null && pred > n ? `<span class="dop-ztrata">−${pred - n}</span>` : '';
    return `<div class="dop-krok"${tip ? ` title="${escAttr(tip)}"` : ''}>
      <span class="dop-krok-n">${n}</span>
      <span class="dop-krok-jmeno">${jmeno}</span>
      ${ztrata}
    </div>`;
  }).join('<span class="dop-sipka">›</span>');
  return `<div class="card dop-trychtyr"><div class="dop-kroky">${html}</div></div>`;
}

function dopKartaHtml(t) {
  const p = DOP_PASMA[t.pasmo] || DOP_PASMA.solidni;
  const zisk = ((t.odds - 1) * 100).toFixed(0);
  const dnes = new Date().toISOString().slice(0, 10);
  const den = t.date === dnes ? 'dnes'
    : (t.date ? new Date(t.date + 'T00:00:00').toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' }) : '');
  const cas = t.live
    ? `<span class="dop-live">🔴 ŽIVĚ${t.minute ? ' ' + escAttr(t.minute) : ''}</span>`
    : `<span class="muted">${escAttr(den)}${t.time ? ' ' + escAttr(t.time) : ''}</span>`;
  const skore = t.live && t.score ? ` <strong>${escAttr(t.score)}</strong>` : '';
  // EV nad 1 = dlouhodobě ziskový tip; pod 1 se sem vůbec nedostane.
  const evText = t.ev >= 1.06
    ? `<span class="dop-ev-plus">EV ${czNum(t.ev, 2)}× – kurz je štědřejší, než odpovídá odhadu</span>`
    : `<span class="muted">EV ${czNum(t.ev, 2)}×</span>`;
  return `
    <div class="card dop-karta ${p.trida}">
      <div class="dop-hlava">
        <span class="dop-pasmo" title="${escAttr(p.popis)}">${p.stitek}</span>
        ${cas}${skore}
        ${tipsportBadge(t.home, t.tipsport, { short: true })}
      </div>
      <div class="dop-zapas">${escAttr(t.match)}</div>
      <div class="dop-liga muted">${escAttr(t.league || '')}</div>
      <div class="dop-tip">
        <span class="dop-nazev">${escAttr(t.name)}</span>
        <span class="dop-kurz">@ ${czNum(t.odds, 2)}</span>
      </div>
      <div class="dop-metriky">
        <div><span class="dop-cislo">${pct(t.prob * 100, 0)}</span><span class="muted">šance dle modelu</span></div>
        <div><span class="dop-cislo">+${zisk} %</span><span class="muted">výnos při výhře</span></div>
      </div>
      <div class="dop-paticka">${evText}</div>
    </div>`;
}

function setupDoporucene() {
  el('dopReload')?.addEventListener('click', loadDoporucene);
  el('dopPrah')?.addEventListener('change', loadDoporucene);
  el('dopDnu')?.addEventListener('change', loadDoporucene);
  el('dopLive')?.addEventListener('change', loadDoporucene);
}

// ---------------------------------------------------------------------------
// Kalibrace modelu na dashboardu – "říká model pravdu?"
// ---------------------------------------------------------------------------
/* Sdílená odpověď /api/dashboard.
   Endpoint umí při studené keši stahovat ESPN synchronně (viz komentář
   u api_dashboard v app.py), takže se nesmí volat víckrát za sebou. Tip
   dne, kalibrace i notifikační poller ho chtějí ve stejnou chvíli – tahle
   promise-keš zajistí, že po síti odejde jen jeden požadavek. */
let _dashboardPromise = null;
let _dashboardTs = 0;
const DASHBOARD_TTL_MS = 30 * 1000;

function dashboardData({ force = false } = {}) {
  const ted = Date.now();
  if (force || !_dashboardPromise || ted - _dashboardTs > DASHBOARD_TTL_MS) {
    _dashboardTs = ted;
    _dashboardPromise = api('/api/dashboard', { timeoutMs: 90000 })
      .catch(e => { _dashboardPromise = null; throw e; });
  }
  return _dashboardPromise;
}

async function loadKalibrace() {
  const card = el('kalibraceCard');
  const box = el('kalibraceContent');
  if (!card || !box) return;
  let d;
  try {
    d = await dashboardData();
  } catch (e) {
    card.style.display = 'none';
    return;
  }
  const k = d.kalibrace;
  if (!k || (!k.aktualni.n && !k.predchozi.n)) { card.style.display = 'none'; return; }
  card.style.display = 'block';

  const casti = [];
  if (k.aktualni.dost_dat) {
    casti.push(kalibraceEraHtml(k.aktualni, 'Současný model', true));
  } else {
    // Malý vzorek se nesmí tvářit jako výsledek – jedna dvě sázky umí
    // ukázat 0 % i 100 % a obojí neznamená nic.
    casti.push(`<div class="kal-cekani">
      Současný model má zatím <strong>${k.aktualni.n}</strong> ${czSazek(k.aktualni.n)}
      z potřebných ${k.min_celkem}. Do té doby se o jeho poctivosti nedá říct nic –
      jakékoli číslo z tak malého vzorku by bylo náhoda.
    </div>`);
  }
  if (k.predchozi.n) {
    casti.push(kalibraceEraHtml(k.predchozi, 'Předchozí model (vyřazený)', false));
  }
  box.innerHTML = casti.join('');
}

function czSazek(n) {
  if (n === 1) return 'sázku';
  if (n >= 2 && n <= 4) return 'sázky';
  return 'sázek';
}

function kalibraceEraHtml(era, nadpis, aktualni) {
  const radky = era.pasma.map(p => {
    // Rozdíl proti realitě: kladný = model si věřil víc, než na co měl.
    const rozdil = p.tvrdil - p.realne;
    const smer = rozdil > 5 ? 'kal-preceni' : (rozdil < -5 ? 'kal-podceni' : 'kal-sedi');
    const komentar = rozdil > 5 ? 'přeceňuje se' : (rozdil < -5 ? 'podceňuje se' : 'sedí');
    return `
      <tr class="${smer}">
        <td>${Math.round(p.od * 100)}–${Math.round(p.do * 100)} %</td>
        <td class="kal-num">${pct(p.tvrdil, 0)}</td>
        <td class="kal-num">${pct(p.realne, 0)}</td>
        <td class="kal-num muted">${p.vyhry}/${p.n}</td>
        <td class="kal-koment">${komentar}</td>
      </tr>`;
  }).join('');

  const shrnuti = era.uspesnost !== null
    ? `${era.vyhry} z ${era.n} vyhráno (${pct(era.uspesnost, 1)})`
    : 'zatím bez vyhodnocených sázek';

  return `
    <div class="kal-era ${aktualni ? 'kal-era-aktualni' : 'kal-era-stara'}">
      <div class="kal-hlava">
        <strong>${nadpis}</strong>
        <span class="muted">${shrnuti}</span>
      </div>
      ${era.pasma.length ? `
      <table class="kal-tabulka">
        <thead><tr>
          <th>pásmo</th><th class="kal-num">model tvrdil</th><th class="kal-num">reálně</th>
          <th class="kal-num">poměr</th><th></th>
        </tr></thead>
        <tbody>${radky}</tbody>
      </table>` : '<div class="muted" style="font-size:12px;">Žádné pásmo nemá dost sázek na vyhodnocení.</div>'}
    </div>`;
}

// ---------------------------------------------------------------------------
// Zdraví appky – jedno místo, kde je vidět, že se něco pokazilo
// ---------------------------------------------------------------------------
/* Appka umí tiše prodělávat: bank spadl z 200 na 57 Kč a model se proti trhu
   zhoršoval několik měření po sobě, aniž by na to rozhraní kdekoli upozornilo.
   Uživatel si to musel poskládat z pěti různých stránek. Tenhle panel dělá
   tu skládačku za něj – čistě nad daty, která dashboard stahuje tak jako tak,
   takže nepřidává jediný požadavek navíc. */

const ZDRAVI_KONTROLY = [
  {
    id: 'model-horsi-nez-trh',
    test: ({ bench }) => {
      if (!bench || bench.length < 1) return null;
      const p = bench[bench.length - 1];
      if (p.brier_model == null || p.brier_market == null) return null;
      const rozdil = p.brier_model - p.brier_market;
      if (rozdil <= 0) return null;   // model je lepší než trh – v pořádku
      // Zhoršuje se, když poslední tři měření rostou (vyšší Brier = horší).
      const posledni = bench.slice(-3).map(x => x.brier_model).filter(v => v != null);
      const zhorsuje = posledni.length === 3 && posledni[0] < posledni[1] && posledni[1] < posledni[2];
      return {
        vazne: zhorsuje,
        nadpis: zhorsuje
          ? 'Model se proti trhu zhoršuje'
          : 'Model je méně přesný než sázkovka',
        popis: `Brierovo skóre modelu ${czNum(p.brier_model, 3)} proti ${czNum(p.brier_market, 3)} u trhu`
          + (zhorsuje ? ' – a poslední tři měření se zhoršují.' : '.')
          + ' Dokud je model horší než trh, jsou akumulátory vypnuté, protože by chybu jen umocnily.',
        akce: 'Ukázat benchmark', kam: 'learning',
      };
    },
  },
  {
    id: 'agent-nesazi',
    test: ({ agent }) => {
      const st = agent?.stats || {};
      if (agent?.settings?.enabled === false) {
        return { vazne: false, nadpis: 'Agent je vypnutý',
                 popis: 'Nesází a nesbírá data. Zapnout jde v Nastavení.',
                 akce: 'Otevřít nastavení', kam: 'settings' };
      }
      if (!st.open && !st.placed) {
        return { vazne: false, nadpis: 'Agent zatím nevsadil nic',
                 popis: 'Buď nic neprošlo filtry, nebo chybí zápasy s reálnými kurzy.',
                 akce: 'Zjistit proč', kam: 'doporucene' };
      }
      return null;
    },
  },
  {
    id: 'bank-pod-polovinou',
    test: ({ agent }) => {
      const st = agent?.stats || {};
      const bal = agent?.balance;
      const start = agent?.settings?.start_balance ?? bal?.start_balance;
      const ted = bal?.balance ?? bal?.current;
      if (start == null || ted == null || start <= 0) return null;
      const podil = ted / start;
      if (podil >= 0.5) return null;
      return {
        vazne: podil < 0.25,
        nadpis: `Bank je na ${Math.round(podil * 100)} % počátečního stavu`,
        popis: `Zbývá ${czNum(ted, 2)} Kč z ${czNum(start, 2)} Kč`
          + (st.roi != null ? `, ROI ${pct(st.roi)}` : '') + '.',
        akce: 'Rozebrat, kde se ztrácí', kam: 'bankroll',
      };
    },
  },
  {
    id: 'vyhodnocovani-chyba',
    test: ({ settle }) => {
      if (!settle?.last_error) return null;
      return {
        vazne: true, nadpis: 'Vyhodnocování výsledků hlásí chybu',
        popis: String(settle.last_error).split('\n')[0].slice(0, 160),
        akce: 'Otevřít živý log', kam: 'log',
      };
    },
  },
  {
    id: 'model-netrenovan',
    test: ({ ml }) => {
      const kdy = ml?.last_trained;
      if (!kdy) return null;
      const dnu = (Date.now() - new Date(kdy).getTime()) / 86400000;
      if (!(dnu > 7)) return null;
      return {
        vazne: false, nadpis: `ML model se netrénoval ${Math.floor(dnu)} dní`,
        popis: 'Nové vyhodnocené sázky se do něj zatím nepromítly.',
        akce: 'Přetrénovat', kam: 'learning',
      };
    },
  },
];

async function loadZdravi() {
  const card = el('zdraviCard');
  const box = el('zdraviContent');
  if (!card || !box) return;

  // Vše z endpointů, které dashboard volá tak jako tak – žádný požadavek navíc.
  const [agent, settle, bench, ml] = await Promise.all([
    api('/api/agent', { timeoutMs: 30000 }).catch(() => null),
    api('/api/settle/status', { timeoutMs: 15000 }).catch(() => null),
    api('/api/model/benchmark/history', { timeoutMs: 15000 }).catch(() => null),
    api('/api/learning/stats', { timeoutMs: 45000 }).catch(() => null),
  ]);

  const kontext = { agent, settle, ml, bench: bench?.history || bench };
  const nalezy = [];
  for (const k of ZDRAVI_KONTROLY) {
    try {
      const r = k.test(kontext);
      if (r) nalezy.push({ ...r, id: k.id });
    } catch (e) { /* jedna vadná kontrola nesmí shodit celý panel */ }
  }

  if (!nalezy.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  card.classList.toggle('je-vazne', nalezy.some(n => n.vazne));

  box.innerHTML = nalezy.map(n => `
    <div class="zdravi-radek">
      <span class="zdravi-ikona">${n.vazne ? '🔴' : '🟡'}</span>
      <div class="zdravi-text">
        <div class="zdravi-nadpis">${esc(n.nadpis)}</div>
        <div class="zdravi-popis">${esc(n.popis)}</div>
        ${n.kam ? `<button class="zdravi-akce" data-kam="${esc(n.kam)}">${esc(n.akce)} →</button>` : ''}
      </div>
    </div>`).join('');

  box.querySelectorAll('.zdravi-akce').forEach(b => {
    b.addEventListener('click', () => goToPage(b.dataset.kam));
  });
}

// ---------------------------------------------------------------------------
// Výkon agenta po ligách (data z /api/agent → league_stats)
// ---------------------------------------------------------------------------
/* Backend tuhle tabulku počítal a posílal při KAŽDÉM volání /api/agent
   (což je pětkrát na různých místech), ale frontend ji nikdy nevykreslil –
   řetězec 'league_stats' se v app.js nevyskytoval ani jednou. */
const LIGY_MIN_VZOREK = 5;   // pod tímhle je ROI náhoda, ne vzorec

async function loadLigyVykon() {
  const box = el('ligyVykon');
  if (!box) return;
  let d;
  try {
    d = await api('/api/agent', { timeoutMs: 30000 });
  } catch (e) {
    chybaKarty('ligyVykon', 'Výkon po ligách se nepodařilo načíst.', loadLigyVykon);
    return;
  }
  const ligy = Object.entries(d.league_stats || {})
    .filter(([, v]) => v.settled > 0)
    .sort((a, b) => b[1].pnl - a[1].pnl);

  box.className = '';
  if (!ligy.length) {
    box.innerHTML = '<div class="empty-state">Zatím žádné vyhodnocené sázky.</div>';
    setText('ligySouhrn', '');
    return;
  }

  const ztratove = ligy.filter(([, v]) => v.settled >= LIGY_MIN_VZOREK && v.roi < 0);
  setText('ligySouhrn', ztratove.length
    ? `${ztratove.length} ligy ke zvážení`
    : `${ligy.length} soutěží`);

  box.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Soutěž</th><th class="num">Vyhodnoceno</th><th class="num">Úspěšnost</th>
          <th class="num">P&amp;L</th><th class="num">ROI</th><th></th>
        </tr></thead>
        <tbody>${ligy.map(([jm, v]) => {
          const slabá = v.settled >= LIGY_MIN_VZOREK && v.roi < 0;
          return `<tr>
            <td>${esc(jm)}</td>
            <td class="num">${v.settled}</td>
            <td class="num">${pct(v.win_rate)}</td>
            <td class="num ${v.pnl >= 0 ? 'pos' : 'bad'}">${v.pnl >= 0 ? '+' : ''}${czNum(v.pnl, 2)}&nbsp;Kč</td>
            <td class="num ${v.roi >= 0 ? 'pos' : 'bad'}">${pct(v.roi)}</td>
            <td>${slabá ? '<span class="pill warn" title="Aspoň 5 vyhodnocených sázek a záporné ROI – zvaž vypnutí této ligy">zvaž vypnout</span>' : ''}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Export do CSV
// ---------------------------------------------------------------------------
/* Záloha do JSON je na obnovu, ne na práci s daty. Kdo si chce sázky
   prohnat Excelem, potřeboval dosud opisovat z obrazovky.
   Středník jako oddělovač a BOM na začátku jsou kvůli českému Excelu –
   bez nich rozhodí diakritiku a všechno nacpe do jednoho sloupce. */
function stahniCsv(nazev, sloupce, radky) {
  const uvozovka = v => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const obsah = '\uFEFF'
    + sloupce.map(c => uvozovka(c.nadpis)).join(';') + '\n'
    + radky.map(r => sloupce.map(c => uvozovka(c.hodnota(r))).join(';')).join('\n');
  const blob = new Blob([obsah], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nazev;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Staženo: ${nazev}`);
}

/* České datum z unixového času – v CSV nemá smysl posílat epoch. */
function csvDatum(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' });
}

async function exportSazekCsv() {
  let d;
  try {
    d = await api('/api/bankroll?limit=0', { timeoutMs: 60000 });
  } catch (e) {
    toast('Export selhal: ' + e.message, 'err');
    return;
  }
  const bets = d.bets || [];
  if (!bets.length) { toast('Není co exportovat.', 'err'); return; }
  stahniCsv('kurzanalytik-sazky.csv', [
    { nadpis: 'Vsazeno',   hodnota: b => csvDatum(b.ts) },
    { nadpis: 'Zápas',     hodnota: b => b.match },
    { nadpis: 'Soutěž',    hodnota: b => b.league },
    { nadpis: 'Sport',     hodnota: b => b.sport },
    { nadpis: 'Výkop',     hodnota: b => `${b.match_date || ''} ${b.match_time || ''}`.trim() },
    { nadpis: 'Tip',       hodnota: b => b.label },
    { nadpis: 'Trh',       hodnota: b => b.market },
    { nadpis: 'Kurz',      hodnota: b => b.odds },
    { nadpis: 'Jistota %', hodnota: b => b.prob != null ? Math.round(b.prob * 100) : '' },
    { nadpis: 'Vklad Kč',  hodnota: b => b.stake },
    { nadpis: 'Stav',      hodnota: b => ({ won: 'výhra', lost: 'prohra', open: 'otevřená', void: 'zrušená' }[b.status] || b.status) },
    { nadpis: 'P&L Kč',    hodnota: b => b.pnl },
    { nadpis: 'CLV',       hodnota: b => b.clv ?? '' },
    { nadpis: 'Vyhodnoceno', hodnota: b => csvDatum(b.settled_ts) },
  ], bets);
}
