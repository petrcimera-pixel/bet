// ============================================================================
// KurzAnalytik Pro — Frontend v2 (Opraveno)
// ============================================================================

const STATE = {
  currentPage: 'dashboard',
  stats: null,
  agentTips: [],
  settings: null,
};

document.addEventListener('DOMContentLoaded', async () => {
  console.log('App loading...');

  setupNavigation();

  // Načti všechna data
  await Promise.all([
    loadStats(),
    loadSettings(),
  ]);

  // Inicializuj nastavení UI
  initializeSettings();

  // Setup event listeners po inicializaci dat
  setupEventListeners();

  // Vykresl dashboard
  renderDashboard();
  console.log('App ready');
});

// ============================================================================
// NAVIGATION
// ============================================================================

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      showPage(page);
      closeMobileMenu();
    });
  });

  const hamburger = document.getElementById('hamburgerBtn');
  const overlay = document.getElementById('sidebarOverlay');
  if (hamburger) {
    hamburger.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      const isOpen = sidebar.classList.toggle('open');
      hamburger.classList.toggle('active', isOpen);
      overlay.classList.toggle('active', isOpen);
    });
  }
  if (overlay) {
    overlay.addEventListener('click', closeMobileMenu);
  }
}

function closeMobileMenu() {
  const sidebar = document.querySelector('.sidebar');
  const hamburger = document.getElementById('hamburgerBtn');
  const overlay = document.getElementById('sidebarOverlay');
  if (sidebar) sidebar.classList.remove('open');
  if (hamburger) hamburger.classList.remove('active');
  if (overlay) overlay.classList.remove('active');
}

function showPage(pageName) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const page = document.getElementById(pageName);
  const navBtn = document.querySelector(`[data-page="${pageName}"]`);

  if (page) page.classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  STATE.currentPage = pageName;

  // Load page-specific data
  setTimeout(() => {
    switch(pageName) {
      case 'agent-tips':
        if (STATE.agentTips.length === 0) {
          loadAgentTips();
        } else {
          renderAgentTips();
        }
        break;
      case 'analytics':
        renderAnalytics();
        break;
      case 'bankroll':
        renderBankroll();
        renderBankrollPage();
        break;
      case 'learning':
        loadLearningStats();
        loadMonitoringStatus();
        break;
      case 'advanced-analytics':
        loadAdvancedAnalytics();
        break;
    }
  }, 100);
}

// ============================================================================
// API CALLS
// ============================================================================

