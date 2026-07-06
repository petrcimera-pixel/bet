# -*- coding: utf-8 -*-
"""
Agent sázení (virtuální).

Automaticky sází ostré tipy z hlavního banku – zítřejší a live zápasy:
  - jen ostré tipy (favorit ≥ SHARP_PROB nebo nalezená value) – žádné coin-flipy
  - vklad podle frakčního Kelly kritéria (nebo plochá částka, dle nastavení) –
    velikost sázky odpovídá jistotě/EV tipu, ne stejná částka na vše
  - denní strop: max. podíl referenčního banku prosázený za 1 kalendářní den,
    ať aktivní den (hodně ostrých tipů) nevyprázdní bank v jednom běhu
  - 1 sázka na zápas, value příležitost má přednost před obyčejným pickem
  - dedupe: na zápas, na který už agent vsadil, znovu nesází
  - live zápasy: sází i na zápasy které právě probíhají (live)

Vše je virtuální – slouží k analýze úspěšnosti modelu na reálném banku appky.
"""

import datetime

from . import bankroll
from . import settings as app_settings
from .tips_db import SHARP_PROB

TAG = "bet-agent"
MIN_STAKE = 1.0   # podlaha pro Kelly sázku, ať nejsou směšně malé/nulové


def _cfg() -> dict:
    return app_settings.get_settings()["agent"]


def agent_bets() -> list:
    return [b for b in bankroll.state()["bets"] if b.get("tag") == TAG]


def _placed_today(bet: dict) -> bool:
    try:
        return datetime.date.fromtimestamp(bet["ts"]) == datetime.date.today()
    except Exception:
        return False


def agent_stats() -> dict:
    """Souhrn výkonu agenta – počty, zisk a ROI jen z jeho sázek."""
    bets = agent_bets()
    settled = [b for b in bets if b["status"] in ("won", "lost", "void")]
    won = [b for b in settled if b["status"] == "won"]
    profit = round(sum(b["pnl"] for b in settled), 2)
    staked = round(sum(b["stake"] for b in settled), 2)
    staked_today = round(sum(b["stake"] for b in bets if _placed_today(b)), 2)

    # Kumulativní křivka zisku (start 0) v pořadí VYHODNOCENÍ sázek –
    # stejný princip jako equity_curve banku, ale jen agentovy peníze.
    curve = [0.0]
    cum = 0.0
    for b in sorted(settled, key=lambda x: x.get("settled_ts") or x["ts"]):
        cum += b["pnl"]
        curve.append(round(cum, 2))

    return {
        "placed": len(bets),
        "open": len(bets) - len(settled),
        "settled": len(settled),
        "won": len(won),
        "accuracy": round(len(won) / len(settled) * 100, 1) if settled else None,
        "profit": profit,
        "staked": staked,
        "roi": round(profit / staked * 100, 1) if staked else None,
        "staked_today": staked_today,
        "profit_curve": curve,
    }


def run(predictions: list) -> dict:
    """Vsadí ostré tipy – zítřejší i live zápasy. Vrací souhrn běhu."""
    cfg = _cfg()
    stake_mode = cfg.get("stake_mode", "kelly")
    flat_stake = float(cfg.get("stake", 10.0))
    kelly_fraction = float(cfg.get("kelly_fraction", 0.25))
    max_daily_pct = float(cfg.get("max_daily_stake_pct", 0.25))

    already = {b["match_id"] for b in agent_bets()}

    # Denní strop: referenční bank = aktuální balance + co už bylo dnes prosázeno
    # (peníze prosázené dnes by jinak "chyběly" v referenční hodnotě). Konzervativní
    # aproximace – nezohledňuje dnešní výhry/prohry vyhodnocené mezitím.
    staked_today = sum(b["stake"] for b in agent_bets() if _placed_today(b))
    balance = bankroll.state()["balance"]
    reference_balance = balance + staked_today
    daily_cap = reference_balance * max_daily_pct
    remaining_budget = max(0.0, daily_cap - staked_today)

    placed = skipped_dup = skipped_soft = skipped_cap = 0
    no_funds = 0

    for p in predictions:
        if p.get("result") is not None:  # Skip jen skončené zápasy
            continue
        if p["id"] in already:
            skipped_dup += 1
            continue

        bv = p.get("best_value", {})
        pick = p.get("pick", "home")
        pick_prob = p.get("probs", {}).get(pick, 0)
        is_sharp = pick_prob >= SHARP_PROB or bool(bv.get("is_value"))
        if cfg.get("only_sharp", True) and not is_sharp:
            skipped_soft += 1
            continue

        # value příležitost má přednost, jinak sázíme pick modelu
        if bv.get("is_value"):
            outcome, bet = bv.get("outcome"), bv
            label = bv.get("label", "VAL")
        else:
            outcome, bet = pick, p.get("bets", {}).get(pick, {})
            label = bet.get("label", "?")

        odds = bet.get("best_odds")
        prob = bet.get("prob", pick_prob)
        if not outcome or not odds:
            continue

        if stake_mode == "kelly":
            stake = bankroll.kelly_stake(prob, odds, balance, kelly_fraction)
            if stake <= 0:
                skipped_soft += 1   # Kelly nedoporučuje sázku (žádná reálná výhoda)
                continue
            stake = max(stake, MIN_STAKE)
        else:
            stake = flat_stake

        if remaining_budget < MIN_STAKE:
            skipped_cap += 1
            continue
        stake = round(min(stake, remaining_budget), 2)   # ořízni na zbytek denního stropu

        cons = (1.0 / bet["market_prob"]) if bet.get("market_prob") else None
        try:
            bankroll.place_bet(p["id"], label, outcome, odds, prob, stake,
                               p["home"], p["away"], consensus_odds=cons, tag=TAG,
                               match_date=p.get("date"), match_time=p.get("time"), league=p.get("league"))
            placed += 1
            already.add(p["id"])
            remaining_budget -= stake
            balance -= stake
        except ValueError:
            no_funds += 1     # došel bank – dál to nemá smysl zkoušet
            break

    return {
        "placed": placed,
        "skipped_duplicate": skipped_dup,
        "skipped_not_sharp": skipped_soft,
        "skipped_daily_cap": skipped_cap,
        "out_of_funds": no_funds > 0,
        "balance": bankroll.state()["balance"],
    }


def league_stats() -> dict:
    """Výkon agenta sázení po ligách - win rate, profit, ROI. Seřazeno od nejziskovější."""
    st = bankroll.state()
    agent_bets = [b for b in st["bets"] if b.get("tag") == TAG]
    settled = [b for b in agent_bets if b["status"] in ("won", "lost")]

    by_league = {}
    for b in settled:
        league = b.get("league", "Unknown")
        if league not in by_league:
            by_league[league] = {"wins": 0, "settled": 0, "pnl": 0.0}
        by_league[league]["settled"] += 1
        if b["status"] == "won":
            by_league[league]["wins"] += 1
        by_league[league]["pnl"] += b["pnl"]

    # Seřaď od nejziskovější ligy
    result = {}
    for league in sorted(by_league.keys(), key=lambda l: by_league[l]["pnl"], reverse=True):
        stats = by_league[league]
        result[league] = {
            "settled": stats["settled"],
            "wins": stats["wins"],
            "win_rate": round(stats["wins"] / stats["settled"] * 100, 1) if stats["settled"] else 0,
            "pnl": round(stats["pnl"], 2),
            "roi": round(stats["pnl"] / stats["settled"], 2) if stats["settled"] else 0,
        }
    return result
