// ============================================================================
// KurzAnalytik Pro — Nový Frontend (2026)
// ============================================================================

const STATE = {
  currentPage: 'dashboard',
  stats: null,
  tips: [],
  agentTips: [],
  settings: null,
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', init);

async function init() {
  setupNavigation();
  setupTabs();
  setupSettings();

  // Načti data
  await loadStats();
  await loadSettings();

  // Vykresl dashboard
  renderDashboard();
}

// ============================================================================
// NAVIGATION
// ============================================================================

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const page = btn.dataset.page;
      showPage(page);
    });
  });
}

function showPage(pageName) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  // Show selected page
  const page = document.getElementById(pageName);
  const navBtn = document.querySelector(`[data-page="${pageName}"]`);

  if (page) {
    page.classList.add('active');
  }
  if (navBtn) {
    navBtn.classList.add('active');
  }

  STATE.currentPage = pageName;

  // Load data specific to page
  switch(pageName) {
    case 'agent-tips':
      loadAgentTips();
      break;
    case 'analytics':
      loadAnalytics();
      break;
    case 'bankroll':
      loadBankroll();
      break;
  }
}

// ============================================================================
// API CALLS
// ============================================================================

async function loadStats() {
  try {
    const res = await fetch('/api/bankroll');
    STATE.stats = await res.json();
  } catch (e) {
    console.error('Error loading stats:', e);
  }
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    STATE.settings = await res.json();
  } catch (e) {
    console.error('Error loading settings:', e);
  }
}

async function loadAgentTips() {
  try {
    const res = await fetch('/api/agent');
    const data = await res.json();
    STATE.agentTips = data.bets || [];
    renderAgentTips();
  } catch (e) {
    console.error('Error loading agent tips:', e);
  }
}

async function loadAnalytics() {
  try {
    const res = await fetch('/api/bankroll');
    STATE.stats = await res.json();
    renderAnalytics();
  } catch (e) {
    console.error('Error loading analytics:', e);
  }
}

async function loadBankroll() {
  try {
    const res = await fetch('/api/bankroll');
    STATE.stats = await res.json();
    renderBankroll();
  } catch (e) {
    console.error('Error loading bankroll:', e);
  }
}

// ============================================================================
// DASHBOARD RENDERING
// ============================================================================

function renderDashboard() {
  if (!STATE.stats) return;

  // Stats cards
  const stats = STATE.stats;

  document.getElementById('dashBalance').textContent = fmt(stats.balance) + ' ' + stats.currency;
  document.getElementById('dashProfit').textContent = fmt(stats.profit) + ' ' + stats.currency;
  document.getElementById('dashROI').textContent = stats.roi + '% ROI';
  document.getElementById('dashWinRate').textContent = stats.win_rate + '%';
  document.getElementById('dashWinCount').textContent = `${stats.won_count}/${stats.settled_count} výher`;
  document.getElementById('dashSharpe').textContent = (stats.sharpe_ratio || 0).toFixed(2);

  // Balance change
  const change = stats.balance - stats.start_balance;
  const changeEl = document.getElementById('dashBalanceChange');
  if (change > 0) {
    changeEl.textContent = `+${fmt(change)} od startu`;
    changeEl.className = 'stat-subtext positive';
  } else if (change < 0) {
    changeEl.textContent = `${fmt(change)} od startu`;
    changeEl.className = 'stat-subtext negative';
  } else {
    changeEl.textContent = 'Beze změny';
  }

  // Tips for today/tomorrow
  loadDashboardTips();

  // Agent status
  loadAgentStatus();
}

async function loadDashboardTips() {
  try {
    // Načti zítřejší tipy
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Můžeš vytvořit nový endpoint nebo použít existující
    const html = `<div class="loading">Tipy se načítají...</div>`;
    document.getElementById('dashTipsContainer').innerHTML = html;
  } catch (e) {
    console.error('Error loading tips:', e);
  }
}