async function loadStats() {
  try {
    const res = await fetch('/api/bankroll', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    STATE.stats = data.stats;  // API returns {stats: {...}, bets: [...]}
    STATE.agentTips = data.bets || [];
    console.log('Stats loaded:', STATE.stats);
  } catch (e) {
    console.error('Stats error:', e);
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    STATE.settings = await res.json();
    console.log('Settings:', STATE.settings);
  } catch (e) {
    console.error('Settings error:', e);
  }
}

async function loadAgentTips() {
  try {
    const res = await fetch('/api/agent', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    STATE.agentTips = data.bets || [];
    renderAgentTips();
  } catch (e) {
    console.error('Agent tips error:', e);
  }
}

// ============================================================================
// DASHBOARD
// ============================================================================

function renderDashboard() {
  if (!STATE.stats) {
    console.warn('No stats available');
    return;
  }

  const s = STATE.stats;
  console.log('FULL STATS OBJECT:', JSON.stringify(s).substring(0, 500));
  console.log('balance =', s.balance, 'type:', typeof s.balance);
  console.log('Keys:', Object.keys(s).slice(0, 10));
  const cur = s.currency || 'Kč';

  // Stat cards
  console.log('Setting dashBalance to:', fmt(s.balance), cur);
  setElText('dashBalance', `${fmt(s.balance)} ${cur}`);
  setElText('dashProfit', `${fmt(s.profit)} ${cur}`);
  setElText('dashROI', `${s.roi || 0}% ROI`);
  setElText('dashWinRate', `${s.win_rate || 0}%`);
  setElText('dashWinCount', `${s.won_count || 0}/${s.settled_count || 0} výher`);
  setElText('dashSharpe', `${((s.sharpe_ratio || 0).toFixed(2))}`);

  // Balance change
  const change = s.balance - s.start_balance;
  const changeEl = document.getElementById('dashBalanceChange');
  if (changeEl) {
    if (change > 0) {
      changeEl.textContent = `+${fmt(change)} od startu`;
      changeEl.style.color = 'var(--pos)';
    } else if (change < 0) {
      changeEl.textContent = `${fmt(change)} od startu`;
      changeEl.style.color = 'var(--bad)';
    } else {
      changeEl.textContent = 'Beze změny';
    }
  }

  // Agent status
  const statusEl = document.getElementById('agentStatus');
  if (statusEl) {
    statusEl.textContent = `${s.open_count || 0} otevřených sázek`;
  }

  // Last run info
  const lastRunEl = document.getElementById('agentLastRun');
  if (lastRunEl && s.total_bets > 0) {
    lastRunEl.innerHTML = `
      <div class="agent-info">
        <strong>Celkem sázek:</strong> ${s.total_bets}<br>
        <strong>Vyřešeno:</strong> ${s.settled_count} (${s.win_rate || 0}% úspěšnost)<br>
        <strong>Zisk:</strong> ${fmt(s.profit)} ${cur}
      </div>
    `;
  }

  // Load and render agent tips for dashboard
  renderDashboardTips();
}

function renderDashboardTips() {
  const container = document.getElementById('dashTipsContainer');
  if (!container) return;

  const bets = STATE.agentTips.filter(b => b.tag === 'bet-agent' && b.status === 'open').slice(0, 10);

  if (!bets.length) {
    container.innerHTML = '<div class="loading">Žádné otevřené sázky agenta</div>';
    return;
  }

  container.innerHTML = bets
    .map(b => `
      <div class="tip-item">
        <div class="tip-match">
          <div class="tip-teams">🤖 ${b.match || 'Neznámý zápas'}</div>
          <div class="tip-meta">
            <span>${b.match_date || '—'} ${b.match_time || '—'}</span>
            <span>${b.league || 'Liga'}</span>
          </div>
          <div class="tip-meta">
            <span>${b.label || '?'}</span>
            <span>${b.odds || 0}× @ ${((b.prob || 0) * 100).toFixed(0)}%</span>
          </div>
        </div>
        <div class="tip-prediction">
          <span class="tip-badge">${(b.status || 'open').toUpperCase()}</span>
          <strong>${b.pnl > 0 ? '+' : ''}${fmt(b.pnl || 0)}</strong>
        </div>
      </div>
    `)
    .join('');
}

// ============================================================================
// AGENT TIPS
// ============================================================================

function renderAgentTips() {
  const container = document.getElementById('agentTipsContainer');
  if (!container) return;

  const bets = STATE.agentTips.filter(b => b.tag === 'bet-agent');

  if (!bets.length) {
    container.innerHTML = '<div class="loading">Žádné sázky agenta</div>';
    return;
  }

  container.innerHTML = bets
    .map(b => `
      <div class="tip-item" data-status="${b.status || 'open'}" onclick="showTipDetail('${b.id}')">
        <div class="tip-match">
          <div class="tip-teams">🤖 ${b.match || 'Neznámý zápas'}</div>
          <div class="tip-meta">
            <span>${b.match_date || '—'} ${b.match_time || '—'}</span>
            <span>${b.league || 'Liga'}</span>
          </div>
          <div class="tip-meta">
            <span>${b.label || '?'}</span>
            <span>${b.odds || 0}× @ ${((b.prob || 0) * 100).toFixed(0)}%</span>
          </div>
        </div>
        <div class="tip-prediction">
          <span class="tip-badge">${(b.status || 'open').toUpperCase()}</span>
          <strong>${b.pnl > 0 ? '+' : ''}${fmt(b.pnl || 0)}</strong>
        </div>
      </div>
    `)
    .join('');

  applyTipFilters();
}

function applyTipFilters() {
  const query = (document.getElementById('tipFilter')?.value || '').toLowerCase();
  const status = document.getElementById('tipStatus')?.value || '';

  document.querySelectorAll('#agentTipsContainer .tip-item').forEach(item => {
    const textOk = !query || item.textContent.toLowerCase().includes(query);
    const statusOk = !status || item.dataset.status === status;
    item.style.display = (textOk && statusOk) ? '' : 'none';
  });
}

function showTipDetail(betId) {
  const bet = STATE.agentTips.find(b => b.id === betId);
  if (!bet) return;

  const modal = document.getElementById('tipDetailModal');
  const content = document.getElementById('tipDetailContent');

  if (!content) return;

  content.innerHTML = `
    <h2>${bet.match || 'Zápas'}</h2>
    <div style="margin: 20px 0; line-height: 1.8;">
      <p><strong>Tip:</strong> ${bet.label || '?'} @ ${bet.odds || 0}</p>
      <p><strong>Jistota:</strong> ${((bet.prob || 0) * 100).toFixed(1)}%</p>
      <p><strong>Vklad:</strong> ${fmt(bet.stake || 0)} Kč</p>
      <p><strong>Status:</strong> ${(bet.status || 'open').toUpperCase()}</p>
      <p><strong>P&L:</strong> ${bet.pnl > 0 ? '+' : ''}${fmt(bet.pnl || 0)} Kč</p>
      <p><strong>Liga:</strong> ${bet.league || '—'}</p>
      <p><strong>Čas:</strong> ${bet.match_date || '—'} ${bet.match_time || '—'}</p>
    </div>

    <h3 style="margin-top: 20px;">Vysvětlení tipu</h3>
    <p>Agent vybral tento tip protože:</p>
    <ul style="margin: 10px 0 10px 20px;">
      <li><strong>Jistota ≥ 55%:</strong> Model udává ${((bet.prob || 0) * 100).toFixed(1)}% šanci na výhru</li>
      <li><strong>Value příležitost:</strong> Kurz je lepší než model doporučuje</li>
      <li><strong>Kelly kritérium:</strong> Vklad ${fmt(bet.stake || 0)} Kč odpovídá frakčnímu Kelly</li>
    </ul>
  `;

  if (modal) {
    modal.classList.add('active');
    modal.classList.remove('hidden');
  }
}

// ============================================================================
// ANALYTICS
// ============================================================================

function renderAnalytics() {
  if (!STATE.stats) return;

  renderMonthlyAnalytics();
  renderLeaguesAnalytics();
}

function renderMonthlyAnalytics() {
  const monthly = STATE.stats?.monthly_pnl || {};
  const tbody = document.querySelector('#monthlyTable tbody');

  if (!tbody) return;

  tbody.innerHTML = Object.entries(monthly)
    .reverse()
    .map(([month, pnl]) => `
      <tr>
        <td>${month}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td style="color: ${pnl > 0 ? 'var(--pos)' : 'var(--bad)'}; font-weight: 600;">
          ${pnl > 0 ? '+' : ''}${fmt(pnl)} Kč
        </td>
        <td>—</td>
      </tr>
    `)
    .join('');
}

function renderLeaguesAnalytics() {
  const byLeague = STATE.stats?.by_league || {};
  const tbody = document.querySelector('#leaguesTable tbody');

  if (!tbody) return;

  tbody.innerHTML = Object.entries(byLeague)
    .sort((a, b) => (b[1].pnl || 0) - (a[1].pnl || 0))
    .map(([league, data]) => `
      <tr>
        <td>${league}</td>
        <td>${data.settled || 0}</td>
        <td>${data.wins || 0}</td>
        <td>${data.win_rate || 0}%</td>
        <td style="color: ${(data.pnl || 0) > 0 ? 'var(--pos)' : 'var(--bad)'}; font-weight: 600;">
          ${(data.pnl || 0) > 0 ? '+' : ''}${fmt(data.pnl || 0)} Kč
        </td>
        <td>${(data.roi || 0) > 0 ? '+' : ''}${data.roi || 0}%</td>
      </tr>
    `)
    .join('');
}

// ============================================================================
// BANKROLL
// ============================================================================

function renderBankroll() {
  if (!STATE.stats) return;

  const s = STATE.stats;
  const cur = s.currency || 'Kč';

  setElText('startBalance', `${fmt(s.start_balance)} ${cur}`);
  setElText('currentBalance', `${fmt(s.balance)} ${cur}`);
  setElText('openBets', s.open_count || 0);

  // Equity curve grafu banku (s.equity = pole zůstatků od startu)
  if (s.equity && s.equity.length > 1) {
    renderEquitySVG(s.equity);
  }

  // Historie sázek – stats objekt sázky neobsahuje, jsou v STATE.agentTips
  // (loadStats tam ukládá data.bets z /api/bankroll = VŠECHNY sázky)
  const allBets = STATE.agentTips || [];
  const tbody = document.querySelector('#betsTable tbody');
  if (tbody && allBets.length) {
    tbody.innerHTML = allBets
      .slice(0, 50)
      .map(b => `
        <tr>
          <td>${b.match || '—'}</td>
          <td>${b.label || '?'}</td>
          <td>${fmt(b.stake || 0)} ${cur}</td>
          <td>${b.odds || 0}×</td>
          <td><span class="tip-badge">${(b.status || 'open').toUpperCase()}</span></td>
          <td style="color: ${(b.pnl || 0) > 0 ? 'var(--pos)' : 'var(--bad)'}; font-weight: 600;">
            ${(b.pnl || 0) > 0 ? '+' : ''}${fmt(b.pnl || 0)} ${cur}
          </td>
        </tr>
      `)
      .join('');
  }
}

function renderEquitySVG(equity) {
  const svg = document.getElementById('equitySVG');
  if (!svg) return;

  const width = 800, height = 300, padding = 40;
  const plotWidth = width - 2 * padding;
  const plotHeight = height - 2 * padding;

  const minVal = Math.min(...equity);
  const maxVal = Math.max(...equity);
  const range = maxVal - minVal || 1;

  let path = '';
  equity.forEach((val, i) => {
    const x = padding + (i / (equity.length - 1)) * plotWidth;
    const y = height - padding - ((val - minVal) / range) * plotHeight;
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  });

  const last = equity[equity.length - 1];
  const first = equity[0];
  const color = last >= first ? 'var(--pos)' : 'var(--bad)';

  svg.innerHTML = `
    <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--line)" stroke-width="1"/>
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="var(--line)" stroke-width="1"/>
    <text x="${padding - 5}" y="${padding + 4}" text-anchor="end" font-size="11" fill="var(--txt2)">${maxVal.toFixed(0)}</text>
    <text x="${padding - 5}" y="${height - padding + 4}" text-anchor="end" font-size="11" fill="var(--txt2)">${minVal.toFixed(0)}</text>
    <path d="${path}" stroke="${color}" stroke-width="2" fill="none"/>
  `;
}

// ============================================================================
// SETTINGS
// ============================================================================

function initializeSettings() {
  if (!STATE.settings?.agent) return;

  const agent = STATE.settings.agent;

  // Initialize toggle states from data
  const agentEnabled = document.getElementById('agentEnabled');
  if (agentEnabled) agentEnabled.checked = agent.enabled || false;

  const agentBetToday = document.getElementById('agentBetToday');
  if (agentBetToday) agentBetToday.checked = agent.bet_today || false;

  const agentOnlyRealOdds = document.getElementById('agentOnlyRealOdds');
  if (agentOnlyRealOdds) agentOnlyRealOdds.checked = agent.only_real_odds || false;

  const agentAutoRun = document.getElementById('agentAutoRun');
  if (agentAutoRun) agentAutoRun.checked = agent.auto_run || false;

  const agentAutoRunHours = document.getElementById('agentAutoRunHours');
  if (agentAutoRunHours) agentAutoRunHours.value = agent.auto_run_hours || '8,16';

  const agentAutoRetrain = document.getElementById('agentAutoRetrain');
  if (agentAutoRetrain) agentAutoRetrain.checked = agent.auto_retrain !== false;

  const agentAutoRetrainThreshold = document.getElementById('agentAutoRetrainThreshold');
  if (agentAutoRetrainThreshold) agentAutoRetrainThreshold.value = agent.auto_retrain_threshold || 10;

  const stakeMode = document.getElementById('stakeMode');
  if (stakeMode) stakeMode.value = agent.stake_mode || 'kelly';

  const flatStake = document.getElementById('flatStake');
  if (flatStake) flatStake.value = agent.stake || 10;

  const homeAdv = document.getElementById('homeAdv');
  if (homeAdv) homeAdv.value = STATE.settings.model?.home_adv || 60;

  const ratingToGoals = document.getElementById('ratingToGoals');
  if (ratingToGoals) ratingToGoals.value = STATE.settings.model?.rating_to_goals || 0.40;

  console.log('Settings initialized');
}

function setupEventListeners() {
  const runBtn = document.getElementById('runAgentBtn');
  if (runBtn) {
    runBtn.addEventListener('click', runAgent);
  }

  const saveBtn = document.getElementById('saveSettings');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveSettings);
  }

  const resetBtn = document.getElementById('resetSettings');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetSettings);
  }

  const trainBtn = document.getElementById('trainModelBtn');
  if (trainBtn) {
    trainBtn.addEventListener('click', trainModel);
  }

  // Toggle listeners for immediate save
  const agentEnabledToggle = document.getElementById('agentEnabled');
  const agentBetTodayToggle = document.getElementById('agentBetToday');
  const stakeModeSelect = document.getElementById('stakeMode');
  const flatStakeInput = document.getElementById('flatStake');

  if (agentEnabledToggle) {
    agentEnabledToggle.addEventListener('change', () => {
      console.log('agentEnabled toggled:', agentEnabledToggle.checked);
      // Auto-save
      saveSettingsQuietly();
    });
  }

  if (agentBetTodayToggle) {
    agentBetTodayToggle.addEventListener('change', () => {
      console.log('agentBetToday toggled:', agentBetTodayToggle.checked);
      // Auto-save
      saveSettingsQuietly();
    });
  }

  const agentOnlyRealOddsToggle = document.getElementById('agentOnlyRealOdds');
  if (agentOnlyRealOddsToggle) {
    agentOnlyRealOddsToggle.addEventListener('change', () => saveSettingsQuietly());
  }

  const agentAutoRunToggle = document.getElementById('agentAutoRun');
  if (agentAutoRunToggle) {
    agentAutoRunToggle.addEventListener('change', () => saveSettingsQuietly());
  }

  const agentAutoRunHoursInput = document.getElementById('agentAutoRunHours');
  if (agentAutoRunHoursInput) {
    agentAutoRunHoursInput.addEventListener('change', () => saveSettingsQuietly());
  }

  const agentAutoRetrainToggle = document.getElementById('agentAutoRetrain');
  if (agentAutoRetrainToggle) {
    agentAutoRetrainToggle.addEventListener('change', () => saveSettingsQuietly());
  }

  const agentAutoRetrainThresholdInput = document.getElementById('agentAutoRetrainThreshold');
  if (agentAutoRetrainThresholdInput) {
    agentAutoRetrainThresholdInput.addEventListener('change', () => saveSettingsQuietly());
  }

  if (stakeModeSelect) {
    stakeModeSelect.addEventListener('change', () => {
      console.log('stakeMode changed:', stakeModeSelect.value);
      const flatStakeGroup = document.getElementById('flatStakeGroup');
      if (flatStakeGroup) {
        flatStakeGroup.style.display = stakeModeSelect.value === 'flat' ? 'block' : 'none';
      }
    });
  }

  // Tabs – POUZE v rámci stránky #analytics (globální selektor by rozbíjel
  // taby na stránce #advanced-analytics, která používá stejné třídy)
  document.querySelectorAll('#analytics .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      document.querySelectorAll('#analytics .tab-content').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('#analytics .tab-btn').forEach(b => b.classList.remove('active'));

      const tab = document.getElementById(`${tabName}-tab`);
      if (tab) tab.classList.add('active');
      btn.classList.add('active');
    });
  });

  // Filter (text + status)
  const filterInput = document.getElementById('tipFilter');
  if (filterInput) {
    filterInput.addEventListener('input', applyTipFilters);
  }
  const statusSelect = document.getElementById('tipStatus');
  if (statusSelect) {
    statusSelect.addEventListener('change', applyTipFilters);
  }

  // Modal close
  document.addEventListener('click', (e) => {
    if (e.target.id === 'tipDetailModal') {
      e.target.classList.remove('active');
      e.target.classList.add('hidden');
    }
    if (e.target.classList.contains('modal-close')) {
      const modal = e.target.closest('.modal');
      if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
      }
    }
  });
}

