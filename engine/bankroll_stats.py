# -*- coding: utf-8 -*-
"""
Bankroll Statistics & Analytics – Detailní vývoj banku
"""

from datetime import datetime, timedelta
from collections import defaultdict
import json


class BankrollAnalytics:
    """Comprehensive bankroll statistics."""

    def __init__(self, bets_list=None):
        self.bets = bets_list or []

    def get_daily_breakdown(self, days=90):
        """Get daily P&L breakdown."""
        daily = defaultdict(lambda: {"bets": 0, "wins": 0, "pnl": 0, "balance": 0})

        for bet in self.bets:
            if bet["status"] in ("won", "lost"):
                ts = bet.get("ts", 0)
                dt = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
                daily[dt]["bets"] += 1
                if bet["status"] == "won":
                    daily[dt]["wins"] += 1
                daily[dt]["pnl"] += bet.get("pnl", 0)

        # Calculate running balance
        sorted_days = sorted(daily.keys())
        running_pnl = 0
        result = {}

        for day in sorted_days:
            running_pnl += daily[day]["pnl"]
            result[day] = {
                "bets": daily[day]["bets"],
                "wins": daily[day]["wins"],
                "pnl": round(daily[day]["pnl"], 2),
                "running_pnl": round(running_pnl, 2),
                "win_rate": round(daily[day]["wins"] / daily[day]["bets"] * 100, 1) if daily[day]["bets"] > 0 else 0,
            }

        return result

    def get_monthly_breakdown(self):
        """Get monthly P&L breakdown."""
        monthly = defaultdict(lambda: {"bets": 0, "wins": 0, "pnl": 0})

        for bet in self.bets:
            if bet["status"] in ("won", "lost"):
                ts = bet.get("ts", 0)
                month = datetime.fromtimestamp(ts).strftime("%Y-%m")
                monthly[month]["bets"] += 1
                if bet["status"] == "won":
                    monthly[month]["wins"] += 1
                monthly[month]["pnl"] += bet.get("pnl", 0)

        result = {}
        for month in sorted(monthly.keys()):
            stats = monthly[month]
            result[month] = {
                "bets": stats["bets"],
                "wins": stats["wins"],
                "pnl": round(stats["pnl"], 2),
                "roi": round(stats["pnl"] / stats["bets"] * 100, 2) if stats["bets"] > 0 else 0,
                "win_rate": round(stats["wins"] / stats["bets"] * 100, 1) if stats["bets"] > 0 else 0,
            }

        return result

    def get_weekly_breakdown(self):
        """Get weekly P&L breakdown."""
        weekly = defaultdict(lambda: {"bets": 0, "wins": 0, "pnl": 0})

        for bet in self.bets:
            if bet["status"] in ("won", "lost"):
                ts = bet.get("ts", 0)
                dt = datetime.fromtimestamp(ts)
                week_start = (dt - timedelta(days=dt.weekday())).strftime("%Y-W%U")
                weekly[week_start]["bets"] += 1
                if bet["status"] == "won":
                    weekly[week_start]["wins"] += 1
                weekly[week_start]["pnl"] += bet.get("pnl", 0)

        result = {}
        for week in sorted(weekly.keys()):
            stats = weekly[week]
            result[week] = {
                "bets": stats["bets"],
                "wins": stats["wins"],
                "pnl": round(stats["pnl"], 2),
                "roi": round(stats["pnl"] / stats["bets"] * 100, 2) if stats["bets"] > 0 else 0,
                "win_rate": round(stats["wins"] / stats["bets"] * 100, 1) if stats["bets"] > 0 else 0,
            }

        return result

    def get_winning_days(self):
        """Get days with positive P&L."""
        daily = self.get_daily_breakdown()
        winning = {d: s for d, s in daily.items() if s["pnl"] > 0}
        return len(winning), sum(s["pnl"] for s in winning.values())

    def get_losing_days(self):
        """Get days with negative P&L."""
        daily = self.get_daily_breakdown()
        losing = {d: s for d, s in daily.items() if s["pnl"] < 0}
        return len(losing), sum(s["pnl"] for s in losing.values())

    def get_peak_and_trough(self):
        """Get peak balance and lowest point."""
        settled = [b for b in self.bets if b["status"] in ("won", "lost")]
        if not settled:
            return None, None

        cumulative = 1000  # Start balance
        peak = 1000
        trough = 1000

        for bet in sorted(settled, key=lambda b: b.get("ts", 0)):
            cumulative += bet.get("pnl", 0)
            peak = max(peak, cumulative)
            trough = min(trough, cumulative)

        return peak, trough

    def get_streak_analysis(self):
        """Analyze winning/losing streaks."""
        settled = [b for b in self.bets if b["status"] in ("won", "lost")]
        if not settled:
            return None

        streaks = []
        current_streak = {"type": None, "length": 0, "pnl": 0}

        for bet in sorted(settled, key=lambda b: b.get("ts", 0)):
            bet_type = "win" if bet["status"] == "won" else "loss"

            if bet_type == current_streak.get("type"):
                current_streak["length"] += 1
                current_streak["pnl"] += bet.get("pnl", 0)
            else:
                if current_streak["type"]:
                    streaks.append(current_streak.copy())
                current_streak = {"type": bet_type, "length": 1, "pnl": bet.get("pnl", 0)}

        if current_streak["type"]:
            streaks.append(current_streak)

        wins = [s for s in streaks if s["type"] == "win"]
        losses = [s for s in streaks if s["type"] == "loss"]

        return {
            "longest_win_streak": max((s["length"] for s in wins), default=0),
            "longest_loss_streak": max((s["length"] for s in losses), default=0),
            "current_streak": current_streak,
            "total_streaks": len(streaks),
            "win_streaks": len(wins),
            "loss_streaks": len(losses),
        }

    def get_best_worst_days(self, n=5):
        """Get best and worst performing days."""
        daily = self.get_daily_breakdown()

        sorted_daily = sorted(daily.items(), key=lambda x: x[1]["pnl"], reverse=True)

        best = dict(sorted_daily[:n])
        worst = dict(sorted_daily[-n:])

        return {"best": best, "worst": worst}

    def get_hourly_distribution(self):
        """Get profit distribution by hour of day."""
        hourly = defaultdict(lambda: {"bets": 0, "wins": 0, "pnl": 0})

        for bet in self.bets:
            if bet["status"] in ("won", "lost"):
                ts = bet.get("ts", 0)
                hour = datetime.fromtimestamp(ts).hour
                hourly[hour]["bets"] += 1
                if bet["status"] == "won":
                    hourly[hour]["wins"] += 1
                hourly[hour]["pnl"] += bet.get("pnl", 0)

        result = {}
        for hour in range(24):
            stats = hourly[hour]
            result[f"{hour:02d}:00"] = {
                "bets": stats["bets"],
                "wins": stats["wins"],
                "pnl": round(stats["pnl"], 2),
                "win_rate": round(stats["wins"] / stats["bets"] * 100, 1) if stats["bets"] > 0 else 0,
            }

        return result

    def get_roi_by_odds(self):
        """Get ROI breakdown by odds ranges."""
        ranges = [(1.0, 1.5), (1.5, 2.0), (2.0, 3.0), (3.0, 5.0), (5.0, 100.0)]
        result = {}

        for low, high in ranges:
            range_bets = [b for b in self.bets if low <= b.get("odds", 0) < high and b["status"] in ("won", "lost")]
            if range_bets:
                wins = sum(1 for b in range_bets if b["status"] == "won")
                pnl = sum(b.get("pnl", 0) for b in range_bets)
                staked = sum(b["stake"] for b in range_bets)
                result[f"{low:.1f}-{high:.1f}"] = {
                    "bets": len(range_bets),
                    "wins": wins,
                    "pnl": round(pnl, 2),
                    "roi": round(pnl / staked * 100, 2) if staked > 0 else 0,
                    "win_rate": round(wins / len(range_bets) * 100, 1) if range_bets else 0,
                }

        return result

    def get_summary(self):
        """Get comprehensive summary."""
        settled = [b for b in self.bets if b["status"] in ("won", "lost")]

        daily_data = self.get_daily_breakdown()
        winning_days, winning_pnl = self.get_winning_days()
        losing_days, losing_pnl = self.get_losing_days()
        peak, trough = self.get_peak_and_trough()
        streaks = self.get_streak_analysis()

        total_pnl = sum(b.get("pnl", 0) for b in settled)
        total_staked = sum(b["stake"] for b in settled)

        return {
            "total_bets": len(settled),
            "total_pnl": round(total_pnl, 2),
            "total_staked": round(total_staked, 2),
            "roi": round(total_pnl / total_staked * 100, 2) if total_staked > 0 else 0,
            "win_rate": round(sum(1 for b in settled if b["status"] == "won") / len(settled) * 100, 1) if settled else 0,
            "winning_days": winning_days,
            "winning_pnl": round(winning_pnl, 2),
            "losing_days": losing_days,
            "losing_pnl": round(losing_pnl, 2),
            "peak_balance": peak,
            "trough_balance": trough,
            "streak_info": streaks,
            "best_day_pnl": max((s["pnl"] for s in daily_data.values()), default=0) if daily_data else 0,
            "worst_day_pnl": min((s["pnl"] for s in daily_data.values()), default=0) if daily_data else 0,
        }
