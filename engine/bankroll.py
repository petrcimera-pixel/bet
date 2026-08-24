# -*- coding: utf-8 -*-
"""
Správa banku (bankroll), Kelly kritérium a historie tipů + statistiky (ROI).
Stav se ukládá do data/bankroll.json.
"""

import os
import time
import uuid

from . import live_log, storage

# ML feedback logging (optional – jen pokud je ML dostupné)
try:
    from . import ml_learner
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False

_DEFAULT = {
    "start_balance": 200.0,
    "balance": 200.0,
    "currency": "Kč",
    "kelly_fraction": 0.25,   # frakční Kelly (čtvrtinový) – konzervativní
    "bets": [],               # historie tipů
}


def state() -> dict:
    st = storage.load("bankroll.json", None)
    if st is None:
        # Stejná past jako u virtual_bettors.load_state: když čtení selže
        # (rozepsaný soubor při souběžném zápisu), storage.load vrátí None
        # a bez téhle pojistky by se prázdný výchozí bank hned uložil na
        # disk – tedy smazané VŠECHNY sázky agenta. Prázdný stav se smí
        # vyrobit jedině tehdy, když soubor opravdu ještě neexistuje.
        if os.path.exists(storage._path("bankroll.json")):
            raise RuntimeError(
                "bankroll.json existuje, ale nepodařilo se ho načíst – "
                "odmítám ho přepsat prázdným bankem.")
        st = dict(_DEFAULT)
        storage.save("bankroll.json", st)
    return st


def _save(st):
    storage.save("bankroll.json", st)


def reset(start_balance: float = 200.0) -> dict:
    """Kompletní reset: smaže VŠECHNY sázky (agentovské i ruční) a nastaví
    nový počáteční bank. Nezachovává historii – použití: začít znovu od
    nuly, aby agent zapomněl minulou zkušenost i pořadí sázek."""
    st = state()
    st["start_balance"] = float(start_balance)
    st["balance"] = float(start_balance)
    st["bets"] = []
    _save(st)
    return {"start_balance": float(start_balance), "balance": float(start_balance)}


def settings(start_balance=None, kelly_fraction=None, currency=None):
    st = state()
    if start_balance is not None:
        diff = float(start_balance) - st["start_balance"]
        st["start_balance"] = float(start_balance)
        st["balance"] = round(st["balance"] + diff, 2)
    if kelly_fraction is not None:
        st["kelly_fraction"] = max(0.05, min(1.0, float(kelly_fraction)))
    if currency:
        st["currency"] = currency
    _save(st)
    return st


def kelly_stake(prob: float, odds: float, balance: float, fraction: float,
                 confidence_scale: float = 1.0) -> float:
    """Doporučená sázka dle (frakčního) Kelly kritéria.

    confidence_scale (0-1, default 1.0) dál srazí vklad, pokud model stojí na
    málo odehraných zápasech (nízké rating_confidence) – i při stejné
    pravděpodobnosti/kurzu je odhad u nového týmu míň spolehlivý, takže si
    zaslouží menší podíl banku."""
    b = odds - 1.0
    if b <= 0:
        return 0.0
    edge = prob * odds - 1.0
    if edge <= 0:
        return 0.0
    f = (prob * b - (1 - prob)) / b   # plný Kelly podíl banku
    f = max(0.0, f) * fraction * max(0.0, min(1.0, confidence_scale))
    return round(balance * f, 2)