async function runAgent() {
  const btn = document.getElementById('runAgentBtn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = 'Běží...';

  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true })
    });

    const result = await res.json();
    alert(`Agent umístil ${result.placed || 0} sázek.`);

    await loadStats();
    renderDashboard();
  } catch (e) {
    alert('Chyba: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Spustit agenta teď';
  }
}

async function saveSettingsQuietly() {
  // Neposílat natvrdo defaulty – zachovej aktuálně uložené hodnoty,
  // jinak by každé kliknutí na toggle resetovalo kelly_fraction apod.
  const saved = STATE.settings?.agent || {};
  const data = {
    enabled: document.getElementById('agentEnabled')?.checked || false,
    bet_today: document.getElementById('agentBetToday')?.checked || false,
    only_real_odds: document.getElementById('agentOnlyRealOdds')?.checked || false,
    auto_run: document.getElementById('agentAutoRun')?.checked || false,
    auto_run_hours: document.getElementById('agentAutoRunHours')?.value || saved.auto_run_hours || '8,16',
    auto_retrain: document.getElementById('agentAutoRetrain')?.checked !== false,
    auto_retrain_threshold: parseInt(document.getElementById('agentAutoRetrainThreshold')?.value) || saved.auto_retrain_threshold || 10,
    stake_mode: document.getElementById('stakeMode')?.value || saved.stake_mode || 'kelly',
    stake: parseFloat(document.getElementById('flatStake')?.value) || saved.stake || 10,
    kelly_fraction: saved.kelly_fraction ?? 0.25,
    max_daily_stake_pct: saved.max_daily_stake_pct ?? 0.25,
    only_sharp: saved.only_sharp ?? true
  };

  try {
    const res = await fetch('/api/agent/settings', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      console.log('✅ Nastavení automaticky uloženo!');
      await loadSettings();
      initializeSettings();
    } else {
      console.error('Chyba při ukládání:', res.status);
    }
  } catch (e) {
    console.error('Chyba:', e.message);
  }
}

