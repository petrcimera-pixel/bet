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
from . import calibration
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
MIN_STAKE = 5.0   # podlaha na tiket – pod tuhle částku se sázka přeskočí
ML_VETO_PROB = 0.35   # model musí dávat aspoň tuto šanci na výhru, jinak tip přeskočíme
MAX_STAKE_PER_TICKET = 10.0   # tvrdý globální strop – žádný tiket agenta nesmí přesáhnout
EXPERIENCE_WINDOW = 30         # počet posledních vyhodnocených sázek pro výpočet dovednosti


def _experience_scale() -> float:
    """Váha dovedností a zkušeností agenta. Stejná myšlenka jako u sázkařů:
    nový agent bez historie sází zlomek, ustálený ziskový plný Kelly, dlouhá
    série proher ho stáhne. Počítá se z posledních EXPERIENCE_WINDOW sázek
    s tagem 'bet-agent'."""
    bets = [b for b in agent_bets() if b.get("status") in ("won", "lost")]
    if not bets:
        return 0.35
    recent = sorted(bets, key=lambda b: b.get("settled_ts") or b.get("ts", 0))[-EXPERIENCE_WINDOW:]
    staked = sum(b.get("stake", 0) for b in recent)
    pnl = sum(b.get("pnl", 0) for b in recent)
    roi = (pnl / staked) if staked else 0.0
    experience = min(1.0, len(recent) / EXPERIENCE_WINDOW)
    skill = max(0.5, min(1.5, 1.0 + roi))
    return round(0.35 + 0.65 * experience * skill, 3)