def track_closing_odds(match_odds: dict) -> int:
    """Zapíše k otevřeným sázkám aktuální kurz trhu.

    CLV (closing line value) = porovnání kurzu, za který jsme vsadili, proti
    kurzu těsně před výkopem. Je to nejspolehlivější ukazatel, jestli sázkař
    dlouhodobě bere lepší cenu než trh – a na rozdíl od zisku dává smysl už
    po pár desítkách sázek, protože nezávisí na tom, jestli zrovna padl gól.

    match_odds: {match_id: {outcome: odds}} z čerstvých predikcí.
    """
    if not match_odds:
        return 0
    st = state()
    n = 0
    for bet in st["bets"]:
        if bet.get("status") != "open" or bet.get("outcome") == "acca":
            continue
        cur = (match_odds.get(bet.get("match_id")) or {}).get(bet.get("outcome"))
        if not cur:
            continue
        # poslední viděný kurz před výkopem = "closing line"
        if bet.get("closing_odds") != cur:
            bet["closing_odds"] = round(float(cur), 3)
            bet["clv"] = _clv(bet["odds"], cur)
            n += 1
    if n:
        _save(st)
    return n


def _clv(odds, consensus_odds):
    """Náskok kurzu nad tržním konsenzem (CLV-style): >0 = vzal jsi lepší cenu než trh."""
    try:
        co = float(consensus_odds)
        if co > 0:
            return round(float(odds) / co - 1.0, 4)
    except (TypeError, ValueError):
        pass
    return None


def place_bet(match_id, label, outcome, odds, prob, stake, home, away,
              consensus_odds=None, tag=None, match_date=None, match_time=None, league=None,
              odds_source=None, market=None, sport=None, slug=None, ml_features=None):
    st = state()
    stake = round(float(stake), 2)
    if stake <= 0 or stake > st["balance"]:
        raise ValueError("Neplatná výše sázky vzhledem k zůstatku.")
    bet = {
        "id": uuid.uuid4().hex[:10],
        "ts": int(time.time()),
        "match_id": match_id,
        "match": f"{home} – {away}",
        "match_date": match_date or "",   # kdy se hraje (YYYY-MM-DD)
        "match_time": match_time or "",   # v kolik (HH:MM)
        "league": league or "Unknown",    # která liga
        "outcome": outcome,            # home / draw / away / over25 ...
        "label": label,                # 1 / X / 2 ...
        "odds": round(float(odds), 2),
        "prob": round(float(prob), 4),
        "stake": stake,
        "status": "open",              # open / won / lost / void
        "pnl": 0.0,
        "clv": _clv(odds, consensus_odds),
        "tag": tag,                    # "bet-agent" = sázka bet agenta
        "odds_source": odds_source or "sim",   # "real" = kurzy sázkovky (ESPN/Odds API)
        "market": market or "score",   # "score" (góly/výsledek) | "corners" (rohy)
        "sport": sport or "soccer",    # pro dohledání výsledku (rohy = ESPN summary)
        "slug": slug or "",            # liga slug pro ESPN summary endpoint
        "ml_features": ml_features or {},   # signály z goals_model pro ML Learning (viz settle_bet)
    }
    st["balance"] = round(st["balance"] - stake, 2)
    st["bets"].insert(0, bet)
    _save(st)
    live_log.zaznam(
        f"vsazeno {stake} Kč · {home} – {away} · tip {label} @ {odds}× "
        f"· jistota {round(float(prob or 0) * 100)} % · zbývá {st['balance']} Kč",
        kategorie="sázka agenta")

    # Record for ML learning (feedback loop)
    if ML_AVAILABLE and tag == "bet-agent":
        try:
            ml_learner.record_bet_outcome(
                bet_id=bet["id"],
                match_id=match_id,
                prediction=outcome,
                odds=odds,
                stake=stake,
                outcome="open",  # will be updated when settled
                home_team=home,
                away_team=away,
                league=league or "Unknown",
                match_date=match_date or "",
                features={"odds": odds, "prob": prob, **(ml_features or {})}
            )
        except Exception:
            pass  # ML logging nie by měl bránit sázce

    return bet