async function saveModelSettings() {
  // Parametry modelu (domácí výhoda, rating→góly) – dřív se tvářily uložené,
  // ale nikam se neposílaly
  const homeAdv = parseFloat(document.getElementById('homeAdv')?.value);
  const ratingToGoals = parseFloat(document.getElementById('ratingToGoals')?.value);
  const values = {};
  if (!isNaN(homeAdv)) values.home_adv = homeAdv;
  if (!isNaN(ratingToGoals)) values.rating_to_goals = ratingToGoals;
  if (!Object.keys(values).length) return;

  try {
    await fetch('/api/settings', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: 'model', values })
    });
  } catch (e) {
    console.error('Chyba ukládání model nastavení:', e.message);
  }
}

async function saveSettings() {
  await saveSettingsQuietly();
  await saveModelSettings();
  alert('Nastavení uloženo!');
}

async function loadLearningStats() {
  try {
    const res = await fetch('/api/learning/stats', { credentials: 'include' });
    const data = await res.json();

    document.getElementById('modelStatus').textContent = data.model_status || '—';
    document.getElementById('totalBets').textContent = data.total_bets || 0;
    document.getElementById('winRate').textContent = data.win_rate ?
      `${(data.win_rate * 100).toFixed(1)}%` : '—';
    document.getElementById('accuracy').textContent = data.model_accuracy ?
      `${(data.model_accuracy * 100).toFixed(1)}%` : '—';
    document.getElementById('aucScore').textContent = data.model_auc ?
      `${data.model_auc.toFixed(3)}` : '—';
    document.getElementById('lastTrained').textContent = data.last_trained ?
      new Date(data.last_trained).toLocaleString('cs-CZ') : '—';

    // Render learning curve
    if (data.learning_curve && data.learning_curve.length > 0) {
      renderLearningCurve(data.learning_curve);
    }

    // Render feature importance
    if (data.feature_importance && Object.keys(data.feature_importance).length > 0) {
      renderFeatureImportance(data.feature_importance);
    }
  } catch (e) {
    console.error('Error loading learning stats:', e);
  }
}

