# -*- coding: utf-8 -*-
"""
Backtesting Engine – Testování strategií na historických datech
"""

import json
import numpy as np
from datetime import datetime, timedelta
from collections import defaultdict

from . import bankroll

class Backtester:
    """Test betting strategies on historical data."""

    def __init__(self):
        self.results = {}
        self.equity_curves = {}
        self.league_performance = {}

    def run_backtest(self, bets, initial_balance=None):
        """Run backtest on a list of bets (net-effect replay v pořadí vyhodnocení)."""
        if initial_balance is None:
            try:
                initial_balance = bankroll.state().get("start_balance", 1000)
            except Exception:
                initial_balance = 1000
        balance = initial_balance
        equity = [balance]
        settled_bets = []

        # Řadíme podle času VYHODNOCENÍ – bank se mění při settle, ne při vsazení
        for bet in sorted(bets, key=lambda b: b.get('settled_ts') or b.get('ts', 0)):
            if bet['status'] in ('won', 'lost', 'void'):
                settled_bets.append(bet)
                if bet['status'] == 'won':
                    balance += bet['stake'] * (bet['odds'] - 1)
                elif bet['status'] == 'lost':
                    balance -= bet['stake']
                # void: čistý efekt 0 (vklad se vrací) – bank se nemění

                equity.append(round(balance, 2))

        # Metriky – win rate a ztráty počítáme jen z rozhodnutých (bez void)
        decided = [b for b in settled_bets if b['status'] in ('won', 'lost')]
        pnl = sum(b.get('pnl', 0) for b in decided)
        staked = sum(b['stake'] for b in decided)
        roi = (pnl / staked * 100) if staked > 0 else 0
        win_count = sum(1 for b in decided if b['status'] == 'won')
        win_rate = (win_count / len(decided) * 100) if decided else 0

        # Sharpe ratio
        pnls = [b.get('pnl', 0) for b in decided]
        if len(pnls) > 1:
            mean = sum(pnls) / len(pnls)
            variance = sum((x - mean) ** 2 for x in pnls) / len(pnls)
            std_dev = variance ** 0.5
            sharpe = mean / std_dev if std_dev > 0 else 0
        else:
            sharpe = 0

        # Max drawdown proti PRŮBĚŽNÉMU peaku (ne globálnímu maximu –
        # to by u rostoucí křivky hlásilo fantomový propad)
        peak = equity[0] if equity else balance
        max_dd = 0
        for eq in equity:
            peak = max(peak, eq)
            dd = (peak - eq) / peak * 100 if peak > 0 else 0
            max_dd = max(max_dd, dd)

        return {
            "equity_curve": equity,
            "final_balance": round(balance, 2),
            "pnl": round(pnl, 2),
            "roi": round(roi, 2),
            "win_rate": round(win_rate, 1),
            "total_bets": len(decided),
            "voids": len(settled_bets) - len(decided),
            "wins": win_count,
            "losses": len(decided) - win_count,
            "sharpe_ratio": round(sharpe, 2),
            "max_drawdown": round(max_dd, 2),
        }

    def backtest_by_league(self, bets):
        """Test performance by league."""
        by_league = defaultdict(list)

        for bet in bets:
            league = bet.get('league', 'Unknown')
            by_league[league].append(bet)

        results = {}
        for league, league_bets in by_league.items():
            results[league] = self.run_backtest(league_bets)

        return results

    def backtest_by_time_period(self, bets, period_days=7):
        """Test performance by time periods."""
        by_period = defaultdict(list)

        for bet in bets:
            if 'ts' in bet:
                dt = datetime.fromtimestamp(bet['ts'])
                period_key = (dt - timedelta(days=dt.weekday())).strftime("%Y-%m-%d")
                by_period[period_key].append(bet)

        results = {}
        for period, period_bets in sorted(by_period.items()):
            results[period] = self.run_backtest(period_bets)

        return results

    def backtest_by_odds_range(self, bets, ranges=[(1.0, 1.5), (1.5, 2.0), (2.0, 3.0), (3.0, 10.0)]):
        """Test performance by odds ranges."""
        results = {}

        for low, high in ranges:
            range_bets = [b for b in bets if low <= b.get('odds', 0) < high]
            key = f"{low:.1f}-{high:.1f}"
            results[key] = self.run_backtest(range_bets)

        return results

    def backtest_agent_vs_manual(self, bets):
        """Compare agent bets vs manual bets."""
        agent_bets = [b for b in bets if b.get('tag') == 'bet-agent']
        manual_bets = [b for b in bets if b.get('tag') != 'bet-agent']

        return {
            "agent": self.run_backtest(agent_bets),
            "manual": self.run_backtest(manual_bets),
            "combined": self.run_backtest(bets),
        }

    def get_best_leagues(self, bets, top_n=5):
        """Find best performing leagues."""
        by_league = self.backtest_by_league(bets)

        sorted_leagues = sorted(
            by_league.items(),
            key=lambda x: x[1].get('roi', 0),
            reverse=True
        )

        return dict(sorted_leagues[:top_n])

    def get_worst_leagues(self, bets, top_n=5):
        """Find worst performing leagues."""
        by_league = self.backtest_by_league(bets)

        sorted_leagues = sorted(
            by_league.items(),
            key=lambda x: x[1].get('roi', 0)
        )

        return dict(sorted_leagues[:top_n])
