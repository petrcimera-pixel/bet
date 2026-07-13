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

  // Init matches page controls
  initMatchesPage();

  // Vykresl dashboard
  renderDashboard();
  loadDashboardExtras();
  initSettlePanel();
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

  // bottom nav active stav
  document.querySelectorAll('.bottom-nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.page === pageName));

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
      case 'matches':
        loadMatches();
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

  // Balance change + peníze vázané v otevřených sázkách
  const change = s.balance - s.start_balance;
  const changeEl = document.getElementById('dashBalanceChange');
  if (changeEl) {
    const inPlay = s.open_stake ? ` · v sázkách ${fmt(s.open_stake)} ${cur}` : '';
    if (change > 0) {
      changeEl.textContent = `+${fmt(change)} od startu${inPlay}`;
      changeEl.style.color = 'var(--pos)';
    } else if (change < 0) {
      changeEl.textContent = `${fmt(change)} od startu${inPlay}`;
      changeEl.style.color = 'var(--bad)';
    } else {
      changeEl.textContent = `Beze změny${inPlay}`;
    }
  }

  // 7denní trend (z lokálních dat sázek)
  const week = (STATE.agentTips || []).filter(b => {
    const ts = (b.settled_ts || 0) * 1000;
    return (b.status === 'won' || b.status === 'lost') && ts > Date.now() - 7 * 86400000;
  });
  const weekPnl = week.reduce((sum, b) => sum + (b.pnl || 0), 0);
  const roiEl = document.getElementById('dashROI');
  if (roiEl && week.length) {
    roiEl.textContent = `${s.roi || 0}% ROI · 7 dní: ${weekPnl > 0 ? '+' : ''}${fmt(weekPnl)} ${cur}`;
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
          <div class="tip-teams">${b.outcome === 'acca' ? '🎫' : '🤖'} ${b.match || 'Neznámý zápas'}</div>
          <div class="tip-meta">
            <span>${czDate(b.match_date, b.match_time)} ${czTime(b.match_date, b.match_time)}</span>
            <span>${b.outcome === 'acca' ? `${(b.legs || []).length} tipů` : (b.league || 'Liga')}</span>
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
      <div class="tip-item" data-status="${b.status || 'open'}" data-acca="${b.outcome === 'acca' ? '1' : '0'}" onclick="showTipDetail('${b.id}')">
        <div class="tip-match">
          <div class="tip-teams">${b.outcome === 'acca' ? '🎫' : '🤖'} ${b.match || 'Neznámý zápas'}</div>
          <div class="tip-meta">
            <span>${czDate(b.match_date, b.match_time)} ${czTime(b.match_date, b.match_time)}</span>
            <span>${b.outcome === 'acca' ? `${(b.legs || []).length} tipů` : (b.league || 'Liga')}</span>
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
  const type = document.getElementById('tipType')?.value || '';

  document.querySelectorAll('#agentTipsContainer .tip-item').forEach(item => {
    const textOk = !query || item.textContent.toLowerCase().includes(query);
    const statusOk = !status || item.dataset.status === status;
    const isAcca = item.dataset.acca === '1';
    const typeOk = !type || (type === 'acca' ? isAcca : !isAcca);
    item.style.display = (textOk && statusOk && typeOk) ? '' : 'none';
  });
}

function showTipDetail(betId) {
  const bet = STATE.agentTips.find(b => b.id === betId);
  if (!bet) return;

  const modal = document.getElementById('tipDetailModal');
  const content = document.getElementById('tipDetailContent');

  if (!content) return;

  const isAcca = bet.outcome === 'acca';
  const legsHtml = isAcca && bet.legs ? `
    <h3 style="margin-top: 20px;">Tipy na tiketu (${bet.legs.length})</h3>
    <div style="margin: 10px 0;">
      ${bet.legs.map(l => `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
          <div>
            <div style="font-weight:600;">${l.match || '—'}</div>
            <div style="font-size:12px; color:var(--dim);">${l.name || l.outcome || ''} · ${l.date || ''} ${l.time || ''}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:monospace; font-weight:700;">${(l.odds || 0).toFixed(2)}</div>
            <div style="font-size:12px; color:${l.result === 'won' ? 'var(--pos)' : l.result === 'lost' ? 'var(--bad)' : 'var(--dim)'};">
              ${l.result === 'won' ? '✓ výhra' : l.result === 'lost' ? '✗ prohra' : 'čeká'}
            </div>
          </div>
        </div>
      `).join('')}
    </div>` : '';

  content.innerHTML = `
    <h2>${bet.match || 'Zápas'}</h2>
    <div style="margin: 20px 0; line-height: 1.8;">
      <p><strong>Tip:</strong> ${bet.label || '?'} @ ${bet.odds || 0}</p>
      <p><strong>Jistota:</strong> ${((bet.prob || 0) * 100).toFixed(1)}%</p>
      <p><strong>Vklad:</strong> ${fmt(bet.stake || 0)} Kč</p>
      <p><strong>Status:</strong> ${(bet.status || 'open').toUpperCase()}</p>
      <p><strong>P&L:</strong> ${bet.pnl > 0 ? '+' : ''}${fmt(bet.pnl || 0)} Kč</p>
      ${isAcca ? '' : `
      <p><strong>Liga:</strong> ${bet.league || '—'}</p>
      <p><strong>Čas:</strong> ${bet.match_date || '—'} ${bet.match_time || '—'}</p>`}
    </div>
    ${legsHtml}
    ${isAcca ? '' : `
    <h3 style="margin-top: 20px;">Proč agent vybral tento tip</h3>
    <ul style="margin: 10px 0 10px 20px;">
      ${(bet.why && bet.why.length)
        ? bet.why.map(w => `<li>${w}</li>`).join('')
        : `<li>Model udává ${((bet.prob || 0) * 100).toFixed(1)}% šanci na výhru</li>
           <li>${bet.market === 'corners' ? 'Trh: rohy (modelované kurzy)' : bet.odds_source === 'real' ? 'Reálné kurzy sázkovky' : 'Modelované kurzy'}</li>`}
    </ul>`}
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

  // Tutovka strategie
  const minProb = document.getElementById('agentMinProb');
  if (minProb) minProb.value = agent.min_prob ?? 0.75;
  const minOdds = document.getElementById('agentMinOdds');
  if (minOdds) minOdds.value = agent.min_odds ?? 1.20;

  const mkts = agent.markets || {};
  const mktIds = { winner: 'mktWinner', goals: 'mktGoals', btts: 'mktBtts', corners: 'mktCorners' };
  for (const [key, id] of Object.entries(mktIds)) {
    const el = document.getElementById(id);
    if (el) el.checked = mkts[key] !== false;
  }

  // Tikety
  const dailyTicket = document.getElementById('agentDailyTicket');
  if (dailyTicket) dailyTicket.checked = agent.daily_ticket !== false;
  const weekendTicket = document.getElementById('agentWeekendTicket');
  if (weekendTicket) weekendTicket.checked = agent.weekend_ticket !== false;
  const ticketStake = document.getElementById('agentTicketStake');
  if (ticketStake) ticketStake.value = agent.ticket_stake ?? 20;

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
  const typeSelect = document.getElementById('tipType');
  if (typeSelect) {
    typeSelect.addEventListener('change', applyTipFilters);
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
    only_sharp: saved.only_sharp ?? true,
    // Tutovka strategie
    min_prob: parseFloat(document.getElementById('agentMinProb')?.value) || saved.min_prob || 0.75,
    min_odds: parseFloat(document.getElementById('agentMinOdds')?.value) || saved.min_odds || 1.20,
    markets: {
      winner: document.getElementById('mktWinner')?.checked !== false,
      goals: document.getElementById('mktGoals')?.checked !== false,
      btts: document.getElementById('mktBtts')?.checked !== false,
      corners: document.getElementById('mktCorners')?.checked !== false,
    },
    sports: saved.sports || ['soccer', 'hockey', 'basketball'],
    // Tikety
    daily_ticket: document.getElementById('agentDailyTicket')?.checked !== false,
    daily_ticket_legs: saved.daily_ticket_legs ?? 3,
    ticket_stake: parseFloat(document.getElementById('agentTicketStake')?.value) || saved.ticket_stake || 20,
    weekend_ticket: document.getElementById('agentWeekendTicket')?.checked !== false,
    weekend_ticket_legs: saved.weekend_ticket_legs ?? 5,
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

// ============================================================================
// MATCHES PAGE
// ============================================================================

const MATCHES_STATE = {
  selectedDate: new Date().toISOString().slice(0, 10),
  sport: 'soccer',
  stripOffset: 0,
};

function _fmtDate(d) { return d.toISOString().slice(0, 10); }

function _dayLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const today = new Date(); today.setHours(12,0,0,0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return 'Dnes';
  if (diff === 1) return 'Zítra';
  if (diff === -1) return 'Včera';
  const days = ['Ne','Po','Út','St','Čt','Pá','So'];
  return days[d.getDay()] + ' ' + d.getDate() + '.' + (d.getMonth()+1) + '.';
}

function buildDayStrip() {
  const container = document.getElementById('dayStripDays');
  if (!container) return;
  const base = new Date(MATCHES_STATE.selectedDate + 'T12:00:00');
  const offset = MATCHES_STATE.stripOffset;
  let html = '';
  for (let i = -3 + offset; i <= 3 + offset; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const ds = _fmtDate(d);
    const isToday = ds === new Date().toISOString().slice(0, 10);
    const isSelected = ds === MATCHES_STATE.selectedDate;
    html += `<button class="day-btn${isSelected ? ' active' : ''}${isToday ? ' today' : ''}" data-date="${ds}">
      <span class="day-name">${_dayLabel(ds)}</span>
      <span class="day-num">${d.getDate()}.${d.getMonth()+1}.</span>
    </button>`;
  }
  container.innerHTML = html;
  container.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      MATCHES_STATE.selectedDate = btn.dataset.date;
      MATCHES_STATE.stripOffset = 0;
      buildDayStrip();
      loadMatches();
    });
  });
}

function initMatchesPage() {
  if (!document.getElementById('dayStripDays')) return;

  buildDayStrip();

  document.getElementById('matchesPrevDay').addEventListener('click', () => {
    const d = new Date(MATCHES_STATE.selectedDate + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    MATCHES_STATE.selectedDate = _fmtDate(d);
    buildDayStrip();
    loadMatches();
  });

  document.getElementById('matchesNextDay').addEventListener('click', () => {
    const d = new Date(MATCHES_STATE.selectedDate + 'T12:00:00');
    d.setDate(d.getDate() + 1);
    MATCHES_STATE.selectedDate = _fmtDate(d);
    buildDayStrip();
    loadMatches();
  });

  document.querySelectorAll('.sport-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sport-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      MATCHES_STATE.sport = btn.dataset.sport;
      loadMatches();
    });
  });

  document.getElementById('matchesRefreshBtn').addEventListener('click', () => loadMatches(true));

  // Filtry – jen překreslení, bez nového fetche
  ['filterRealOdds', 'filterTutovky', 'filterUpcoming'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (MATCHES_STATE.lastLeagues) {
        renderMatchesLeagues(MATCHES_STATE.lastLeagues, document.getElementById('matchesContainer'));
      }
    });
  });

  // Mobilní bottom nav
  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });
}

async function loadMatches(refresh = false) {
  const container = document.getElementById('matchesContainer');
  const summary = document.getElementById('matchesSummary');
  if (!container) return;

  container.innerHTML = '<div class="loading">Načítání zápasů...</div>';
  summary.innerHTML = '';

  try {
    const url = `/api/matches?date=${MATCHES_STATE.selectedDate}&sport=${MATCHES_STATE.sport}&days=1${refresh ? '&refresh=1' : ''}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderMatchesSummary(data, summary);
    renderMatchesLeagues(data.leagues || [], container);
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Chyba: ${e.message}</div>`;
  }
}

function renderMatchesSummary(data, el) {
  const tip = data.tip;
  el.innerHTML = `
    <div class="matches-summary-bar">
      <div class="summary-stat"><span class="summary-num">${data.total_matches}</span> zápasů</div>
      <div class="summary-stat"><span class="summary-num">${data.total_leagues}</span> lig</div>
      <div class="summary-stat accent"><span class="summary-num">${data.value_count || 0}</span> value</div>
      ${tip ? `<div class="summary-tip">💡 <strong>${tip.home}</strong> vs <strong>${tip.away}</strong> — <span class="pick-badge pick-${tip.pick}">${tip.pick === 'home' ? '1' : tip.pick === 'draw' ? 'X' : '2'}</span> @ ${(tip.best_value.odds || 0).toFixed(2)}</div>` : ''}
    </div>
  `;
}

const FAV_LEAGUES_KEY = 'kurzanalytik_fav_leagues';

function getFavLeagues() {
  try { return new Set(JSON.parse(localStorage.getItem(FAV_LEAGUES_KEY) || '[]')); }
  catch { return new Set(); }
}

function toggleFavLeague(league) {
  const favs = getFavLeagues();
  if (favs.has(league)) favs.delete(league); else favs.add(league);
  localStorage.setItem(FAV_LEAGUES_KEY, JSON.stringify([...favs]));
  if (MATCHES_STATE.lastLeagues) {
    renderMatchesLeagues(MATCHES_STATE.lastLeagues, document.getElementById('matchesContainer'));
  }
}

function _matchPassesFilters(m) {
  const probs = m.probs || {};
  if (document.getElementById('filterRealOdds')?.checked && m.odds_source !== 'real') return false;
  if (document.getElementById('filterUpcoming')?.checked && (m.result || m.live)) return false;
  if (document.getElementById('filterTutovky')?.checked) {
    const maxProb = Math.max(...Object.values(probs), 0);
    if (maxProb < 0.75) return false;
  }
  return true;
}

function renderMatchesLeagues(leagues, container) {
  MATCHES_STATE.lastLeagues = leagues;
  if (!leagues.length) {
    container.innerHTML = '<div class="empty-state">Žádné zápasy pro tento den a sport</div>';
    return;
  }
  const favs = getFavLeagues();
  // oblíbené ligy první
  const sorted = [...leagues].sort((a, b) =>
    (favs.has(b.league) ? 1 : 0) - (favs.has(a.league) ? 1 : 0));

  let html = '';
  for (const lg of sorted) {
    const matches = lg.matches.filter(_matchPassesFilters);
    if (!matches.length) continue;
    const isFav = favs.has(lg.league);
    html += `
    <div class="match-league">
      <div class="match-league-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="league-star ${isFav ? 'fav' : ''}" onclick="event.stopPropagation(); toggleFavLeague('${lg.league.replace(/'/g, "\\'")}')">${isFav ? '★' : '☆'}</span>
        <span class="league-flag">${lg.flag || '🏳️'}</span>
        <span class="league-name">${lg.league}</span>
        <span class="league-count">${matches.length}</span>
        <span class="league-chevron">▾</span>
      </div>
      <div class="match-league-body">
        ${matches.map(m => renderMatchRow(m)).join('')}
      </div>
    </div>`;
  }
  container.innerHTML = html || '<div class="empty-state">Žádný zápas neodpovídá filtrům</div>';
}

function renderMatchRow(m) {
  const probs = m.probs || {};
  const bv = m.best_value || {};
  const odds = m.odds || {};
  const isValue = bv.is_value;
  const isReal = m.odds_source === 'real';

  let statusHtml;
  if (m.live) {
    statusHtml = `<span class="status-live">${m.status || 'LIVE'}</span>`;
  } else if (m.result) {
    statusHtml = `<span class="status-ft">Ukončen</span>`;
  } else {
    statusHtml = `<span class="status-time">${czTime(m.date, m.time)}</span>`;
  }

  let scoreHtml;
  if (m.result) {
    scoreHtml = `<span class="score final">${m.result.home} – ${m.result.away}</span>`;
  } else if (m.live) {
    scoreHtml = `<span class="score live">${m.result ? m.result.home + ' – ' + m.result.away : '— – —'}</span>`;
  } else {
    scoreHtml = `<span class="score upcoming">–</span>`;
  }

  // kurzy 1 / X / 2 vedle sebe, zvýrazněný pick modelu
  const oddsKeys = 'draw' in odds ? ['home', 'draw', 'away'] : ['home', 'away'];
  const oddsHtml = oddsKeys.map(k => {
    const o = odds[k];
    const lbl = k === 'home' ? '1' : k === 'draw' ? 'X' : '2';
    const isPick = m.pick === k;
    return `<span class="odd-cell ${isPick ? 'pick' : ''}" title="${lbl}${probs[k] ? ': ' + (probs[k]*100).toFixed(0) + '%' : ''}">${o ? o.toFixed(2) : '—'}</span>`;
  }).join('');

  const probPct = probs[m.pick] ? (probs[m.pick] * 100).toFixed(0) + '%' : '';

  return `
    <div class="match-row${isValue ? ' value' : ''}${m.live ? ' live' : ''}" onclick='showMatchDetail(${JSON.stringify(m.id)})'>
      <div class="mr-status">${statusHtml}${isReal ? '<span class="real-dot" title="Reálné kurzy sázkovky">●</span>' : ''}</div>
      <div class="mr-teams">
        <span class="team home">${m.home}</span>
        <span class="team away">${m.away}</span>
      </div>
      <div class="mr-score">${scoreHtml}</div>
      <div class="mr-odds">${oddsHtml}</div>
      <div class="mr-prediction">
        ${probPct ? `<span class="pred-prob">${probPct}</span>` : ''}
      </div>
      <div class="mr-value">${isValue ? `<span class="value-tag">${(bv.odds || 0).toFixed(2)} <small>EV ${((bv.ev || 0) * 100).toFixed(0)}%</small></span>` : ''}</div>
    </div>
  `;
}

// ============================================================================
// MATCH DETAIL MODAL
// ============================================================================

function _findMatch(id) {
  for (const lg of MATCHES_STATE.lastLeagues || []) {
    const m = lg.matches.find(x => x.id === id);
    if (m) return { ...m, flag: lg.flag };
  }
  return null;
}

function closeMatchDetail() {
  const modal = document.getElementById('matchDetailModal');
  if (modal) { modal.classList.add('hidden'); modal.classList.remove('active'); }
}

async function showMatchDetail(id) {
  const m = _findMatch(id);
  if (!m) return;
  const modal = document.getElementById('matchDetailModal');
  const content = document.getElementById('matchDetailContent');
  if (!content) return;

  const probs = m.probs || {};
  const odds = m.odds || {};
  const keys = 'draw' in odds ? ['home', 'draw', 'away'] : ['home', 'away'];
  const lbl = { home: '1', draw: 'X', away: '2' };

  const marketsHtml = keys.map(k => `
    <div class="md-market ${m.pick === k ? 'pick' : ''}">
      <div class="md-market-lbl">${lbl[k]}</div>
      <div class="md-market-odds">${odds[k] ? odds[k].toFixed(2) : '—'}</div>
      <div class="md-market-prob">${probs[k] ? (probs[k]*100).toFixed(0)+' %' : ''}</div>
    </div>`).join('');

  const glHtml = (m.goal_lines || []).map(g => `
    <div class="md-line">
      <span>Góly ${g.line}</span>
      <span>Over ${g.over.best_odds ? g.over.best_odds.toFixed(2) : '—'} (${(g.over.prob*100).toFixed(0)} %)</span>
      <span>Under ${g.under.best_odds ? g.under.best_odds.toFixed(2) : '—'} (${(g.under.prob*100).toFixed(0)} %)</span>
    </div>`).join('');

  const clHtml = (m.corner_lines || []).map(g => `
    <div class="md-line">
      <span>Rohy ${g.line}${m.exp_corners ? ` (oček. ${m.exp_corners})` : ''}</span>
      <span>Over ${g.over.best_odds ? g.over.best_odds.toFixed(2) : '—'} (${(g.over.prob*100).toFixed(0)} %)</span>
      <span>Under ${g.under.best_odds ? g.under.best_odds.toFixed(2) : '—'} (${(g.under.prob*100).toFixed(0)} %)</span>
    </div>`).join('');

  const scoresHtml = (m.top_scores || []).map(s =>
    `<span class="md-score-chip">${s.score} <small>${(s.prob*100).toFixed(0)} %</small></span>`).join('');

  content.innerHTML = `
    <h2>${m.flag || ''} ${m.home} – ${m.away}</h2>
    <div class="md-meta">${m.league} · ${czDate(m.date, m.time)} ${czTime(m.date, m.time)}
      ${m.odds_source === 'real' ? '· <span class="real-dot">●</span> reálné kurzy' : '· modelované kurzy'}</div>
    ${m.result ? `<div class="md-result">Výsledek: <strong>${m.result.home} – ${m.result.away}</strong></div>` : ''}
    <h3>Vítěz zápasu</h3>
    <div class="md-markets">${marketsHtml}</div>
    ${m.exp_goals ? `<div class="md-meta">Očekávané góly: ${m.exp_goals.home} – ${m.exp_goals.away} (celkem ${m.exp_total})</div>` : ''}
    ${scoresHtml ? `<h3>Nejpravděpodobnější výsledky</h3><div class="md-scores">${scoresHtml}</div>` : ''}
    ${glHtml ? `<h3>Góly Over/Under</h3>${glHtml}` : ''}
    ${clHtml ? `<h3>Rohy</h3>${clHtml}` : ''}
    <h3>Forma týmů</h3>
    <div id="mdForm" class="md-form"><div class="loading">Načítání formy...</div></div>
  `;
  modal.classList.remove('hidden');
  modal.classList.add('active');

  // Forma + H2H on-demand z ESPN
  try {
    const q = new URLSearchParams({ sport: m.sport || 'soccer', slug: m.slug || '',
      home_id: m.home_id || '', away_id: m.away_id || '', home: m.home, away: m.away });
    const res = await fetch(`/api/form?${q}`, { credentials: 'include' });
    const f = await res.json();
    const formEl = document.getElementById('mdForm');
    if (!formEl) return;
    const score = g => (g.gf != null && g.ga != null) ? `${g.gf}:${g.ga}` : '';
    const fmtForm = (games) => (games || []).slice(0, 5).map(g =>
      `<span class="form-chip ${g.res === 'W' ? 'w' : g.res === 'L' ? 'l' : 'd'}" title="${g.opp || ''} ${score(g)}">${g.res || '?'}</span>`).join('');
    const h2h = (f.h2h || []).slice(0, 3).map(g =>
      `<div class="md-h2h-row">${g.date || ''} · ${g.opp || ''} · ${score(g)} (${g.res || '?'})</div>`).join('');
    formEl.innerHTML = `
      <div class="md-form-row"><strong>${m.home}:</strong> ${fmtForm(f.home) || '—'}</div>
      <div class="md-form-row"><strong>${m.away}:</strong> ${fmtForm(f.away) || '—'}</div>
      ${h2h ? `<h4>Vzájemné zápasy</h4>${h2h}` : ''}
    `;
  } catch {
    const formEl = document.getElementById('mdForm');
    if (formEl) formEl.innerHTML = '<div class="empty-state">Forma není k dispozici</div>';
  }
}

// ============================================================================
// ČESKÝ ČAS — ESPN vrací UTC, převádíme na lokální čas prohlížeče
// ============================================================================

function czTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return timeStr || '—';
  try {
    const d = new Date(`${dateStr}T${timeStr}:00Z`);
    if (isNaN(d)) return timeStr;
    return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
  } catch { return timeStr; }
}

function czDate(dateStr, timeStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(`${dateStr}T${timeStr || '12:00'}:00Z`);
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' });
  } catch { return dateStr; }
}

// ============================================================================
// DASHBOARD EXTRAS — tip dne, dnešní tiket, včerejší bilance
// ============================================================================

async function loadDashboardExtras(attempt = 0) {
  try {
    const res = await fetch('/api/dashboard', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    renderTodayTicket(d.ticket);
    renderYesterdayBanner(d.yesterday, d.last_run);
    if (d.warming && attempt < 12) {
      // server teprve stahuje zápasy z ESPN – zkus znovu za 15 s
      const el = document.getElementById('tipOfDayContainer');
      if (el) el.innerHTML = '<div class="loading">Stahuji dnešní zápasy z ESPN...</div>';
      setTimeout(() => loadDashboardExtras(attempt + 1), 15000);
      return;
    }
    renderTipOfDay(d.tip, d.tutovka);
  } catch (e) {
    console.error('Dashboard extras error:', e);
    if (attempt < 3) { setTimeout(() => loadDashboardExtras(attempt + 1), 10000); return; }
    const el = document.getElementById('tipOfDayContainer');
    if (el) el.innerHTML = '<div class="empty-state">Nepodařilo se načíst</div>';
  }
}

function renderTipOfDay(tip, tutovka) {
  const el = document.getElementById('tipOfDayContainer');
  if (!el) return;
  if (!tip) {
    el.innerHTML = '<div class="empty-state">Dnes žádná tutovka nesplňuje kritéria</div>';
    return;
  }
  const acc = tutovka?.accuracy != null
    ? `<div class="tip-day-acc">Tutovky historicky: ${tutovka.won}/${tutovka.settled} (${tutovka.accuracy} %)</div>` : '';
  el.innerHTML = `
    <div class="tip-day-match">${tip.match}</div>
    <div class="tip-day-meta">${tip.league} · ${czDate(tip.date, tip.time)} ${czTime(tip.date, tip.time)}</div>
    <div class="tip-day-bet">
      <span class="tip-day-pick">${tip.name}</span>
      <span class="tip-day-odds">${(tip.odds || 0).toFixed(2)}</span>
    </div>
    <div class="tip-day-prob">
      <div class="prob-bar"><div class="prob-fill" style="width:${(tip.prob * 100).toFixed(0)}%"></div></div>
      <span>${(tip.prob * 100).toFixed(0)} % jistota${tip.real ? ' · reálný kurz' : ''}</span>
    </div>
    ${acc}
  `;
}

function renderTodayTicket(ticket) {
  const el = document.getElementById('todayTicketContainer');
  if (!el) return;
  if (!ticket) {
    el.innerHTML = '<div class="empty-state">Agent dnes tiket nevytvořil</div>';
    return;
  }
  const legs = (ticket.legs || []).map(l => `
    <div class="ticket-leg">
      <span class="ticket-leg-status ${l.result === 'won' ? 'won' : l.result === 'lost' ? 'lost' : ''}">${l.result === 'won' ? '✓' : l.result === 'lost' ? '✗' : '·'}</span>
      <span class="ticket-leg-match">${l.match}</span>
      <span class="ticket-leg-odds">${(l.odds || 0).toFixed(2)}</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="ticket-head">
      <span>${ticket.match}</span>
      <span class="ticket-total">${(ticket.odds || 0).toFixed(2)}×</span>
    </div>
    ${legs}
    <div class="ticket-foot">
      Vklad ${fmt(ticket.stake)} Kč → možná výhra ${fmt(ticket.stake * ticket.odds)} Kč
      <span class="tip-badge" data-status="${ticket.status}">${(ticket.status || 'open').toUpperCase()}</span>
    </div>
  `;
}

function renderYesterdayBanner(y, lastRun) {
  const el = document.getElementById('yesterdayBanner');
  if (!el) return;
  const parts = [];
  if (y && y.settled > 0) {
    const cls = y.pnl >= 0 ? 'pos' : 'neg';
    parts.push(`Včera: ${y.won}/${y.settled} výher, <strong class="${cls}">${y.pnl > 0 ? '+' : ''}${fmt(y.pnl)} Kč</strong>`);
  }
  if (lastRun && lastRun.ts) {
    const t = new Date(lastRun.ts * 1000).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    parts.push(`Poslední běh agenta ${t} (${lastRun.mode === 'auto' ? 'auto' : 'ručně'}): ${lastRun.placed} sázek${(lastRun.tickets || []).length ? ' + tiket' : ''}`);
  }
  if (!parts.length) { el.classList.add('hidden'); return; }
  el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
  el.classList.remove('hidden');
}

// ============================================================================
// SETTLE PROGRESS — průběh vyhodnocování zápasů
// ============================================================================

let _settleTimer = null;

function initSettlePanel() {
  const btn = document.getElementById('settleNowBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Vyhodnocuji...';
      try {
        await fetch('/api/tips/settle', { method: 'POST', credentials: 'include' });
        await loadStats();          // obnov bank i tipy
        renderDashboard();
      } catch (e) { console.error('Settle error:', e); }
      btn.disabled = false;
      btn.textContent = 'Zkontrolovat výsledky';
      pollSettleStatus();
    });
  }
  pollSettleStatus();
}

async function pollSettleStatus() {
  clearTimeout(_settleTimer);
  let interval = 30000;
  try {
    const res = await fetch('/api/settle/status', { credentials: 'include' });
    if (res.ok) {
      const s = await res.json();
      renderSettlePanel(s);
      interval = s.in_progress ? 5000 : 30000;   // při běhu obnovuj rychleji
    }
  } catch (e) { /* ticho – další pokus za interval */ }
  _settleTimer = setTimeout(pollSettleStatus, interval);
}

function renderSettlePanel(s) {
  const panel = document.getElementById('settlePanel');
  if (!panel) return;
  const totalOpen = (s.open_tips || 0) + (s.open_bets || 0);
  const text = document.getElementById('settleText');
  const sub = document.getElementById('settleSub');
  const icon = document.getElementById('settleIcon');
  const progWrap = document.getElementById('settleProgressWrap');
  const progFill = document.getElementById('settleProgressFill');

  if (totalOpen === 0 && !s.in_progress) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  if (s.in_progress) {
    icon.textContent = '🔄';
    icon.classList.add('spin');
    text.textContent = `Vyhodnocování běží — ${s.settled_so_far || 0} vyřešeno`;
    const pct = s.total_pending ? Math.min(100, (s.settled_so_far / s.total_pending) * 100) : 0;
    progWrap.classList.remove('hidden');
    progFill.style.width = pct.toFixed(0) + '%';
    sub.textContent = `Čeká ${totalOpen} položek (${s.open_bets || 0} sázek, ${s.open_tips || 0} tipů)${s.more_pending ? ' · další dávka následuje' : ''}`;
  } else {
    icon.textContent = '⏳';
    icon.classList.remove('spin');
    progWrap.classList.add('hidden');
    text.textContent = `Čeká na vyhodnocení: ${totalOpen} položek`;
    const last = s.last_check
      ? new Date(s.last_check * 1000).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
      : null;
    sub.textContent = `${s.open_bets || 0} sázek + ${s.open_tips || 0} tipů modelu` +
      (last ? ` · poslední kontrola ${last}` : ' · kontrola běží automaticky na pozadí');
  }
}