function renderLearningCurve(curve) {
  const svg = document.getElementById('learningCurve');
  if (!svg || curve.length === 0) return;

  const width = 800, height = 300;
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  // Clear SVG
  svg.innerHTML = '';

  // Axes
  const axisGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  axisGroup.innerHTML = `
    <line x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="2"/>
    <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}" stroke="var(--line)" stroke-width="2"/>
  `;
  svg.appendChild(axisGroup);

  // Plot points
  const points = curve.map((p, i) => ({
    x: padding.left + (i / (curve.length - 1)) * plotWidth,
    y: height - padding.bottom - (p.win_rate || 0) * plotHeight
  }));

  // Draw line
  const pathData = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pathEl.setAttribute('d', pathData);
  pathEl.setAttribute('stroke', 'var(--acc)');
  pathEl.setAttribute('stroke-width', '3');
  pathEl.setAttribute('fill', 'none');
  svg.appendChild(pathEl);

  // Draw points
  points.forEach(p => {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', p.x);
    circle.setAttribute('cy', p.y);
    circle.setAttribute('r', '5');
    circle.setAttribute('fill', 'var(--acc)');
    svg.appendChild(circle);
  });
}

function renderFeatureImportance(importance) {
  const container = document.getElementById('featureImportance');
  const maxVal = Math.max(...Object.values(importance));

  container.innerHTML = Object.entries(importance)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 8)
    .map(([name, value]) => `
      <div class="feature-item">
        <span class="feature-name">${name}</span>
        <div class="feature-bar">
          <div class="feature-fill" style="width: ${(value / maxVal * 100).toFixed(0)}%"></div>
        </div>
        <span style="font-weight: 700; color: var(--acc);">${value.toFixed(3)}</span>
      </div>
    `).join('');
}

