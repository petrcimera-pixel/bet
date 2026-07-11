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
from . import data_sources as _ds
from .tips_db import SHARP_PROB

# ML gate (volitelné) – naučený model může vetovat tipy, na kterých historicky prodělává
try:
    from . import ml_learner
    _ML = True
except ImportError:
    _ML = False

TAG = "bet-agent"
MIN_STAKE = 1.0   # podlaha pro Kelly sázku, ať nejsou směšně malé/nulové
ML_VETO_PROB = 0.35   # model musí dávat aspoň tuto šanci na výhru, jinak tip přeskočíme


def _ml_veto(outcome, odds, prob, league) -> bool:
    """True = naučený model tip zamítá. Bez natrénovaného modelu nikdy nevetuje."""
    if not _ML:
        return False
    try:
        learner = ml_learner.get_learner()
        if learner.model is None:
            return False
        pred = learner.predict_with_confidence({
            "odds": odds, "prob": prob, "prediction": outcome, "league": league,
        })
        return pred.get("model_status") == "ready" and pred.get("win_prob", 0.5) < ML_VETO_PROB
    except Exception:
        return False    # ML nesmí nikdy shodit sázení


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


def _candidates(p, cfg):
    """Všechny sázecí příležitosti zápasu napříč povolenými trhy.
    Vrací list dictů: outcome, label, name, odds, prob, market, market_prob, real."""
    markets = cfg.get("markets") or {}
    real_match = p.get("odds_source") == "real"
    out = []
    bets = p.get("bets", {})

    def add(outcome, b, market, real):
        odds, prob = b.get("best_odds"), b.get("prob")
        if not odds or not prob:
            return
        out.append({
            "outcome": outcome, "label": b.get("label", "?"),
            "name": b.get("name", b.get("label", "?")),
            "odds": float(odds), "prob": float(prob),
            "market_prob": b.get("market_prob"), "market": market, "real": real,
        })

    if markets.get("winner", True):
        keys = ("home", "away") if p.get("two_way") else ("home", "draw", "away")
        for k in keys:
            if k in bets:
                add(k, bets[k], "winner", real_match)
    if markets.get("goals", True):
        for k, b in bets.items():
            if k.startswith(("over", "under")):
                add(k, b, "goals", bool(b.get("real")))
    if markets.get("btts", True) and not p.get("two_way"):
        for k in ("btts_yes", "btts_no"):
            if k in bets:
                add(k, bets[k], "btts", False)
    if markets.get("corners", True) and p.get("sport", "soccer") == "soccer":
        for cl in p.get("corner_lines") or []:
            line = cl["line"]
            for side in ("over", "under"):
                b = dict(cl[side])
                b["label"] = f'Rohy {"Over" if side == "over" else "Under"} {line}'
                b["name"] = f'{"Více" if side == "over" else "Méně"} než {line} rohů'
                add(f"{side}{line}", dict(b, best_odds=b.get("best_odds"),
                                          prob=b.get("prob")), "corners", False)
    return out


def _best_tutovka(cands, min_prob, min_odds, only_real):
    """Nejjistější tip zápasu: nejvyšší pravděpodobnost splňující prahy."""
    ok = [c for c in cands
          if c["prob"] >= min_prob and c["odds"] >= min_odds
          and not (only_real and not c["real"])]
    return max(ok, key=lambda c: c["prob"]) if ok else None


def _has_ticket_today(kind: str) -> bool:
    """Už dnes existuje agentův tiket daného druhu? (dedupe tiketů)"""
    today = datetime.date.today()
    for b in bankroll.state()["bets"]:
        if (b.get("tag") == TAG and b.get("outcome") == "acca"
                and b.get("ticket_kind") == kind):
            try:
                if datetime.date.fromtimestamp(b["ts"]) == today:
                    return True
            except Exception:
                pass
    return False