def place_acca(legs, stake, tag=None, name=None):
    """Akumulátor – jeden tiket z více výběrů (kombinovaný kurz).
    Legs s match_id + outcome se vyhodnocují automaticky (settle_accas)."""
    st = state()
    stake = round(float(stake), 2)
    if not legs:
        raise ValueError("Prázdný tiket.")
    if stake <= 0 or stake > st["balance"]:
        raise ValueError("Neplatná výše sázky vzhledem k zůstatku.")
    odds = 1.0
    prob = 1.0
    for l in legs:
        odds *= float(l["odds"])
        prob *= float(l.get("prob") or 0)
    # nejbližší výkop napříč výběry – kdy se tiket začne rozhodovat
    dated = sorted((l.get("date", ""), l.get("time", "")) for l in legs if l.get("date"))
    earliest_date, earliest_time = dated[0] if dated else ("", "")
    bet = {
        "id": uuid.uuid4().hex[:10],
        "ts": int(time.time()),
        "match_id": "",
        "match": name or f"Akumulátor ({len(legs)} tipy)",
        "match_date": earliest_date,
        "match_time": earliest_time,
        "outcome": "acca",
        "label": f"AKO {len(legs)}",
        "odds": round(odds, 2),
        "prob": round(prob, 4),
        "stake": stake,
        "status": "open",
        "pnl": 0.0,
        "clv": None,
        "tag": tag,
        "legs": [{"match": l.get("match", ""), "name": l.get("name", ""),
                  "match_id": l.get("match_id", ""), "outcome": l.get("outcome", ""),
                  "prob": float(l.get("prob") or 0), "result": None,
                  "odds": float(l["odds"]), "date": l.get("date", ""), "time": l.get("time", "")}
                 for l in legs],
    }
    st["balance"] = round(st["balance"] - stake, 2)
    st["bets"].insert(0, bet)
    _save(st)
    live_log.zaznam(
        f"vsazen tiket {stake} Kč · {len(legs)} noh @ {round(odds, 2)}× "
        f"· {' + '.join(l.get('match', '?') for l in legs)} · zbývá {st['balance']} Kč",
        kategorie="sázka agenta")
    return bet


def eval_outcome(outcome, hs, as_):
    """Vyhodnotí výsledek sázky podle skóre. Vrací 'won' / 'lost' / None (acca)."""
    if outcome == "acca":
        return None
    total = hs + as_
    if outcome == "home":
        return "won" if hs > as_ else "lost"
    if outcome == "away":
        return "won" if as_ > hs else "lost"
    if outcome == "draw":
        return "won" if hs == as_ else "lost"
    if outcome == "btts_yes":
        return "won" if (hs > 0 and as_ > 0) else "lost"
    if outcome == "btts_no":
        return "won" if not (hs > 0 and as_ > 0) else "lost"
    if outcome.startswith("over"):
        return "won" if total > float(outcome[4:]) else "lost"
    if outcome.startswith("under"):
        return "won" if total < float(outcome[5:]) else "lost"
    # Dvojtip – pokrývá dva ze tří výsledků najednou
    if outcome == "dc_1x":
        return "won" if hs >= as_ else "lost"
    if outcome == "dc_12":
        return "won" if hs != as_ else "lost"
    if outcome == "dc_x2":
        return "won" if as_ >= hs else "lost"
    # Remíza zpět – při remíze se vrací vklad
    if outcome == "dnb_home":
        return "void" if hs == as_ else ("won" if hs > as_ else "lost")
    if outcome == "dnb_away":
        return "void" if hs == as_ else ("won" if as_ > hs else "lost")
    # Handicap (asijský): "ah_home_-0.5" = k domácím se přičte -0.5 gólu.
    # Půlgólové linie nemůžou skončit remízou, takže se nikdy nevrací vklad.
    if outcome.startswith("ah_"):
        try:
            _, side, line = outcome.split("_", 2)
            adj = (hs + float(line)) - as_ if side == "home" else (as_ + float(line)) - hs
        except (ValueError, TypeError):
            return None
        if adj > 0:
            return "won"
        if adj < 0:
            return "lost"
        return "void"        # celé číslo a přesná shoda = vklad zpět
    return None