async function trainModel() {
  const btn = document.getElementById('trainModelBtn');
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = '⏳ Tréning běží...';

  try {
    const res = await fetch('/api/learning/train', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await res.json();
    alert(result.message || 'Model trained!');
    await loadLearningStats();
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🧠 Přetrénovat Model';
  }
}

async function resetSettings() {
  if (!confirm('Opravdu resetovat všechna nastavení?')) return;

  try {
    await fetch('/api/settings/reset', { method: 'POST', credentials: 'include' });
    alert('Nastavení resetováno.');
    location.reload();
  } catch (e) {
    alert('Chyba: ' + e.message);
  }
}

// ============================================================================
// UTILS
// ============================================================================

function fmt(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(num);
}

function setElText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ============================================================================
// ADVANCED ANALYTICS
// ============================================================================

let _advTabsBound = false;

function loadAdvancedAnalytics() {
  // Taby scopované na #advanced-analytics + bind jen jednou
  // (globální selektor rozbíjel taby stránky #analytics a listenery se vršily)
  if (!_advTabsBound) {
    _advTabsBound = true;
    const tabBtns = document.querySelectorAll('#advanced-analytics .tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('#advanced-analytics .tab-content').forEach(c => c.classList.remove('active'));
        const tab = document.getElementById(btn.dataset.tab + '-tab');
        if (tab) tab.classList.add('active');
      });
    });
  }

  // Load backtest data
  loadBacktestSummary();
  loadLeaguePerformance();
  loadAgentVsManual();
  loadOddsAnalysis();
}

async function loadBacktestSummary() {
  try {
    const res = await fetch('/api/analytics/summary', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.success) return;

    const stats = data.bankroll_stats;

    setElText('backtestTotal', stats.total_bets || 0);
    setElText('backtestWinRate', (stats.win_rate || 0) + '%');
    setElText('backtestROI', (stats.roi || 0) + '%');
    setElText('backtestSharpe', (stats.sharpe_ratio || 0).toFixed(2));
    setElText('backtestDrawdown', '0%');
    setElText('backtestBalance', fmt(stats.balance || 0) + ' Kč');

    // Draw equity curve
    if (stats.equity && stats.equity.length > 0) {
      drawEquityCurve(stats.equity);
    }
  } catch (e) {
    console.error('Backtest error:', e);
  }
}

function drawEquityCurve(equity) {
  const svg = document.getElementById('backtestChartSVG');
  if (!svg) return;

  const width = 800, height = 300;
  const padding = 40;
  const plotWidth = width - 2 * padding;
  const plotHeight = height - 2 * padding;

  const minVal = Math.min(...equity);
  const maxVal = Math.max(...equity);
  const range = maxVal - minVal || 1;

  let path = '';
  equity.forEach((val, i) => {
    const x = padding + (i / (equity.length - 1 || 1)) * plotWidth;
    const y = height - padding - ((val - minVal) / range) * plotHeight;
    path += (i === 0 ? 'M' : 'L') + x + ',' + y;
  });

  svg.innerHTML = `
    <line x1="${padding}" y1="${height-padding}" x2="${width-padding}" y2="${height-padding}" stroke="var(--line)" stroke-width="1"/>
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height-padding}" stroke="var(--line)" stroke-width="1"/>
    <path d="${path}" stroke="var(--acc)" stroke-width="2" fill="none"/>
  `;
}

