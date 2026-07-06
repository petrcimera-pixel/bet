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
    });
  });
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
      <div class="tip-item" onclick="showTipDetail('${b.id}')">
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

  const tbody = document.querySelector('#betsTable tbody');
  if (tbody && s.bets) {
    tbody.innerHTML = s.bets
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

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

      const tab = document.getElementById(`${tabName}-tab`);
      if (tab) tab.classList.add('active');
      btn.classList.add('active');
    });
  });

  // Filter
  const filterInput = document.getElementById('tipFilter');
  if (filterInput) {
    filterInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      document.querySelectorAll('.tip-item').forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(query) ? '' : 'none';
      });
    });
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

async function saveSettings() {
  const data = {
    enabled: document.getElementById('agentEnabled')?.checked || false,
    bet_today: document.getElementById('agentBetToday')?.checked || false,
    stake_mode: document.getElementById('stakeMode')?.value || 'kelly',
    stake: parseFloat(document.getElementById('flatStake')?.value || 10),
    kelly_fraction: 0.25,
    max_daily_stake_pct: 0.25,
    only_sharp: true
  };

  try {
    const res = await fetch('/api/agent/settings', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      console.log('Nastavení uloženo!');
      alert('Nastavení uloženo!');
      await loadSettings();
      initializeSettings();
      await loadStats();
      renderDashboard();
    } else {
      alert('Chyba při ukládání: ' + res.status);
    }
  } catch (e) {
    alert('Chyba: ' + e.message);
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