def _build_ticket(pool, max_legs, min_total_odds, min_prob):
    """Greedy tiket: nejjistější tipy z různých zápasů, dokud kurz nedosáhne cíle."""
    legs = []
    used = set()
    total = 1.0
    for c in sorted(pool, key=lambda c: c["prob"], reverse=True):
        if c["prob"] < min_prob or c["match_id"] in used or c["market"] == "corners":
            continue   # rohy do tiketů ne – nejdou vyhodnotit ze skóre
        legs.append(c)
        used.add(c["match_id"])
        total *= c["odds"]
        if len(legs) >= max_legs:
            break
    if len(legs) >= 2 and total >= min_total_odds:
        return legs
    return None


def _place_tickets(ticket_pool, cfg, balance):
    """Denní AKO (2–3 tutovky) + páteční víkendový tiket (4–6 tipů)."""
    placed = []
    stake = float(cfg.get("ticket_stake", 20.0))

    def _legs_payload(legs):
        return [{"match": c["match"], "name": c["name"], "match_id": c["match_id"],
                 "outcome": c["outcome"], "odds": c["odds"], "prob": c["prob"],
                 "date": c.get("date", ""), "time": c.get("time", "")} for c in legs]

    if cfg.get("daily_ticket", True) and not _has_ticket_today("daily"):
        legs = _build_ticket(ticket_pool, int(cfg.get("daily_ticket_legs", 3)),
                             min_total_odds=2.0, min_prob=float(cfg.get("min_prob", 0.75)))
        if legs and stake <= balance:
            bet = bankroll.place_acca(_legs_payload(legs), stake, tag=TAG,
                                      name=f"Jistota dne ({len(legs)} tipy)")
            _mark_ticket_kind(bet["id"], "daily")
            placed.append("daily")
            balance -= stake

    # Víkendový tiket: pátek/sobota, delší kombinace s mírně volnějším prahem
    if (cfg.get("weekend_ticket", True) and datetime.date.today().weekday() in (4, 5)
            and not _has_ticket_today("weekend")):
        legs = _build_ticket(ticket_pool, int(cfg.get("weekend_ticket_legs", 5)),
                             min_total_odds=4.0, min_prob=0.65)
        if legs and len(legs) >= 4 and stake <= balance:
            bet = bankroll.place_acca(_legs_payload(legs), stake, tag=TAG,
                                      name=f"Víkendový tiket ({len(legs)} tipů)")
            _mark_ticket_kind(bet["id"], "weekend")
            placed.append("weekend")
    return placed


def _attach_reasoning(bet_id, p, best):
    """Uloží k sázce konkrétní zdůvodnění (proč agent tip vybral)."""
    why = []
    why.append(f'Model dává {best["prob"]*100:.0f}% šanci – nejjistější tip zápasu '
               f'napříč trhy ({_MARKET_CZ.get(best["market"], best["market"])}).')
    eg = p.get("exp_goals")
    if eg:
        why.append(f'Očekávané skóre {eg.get("home", "?")} : {eg.get("away", "?")} gólů '
                   f'(celkem {p.get("exp_total", "?")}).')
    ts = p.get("top_scores") or []
    if ts:
        s = ts[0]
        try:
            why.append(f'Nejpravděpodobnější výsledek {s["score"]} ({s["prob"]*100:.0f} %).')
        except (KeyError, TypeError):
            pass
    rh, ra = p.get("rating_home"), p.get("rating_away")
    if rh and ra:
        diff = rh - ra
        if abs(diff) >= 50:
            stronger = p["home"] if diff > 0 else p["away"]
            why.append(f'{stronger} je výrazně silnější tým (Elo rozdíl {abs(diff)} bodů).')
    if best["real"]:
        why.append(f'Kurz {best["odds"]} je reálný kurz sázkovky – ne odhad modelu.')
    else:
        why.append(f'Kurz {best["odds"]} je modelovaný (trh pro tento tip nemá reálné kurzy).')
    st = bankroll.state()
    for b in st["bets"]:
        if b["id"] == bet_id:
            b["why"] = why
            break
    bankroll._save(st)


_MARKET_CZ = {"winner": "vítěz 1X2", "goals": "góly O/U", "btts": "oba skórují",
              "corners": "rohy"}


