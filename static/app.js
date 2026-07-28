// ============================================================================
// KurzAnalytik v3 — Frontend (kompletně přepsáno)
// ============================================================================

const STATE = { page: 'dashboard', sport: 'soccer', date: todayStr() };

document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupMobileMenu();
  buildDateStrip();
  bindEvents();
  loadDashboard();
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
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
      if (page === 'dashboard') loadDashboard();
      if (page === 'matches') loadMatches();
      if (page === 'bankroll') loadBankroll();
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
  document.querySelectorAll('#sportStrip .pill[data-sport]').forEach(p => {
    p.addEventListener('click', () => {
      document.querySelectorAll('#sportStrip .pill').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      STATE.sport = p.dataset.sport;
      loadMatches();
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
  contentEl.style.display = 'none';
  try {
    const data = await api('/api/dashboard');
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
    contentEl.innerHTML = `<div class="match" style="color:var(--bad); font-size:14px;">Nepodařilo se načíst tip dne.</div>`;
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
    <thead><tr><th>Zápas</th><th>Tip</th><th>Kurz</th><th>Status</th><th>P&L</th></tr></thead>
    <tbody>${bets.slice(0, 12).map(b => `
      <tr>
        <td>${b.match || '—'}</td>
        <td>${b.label || '?'}</td>
        <td>${b.odds || 0}×</td>
        <td><span class="badge ${b.status}">${(b.status || 'open').toUpperCase()}</span></td>
        <td class="${b.status === 'open' ? 'muted' : (b.pnl || 0) > 0 ? 'pos' : 'bad'}">
          ${b.status === 'open' ? '—' : `${(b.pnl || 0) > 0 ? '+' : ''}${fmt(b.pnl || 0)} Kč`}
        </td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

async function loadSettleStatus() {
  try {
    const s = await api('/api/settle/status');
    const bar = el('settleBar');
    const total = (s.open_tips || 0) + (s.open_bets || 0);
    if (total > 0) {
      bar.style.display = 'block';
      setText('settleText', `Čeká ${total} položek na vyhodnocení (${s.open_bets || 0} sázek, ${s.open_tips || 0} tipů).`);
    } else {
      bar.style.display = 'none';
    }
  } catch (e) { /* nic */ }
}

async function settleNow() {
  const btn = el('settleNowBtn');
  btn.disabled = true;
  btn.textContent = 'Kontroluji…';
  try {
    const data = await api('/api/tips/settle', { method: 'POST' });
    toast(`Vyhodnoceno: ${data.settled || 0} tipů, ${data.settled_bets || 0} sázek.`);
    loadDashboard();
  } catch (e) {
    toast('Vyhodnocení selhalo.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Zkontrolovat výsledky';
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
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 55000);

  try {
    const url = `/api/matches?date=${STATE.date}&sport=${STATE.sport}&days=1${refresh ? '&refresh=1' : ''}`;
    const data = await api(url, { signal: controller.signal });
    renderMatchesSummary(data, summary);
    renderMatchesLeagues(data.leagues || [], container);
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'Načítání trvá příliš dlouho (ESPN neodpovídá).' : `Chyba: ${e.message}`;
    container.innerHTML = `<div class="empty-state">${msg}
      <button class="btn small" id="matchesRetryBtn" style="margin-top:8px;">Zkusit znovu</button></div>`;
    el('matchesRetryBtn')?.addEventListener('click', () => loadMatches(refresh));
  } finally {
    clearTimeout(t1); clearTimeout(t2); clearTimeout(abortTimer);
  }
}

function renderMatchesSummary(data, box) {
  box.innerHTML = `
    <div class="pill-row" style="margin-bottom:10px;">
      <span class="pill">${data.total_matches} zápasů</span>
      <span class="pill">${data.total_leagues} lig</span>
      ${data.tip ? `<span class="pill active">💡 ${data.tip.home} – ${data.tip.away}</span>` : ''}
    </div>`;
}

function renderMatchesLeagues(leagues, container) {
  if (!leagues.length) {
    container.innerHTML = '<div class="empty-state">Žádné zápasy pro tento den a sport</div>';
    return;
  }
  container.innerHTML = leagues.map(lg => `
    <div class="league-group">
      <div class="league-head"><span class="flag">${lg.flag || ''}</span> ${lg.league} <span class="count">${lg.matches.length}</span></div>
      ${lg.matches.map(matchCardHtml).join('')}
    </div>`).join('');
}

function matchCardHtml(m) {
  const finished = m.result !== null;
  const timeLabel = finished ? 'Konec' : m.live ? 'ŽIVĚ' : (m.time || '');
  const scoreLine = m.result ? `${m.result.home} : ${m.result.away}` : `${m.home}<br>${m.away}`;
  const best = m.best_value || {};
  const hasPick = best.outcome && m.odds_source === 'real';
  return `
    <div class="match-card">
      <div class="time ${m.live ? 'live' : ''}">${timeLabel}</div>
      <div class="teams">
        <div class="team-row"><span>${m.home}</span>${m.result ? `<span class="score">${m.result.home}</span>` : ''}</div>
        <div class="team-row"><span>${m.away}</span>${m.result ? `<span class="score">${m.result.away}</span>` : ''}</div>
      </div>
      <div class="pick-col">
        ${hasPick ? `
          <div class="pick-badge">
            <span class="pl">${best.label || '?'}</span>
            <span class="pv">${(best.odds || 0).toFixed(2)}</span>
          </div>
          <span class="badge ${best.is_value ? 'real' : 'model'}">${Math.round((best.prob || 0) * 100)}%</span>
        ` : `<span class="badge model">model ${m.confidence || Math.round((m.probs?.[m.pick] || 0) * 100)}%</span>`}
      </div>
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
    el('diagInfo').innerHTML = `
      Otevřených tipů: ${diag.open_tips ?? '—'}<br>
      Otevřených sázek: ${diag.open_bets ?? '—'}<br>
      Paměť procesu: ${diag.rss_mb ?? '—'} MB`;
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
