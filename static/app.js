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
function fmt(num) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(num);
}
function pct(num, digits = 1) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  // cs-CZ: desetinná čárka + tenké mezerování před % kvůli konzistenci s fmt()
  return new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(num) + ' %';
}
/** Číslo s českou desetinnou čárkou bez jednotky – pro místa jako "p.b.",
 *  kde pct() by jednotku zdvojil. */
function czNum(num, digits = 1) {
  if (num === null || num === undefined || isNaN(num)) return '—';
  return new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(num);
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
      if (page !== 'search') stopSearchPolling();
      if (page === 'dashboard') loadDashboard();
      if (page === 'matches') loadMatches();
      if (page === 'search') loadSearchPage();
      if (page === 'bettors') loadBettors();
      if (page === 'bankroll') loadBankroll();
      if (page === 'learning') { loadMlLearning(); loadBacktest(); loadAgentBreakdown(); }
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
  el('refreshMatchesBtn')?.addEventListener('click', () => loadMatches(true));
  el('saveSettingsBtn')?.addEventListener('click', saveAgentSettings);
  el('saveBankrollBtn')?.addEventListener('click', saveBankrollSettings);
  el('runBettorsBtn')?.addEventListener('click', runBettorsRound);
  el('retrainMlBtn')?.addEventListener('click', retrainMlModel);
  el('apifSaveBtn')?.addEventListener('click', saveApifKey);
  el('backfillBtn')?.addEventListener('click', runBackfill);
  el('backfillArchiveBtn')?.addEventListener('click', runBackfillArchive);
  el('benchmarkBtn')?.addEventListener('click', runBenchmark);
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
      ? `Agent má zatím ROI ${pct(agentRoi)} (${d.agent_stats.settled} vyřešeno).`
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
      </div>
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
    el('agentSummary').className = '';   // odstraň 'loading' padding, jinak se rozjede layout
    el('agentSummary').innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px; font-size:13px;">
        <div style="display:flex; justify-content:space-between;"><span class="muted">Umístěno</span><span>${s.placed}</span></div>
        <div style="display:flex; justify-content:space-between;"><span class="muted">Vyřešeno</span><span>${s.settled} (${s.accuracy !== null ? pct(s.accuracy) : '—'})</span></div>
        <div style="display:flex; justify-content:space-between;"><span class="muted">Zisk</span><span class="${s.profit >= 0 ? 'pos' : 'bad'}">${fmt(s.profit)} Kč</span></div>
        <div style="display:flex; justify-content:space-between;"><span class="muted">ROI</span><span>${s.roi !== null ? pct(s.roi) : '—'}</span></div>
      </div>`;
    renderRecentBets(data.bets || []);
  } catch (e) {
    el('agentSummary').innerHTML = `<div class="empty-state" style="padding:10px 0;">Chyba načítání</div>`;
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
        <td>${b.match || '—'}</td>
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

// ---------------------------------------------------------------------------
// Dolní stavová lišta – kdy naposled proběhla kontrola výsledků
// ---------------------------------------------------------------------------
const STATUSBAR_POLL_MS = 60 * 1000;
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
  setInterval(() => {
    if (document.visibilityState === 'visible') updateStatusBar();
  }, STATUSBAR_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateStatusBar();
  });
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
        <td><strong>${m.home}</strong> – ${m.away}</td>
        <td>${m.has_odds ? '<span class="badge real">kurzy</span>'
              : `<span class="badge model" title="${m.odds_expected ? 'Kurzy se obvykle objeví krátce před výkopem' : 'Takhle daleko dopředu ESPN kurzy nedává'}">jen model</span>`}</td>
        <td><button class="btn small">Rozbor →</button></td>
      </tr>`).join('');
    box.innerHTML = `
      <div style="margin-bottom:12px;">
        <button class="btn small" id="leaguesBackBtn">← Zpět na soutěže</button>
      </div>
      <h4 style="margin:0 0 10px;">${d.flag || ''} ${d.league} <span class="muted">(${d.total} zápasů)</span></h4>
      ${rows ? `<div class="table-wrap"><table>
        <thead><tr><th>Kdy</th><th>Zápas</th><th></th><th></th></tr></thead>
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
    box.innerHTML = `<div class="card"><div class="empty-state">Pro „${d.query}" jsem v příštích ${d.days || 14} dnech nenašel žádný zápas.</div></div>`;
    return;
  }
  const teams = (d.teams || []).map(t => `<span class="pill">${t.name} <span class="muted">(${t.matches})</span></span>`).join('');
  const rows = d.matches.map(m => {
    // Kurzy ESPN dává až blízko výkopu – u vzdálenějších zápasů řekni rovnou,
    // že půjde jen o odhad modelu, ať to není překvapení až v rozboru
    const badge = m.has_odds
      ? '<span class="badge real">kurzy</span>'
      : `<span class="badge model" title="${m.odds_expected ? 'Kurzy se obvykle objeví krátce před výkopem' : 'Takhle daleko dopředu ESPN kurzy nedává – bude jen odhad modelu'}">jen model</span>`;
    return `<tr class="search-row-item" data-id="${escAttr(m.id)}" data-sport="${escAttr(m.sport)}">
      <td>${fmtWhen(m.date, m.time)}</td>
      <td><strong>${m.home}</strong> – ${m.away}</td>
      <td class="muted">${m.flag || ''} ${m.league}</td>
      <td>${badge}</td>
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
        <thead><tr><th>Kdy</th><th>Zápas</th><th>Soutěž</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`;
  box.querySelectorAll('.search-row-item').forEach(tr => {
    tr.addEventListener('click', () => openMatchAnalysis(tr.dataset.id, tr.dataset.sport));
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
      <h2 style="margin:0 0 4px;">${m.home} – ${m.away}</h2>
      <p class="lead">${m.flag || ''} ${m.league} · ${fmtWhen(m.date, m.time)}</p>
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
          <div class="perf-title">Forma – ${m.home}</div>
          <div class="form-row">${formIcons(fh)}</div>
        </div>
        <div class="perf-block">
          <div class="perf-title">Forma – ${m.away}</div>
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
            <div class="perf-row"><span class="perf-key">${m.home}</span><span class="perf-nums"><strong>${pct((fts.home || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">${m.away}</span><span class="perf-nums"><strong>${pct((fts.away || 0) * 100)}</strong></span></div>
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
              <div class="perf-row"><span class="perf-key">${m.home}: ${x.goals}</span><span class="perf-nums"><strong>${pct(x.prob * 100)}</strong></span></div>`).join('')}
            ${(em.exact_team_goals?.away || []).slice(0, 3).map(x => `
              <div class="perf-row"><span class="perf-key">${m.away}: ${x.goals}</span><span class="perf-nums"><strong>${pct(x.prob * 100)}</strong></span></div>`).join('')}
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
            <div class="perf-row"><span class="perf-key">${m.home} a přes</span><span class="perf-nums"><strong>${pct((em.winner_and_total?.home_over25 || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Remíza a přes</span><span class="perf-nums"><strong>${pct((em.winner_and_total?.draw_over25 || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">${m.away} a přes</span><span class="perf-nums"><strong>${pct((em.winner_and_total?.away_over25 || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Výsledek + ${m.home} nad 1,5 gólu</div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">${m.home} vyhraje a nad 1,5</span><span class="perf-nums"><strong>${pct((em.winner_and_team_goals?.home_home_over || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">Remíza a ${m.home} nad 1,5</span><span class="perf-nums"><strong>${pct((em.winner_and_team_goals?.draw_home_over || 0) * 100)}</strong></span></div>
          </div>
        </div>

        <div class="perf-block">
          <div class="perf-title">Výsledek + kdo dal první gól <span class="muted" title="Aproximace – grid nezachycuje časové pořadí gólů, spočítáno jako P(výsledek) × P(první gól)">ⓘ</span></div>
          <div class="perf-rows">
            <div class="perf-row"><span class="perf-key">${m.home} vyhraje a skóruje první</span><span class="perf-nums"><strong>${pct((em.winner_and_first_scorer?.home_home_first || 0) * 100)}</strong></span></div>
            <div class="perf-row"><span class="perf-key">${m.away} vyhraje a skóruje první</span><span class="perf-nums"><strong>${pct((em.winner_and_first_scorer?.away_away_first || 0) * 100)}</strong></span></div>
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
  }[STATE.statusFilter];
  const leagues = (pass
    ? leaguesIn.map(lg => ({ ...lg, matches: lg.matches.filter(pass) })).filter(lg => lg.matches.length)
    : leaguesIn);

  container.className = '';   // odstraní 'loading' padding po naplnění daty
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

  const why = bet ? `
    <div class="why-box" style="display:none;">
      ${bet.ticket ? `Součást tiketu <strong>${bet.ticket}</strong> – tip <strong>${bet.label}</strong>.`
        : bet.why && bet.why.length ? `<strong>${bet.label}</strong><ul>${bet.why.map(w => `<li>${w}</li>`).join('')}</ul>`
        : `Vsazeno na <strong>${bet.label}</strong>.`}
    </div>` : '';

  const hasExtra = marketChips || bet;

  return `
    <div class="match-card" data-match-id="${escAttr(m.id)}">
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
          ${finished ? '' : hasPick ? `
            <div class="pick-badge">
              <span class="pl">${best.label || '?'}</span>
              <span class="pv">${(best.odds || 0).toFixed(2)}</span>
            </div>
            <span class="badge ${best.is_value ? 'real' : 'model'}">${Math.round((best.prob || 0) * 100)}%</span>
          ` : `<span class="badge model">model ${m.confidence || Math.round((m.probs?.[m.pick] || 0) * 100)}%</span>`}
          ${(!finished && !_coldstartIsNorm && m.rating_confidence != null && m.rating_confidence < 0.3) ? `<span class="badge coldstart" title="Rating týmu/týmů stojí na málo odehraných zápasech - predikce je míň spolehlivá">⚠️ nový tým</span>` : ''}
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
    // stejné rozlišení jako na dashboardu: zůstatek není ztráta, dokud jsou
    // peníze jen zamrzlé v otevřených sázkách
    setText('bOpenStake', s.open_stake
      ? `${fmt(s.open_stake)} ${s.currency || 'Kč'} v otevřených sázkách` : 'žádné otevřené sázky');
    setText('bProfit', `${fmt(s.profit)} ${s.currency || 'Kč'}`);
    el('bProfit').className = 'value ' + (s.profit >= 0 ? 'pos' : 'bad');
    setText('bProfitHint', `z ${s.settled_count || 0} vyhodnocených`);
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
  if (!bets.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty-state">Zatím žádné sázky</td></tr>`; return; }
  tbody.innerHTML = bets.map(b => `
    <tr>
      <td>${b.match || '—'}</td>
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
      `<div style="font-size:15px; font-weight:700;">${d.emoji} ${custom || d.name}</div>
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
    toast(`Sázkař ${b.emoji} ${b.name} vytvořen.`);
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
  } catch (e) {
    box.innerHTML = `<div class="empty-state">Chyba: ${e.message}</div>`;
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

const ARENA_SLOUPCE = [
  { key: null,         label: '',          cls: 'arena-caret' },
  { key: 'rank',       label: '#' },
  { key: 'name',       label: 'Sázkař' },
  { key: null,         label: 'Vývoj',     cls: 'hide-sm' },
  { key: 'balance',    label: 'Zůstatek',  num: true },
  { key: 'profit',     label: 'Zisk',      num: true },
  { key: 'roi',        label: 'ROI',       num: true },
  { key: 'win_rate',   label: 'Úspěšnost', num: true, cls: 'hide-md' },
  { key: 'settled',    label: 'Sázek',     num: true, cls: 'hide-md' },
  { key: 'open_stake', label: 'Ve hře',    num: true, cls: 'hide-sm' },
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
  if (!pocty[_arenaGroup]) _arenaGroup = order.find(g => pocty[g]) || 'single';

  box.className = '';
  box.innerHTML = `
    <div class="arena-tabs" id="arenaTabs">
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
  const info = groups[_arenaGroup] || {};
  const list = _arenaAll.filter(b => (b.group || 'single') === _arenaGroup);

  const zisk = list.reduce((a, x) => a + (x.profit || 0), 0);
  const veHre = list.reduce((a, x) => a + (x.open_stake || 0), 0);
  const vyresene = list.reduce((a, x) => a + (x.settled || 0), 0);
  const vyhry = list.reduce((a, x) => a + (x.settled || 0) * ((x.win_rate || 0) / 100), 0);
  const uspesnost = vyresene ? (vyhry / vyresene * 100) : null;
  const nejlepsi = list.reduce((a, x) => (!a || (x.profit || 0) > (a.profit || 0)) ? x : a, null);
  const vPlusu = list.filter(b => (b.profit || 0) > 0).length;

  const razeno = [...list].sort((a, b) => {
    const k = _arenaSort.key;
    let va = a[k], vb = b[k];
    if (typeof va === 'string') return _arenaSort.dir * va.localeCompare(vb, 'cs');
    va = (va === null || va === undefined) ? -Infinity : va;
    vb = (vb === null || vb === undefined) ? -Infinity : vb;
    return _arenaSort.dir * (va - vb);
  });

  box.innerHTML = `
    ${info.desc ? `<p class="arena-desc">${info.desc}</p>` : ''}

    <div class="grid-stats">
      <div class="stat-tile">
        <div class="label">Zisk kategorie</div>
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
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="arena-table">
          <thead><tr>${ARENA_SLOUPCE.map(c => `
            <th class="${c.num ? 'num ' : ''}${c.cls || ''} ${c.key ? 's' : ''} ${c.key && c.key === _arenaSort.key ? 'on' : ''}"
                ${c.key ? `data-sort="${c.key}"` : ''}>${c.label}${c.key && c.key === _arenaSort.key ? (_arenaSort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
          </tr></thead>
          <tbody>${razeno.map(b => arenaRadek(b, veHre)).join('')}</tbody>
        </table>
      </div>
    </div>`;

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
}

function arenaRadek(b, veHreCelkem) {
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
    <tr class="row bettor-row ${nesazi ? 'idle' : ''}" data-id="${b.id}">
      <td class="arena-caret"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3l3 4 3-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></td>
      <td class="arena-rank ${medaile ? 'medal' : ''}">${medaile || b.rank}</td>
      <td>
        <div class="arena-who">
          <span class="face">${b.emoji}</span>
          <span>
            <div class="nm">${b.name}${nesazi ? ' <span class="idle-badge" title="Strategie zatím nenašla vhodnou příležitost">bez sázek</span>' : ''}</div>
            <div class="tg">${b.tagline}</div>
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
          <button class="btn small icon-only bettor-deposit" data-id="${b.id}" data-name="${escAttr(b.name)}" title="Vložit peníze">＋</button>
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
      </div>
      ${bl.length ? `<div class="perf-blacklist">🚫 Automaticky vyřazené sporty: <b>${bl.join(', ')}</b> — sázkař na ně po ≥15 sázkách má záporné ROI a přestal na ně sázet.</div>` : ''}
    ` : '';
    // pohyby na banku se ukážou i u sázkaře, co ještě nestihl vsadit
    if (!bets.length) {
      box.innerHTML = txHtml + breakdownHtml + '<div class="empty-state" style="padding:14px 0;">Zatím žádné sázky</div>';
      return;
    }
    box.innerHTML = txHtml + breakdownHtml + `<div class="table-wrap"><table>
      <thead><tr><th>Zápas</th><th>Kdy</th><th>Zápas stav</th><th>Tip</th><th>Kurz</th><th>Vklad</th><th>Sázka</th><th>P&L</th></tr></thead>
      <tbody>${bets.map(bt => `
        <tr${bt.legs ? ' class="ticket-row"' : ''}>
          <td>${bt.legs ? `<span class="muted">${bt.kind === 'combo' ? '🔗' : '🎫'}</span> ` : ''}${bt.match}</td>
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
              <span class="muted">${l.match}</span>
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
    `<span class="pill info">${d.name} <strong>${d.count}×</strong> · ${fmt(d.staked)} Kč</span>`).join('');
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
const NOTIF_POLL_MS = 3 * 60 * 1000;

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
  if (!box) return;

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
  // Bez podminky na opravneni - kdyz systemove notifikace nejdou,
  // notify() to zobrazi v okne aplikace.

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
  try {
    const s = await api('/api/learning/stats', { timeoutMs: 20000 });
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
    toast('Nepodařilo se načíst ML Learning.', 'err');
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
