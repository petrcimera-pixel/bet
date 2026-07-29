// ============================================================================
// KurzAnalytik v3 — Frontend (kompletně přepsáno)
// ============================================================================

const STATE = { page: 'dashboard', sport: 'soccer', date: todayStr(), statusFilter: 'all', lastMatchesData: null, lastBetMap: {} };

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupMobileMenu();
  buildDateStrip();
  bindEvents();
  loadDashboard();
  setupNotifications();
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
function fmt(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(num);
}
function pct(num, digits = 1) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return num.toFixed(digits) + '%';
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

function toast(msg, kind = 'ok') {
  const box = el('toast');
  const item = document.createElement('div');
  item.className = `toast-item ${kind}`;
  item.textContent = msg;
  box.appendChild(item);
  setTimeout(() => item.remove(), 4000);
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const page = btn.dataset.page;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      el(`page-${page}`).classList.add('active');
      STATE.page = page;
      closeMobileMenu();
      if (page !== 'matches') stopLivePolling();   // poller běží jen na Zápasech
      if (page === 'dashboard') loadDashboard();
      if (page === 'matches') loadMatches();
      if (page === 'bettors') loadBettors();
      if (page === 'bankroll') loadBankroll();
      if (page === 'learning') loadMlLearning();
      if (page === 'settings') loadSettings();
    });
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
  el('settleNowBtn')?.addEventListener('click', settleNow);
  el('refreshMatchesBtn')?.addEventListener('click', () => loadMatches(true));
  el('saveSettingsBtn')?.addEventListener('click', saveAgentSettings);
  el('saveBankrollBtn')?.addEventListener('click', saveBankrollSettings);
  el('runBettorsBtn')?.addEventListener('click', runBettorsRound);
  el('retrainMlBtn')?.addEventListener('click', retrainMlModel);
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
        renderMatchesLeagues(STATE.lastMatchesData.leagues || [], el('matchesContainer'), STATE.lastBetMap);
      }
    });
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
      ? `Agent má zatím ROI ${agentRoi}% (${d.agent_stats.settled} vyřešeno).`
      : 'Agent zatím nemá dost vyřešených sázek pro srovnání.';

    const applyBtn = d.agent_settings
      ? `<button class="btn small" id="applyInsightBtn" style="margin-top:10px;">Použít toto nastavení na agenta</button>`
      : `<div class="muted" style="font-size:12px; margin-top:8px;">Tuhle strategii nejde na agenta 1:1 nastavit (řídí se jinak než agent umí) – jde jen o inspiraci.</div>`;

    box.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <span style="font-size:24px;">${d.emoji}</span>
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:700;">${d.name}</div>
          <div style="font-size:12px; color:var(--txt2);">${d.tagline}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700; color:var(--pos);">ROI ${d.roi}%</div>
          <div style="font-size:11.5px; color:var(--txt2);">${d.win_rate}% win rate · ${d.settled} vyřešeno</div>
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
    const diff = s.balance - s.start_balance;
    setText('stBalanceHint', `${diff >= 0 ? '+' : ''}${fmt(diff)} od startu`);
    setText('stProfit', `${fmt(s.profit)} ${s.currency || 'Kč'}`);
    el('stProfit').className = 'value ' + (s.profit >= 0 ? 'pos' : 'bad');
    setText('stProfitHint', s.roi !== null && s.roi !== undefined ? `${pct(s.roi)} ROI` : '');
    setText('stWinRate', s.win_rate !== null ? pct(s.win_rate) : '—');
    setText('stWinHint', s.settled_count ? `${s.won_count || 0}/${s.settled_count} výher` : 'zatím žádná data');
    setText('stOpen', s.open_count ?? 0);
  } catch (e) { /* tichý fallback – tiles zůstanou na — */ }
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
    const data = await api('/api/dashboard', { timeoutMs: 90000 });
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';
    if (!data.tip) {
      contentEl.innerHTML = `<div class="match" style="font-size:15px; color:var(--txt2); margin-top:8px;">
        Dnes žádná tutovka se skutečnými kurzy nesplňuje kritéria jistoty.</div>`;
      return;
    }
    const t = data.tip;
    contentEl.innerHTML = `
      <div class="match">${t.match}</div>
      <div class="meta">${t.league || ''} · ${(t.date || '').slice(5)} ${t.time || ''}</div>
      <div class="pick-line">
        <span class="pick-name">${t.name}</span>
        <span class="odds-chip">${t.odds.toFixed(2)}</span>
        <span class="conf-chip">${Math.round(t.prob * 100)} % jistota</span>
      </div>`;
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
    el('agentSummary').innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px; font-size:13px;">
        <div style="display:flex; justify-content:space-between;"><span class="muted">Umístěno</span><span>${s.placed}</span></div>
        <div style="display:flex; justify-content:space-between;"><span class="muted">Vyřešeno</span><span>${s.settled} (${s.accuracy !== null ? s.accuracy + '%' : '—'})</span></div>
        <div style="display:flex; justify-content:space-between;"><span class="muted">Zisk</span><span class="${s.profit >= 0 ? 'pos' : 'bad'}">${fmt(s.profit)} Kč</span></div>
        <div style="display:flex; justify-content:space-between;"><span class="muted">ROI</span><span>${s.roi !== null ? s.roi + '%' : '—'}</span></div>
      </div>`;
    renderRecentBets(data.bets || []);
  } catch (e) {
    el('agentSummary').innerHTML = `<div class="empty-state" style="padding:10px 0;">Chyba načítání</div>`;
  }
}

function renderRecentBets(bets) {
  const box = el('recentBets');
  if (!bets.length) { box.innerHTML = `<div class="empty-state">Agent zatím nevsadil žádný tip</div>`; return; }
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Zápas</th><th>Kdy</th><th>Tip</th><th>Kurz</th><th>Status</th><th>P&L</th><th></th></tr></thead>
    <tbody>${bets.slice(0, 12).map((b, i) => {
      const hasWhy = (b.why && b.why.length) || b.outcome === 'acca';
      const when = `${fmtDateShort(b.match_date)} ${b.match_time || ''}`.trim() || '—';
      const whyId = `betWhy${i}`;
      return `
      <tr>
        <td>${b.match || '—'}</td>
        <td class="muted">${when}</td>
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
        <td colspan="7" style="background:var(--panel-2);">
          ${b.outcome === 'acca'
            ? `<div style="font-size:12.5px; color:var(--txt2);"><strong>AKO tiket – nohy:</strong><ul style="margin:6px 0 0; padding-left:18px;">
                ${(b.legs || []).map(l => `<li>${l.match}: <strong>${l.name}</strong> @ ${l.odds}× (${Math.round((l.prob || 0) * 100)}%)</li>`).join('')}
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

async function settleNow() {
  const btn = el('settleNowBtn');
  const spinner = el('settleSpinner');
  btn.disabled = true;
  btn.textContent = 'Kontroluji…';
  spinner.style.display = 'inline-block';
  setText('settleText', 'Stahuji čerstvé výsledky z ESPN pro čekající ligy…');
  try {
    const data = await api('/api/tips/settle', { method: 'POST', timeoutMs: 60000 });
    toast(`Vyhodnoceno: ${data.settled || 0} tipů, ${data.settled_bets || 0} sázek.`);
    loadDashboard();
  } catch (e) {
    toast(`Vyhodnocení selhalo: ${e.message}`, 'err');
    loadSettleStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Zkontrolovat výsledky';
    spinner.style.display = 'none';
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
async function refreshLiveMatches() {
  if (_livePollInFlight) return;                       // nepřekrývat requesty
  if (STATE.page !== 'matches') return;
  if (document.visibilityState !== 'visible') return;  // skrytá karta = neplýtvat ESPN
  if (STATE.date !== todayStr()) return;               // historii nemá smysl obnovovat
  if (!hasLiveMatches(STATE.lastMatchesData)) { stopLivePolling(); return; }

  _livePollInFlight = true;
  try {
    const url = `/api/matches?date=${STATE.date}&sport=${STATE.sport}&days=1&refresh=1`;
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
  if (STATE.page === 'matches' && STATE.date === todayStr() && hasLiveMatches(data)) startLivePolling();
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

function renderMatchesSummary(data, box) {
  const liveCount = (data?.leagues || [])
    .reduce((n, lg) => n + (lg.matches || []).filter(m => m.live).length, 0);
  box.innerHTML = `
    <div class="pill-row" style="margin-bottom:10px;">
      <span class="pill">${data.total_matches} zápasů</span>
      <span class="pill">${data.total_leagues} lig</span>
      ${liveCount ? `<span class="pill live-pill" title="Skóre se samo obnovuje každou minutu">🔴 ${liveCount} živě · auto-obnova</span>` : ''}
      ${data.tip ? `<span class="pill active">💡 ${data.tip.home} – ${data.tip.away}</span>` : ''}
    </div>`;
}

function renderMatchesLeagues(leaguesIn, container, betMap = {}) {
  // "Nehrané / nedohrané" = zápasy, které ještě nemají finální výsledek
  // (nezačaly NEBO právě běží živě) – čistě klientský filtr, data už máme.
  // m.result je naplněné i u živých zápasů (průběžné skóre), takže samotné
  // "result === null" by živé zápasy z tohohle filtru vyhodilo – proto || m.live.
  const leagues = (STATE.statusFilter === 'upcoming'
    ? leaguesIn.map(lg => ({ ...lg, matches: lg.matches.filter(m => m.result === null || m.live) })).filter(lg => lg.matches.length)
    : leaguesIn);

  if (!leagues.length) {
    container.innerHTML = '<div class="empty-state">Žádné zápasy pro tento filtr</div>';
    return;
  }
  container.innerHTML = leagues.map(lg => `
    <div class="league-group">
      <div class="league-head"><span class="flag">${lg.flag || ''}</span> ${lg.league} <span class="count">${lg.matches.length}</span></div>
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
  const startLabel = `${fmtDateShort(m.date)} ${m.time || ''}`.trim();
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

  const why = bet ? `
    <div class="why-box" style="display:none;">
      ${bet.ticket ? `Součást tiketu <strong>${bet.ticket}</strong> – tip <strong>${bet.label}</strong>.`
        : bet.why && bet.why.length ? `<strong>${bet.label}</strong><ul>${bet.why.map(w => `<li>${w}</li>`).join('')}</ul>`
        : `Vsazeno na <strong>${bet.label}</strong>.`}
    </div>` : '';

  const hasExtra = marketChips || bet;

  return `
    <div class="match-card">
      <div class="mc-row">
        <div class="time ${m.live ? 'live' : ''}">
          <span class="status">${statusLabel}</span>
          ${liveDetail}
          <span>${startLabel}</span>
        </div>
        <div class="teams">
          <div class="team-row"><span>${m.home}</span>${m.result ? `<span class="score ${m.live ? 'live' : ''}">${m.result.home}</span>` : ''}</div>
          <div class="team-row"><span>${m.away}</span>${m.result ? `<span class="score ${m.live ? 'live' : ''}">${m.result.away}</span>` : ''}</div>
        </div>
        <div class="pick-col">
          ${hasPick ? `
            <div class="pick-badge">
              <span class="pl">${best.label || '?'}</span>
              <span class="pv">${(best.odds || 0).toFixed(2)}</span>
            </div>
            <span class="badge ${best.is_value ? 'real' : 'model'}">${Math.round((best.prob || 0) * 100)}%</span>
          ` : `<span class="badge model">model ${m.confidence || Math.round((m.probs?.[m.pick] || 0) * 100)}%</span>`}
          ${(m.rating_confidence != null && m.rating_confidence < 0.3) ? `<span class="badge coldstart" title="Rating týmu/týmů stojí na málo odehraných zápasech - predikce je míň spolehlivá">⚠️ nový tým</span>` : ''}
          ${bet ? `<span class="badge ${bet.status}">💰 ${(bet.status || 'open').toUpperCase()}</span>` : ''}
        </div>
      </div>
      ${hasExtra ? `
      <div class="mc-extra">
        ${marketChips ? `<div class="mc-markets">${marketChips}</div>` : ''}
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
    setText('bRoi', s.roi !== null && s.roi !== undefined ? pct(s.roi) : '—');
    setText('bWinRate', s.win_rate !== null ? pct(s.win_rate) : '—');
    if (s.equity && s.equity.length > 1) drawEquity(s.equity);
    renderBetsTable(data.bets || []);
  } catch (e) {
    toast('Nepodařilo se načíst bankroll.', 'err');
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

function renderBetsTable(bets) {
  const tbody = el('betsTable');
  if (!bets.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-state">Zatím žádné sázky</td></tr>`; return; }
  tbody.innerHTML = bets.map(b => `
    <tr>
      <td>${b.match || '—'}</td>
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
async function loadSettings() {
  renderNotifStatus();
  try {
    const data = await api('/api/agent');
    const c = data.settings;
    el('cfgEnabled').checked = !!c.enabled;
    el('cfgAutoRun').checked = !!c.auto_run;
    el('cfgMinProb').value = Math.round((c.min_prob || 0.75) * 100);
    el('cfgMinOdds').value = c.min_odds || 1.2;
    el('cfgStakeMode').value = c.stake_mode || 'kelly';
    el('cfgDailyCap').value = Math.round((c.max_daily_stake_pct || 0.25) * 100);

    const bdata = await api('/api/bankroll');
    el('cfgStartBalance').value = bdata.stats.start_balance;
    el('cfgKellyFraction').value = bdata.stats.kelly_fraction || 0.25;

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
      Otevřených tipů: ${diag.open_tips ?? '—'}<br>
      Otevřených sázek: ${diag.open_bets ?? '—'}<br>
      Paměť procesu: ${diag.rss_mb ?? '—'} MB${calibHtml}`;
  } catch (e) {
    toast('Nepodařilo se načíst nastavení.', 'err');
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
async function loadBettors() {
  const box = el('bettorsContainer');
  box.innerHTML = '<div class="loading"><span class="spinner"></span> Načítání sázkařů…</div>';
  try {
    const [data, calib] = await Promise.all([
      api('/api/bettors', { timeoutMs: 20000 }),
      api('/api/bettors/calibration', { timeoutMs: 15000 }).catch(() => ({ buckets: [] })),
    ]);
    renderBettors(data.bettors || []);
    drawCalibrationChart(calib.buckets || []);
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Chyba: ${e.message}</div>`;
  }
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

function renderBettors(bettors) {
  const box = el('bettorsContainer');
  if (!bettors.length) { box.innerHTML = '<div class="empty-state">Žádní sázkaři</div>'; return; }

  box.innerHTML = bettors.map(b => {
    const profitClass = b.profit >= 0 ? 'pos' : 'bad';
    const rankBadge = b.rank === 1 ? '🥇' : b.rank === 2 ? '🥈' : b.rank === 3 ? '🥉' : `#${b.rank}`;
    return `
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div style="font-size:22px; min-width:36px; text-align:center;">${rankBadge}</div>
        <div style="font-size:26px;">${b.emoji}</div>
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:700; font-size:14.5px;">${b.name}</div>
          <div style="font-size:12px; color:var(--txt2); margin-top:2px;">${b.tagline}</div>
        </div>
        <div style="min-width:90px;">${sparklineSvg(b.equity)}</div>
        <div style="text-align:right;">
          <div style="font-size:18px; font-weight:700;" class="${profitClass}">${b.balance.toFixed(0)} Kč</div>
          <div style="font-size:11.5px; color:var(--txt2);">${b.profit >= 0 ? '+' : ''}${b.profit.toFixed(0)} Kč · ROI ${b.roi}%</div>
        </div>
        <button class="btn small bettor-toggle" data-id="${b.id}" style="margin-left:8px;">Detail ▾</button>
      </div>
      <div style="display:flex; gap:18px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border); font-size:12px; color:var(--txt2); flex-wrap:wrap;">
        <span>Umístěno: <strong style="color:var(--txt);">${b.placed}</strong></span>
        <span>Vyřešeno: <strong style="color:var(--txt);">${b.settled}</strong></span>
        <span>Win rate: <strong style="color:var(--txt);">${b.win_rate !== null ? b.win_rate + '%' : '—'}</strong></span>
        <span>Otevřené: <strong style="color:var(--txt);">${b.open_count}</strong></span>
      </div>
      <div id="bettorDetail-${b.id}" style="display:none; margin-top:12px;"></div>
    </div>`;
  }).join('');

  box.querySelectorAll('.bettor-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleBettorDetail(btn.dataset.id, btn));
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
      <text x="${(x + barW / 2).toFixed(1)}" y="${(actualY - 6).toFixed(1)}" text-anchor="middle" font-size="10.5" fill="var(--txt)">${b.actual_win_rate}%</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${height - padding + 16}" text-anchor="middle" font-size="10" fill="var(--txt3)">${b.range} (n=${b.n})</text>`;
  }).join('');

  svg.innerHTML = `
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)"/>
    <path d="${idealPath}" stroke="var(--blue)" stroke-width="1.5" stroke-dasharray="4,4" fill="none"/>
    <text x="${width - padding}" y="${(toY(100) - 6).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--blue)">ideál</text>
    ${bars}`;
}

async function toggleBettorDetail(id, btn) {
  const box = el(`bettorDetail-${id}`);
  const opening = box.style.display === 'none';
  if (!opening) { box.style.display = 'none'; btn.textContent = 'Detail ▾'; return; }
  btn.textContent = 'Detail ▴';
  box.style.display = 'block';
  box.innerHTML = '<div class="loading" style="padding:14px 0;"><span class="spinner"></span></div>';
  try {
    const data = await api(`/api/bettors/${id}`, { timeoutMs: 15000 });
    const bets = data.bets || [];
    if (!bets.length) { box.innerHTML = '<div class="empty-state" style="padding:14px 0;">Zatím žádné sázky</div>'; return; }
    box.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Zápas</th><th>Kdy</th><th>Tip</th><th>Kurz</th><th>Vklad</th><th>Status</th><th>P&L</th></tr></thead>
      <tbody>${bets.map(bt => `
        <tr>
          <td>${bt.match}</td>
          <td class="muted">${fmtDateShort(bt.match_date)} ${bt.match_time || ''}</td>
          <td>${bt.label}</td>
          <td>${bt.odds}×</td>
          <td>${fmt(bt.stake)} Kč</td>
          <td><span class="badge ${bt.status}">${bt.status.toUpperCase()}</span></td>
          <td class="${bt.status === 'open' ? 'muted' : bt.pnl > 0 ? 'pos' : 'bad'}">
            ${bt.status === 'open' ? '—' : `${bt.pnl > 0 ? '+' : ''}${fmt(bt.pnl)} Kč`}
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty-state" style="padding:14px 0;">Chyba: ${e.message}</div>`;
  }
}

async function runBettorsRound() {
  const btn = el('runBettorsBtn');
  btn.disabled = true;
  btn.textContent = 'Spouštím…';
  try {
    const data = await api('/api/bettors/run', { method: 'POST', timeoutMs: 60000 });
    const totalPlaced = Object.values(data.placed || {}).reduce((a, b) => a + b, 0);
    toast(totalPlaced > 0 ? `Sázkaři umístili ${totalPlaced} sázek.` : 'Všichni sázkaři už dnes sázeli.');
    renderBettors(data.bettors || []);
  } catch (e) {
    toast('Kolo sázení selhalo.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Spustit kolo teď';
  }
}

// ---------------------------------------------------------------------------
// NOTIFIKACE – čistě klientské (Notification API), appka nemá server push.
// Musí zůstat otevřená karta v prohlížeči; kontroluje se periodicky, dokud
// běží. Nový tip dne a nově vyhodnocené sázky agenta = jedno upozornění.
// ---------------------------------------------------------------------------
const NOTIF_SEEN_BETS_KEY = 'kurzanalytik_notif_seen_bets';
const NOTIF_LAST_TIP_KEY = 'kurzanalytik_notif_last_tip';
const NOTIF_POLL_MS = 3 * 60 * 1000;

function renderNotifStatus() {
  const box = el('notifStatus');
  const btn = el('notifEnableBtn');
  if (!box || !('Notification' in window)) { if (box) box.textContent = 'Tenhle prohlížeč notifikace nepodporuje.'; return; }
  if (Notification.permission === 'granted') {
    box.innerHTML = '<span class="badge won">POVOLENO</span>';
    if (btn) { btn.textContent = 'Notifikace jsou zapnuté'; btn.disabled = true; }
  } else if (Notification.permission === 'denied') {
    box.innerHTML = '<span class="badge lost">ZABLOKOVÁNO</span> – povol je v nastavení prohlížeče pro tuhle stránku.';
  } else {
    box.innerHTML = '<span class="badge open">NEPOVOLENO</span>';
  }
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, icon: undefined }); } catch (e) { /* nic */ }
}

async function pollForNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  // Nový tip dne
  try {
    const d = await api('/api/dashboard', { timeoutMs: 20000 });
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
}

function setupNotifications() {
  renderNotifStatus();
  el('notifEnableBtn')?.addEventListener('click', async () => {
    if (!('Notification' in window)) { toast('Prohlížeč notifikace nepodporuje.', 'err'); return; }
    const perm = await Notification.requestPermission();
    renderNotifStatus();
    if (perm === 'granted') {
      toast('Notifikace zapnuté.');
      pollForNotifications();
    }
  });
  if ('Notification' in window && Notification.permission === 'granted') {
    pollForNotifications();
  }
  setInterval(pollForNotifications, NOTIF_POLL_MS);
}

// ---------------------------------------------------------------------------
// ML LEARNING
// ---------------------------------------------------------------------------
const ML_STATUS_CZ = {
  no_data: 'Čeká na data', not_trained: 'Netrénováno',
  trained: 'Natrénováno', error: 'Chyba',
};

async function loadMlLearning() {
  try {
    const s = await api('/api/learning/stats', { timeoutMs: 20000 });
    setText('mlStatus', ML_STATUS_CZ[s.model_status] || s.model_status || '—');
    setText('mlTotal', s.total_bets ?? 0);
    setText('mlAccuracy', s.model_accuracy ? pct(s.model_accuracy * 100) : '—');
    setText('mlAuc', s.model_auc ? s.model_auc.toFixed(3) : '—');
    renderMlFeatures(s.feature_importance || {});
  } catch (e) {
    toast('Nepodařilo se načíst ML Learning.', 'err');
  }
}

function renderMlFeatures(importance) {
  const box = el('mlFeatures');
  const entries = Object.entries(importance).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { box.innerHTML = '<div class="empty-state">Model ještě není natrénovaný</div>'; return; }
  const max = entries[0][1] || 1;
  box.innerHTML = entries.map(([name, val]) => `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
      <span style="width:150px; font-size:12px; color:var(--txt2); flex-shrink:0;">${name}</span>
      <div style="flex:1; background:var(--panel-2); border-radius:4px; height:8px; overflow:hidden;">
        <div style="width:${Math.max(2, val / max * 100)}%; height:100%; background:var(--accent);"></div>
      </div>
      <span style="width:45px; text-align:right; font-size:11.5px; color:var(--txt3);">${(val * 100).toFixed(1)}%</span>
    </div>`).join('');
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
      setText('mlAuc', data.stats.model_auc ? data.stats.model_auc.toFixed(3) : '—');
      renderMlFeatures(data.stats.feature_importance || {});
    }
  } catch (e) {
    toast(`Trénink selhal: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Přetrénovat teď';
  }
}