def _mark_ticket_kind(bet_id, kind):
    """Uloží druh tiketu do bet záznamu (pro denní dedupe)."""
    st = bankroll.state()
    for b in st["bets"]:
        if b["id"] == bet_id:
            b["ticket_kind"] = kind
            break
    bankroll._save(st)


def run(predictions: list) -> dict:
    """Tutovka strategie: pro každý zápas najde nejjistější tip napříč trhy
    (1X2, góly O/U, BTTS, rohy), vsadí singly a postaví AKO tikety."""
    cfg = _cfg()
    stake_mode = cfg.get("stake_mode", "kelly")
    flat_stake = float(cfg.get("stake", 10.0))
    kelly_fraction = float(cfg.get("kelly_fraction", 0.25))
    max_daily_pct = float(cfg.get("max_daily_stake_pct", 0.25))
    min_prob = float(cfg.get("min_prob", 0.75))
    min_odds = float(cfg.get("min_odds", 1.20))
    only_real = bool(cfg.get("only_real_odds", False))

    already = {b["match_id"] for b in agent_bets()}

    staked_today = sum(b["stake"] for b in agent_bets() if _placed_today(b))
    balance = bankroll.state()["balance"]
    reference_balance = balance + staked_today
    daily_cap = reference_balance * max_daily_pct
    remaining_budget = max(0.0, daily_cap - staked_today)

    placed = skipped_dup = skipped_soft = skipped_cap = skipped_ml = skipped_sim = 0
    no_funds = 0
    ticket_pool = []   # kandidáti pro AKO tikety (i nad denní strop singlů)

    ordered = sorted(predictions, key=lambda p: (
        0 if p.get("odds_source") == "real" else 1,
        _ds.league_rank(p.get("league", "")),
    ))

    for p in ordered:
        if p.get("result") is not None or p.get("live"):
            continue   # skončené a živé zápasy do tutovek nepatří
        if p["id"] in already:
            skipped_dup += 1
            continue
        if only_real and p.get("odds_source") != "real":
            skipped_sim += 1
            continue

        cands = _candidates(p, cfg)
        best = _best_tutovka(cands, min_prob, min_odds, only_real)
        if not best:
            skipped_soft += 1
            continue

        # ML gate: naučený model může tip vetovat (učí se z vlastních chyb)
        if _ml_veto(best["outcome"], best["odds"], best["prob"], p.get("league")):
            skipped_ml += 1
            continue

        # kandidát na tiket (i když se single nevejde do denního stropu)
        ticket_pool.append(dict(best, match_id=p["id"],
                                match=f'{p["home"]} – {p["away"]}',
                                date=p.get("date", ""), time=p.get("time", "")))

        if stake_mode == "kelly":
            stake = bankroll.kelly_stake(best["prob"], best["odds"], balance, kelly_fraction)
            stake = max(stake, MIN_STAKE) if stake > 0 else flat_stake * 0.5
        else:
            stake = flat_stake

        if remaining_budget < MIN_STAKE:
            skipped_cap += 1
            continue
        stake = round(min(stake, remaining_budget), 2)

        cons = (1.0 / best["market_prob"]) if best.get("market_prob") else None
        try:
            bet = bankroll.place_bet(p["id"], best["label"], best["outcome"],
                               best["odds"], best["prob"], stake,
                               p["home"], p["away"], consensus_odds=cons, tag=TAG,
                               match_date=p.get("date"), match_time=p.get("time"),
                               league=p.get("league"),
                               odds_source="real" if best["real"] else "sim",
                               market="corners" if best["market"] == "corners" else "score",
                               sport=p.get("sport", "soccer"), slug=p.get("slug", ""))
            _attach_reasoning(bet["id"], p, best)
            placed += 1
            already.add(p["id"])
            remaining_budget -= stake
            balance -= stake
        except ValueError:
            no_funds += 1
            break

    tickets = _place_tickets(ticket_pool, cfg, balance)

    return {
        "placed": placed,
        "tickets": tickets,
        "skipped_duplicate": skipped_dup,
        "skipped_not_sharp": skipped_soft,
        "skipped_daily_cap": skipped_cap,
        "skipped_ml_veto": skipped_ml,
        "skipped_simulated_odds": skipped_sim,
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