async function loadLeaguePerformance() {
  try {
    const res = await fetch('/api/backtest/best-leagues?top=5', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.success) return;

    const tbody = document.querySelector('#bestLeaguesTable tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    Object.entries(data.results || {}).forEach(([league, stats]) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${league}</td>
        <td>${stats.total_bets || 0}</td>
        <td>${stats.wins || 0}</td>
        <td>${(stats.win_rate || 0).toFixed(1)}%</td>
        <td>${fmt(stats.pnl || 0)} Kč</td>
        <td>${(stats.roi || 0).toFixed(1)}%</td>
      `;
      tbody.appendChild(row);
    });
  } catch (e) {
    console.error('League perf error:', e);
  }
}

async function loadAgentVsManual() {
  try {
    const res = await fetch('/api/backtest/agent-vs-manual', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.success || !data.results) return;

    const agent = data.results.agent || {};
    const manual = data.results.manual || {};
    const combined = data.results.combined || {};

    // Agent
    setElText('agentTotal', agent.total_bets || 0);
    setElText('agentWinRate', (agent.win_rate || 0).toFixed(1) + '%');
    setElText('agentROI', (agent.roi || 0).toFixed(1) + '%');
    setElText('agentPnL', fmt(agent.pnl || 0) + ' Kč');

    // Manual
    setElText('manualTotal', manual.total_bets || 0);
    setElText('manualWinRate', (manual.win_rate || 0).toFixed(1) + '%');
    setElText('manualROI', (manual.roi || 0).toFixed(1) + '%');
    setElText('manualPnL', fmt(manual.pnl || 0) + ' Kč');

    // Combined
    setElText('combinedTotal', combined.total_bets || 0);
    setElText('combinedWinRate', (combined.win_rate || 0).toFixed(1) + '%');
    setElText('combinedROI', (combined.roi || 0).toFixed(1) + '%');
    setElText('combinedPnL', fmt(combined.pnl || 0) + ' Kč');
  } catch (e) {
    console.error('Agent vs manual error:', e);
  }
}

async function loadOddsAnalysis() {
  try {
    const res = await fetch('/api/backtest/odds-ranges', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.success) return;

    const tbody = document.querySelector('#oddsTable tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    Object.entries(data.results || {}).forEach(([range, stats]) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${range}</td>
        <td>${stats.total_bets || 0}</td>
        <td>${stats.wins || 0}</td>
        <td>${(stats.win_rate || 0).toFixed(1)}%</td>
        <td>${fmt(stats.pnl || 0)} Kč</td>
        <td>${(stats.roi || 0).toFixed(1)}%</td>
      `;
      tbody.appendChild(row);
    });
  } catch (e) {
    console.error('Odds analysis error:', e);
  }
}

// ============================================================================
// MONITORING & REAL-TIME METRICS
// ============================================================================

async function loadMonitoringStatus() {
  try {
    const res = await fetch('/api/monitoring/summary', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();

    if (!data.success) return;

    const monitoring = data.monitoring || {};
    setElText('activeAlerts', monitoring.recent_alerts || '—');
    setElText('highPriorityAlerts', monitoring.high_priority_alerts || '—');
    setElText('lastAlert', monitoring.latest_alert?.type || 'None');
    setElText('modelHealth', 'Healthy');
  } catch (e) {
    console.error('Monitoring error:', e);
  }
}

// Automatically update monitoring every 30 seconds
setInterval(() => {
  if (STATE.currentPage === 'learning') {
    loadMonitoringStatus();
  }
}, 30000);

// ============================================================================
// BANKROLL ANALYTICS
// ============================================================================

function setupBankrollChartTabs() {
  document.querySelectorAll('.chart-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const chart = btn.dataset.chart;
      
      document.querySelectorAll('.chart-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.chart-tab-content').forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(chart + '-chart').classList.add('active');
    });
  });
}

async function renderBankrollPage() {
  try {
    setupBankrollChartTabs();
    
    const [summary, daily, monthly, best, streaks, hourly] = await Promise.all([
      fetch('/api/bankroll/summary', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/bankroll/daily', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/bankroll/monthly', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/bankroll/best-worst?n=5', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/bankroll/streaks', { credentials: 'include' }).then(r => r.json()),
      fetch('/api/bankroll/hourly', { credentials: 'include' }).then(r => r.json()),
    ]);

    if (summary.success) loadBankrollSummary(summary.summary);
    if (daily.success) renderDailyChart(daily.daily);
    if (monthly.success) renderMonthlyTable(monthly.monthly);
    if (best.success) renderBestWorstDays(best);
    if (streaks.success) renderStreaks(streaks.streaks);
    if (hourly.success) renderHourlyTable(hourly.hourly);
  } catch (e) {
    console.error('Bankroll error:', e);
  }
}

