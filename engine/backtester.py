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

    def run_backtest(self, bets, initial_balance=1000, kelly_fraction=0.25):
        """Run backtest on a list of bets."""
        balance = initial_balance
        equity = [balance]
        settled_bets = []

        for bet in sorted(bets, key=lambda b: b.get('ts', 0)):
            if bet['status'] in ('won', 'lost', 'void'):
                settled_bets.append(bet)
                if bet['status'] == 'won':
                    payout = bet['stake'] * bet['odds']
                    balance += payout - bet['stake']
                elif bet['status'] == 'void':
                    balance += bet['stake']
                else:  # lost
                    balance -= bet['stake']

                equity.append(round(balance, 2))

        # Calculate metrics
        pnl = sum(b.get('pnl', 0) for b in settled_bets)
        staked = sum(b['stake'] for b in settled_bets)
        roi = (pnl / staked * 100) if staked > 0 else 0
        win_count = sum(1 for b in settled_bets if b['status'] == 'won')
        win_rate = (win_count / len(settled_bets) * 100) if settled_bets else 0

        # Sharpe ratio
        pnls = [b.get('pnl', 0) for b in settled_bets]
        if len(pnls) > 1:
            mean = sum(pnls) / len(pnls)
            variance = sum((x - mean) ** 2 for x in pnls) / len(pnls)
            std_dev = variance ** 0.5
            sharpe = mean / std_dev if std_dev > 0 else 0
        else:
            sharpe = 0

        # Max drawdown
        max_bal = max(equity) if equity else balance
        max_dd = 0
        for eq in equity:
            dd = (max_bal - eq) / max_bal * 100 if max_bal > 0 else 0
            max_dd = max(max_dd, dd)

        return {
            "equity_curve": equity,
            "final_balance": round(balance, 2),
            "pnl": round(pnl, 2),
            "roi": round(roi, 2),
            "win_rate": round(win_rate, 1),
            "total_bets": len(settled_bets),
            "wins": win_count,
            "losses": len(settled_bets) - win_count,
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

    def backtest_with_kelly_variants(self, bets, fractions=[0.1, 0.25, 0.5, 1.0]):
        """Test different Kelly fractions."""
        results = {}
        for frac in fractions:
            results[f"kelly_{frac}"] = self.run_backtest(bets, kelly_fraction=frac)

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