async function loadAgentStatus() {
  try {
    const res = await fetch('/api/agent');
    const data = await res.json();

    const stats = data.stats || {};
    const lastRun = data.bets?.[0];

    document.getElementById('agentStatus').textContent =
      `${stats.placed || 0} sázek umístěno dnes`;

    if (lastRun) {
      document.getElementById('agentLastRun').innerHTML = `
        <div class="agent-info">
          <strong>Poslední běh:</strong> Právě teď<br>
          <strong>Umístěno:</strong> ${stats.placed || 0} sázek<br>
          <strong>Přeskočeno:</strong> ${stats.skipped_not_sharp || 0} (soft) + ${stats.skipped_duplicate || 0} (duplikáty)
        </div>
      `;
    }
  } catch (e) {
    console.error('Error loading agent status:', e);
  }
}

// ============================================================================
// AGENT TIPS RENDERING
// ============================================================================

function renderAgentTips() {
  const container = document.getElementById('agentTipsContainer');

  if (!STATE.agentTips.length) {
    container.innerHTML = '<div class="loading">Žádné sázky agenta</div>';
    return;
  }

  container.innerHTML = STATE.agentTips
    .filter(b => b.tag === 'bet-agent')
    .map(b => `
      <div class="tip-item" onclick="showTipDetail('${b.id}')">
        <div class="tip-match">
          <div class="tip-teams">🤖 ${b.match}</div>
          <div class="tip-meta">
            <span>${b.match_date} ${b.match_time}</span>
            <span>${b.league}</span>
          </div>
          <div class="tip-meta">
            <span>${b.label}</span>
            <span>${b.odds}× @ ${b.prob * 100 | 0}%</span>
          </div>
        </div>
        <div class="tip-prediction">
          <span class="tip-badge">${b.status.toUpperCase()}</span>
          <strong>${b.pnl > 0 ? '+' : ''}${fmt(b.pnl)}</strong>
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

  content.innerHTML = `
    <h2>${bet.match}</h2>
    <div style="margin: 20px 0;">
      <p><strong>Tip:</strong> ${bet.label} @ ${bet.odds}</p>
      <p><strong>Jistota:</strong> ${(bet.prob * 100).toFixed(1)}%</p>
      <p><strong>Vklad:</strong> ${fmt(bet.stake)} Kč</p>
      <p><strong>Status:</strong> ${bet.status.toUpperCase()}</p>
      <p><strong>P&L:</strong> ${bet.pnl > 0 ? '+' : ''}${fmt(bet.pnl)} Kč</p>
      <p><strong>Liga:</strong> ${bet.league}</p>
      <p><strong>Čas:</strong> ${bet.match_date} ${bet.match_time}</p>
    </div>

    <h3 style="margin-top: 20px;">Vysvětlení tipu</h3>
    <p>Agent vybral tento tip protože:</p>
    <ul style="margin: 10px 0 10px 20px;">
      <li><strong>Jistota ≥ 55%:</strong> Model udává ${(bet.prob * 100).toFixed(1)}% šanci na výhru</li>
      <li><strong>Value příležitost:</strong> Kurz je lepší než model doporučuje</li>
      <li><strong>Kelly kritérium:</strong> Vklad ${fmt(bet.stake)} Kč odpovídá frakčnímu Kelly</li>
    </ul>

    <h3 style="margin-top: 20px;">Historie</h3>
    <p>Tuto sázku agent umístil: ${new Date(bet.ts * 1000).toLocaleString('cs-CZ')}</p>
  `;

  modal.classList.add('active');
  modal.classList.remove('hidden');
}

// ============================================================================
// ANALYTICS RENDERING
// ============================================================================

function renderAnalytics() {
  if (!STATE.stats) return;

  // Monthly tab
  renderMonthlyAnalytics();

  // Leagues tab
  renderLeaguesAnalytics();
}

function renderMonthlyAnalytics() {
  const stats = STATE.stats;
  const monthly = stats.monthly_pnl || {};

  const table = document.querySelector('#monthlyTable tbody');
  table.innerHTML = Object.entries(monthly)
    .reverse()
    .map(([month, pnl]) => `
      <tr>
        <td>${month}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td class="${pnl > 0 ? 'positive' : 'negative'}">${pnl > 0 ? '+' : ''}${fmt(pnl)} Kč</td>
        <td>—</td>
      </tr>
    `)
    .join('');
}

function renderLeaguesAnalytics() {
  const stats = STATE.stats;
  const byLeague = stats.by_league || {};

  const table = document.querySelector('#leaguesTable tbody');
  table.innerHTML = Object.entries(byLeague)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([league, data]) => `
      <tr>
        <td>${league}</td>
        <td>${data.settled}</td>
        <td>${data.wins}</td>
        <td>${data.win_rate}%</td>
        <td class="${data.pnl > 0 ? 'positive' : 'negative'}">${data.pnl > 0 ? '+' : ''}${fmt(data.pnl)} Kč</td>
        <td>${data.roi > 0 ? '+' : ''}${data.roi}%</td>
      </tr>
    `)
    .join('');
}

// ============================================================================
// BANKROLL RENDERING
// ============================================================================

function renderBankroll() {
  const stats = STATE.stats;

  document.getElementById('startBalance').textContent = fmt(stats.start_balance) + ' Kč';
  document.getElementById('currentBalance').textContent = fmt(stats.balance) + ' Kč';
  document.getElementById('openBets').textContent = stats.open_count;

  // Bets table
  const table = document.querySelector('#betsTable tbody');
  const bets = STATE.stats?.bets || [];

  table.innerHTML = bets
    .slice(0, 50)
    .map(b => `
      <tr>
        <td>${b.match}</td>
        <td>${b.label}</td>
        <td>${fmt(b.stake)} Kč</td>
        <td>${b.odds}×</td>
        <td><span class="tip-badge">${b.status.toUpperCase()}</span></td>
        <td class="${b.pnl > 0 ? 'positive' : 'negative'}">${b.pnl > 0 ? '+' : ''}${fmt(b.pnl)} Kč</td>
      </tr>
    `)
    .join('');
}

// ============================================================================
// SETTINGS & CONTROLS
// ============================================================================

function setupSettings() {
  document.getElementById('runAgentBtn')?.addEventListener('click', runAgent);
  document.getElementById('saveSettings')?.addEventListener('click', saveSettings);
  document.getElementById('resetSettings')?.addEventListener('click', resetSettings);

  // Load current settings
  if (STATE.settings?.agent) {
    const agent = STATE.settings.agent;
    document.getElementById('agentEnabled').checked = agent.enabled;
    document.getElementById('agentBetToday').checked = agent.bet_today;
    document.getElementById('stakeMode').value = agent.stake_mode;
    document.getElementById('flatStake').value = agent.stake;
  }
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;

      // Hide all tabs
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

      // Show selected tab
      document.getElementById(`${tabName}-tab`)?.classList.add('active');
      btn.classList.add('active');
    });
  });
}

async function runAgent() {
  const btn = document.getElementById('runAgentBtn');
  btn.disabled = true;
  btn.textContent = 'Běží...';

  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: true })
    });

    const result = await res.json();
    alert(`Agent umístil ${result.placed} sázek.`);

    // Reload stats
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
    enabled: document.getElementById('agentEnabled').checked,
    bet_today: document.getElementById('agentBetToday').checked,
    stake_mode: document.getElementById('stakeMode').value,
    stake: parseFloat(document.getElementById('flatStake').value),
    kelly_fraction: 0.25,
    max_daily_stake_pct: 0.25,
    only_sharp: true
  };

  try {
    const res = await fetch('/api/agent/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    await res.json();
    alert('Nastavení uloženo!');
  } catch (e) {
    alert('Chyba: ' + e.message);
  }
}

async function resetSettings() {
  if (confirm('Opravdu resetovat všechna nastavení?')) {
    try {
      await fetch('/api/settings/reset', { method: 'POST' });
      await loadSettings();
      alert('Nastavení resetováno na výchozí hodnoty.');
      location.reload();
    } catch (e) {
      alert('Chyba: ' + e.message);
    }
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function fmt(num) {
  if (num === null || num === undefined) return '—';
  return new Intl.NumberFormat('cs-CZ', {
    maximumFractionDigits: 2
  }).format(num);
}

// Modal close
document.addEventListener('click', (e) => {
  if (e.target.id === 'tipDetailModal') {
    e.target.classList.remove('active');
    e.target.classList.add('hidden');
  }

  if (e.target.classList.contains('modal-close')) {
    e.target.closest('.modal').classList.remove('active');
    e.target.closest('.modal').classList.add('hidden');
  }
});

// Filter tips
document.getElementById('tipFilter')?.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  document.querySelectorAll('.tip-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    item.style.display = text.includes(query) ? '' : 'none';
  });
});