function loadBankrollSummary(summary) {
  setElText('summaryTotalBets', summary.total_bets || '—');
  setElText('summaryPnL', fmt(summary.total_pnl) + ' Kč');
  setElText('summaryROI', (summary.roi || 0).toFixed(2) + '%');
  setElText('summaryWinRate', (summary.win_rate || 0).toFixed(1) + '%');
  setElText('summaryWinDays', summary.winning_days || '—');
  setElText('summaryLoseDays', summary.losing_days || '—');
  setElText('summaryPeak', fmt(summary.peak_balance) + ' Kč');
  setElText('summaryTrough', fmt(summary.trough_balance) + ' Kč');
}

function renderDailyChart(dailyData) {
  const days = Object.keys(dailyData).slice(-30);
  const pnls = days.map(d => dailyData[d].pnl);
  
  const svg = document.getElementById('dailyChartSVG');
  if (!svg) return;
  
  const width = 1000, height = 300;
  const padding = 40;
  const plotWidth = width - 2 * padding;
  const plotHeight = height - 2 * padding;
  
  const minVal = Math.min(...pnls, 0);
  const maxVal = Math.max(...pnls, 0);
  const range = maxVal - minVal || 1;
  const zeroY = height - padding - ((0 - minVal) / range) * plotHeight;
  
  let bars = '';
  days.forEach((day, i) => {
    const x = padding + (i / (days.length - 1 || 1)) * plotWidth;
    const pnl = dailyData[day].pnl;
    const y = height - padding - ((pnl - minVal) / range) * plotHeight;
    const barHeight = Math.abs(zeroY - y);
    const barColor = pnl > 0 ? 'var(--pos)' : 'var(--bad)';
    const barY = Math.min(zeroY, y);
    
    bars += `<rect x="${x-3}" y="${barY}" width="6" height="${barHeight}" fill="${barColor}" opacity="0.7"/>`;
  });
  
  svg.innerHTML = `
    <line x1="${padding}" y1="${zeroY}" x2="${width-padding}" y2="${zeroY}" stroke="var(--line)" stroke-width="1"/>
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height-padding}" stroke="var(--line)" stroke-width="1"/>
    ${bars}
  `;
  
  // Render table
  const tbody = document.querySelector('#dailyTable tbody');
  if (tbody) {
    tbody.innerHTML = days.slice(-10).reverse().map(day => {
      const d = dailyData[day];
      return `
        <tr>
          <td>${day}</td>
          <td>${d.bets}</td>
          <td>${d.wins}</td>
          <td>${d.win_rate}%</td>
          <td style="color: ${d.pnl > 0 ? 'var(--pos)' : 'var(--bad)'}">${fmt(d.pnl)} Kč</td>
        </tr>
      `;
    }).join('');
  }
}

function renderMonthlyTable(monthlyData) {
  // Bankroll stránka má vlastní tabulku – #monthlyTable patří stránce Analytics
  const tbody = document.querySelector('#bankrollMonthlyTable tbody');
  if (!tbody) return;
  
  tbody.innerHTML = Object.entries(monthlyData).map(([month, d]) => `
    <tr>
      <td>${month}</td>
      <td>${d.bets}</td>
      <td>${d.wins}</td>
      <td>${d.win_rate}%</td>
      <td style="color: ${d.pnl > 0 ? 'var(--pos)' : 'var(--bad)'}">${fmt(d.pnl)} Kč</td>
      <td>${d.roi}%</td>
    </tr>
  `).join('');
}

function renderBestWorstDays(data) {
  const bestTbody = document.querySelector('#bestDaysTable tbody');
  const worstTbody = document.querySelector('#worstDaysTable tbody');
  
  if (bestTbody) {
    bestTbody.innerHTML = Object.entries(data.best_days).map(([day, d]) => `
      <tr>
        <td>${day}</td>
        <td style="color: var(--pos)">+${fmt(d.pnl)} Kč</td>
      </tr>
    `).join('');
  }
  
  if (worstTbody) {
    worstTbody.innerHTML = Object.entries(data.worst_days).map(([day, d]) => `
      <tr>
        <td>${day}</td>
        <td style="color: var(--bad)">${fmt(d.pnl)} Kč</td>
      </tr>
    `).join('');
  }
}

function renderStreaks(streaksData) {
  if (!streaksData) return;
  
  setElText('longestWinStreak', streaksData.longest_win_streak + ' 🏆' || '—');
  setElText('longestLossStreak', streaksData.longest_loss_streak + ' 📉' || '—');
  
  const current = streaksData.current_streak;
  const currentText = current ? `${current.length} ${current.type === 'win' ? '✅' : '❌'}` : '—';
  setElText('currentStreak', currentText);
}

function renderHourlyTable(hourlyData) {
  const tbody = document.querySelector('#hourlyTable tbody');
  if (!tbody) return;
  
  const sorted = Object.entries(hourlyData)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .slice(0, 10);
  
  tbody.innerHTML = sorted.map(([hour, d]) => `
    <tr>
      <td>${hour}</td>
      <td>${d.bets}</td>
      <td>${d.wins}</td>
      <td>${d.win_rate}%</td>
      <td style="color: ${d.pnl > 0 ? 'var(--pos)' : 'var(--bad)'}">${fmt(d.pnl)} Kč</td>
    </tr>
  `).join('');
}