def auto_settle(results: dict, corner_results: dict = None) -> int:
    """results: {match_id: {'home':hs,'away':as_}} = skóre.
    corner_results: {match_id: {'home':h,'away':a}} = rohy.
    Vyhodnotí otevřené single tipy (skóre i rohy) a AKO tikety."""
    corner_results = corner_results or {}
    if not results and not corner_results:
        return 0
    to_settle = []
    for bet in state()["bets"]:
        if bet["status"] != "open" or bet.get("outcome") == "acca":
            continue
        # rohové sázky se vyhodnocují proti počtu rohů, ne skóre
        src = corner_results if bet.get("market") == "corners" else results
        res = src.get(bet["match_id"])
        if not res:
            continue
        r = eval_outcome(bet["outcome"], res["home"], res["away"])
        if r:
            # skóre se předává dál, aby ho sázka nesla i po vyhodnocení
            to_settle.append((bet["id"], r, results.get(bet["match_id"])))
    for bet_id, result, score in to_settle:
        settle_bet(bet_id, result, score)
    return len(to_settle) + settle_accas(results)


def settle_accas(results: dict) -> int:
    """Vyhodnotí otevřené AKO tikety: prohraný leg = celý tiket prohrán,
    všechny legy vyhrané = tiket vyhrán. Nerozhodnuté legy = tiket zůstává open."""
    if not results:
        return 0
    st = state()
    n = 0
    changed = False
    for bet in st["bets"]:
        if bet["status"] != "open" or bet.get("outcome") != "acca":
            continue
        legs = bet.get("legs") or []
        if not legs or not all(l.get("match_id") and l.get("outcome") for l in legs):
            continue   # starý tiket bez match_id – nelze vyhodnotit automaticky
        undecided = False
        lost = False
        for l in legs:
            if l.get("result") in ("won", "lost"):
                if l["result"] == "lost":
                    lost = True
                continue
            res = results.get(l["match_id"])
            if not res:
                undecided = True
                continue
            r = eval_outcome(l["outcome"], res["home"], res["away"])
            if r:
                l["result"] = r
                changed = True
                if r == "lost":
                    lost = True
            else:
                undecided = True
        if lost:
            bet["status"] = "lost"
            bet["pnl"] = round(-bet["stake"], 2)
            bet["settled_ts"] = int(time.time())
            changed = True
            n += 1
        elif not undecided:
            payout = round(bet["stake"] * bet["odds"], 2)
            bet["status"] = "won"
            bet["pnl"] = round(payout - bet["stake"], 2)
            st["balance"] = round(st["balance"] + payout, 2)
            bet["settled_ts"] = int(time.time())
            changed = True
            n += 1
    if changed:
        _save(st)
    return n


def settle_bet(bet_id, result, score=None):
    """result: 'won' / 'lost' / 'void'."""
    st = state()
    for bet in st["bets"]:
        if bet["id"] == bet_id and bet["status"] == "open":
            if result == "won":
                payout = round(bet["stake"] * bet["odds"], 2)
                bet["pnl"] = round(payout - bet["stake"], 2)
                st["balance"] = round(st["balance"] + payout, 2)
            elif result == "void":
                bet["pnl"] = 0.0
                st["balance"] = round(st["balance"] + bet["stake"], 2)
            else:  # lost
                bet["pnl"] = round(-bet["stake"], 2)
            bet["status"] = result
            bet["settled_ts"] = int(time.time())
            # výsledek zápasu k sázce, ať je v historii vidět, jak to dopadlo
            if score and score.get("home") is not None:
                bet["result"] = {"home": score["home"], "away": score["away"]}
            _save(st)
            _vysledek = {"won": "✅ vyhrála", "lost": "❌ prohrála"}.get(result, "➖ zrušena")
            live_log.zaznam(
                f"sázka {_vysledek} · {bet.get('match', '?')} · {bet.get('label', '?')} "
                + (f"· {score['home']}:{score['away']} " if score and score.get("home") is not None else "")
                + f"· {'+' if bet['pnl'] > 0 else ''}{bet['pnl']} Kč · zůstatek {st['balance']} Kč",
                kategorie="sázka agenta",
                uroven="info")

            # Update ML feedback with actual outcome
            if ML_AVAILABLE and bet.get("tag") == "bet-agent":
                try:
                    ml_learner.record_bet_outcome(
                        bet_id=bet["id"],
                        match_id=bet["match_id"],
                        prediction=bet["outcome"],
                        odds=bet["odds"],
                        stake=bet["stake"],
                        outcome=result,  # won / lost / void
                        home_team=bet["match"].split(" – ")[0] if " – " in bet["match"] else "",
                        away_team=bet["match"].split(" – ")[1] if " – " in bet["match"] else "",
                        league=bet.get("league", "Unknown"),
                        match_date=bet.get("match_date", ""),
                        features={"odds": bet["odds"], "prob": bet["prob"], **(bet.get("ml_features") or {})}
                    )
                except Exception:
                    pass  # ML update nie by měl bránit vyhodnocení

            return bet
    raise ValueError("Tip nenalezen nebo již vyhodnocen.")