def _ml_veto(outcome, odds, prob, league, ml_features=None) -> bool:
    """True = naučený model tip zamítá. Bez natrénovaného modelu nikdy nevetuje."""
    if not _ML:
        return False
    try:
        learner = ml_learner.get_learner()
        if learner.model is None:
            return False
        pred = learner.predict_with_confidence({
            "odds": odds, "prob": prob, "prediction": outcome, "league": league,
            **(ml_features or {}),
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
    Vrací list dictů: outcome, label, name, odds, prob, market, real.
    JEN trhy, kde ESPN poskytlo skutečné kurzy sázkovky – žádné fingované
    kurzy (stará verze si vymýšlela panel bookmakerů, když reálné chyběly)."""
    markets = cfg.get("markets") or {}
    out = []
    bets = p.get("bets", {})

    def add(outcome, b, market):
        odds, prob = b.get("odds"), b.get("prob")
        if not odds or not prob or not b.get("real"):
            return   # bez reálného kurzu sázkovky se nesází – jen "papírová" pravděpodobnost
        # Odfiltrovat drahé trhy (vysoká marže sázkovky). Nad ~8 % marže
        # se prakticky nedá najít systematická value – jen šum. Stejný
        # limit používají i virtuální sázkaři (VIG_CAP v virtual_bettors.py).
        vig = b.get("market_vig")
        if vig is not None and vig > 0.08:
            return
        out.append({
            "outcome": outcome, "label": b.get("label", "?"),
            "name": b.get("name", b.get("label", "?")),
            "odds": float(odds), "prob": float(prob),
            # kalibrovaná pravděpodobnost = model prob opravená podle skutečné
            # historické úspěšnosti (model je systematicky překalibrovaný)
            "cal_prob": calibration.calibrate(float(prob), outcome),
            "edge": b.get("edge", 0.0) or 0.0,
            "market_vig": vig,
            "market": market, "real": True,
        })

    if markets.get("winner", True):
        keys = ("home", "away") if p.get("two_way") else ("home", "draw", "away")
        for k in keys:
            if k in bets:
                add(k, bets[k], "winner")
    if markets.get("goals", True):
        for k, b in bets.items():
            if k.startswith(("over", "under")):
                add(k, b, "goals")
    return out


MIN_CAL_EV = 1.02   # min. EV z KALIBROVANÉ pravděpodobnosti – ať se nesází nula-EV tipy

def _best_tutovka(cands, min_prob, min_odds, only_real):
    """Nejjistější tip zápasu podle KALIBROVANÉ pravděpodobnosti.

    Nově navíc gate: kalibrované EV = cal_prob * odds musí být aspoň
    MIN_CAL_EV. Bez toho by šla vsadit "jistá" sázka na 82 % za kurz 1.20,
    kde je kalibrovaná pravděpodobnost 78 % a EV = 0.94 (očekávaně ztrátové).
    Historicky přesně takové sázky – vysoká jistota, nízký kurz – dělaly
    Konzervativní Kláře 75 % win rate a mínusový bank."""
    ok = [c for c in cands
          if c.get("cal_prob", c["prob"]) >= min_prob and c["odds"] >= min_odds
          and c.get("cal_prob", c["prob"]) * c["odds"] >= MIN_CAL_EV
          and not (only_real and not c["real"])]
    return max(ok, key=lambda c: c.get("cal_prob", c["prob"])) if ok else None


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
    for c in sorted(pool, key=lambda c: c.get("cal_prob", c["prob"]), reverse=True):
        if c.get("cal_prob", c["prob"]) < min_prob or c["match_id"] in used or c["market"] == "corners":
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
    # AKO tikety: stejný tvrdý strop 10 Kč jako u singlů – aby agent
    # nemohl obejít MAX_STAKE_PER_TICKET přes vyšší 'ticket_stake' v Nastavení.
    stake = min(float(cfg.get("ticket_stake", 20.0)), MAX_STAKE_PER_TICKET)

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
    cal = best.get("cal_prob", best["prob"])
    if abs(cal - best["prob"]) >= 0.02:
        why.append(f'Kalibrovaná jistota {cal*100:.0f} % (model říká {best["prob"]*100:.0f} %, '
                   f'korekce podle skutečné historické úspěšnosti) – nejjistější tip '
                   f'zápasu napříč trhy ({_MARKET_CZ.get(best["market"], best["market"])}).')
    else:
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
        diff = rh.get("a", 1.0) - ra.get("a", 1.0)
        if abs(diff) >= 0.15:
            stronger = p["home"] if diff > 0 else p["away"]
            why.append(f'{stronger} má výrazně silnější útočný rating.')
    why.append(f'Kurz {best["odds"]} je reálný kurz sázkovky – ne odhad modelu.')
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
    # Váha dovednosti podle nedávné historie – nový/špatný agent tlumí sázky
    skill = _experience_scale()

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

        rh, ra = p.get("rating_home") or {}, p.get("rating_away") or {}
        eg = p.get("exp_goals") or {}
        ml_features = {
            "edge": best.get("edge", 0.0),
            "attack_home": rh.get("a", 1.0), "defense_home": rh.get("d", 1.0),
            "attack_away": ra.get("a", 1.0), "defense_away": ra.get("d", 1.0),
            "exp_goals_home": eg.get("home"), "exp_goals_away": eg.get("away"),
            # kolik zápasů rating obou týmů reálně viděl – nový/málo sledovaný
            # tým na 1.0 (neutrální výchozí hodnota) je mnohem nejistější
            # odhad než tým po desítkách zápasů
            "rating_confidence": min(1.0, (rh.get("n", 0) + ra.get("n", 0)) / 40.0),
        }

        # ML gate: naučený model může tip vetovat (učí se z vlastních chyb) –
        # STEJNÉ featury jako se pak ukládají k tréninku, jinak by veto
        # rozhodoval podle jiných vstupů, než na jakých se model učil.
        if _ml_veto(best["outcome"], best["odds"], best["prob"], p.get("league"), ml_features):
            skipped_ml += 1
            continue

        # kandidát na tiket (i když se single nevejde do denního stropu)
        ticket_pool.append(dict(best, match_id=p["id"],
                                match=f'{p["home"]} – {p["away"]}',
                                date=p.get("date", ""), time=p.get("time", "")))

        cal = best.get("cal_prob", best["prob"])
        if stake_mode == "kelly":
            # Kelly z KALIBROVANÉ pravděpodobnosti – syrová by nadhodnocovala vklady.
            # confidence_scale (0.5-1.0): i při stejném edge srazí vklad, pokud
            # rating stojí na málo odehraných zápasech – nejistý odhad si
            # zaslouží menší podíl banku, ne jen nižší práh jistoty.
            conf_scale = 0.5 + 0.5 * ml_features["rating_confidence"]
            stake = bankroll.kelly_stake(cal, best["odds"], balance, kelly_fraction, conf_scale)
            stake = max(stake, MIN_STAKE) if stake > 0 else flat_stake * 0.5
        else:
            stake = flat_stake

        if remaining_budget < MIN_STAKE:
            skipped_cap += 1
            continue
        # Když strategie navrhla nenulovou sázku, natlačíme ji do rozsahu
        # MIN..MAX Kč. Bez podlahy by na malém banku (200 Kč) a experience
        # nováčka (×0.35) skoro každá sázka spadla pod MIN a agent by
        # prakticky nesázel – přitom uživatel žádal "min 5, max 10 na tiket".
        stake = stake * skill
        if stake < 0.5:
            skipped_cap += 1
            continue
        stake = max(MIN_STAKE, min(stake, remaining_budget, MAX_STAKE_PER_TICKET))
        stake = round(stake, 2)

        try:
            bet = bankroll.place_bet(p["id"], best["label"], best["outcome"],
                               best["odds"], cal, stake,
                               p["home"], p["away"], consensus_odds=None, tag=TAG,
                               match_date=p.get("date"), match_time=p.get("time"),
                               league=p.get("league"),
                               odds_source="real", market="score",
                               sport=p.get("sport", "soccer"), slug=p.get("slug", ""),
                               ml_features=ml_features)
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