def equity_curve(st=None) -> list:
    """Vývoj banku v čase: počáteční stav + kumulativní zisk vyhodnocených tipů,
    seřazeno podle času VYHODNOCENÍ (ne vsazení) – hromadné dohnání starších
    výsledků (settle přes více dní najednou) by jinak zamíchalo tvar křivky."""
    if st is None:
        st = state()
    settled = sorted([b for b in st["bets"] if b["status"] in ("won", "lost", "void")],
                     key=lambda b: b.get("settled_ts") or b["ts"])
    bal = st["start_balance"]
    pts = [round(bal, 2)]
    for b in settled:
        bal += b["pnl"]
        pts.append(round(bal, 2))
    return pts


def stats() -> dict:
    st = state()
    settled = [b for b in st["bets"] if b["status"] in ("won", "lost")]
    staked = sum(b["stake"] for b in settled)
    pnl = sum(b["pnl"] for b in settled)
    won = sum(1 for b in settled if b["status"] == "won")
    open_bets = [b for b in st["bets"] if b["status"] == "open"]
    best = max((b["pnl"] for b in settled), default=0.0)
    worst = min((b["pnl"] for b in settled), default=0.0)
    clvs = [b["clv"] for b in st["bets"] if b.get("clv") is not None]
    avg_clv = round(sum(clvs) / len(clvs) * 100, 2) if clvs else None

    # Nové metriky
    unit_count = round(staked / len(settled), 2) if settled else 0
    sharpe = _compute_sharpe(settled)
    monthly_pnl = _compute_monthly_pnl(settled)
    by_league = _compute_by_league(settled)

    return {
        "balance": st["balance"],
        "start_balance": st["start_balance"],
        "currency": st["currency"],
        "kelly_fraction": st["kelly_fraction"],
        # Realizovaný zisk jen z VYHODNOCENÝCH sázek (ne balance-start_balance, což by
        # počítalo i peníze aktuálně vázané v otevřených sázkách jako by byly prohrané).
        "profit": round(pnl, 2),
        "roi": round(pnl / staked * 100, 1) if staked else 0.0,
        "settled_count": len(settled),
        "won_count": won,
        "win_rate": round(won / len(settled) * 100, 1) if settled else 0.0,
        "open_count": len(open_bets),
        "open_stake": round(sum(b["stake"] for b in open_bets), 2),
        "total_bets": len(st["bets"]),
        "best_win": round(best, 2),
        "worst_loss": round(worst, 2),
        "avg_clv": avg_clv,
        "equity": equity_curve(st),
        # Nové metriky
        "unit_count": unit_count,
        "sharpe_ratio": round(sharpe, 2),
        "monthly_pnl": monthly_pnl,
        "by_league": by_league,
    }


def _compute_sharpe(bets: list) -> float:
    """Sharpe ratio = (avg_return - risk_free) / std_dev. Risk-free rate = 0."""
    if len(bets) < 2:
        return 0
    pnls = [b["pnl"] for b in bets]
    mean = sum(pnls) / len(pnls)
    variance = sum((x - mean) ** 2 for x in pnls) / len(pnls)
    std_dev = variance ** 0.5
    return mean / std_dev if std_dev > 0 else 0


def _compute_monthly_pnl(bets: list) -> dict:
    """Groupuj P&L po měsících (YYYY-MM)."""
    import datetime
    monthly = {}
    for b in bets:
        ts = b.get("ts")
        if ts:
            try:
                dt = datetime.datetime.fromtimestamp(ts)
                month_key = dt.strftime("%Y-%m")
            except (ValueError, TypeError):
                month_key = "unknown"
        else:
            month_key = "unknown"
        monthly[month_key] = monthly.get(month_key, 0) + b["pnl"]
    return {k: round(v, 2) for k, v in sorted(monthly.items())}


def breakdown(bets: list, key: str, tag: str = None) -> list:
    """Seskupí VYHODNOCENÉ sázky podle daného klíče (sport / league /
    outcome_market) a spočítá n, win_rate, staked, pnl, ROI. Vrátí seřazené
    podle profitu sestupně. Stejná logika jako _perf_breakdown v aréně
    sázkařů – tam se používá na virtuální sázkaře, tady na agenta, ať jde
    obojí srovnat stejným pohledem."""
    by = {}
    for x in bets:
        if x.get("status") not in ("won", "lost") or x.get("legs"):
            continue   # AKO tikety kombinují víc zápasů/sportů, nemají jediný smysluplný sport/trh
        if tag is not None and x.get("tag") != tag:
            continue
        k = x.get(key) or "?"
        if key == "outcome":
            oc = x.get("outcome", "")
            if oc in ("home", "draw", "away") or oc.startswith("dc_") or oc.startswith("dnb_"):
                k = "vítěz"
            elif oc.startswith("over") or oc.startswith("under"):
                k = "góly"
            elif oc.startswith("ah_"):
                k = "handicap"
            elif oc == "acca":
                k = "tikety"
            else:
                k = "ostatní"
        d = by.setdefault(k, {"key": k, "n": 0, "won": 0, "staked": 0.0, "pnl": 0.0})
        d["n"] += 1
        d["won"] += (1 if x["status"] == "won" else 0)
        d["staked"] += x.get("stake", 0)
        d["pnl"] += x.get("pnl", 0)
    for d in by.values():
        d["win_rate"] = round(d["won"] / d["n"] * 100, 1) if d["n"] else 0.0
        d["roi"] = round(d["pnl"] / d["staked"] * 100, 1) if d["staked"] else 0.0
        d["pnl"] = round(d["pnl"], 2)
        d["staked"] = round(d["staked"], 2)
    return sorted(by.values(), key=lambda x: -x["pnl"])


def _compute_by_league(bets: list) -> dict:
    """Groupuj výkon po ligách - wins, settled, pnl, win_rate, roi."""
    by_league = {}
    for b in bets:
        league = b.get("league", "Unknown")
        if league not in by_league:
            by_league[league] = {"wins": 0, "settled": 0, "pnl": 0.0, "staked": 0.0}
        by_league[league]["settled"] += 1
        by_league[league]["staked"] += b["stake"]
        if b["status"] == "won":
            by_league[league]["wins"] += 1
        by_league[league]["pnl"] += b["pnl"]

    for league in by_league:
        settled = by_league[league]["settled"]
        staked = by_league[league]["staked"]
        by_league[league]["win_rate"] = round(
            by_league[league]["wins"] / settled * 100, 1
        ) if settled else 0
        # ROI = zisk / prosázená částka (ne / počet sázek)
        by_league[league]["roi"] = round(
            by_league[league]["pnl"] / staked * 100, 1
        ) if staked else 0
        by_league[league]["pnl"] = round(by_league[league]["pnl"], 2)
        by_league[league]["staked"] = round(staked, 2)

    return by_league
