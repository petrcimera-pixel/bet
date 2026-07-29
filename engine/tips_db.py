# -*- coding: utf-8 -*-
"""
Databáze automatických tipů modelu.

Každý nový nadcházející zápas, který model analyzuje, se automaticky uloží jako tip.
Tipy lze zpětně vyhodnotit podle skutečných výsledků a sledovat:
  - Pick accuracy: jak often správně predikuje favorita
  - Value ROI: výnos, kdybys vsadil 1 jednotku na každou value příležitost
  - Kalibrace: zda 70% jistota = skutečně ~70% úspěšnost
"""

import datetime
from . import storage


SHARP_PROB = 0.55   # od jaké pravděpodobnosti favorita je tip „ostrý" (ne coin-flip)


def _sharp(t: dict) -> bool:
    """Ostrý tip = reálná konvikce. Počítá se z pick_prob/has_value, takže funguje
    i zpětně na tipech uložených před zavedením pole is_sharp."""
    if t.get("is_sharp") is not None:
        return bool(t["is_sharp"])
    return (t.get("pick_prob") or 0) >= SHARP_PROB or bool(t.get("has_value"))


# ---------------------------------------------------------------------------
# Interní stav
# ---------------------------------------------------------------------------
def _db() -> dict:
    return storage.load("tips.json", {"tips": []})


def _save(db: dict):
    storage.save("tips.json", db)


# ---------------------------------------------------------------------------
# Ukládání tipů
# ---------------------------------------------------------------------------
def save_tips(predictions: list) -> int:
    """
    Automaticky uloží tipy pro nové nadcházející zápasy.
    Přeskočí: (a) zápasy s výsledkem, (b) duplikáty.
    Vrací počet nově uložených tipů.
    """
    db = _db()
    existing = {t["id"] for t in db["tips"]}
    added = 0
    now = datetime.datetime.now().isoformat(timespec="seconds")

    for p in predictions:
        if p.get("result") is not None:
            continue
        if p["id"] in existing:
            continue

        bv = p.get("best_value") or {}
        pick = p.get("pick", "home")
        pick_bet = p.get("bets", {}).get(pick, {})

        # Tip na góly (více/méně) – vybere se linie, ve které je model nejjistější
        goal_lines = p.get("goal_lines") or []
        gp = None
        if goal_lines:
            best_line = max(goal_lines, key=lambda g: max(g["over"]["prob"], g["under"]["prob"]))
            side = "over" if best_line["over"]["prob"] >= best_line["under"]["prob"] else "under"
            sel = best_line[side]
            # "name" je jen v p["bets"], ne v goal_lines – dohledáme ho odtud, jinak poskládáme
            bet_name = p.get("bets", {}).get(f"{side}{best_line['line']}", {}).get("name", "")
            unit = p.get("unit", "gólů")
            name = bet_name or f"{'Více' if side == 'over' else 'Méně'} než {best_line['line']} {unit}"
            gp = {
                "line": best_line["line"],
                "side": side,
                "outcome": f"{side}{best_line['line']}",
                "name": name,
                "prob": round(sel.get("prob", 0), 4),
                "odds": sel.get("odds"),
                "book": "ESPN BET" if sel.get("real") else "",
                "is_value": bool(sel.get("is_value")),
                "ev": round(sel.get("ev", 0) * 100, 1) if sel.get("is_value") else None,
            }

        # Tip na rohy (více/méně) – jen fotbal, vybere se nejjistější linie
        corner_lines = p.get("corner_lines") or []
        cp = None
        if corner_lines:
            best_cline = max(corner_lines, key=lambda g: max(g["over"]["prob"], g["under"]["prob"]))
            cside = "over" if best_cline["over"]["prob"] >= best_cline["under"]["prob"] else "under"
            csel = best_cline[cside]
            cname = f"{'Více' if cside == 'over' else 'Méně'} než {best_cline['line']} rohů"
            cp = {
                "line": best_cline["line"],
                "side": cside,
                "outcome": f"{cside}{best_cline['line']}",
                "name": cname,
                "prob": round(csel.get("prob", 0), 4),
                "odds": csel.get("odds"),
                "book": "ESPN BET" if csel.get("real") else "",
                "is_value": bool(csel.get("is_value")),
                "ev": round(csel.get("ev", 0) * 100, 1) if csel.get("is_value") else None,
            }

        probs = p.get("probs", {})
        pick_prob = round(probs.get(pick, 0), 4)

        # Dvojtip (double-chance) – jen fotbal (3cestný trh). U nejistých zápasů,
        # kde není jasný favorit, je pokrytí dvou výsledků výrazně trefovější než
        # sázka na jeden. Vybere dva nejpravděpodobnější výsledky (zahodí nejmenší).
        dc = None
        if "draw" in probs and probs.get("draw") is not None:
            drop = min(("home", "draw", "away"), key=lambda k: probs.get(k, 0))
            keep = [k for k in ("home", "draw", "away") if k != drop]
            _DC = {("home", "draw"): ("1X", "Domácí nebo remíza"),
                   ("home", "away"): ("12", "Domácí nebo hosté"),
                   ("draw", "away"): ("X2", "Remíza nebo hosté")}
            code, name = _DC[tuple(keep)]
            dc = {
                "outcome": code,
                "name": name,
                "prob": round(sum(probs.get(k, 0) for k in keep), 4),
                # dvojtip doporučíme, jen když jednotlivý favorit není přesvědčivý (<50 %)
                "recommended": pick_prob < 0.50,
            }

        # Ostrý tip = model má reálnou konvikci (favorit ≥ SHARP_PROB) nebo našel value.
        # Slouží k oddělení skutečných tipů od coin-flipů (viz separátní statistika).
        is_sharp = pick_prob >= SHARP_PROB or bool(bv.get("is_value"))

        tip = {
            "id":           p["id"],
            "sport":        p.get("sport", "soccer"),
            "slug":         p.get("slug", ""),
            "league":       p.get("league", ""),
            "country":      p.get("country", ""),
            "home":         p.get("home", ""),
            "away":         p.get("away", ""),
            "date":         p.get("date", ""),
            "time":         p.get("time", ""),
            # Pick (nejpravděpodobnější výsledek)
            "pick":         pick,
            "pick_label":   p.get("pick_label", ""),
            "pick_name":    pick_bet.get("name", ""),
            "pick_prob":    round(p.get("probs", {}).get(pick, 0), 4),
            "confidence":   p.get("confidence", 0),
            "pick_odds":    pick_bet.get("odds"),
            "pick_book":    "ESPN BET" if pick_bet.get("real") else "",
            # Value sázka (best EV – může být i Over/Under, BTTS…)
            "has_value":    bool(bv.get("is_value")),
            "value_outcome": bv.get("outcome") if bv.get("is_value") else None,
            "value_name":   bv.get("name", ""),
            "value_odds":   bv.get("odds") if bv.get("is_value") else None,
            "value_ev":     round(bv.get("ev", 0) * 100, 1) if bv.get("is_value") else None,
            "value_book":   ("ESPN BET" if bv.get("real") else "") if bv.get("is_value") else None,
            # Predikce gólů (očekávané hodnoty)
            "exp_goals":    p.get("exp_goals"),
            "exp_total":    p.get("exp_total"),
            # Tip na góly – více/méně (nejjistější linie)
            "goal_line":    gp["line"] if gp else None,
            "goal_side":    gp["side"] if gp else None,
            "goal_outcome": gp["outcome"] if gp else None,
            "goal_name":    gp["name"] if gp else "",
            "goal_prob":    gp["prob"] if gp else None,
            "goal_odds":    gp["odds"] if gp else None,
            "goal_book":    gp["book"] if gp else "",
            "goal_is_value": gp["is_value"] if gp else False,
            "goal_ev":      gp["ev"] if gp else None,
            "exp_corners":  p.get("exp_corners"),
            # Tip na rohy – více/méně (nejjistější linie); reálně se ověřuje
            # přes ESPN boxscore, který ne každá liga poskytuje
            "corner_line":    cp["line"] if cp else None,
            "corner_side":    cp["side"] if cp else None,
            "corner_outcome": cp["outcome"] if cp else None,
            "corner_name":    cp["name"] if cp else "",
            "corner_prob":    cp["prob"] if cp else None,
            "corner_odds":    cp["odds"] if cp else None,
            "corner_book":    cp["book"] if cp else "",
            "corner_is_value": cp["is_value"] if cp else False,
            "corner_ev":      cp["ev"] if cp else None,
            # Dvojtip (double-chance) – bezpečnější alternativa u nejistých zápasů
            "dc_outcome":     dc["outcome"] if dc else None,
            "dc_name":        dc["name"] if dc else "",
            "dc_prob":        dc["prob"] if dc else None,
            "dc_recommended": dc["recommended"] if dc else False,
            # Ostrý tip = reálná konvikce (ne coin-flip)
            "is_sharp":       is_sharp,
            # Metadata
            "saved_at":     now,
            # Výsledek (vyplní se po vyhodnocení)
            "result":       None,   # {"home": H, "away": A}
            "actual":       None,   # "home" / "draw" / "away"
            "pick_result":  None,   # "won" / "lost"
            "value_result": None,   # "won" / "lost" / None
            "goal_result":  None,   # "won" / "lost" / None
            "corner_result": None,   # "won" / "lost" / None / "unverifiable"
            "dc_result":    None,   # "won" / "lost" / None
            "settled_at":   None,
        }
        db["tips"].append(tip)
        added += 1

    if added:
        _prune(db)
        _save(db)
    return added


_MAX_TIPS = 12000   # strop velikosti tips.json – bez něj roste bez omezení


def _prune(db: dict) -> int:
    """Když tips.json přeroste strop, zahodí nejstarší VYHODNOCENÉ tipy (nikdy
    otevřené – ty čekají na settle). Bez tohoto stropu soubor po měsících
    nepřetržitého běhu naroste na desítky MB a KAŽDÝ request (settle/status,
    dashboard, tips) ho musí znovu načíst a parsovat – na jednom gunicorn
    workeru to appku dokáže úplně ucpat."""
    tips = db["tips"]
    over = len(tips) - _MAX_TIPS
    if over <= 0:
        return 0
    settled = sorted(
        (i for i, t in enumerate(tips) if t.get("pick_result") is not None),
        key=lambda i: tips[i].get("settled_at") or "")
    drop = set(settled[:over])
    if not drop:
        return 0   # samé otevřené tipy – nemáme co bezpečně zahodit
    db["tips"] = [t for i, t in enumerate(tips) if i not in drop]
    return len(drop)


# ---------------------------------------------------------------------------
# Vyhodnocení tipů
# ---------------------------------------------------------------------------
def settle_tips(results: dict, corner_results: dict = None) -> int:
    """
    Vyhodnotí otevřené tipy podle slovníku výsledků.
    results: {match_id: {"home": int, "away": int}} – góly (z ESPN scoreboardu)
    corner_results: {match_id: {"home": int, "away": int}} – rohy (z ESPN
    boxscore summary, dostupné jen u některých lig – best effort)
    Vrací počet nově vyhodnocených tipů.
    """
    db = _db()
    corner_results = corner_results or {}
    settled = 0
    now = datetime.datetime.now().isoformat(timespec="seconds")

    for tip in db["tips"]:
        if tip["pick_result"] is not None:
            continue
        if tip["id"] not in results:
            continue

        res = results[tip["id"]]
        hs, as_ = int(res["home"]), int(res["away"])
        tip["result"] = {"home": hs, "away": as_}

        # Skutečný výsledek
        if tip.get("sport") == "soccer":
            actual = "home" if hs > as_ else ("away" if as_ > hs else "draw")
        else:
            actual = "home" if hs > as_ else "away"
        tip["actual"] = actual

        # Pick správně?
        tip["pick_result"] = "won" if tip["pick"] == actual else "lost"

        # Dvojtip (double-chance) správně? Vyhrává, když skutečný výsledek je v páru.
        dc = tip.get("dc_outcome")
        if dc:
            pair = {"1X": ("home", "draw"), "12": ("home", "away"), "X2": ("draw", "away")}.get(dc, ())
            tip["dc_result"] = "won" if actual in pair else "lost"

        # Value sázka správně?
        if tip["has_value"] and tip.get("value_outcome"):
            tip["value_result"] = _eval_outcome(tip["value_outcome"], hs, as_)

        # Tip na góly (více/méně) správně?
        if tip.get("goal_outcome"):
            tip["goal_result"] = _eval_outcome(tip["goal_outcome"], hs, as_)

        # Tip na rohy (více/méně) – ověří se jen pokud ESPN dal k zápasu boxscore
        if tip.get("corner_outcome"):
            cres = corner_results.get(tip["id"])
            if cres:
                tip["corner_result"] = _eval_outcome(tip["corner_outcome"], cres["home"], cres["away"])
            else:
                tip["corner_result"] = "unverifiable"

        tip["settled_at"] = now
        settled += 1

    if settled:
        _prune(db)
        _save(db)
    return settled


def _eval_outcome(outcome: str, hs: int, as_: int):
    """Vyhodnotí konkrétní market podle výsledku. Vrací 'won' / 'lost' / None."""
    total = hs + as_
    if outcome == "home":
        return "won" if hs > as_ else "lost"
    if outcome == "away":
        return "won" if as_ > hs else "lost"
    if outcome == "draw":
        return "won" if hs == as_ else "lost"
    if outcome == "btts_yes":
        return "won" if hs > 0 and as_ > 0 else "lost"
    if outcome == "btts_no":
        return "won" if not (hs > 0 and as_ > 0) else "lost"
    if outcome.startswith("over"):
        try:
            return "won" if total > float(outcome[4:]) else "lost"
        except ValueError:
            return None
    if outcome.startswith("under"):
        try:
            return "won" if total < float(outcome[5:]) else "lost"
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# Dotazy a statistiky
# ---------------------------------------------------------------------------
def open_tips_until(date_str: str, limit: int = 3000) -> list:
    """Otevřené tipy se zápasem do daného data VČETNĚ, od nejstarších.
    Pro vyhodnocování – get_tips řadí od nejnovějších a s limitem by staré
    (vyhodnotitelné) tipy zahodil ve prospěch budoucích."""
    out = [t for t in _db()["tips"]
           if t["pick_result"] is None and (t.get("date") or "") <= date_str]
    out.sort(key=lambda t: t.get("date", ""))
    return out[:limit]


def get_tips(sport: str = None, status: str = None,
             limit: int = 200, offset: int = 0) -> list:
    """Vrátí tipy seřazené od nejnovějšího s volitelnými filtry."""
    tips = _db()["tips"]
    if sport:
        tips = [t for t in tips if t.get("sport") == sport]
    if status == "open":
        tips = [t for t in tips if t["pick_result"] is None]
    elif status == "settled":
        tips = [t for t in tips if t["pick_result"] is not None]
    elif status == "won":
        tips = [t for t in tips if t["pick_result"] == "won"]
    elif status == "lost":
        tips = [t for t in tips if t["pick_result"] == "lost"]
    elif status == "sharp":
        tips = [t for t in tips if _sharp(t)]
    tips = sorted(tips, key=lambda t: (t.get("date", ""), t.get("saved_at", "")), reverse=True)
    return tips[offset: offset + limit]


def stats(sport: str = None) -> dict:
    """Kompletní statistiky modelu – pick accuracy, value ROI, kalibrace, top ligy."""
    tips = _db()["tips"]
    if sport:
        tips = [t for t in tips if t.get("sport") == sport]

    settled  = [t for t in tips if t["pick_result"] is not None]
    open_    = [t for t in tips if t["pick_result"] is None]
    won      = [t for t in settled if t["pick_result"] == "won"]

    # Ostré tipy = reálná konvikce (favorit ≥55 % / value). Klíčová metrika –
    # coin-flipy do ní nepatří, ať je vidět skutečná síla modelu.
    sharp = [t for t in settled if _sharp(t)]
    sharp_won = [t for t in sharp if t["pick_result"] == "won"]

    # Dvojtip (double-chance) – přesnost tam, kde ho model doporučil (nejisté zápasy)
    dc_tips = [t for t in settled if t.get("dc_recommended") and t.get("dc_result") is not None]
    dc_won  = [t for t in dc_tips if t["dc_result"] == "won"]

    # Value bet výsledky (jen tipy se zjištěným výsledkem value sázky)
    val_tips = [t for t in settled if t["has_value"] and t["value_result"] is not None]
    val_won  = [t for t in val_tips if t["value_result"] == "won"]
    val_profit = sum(
        (t["value_odds"] - 1) if t["value_result"] == "won" else -1
        for t in val_tips if t.get("value_odds")
    )

    # Tipy na góly (více/méně) – přesnost
    goal_tips = [t for t in settled if t.get("goal_result") is not None]
    goal_won  = [t for t in goal_tips if t["goal_result"] == "won"]

    # Tipy na rohy (více/méně) – přesnost (vynechá "unverifiable" – ESPN bez boxscore)
    corner_tips = [t for t in settled if t.get("corner_result") in ("won", "lost")]
    corner_won  = [t for t in corner_tips if t["corner_result"] == "won"]
    corner_unverif = sum(1 for t in settled if t.get("corner_result") == "unverifiable")

    # ROI křivka value sázek (kumulativní, 1 jednotka na sázku)
    val_sorted = sorted(val_tips, key=lambda t: t.get("settled_at", ""))
    roi_curve = []
    cumul = 0.0
    for t in val_sorted:
        if t.get("value_odds"):
            cumul += (t["value_odds"] - 1) if t["value_result"] == "won" else -1
            roi_curve.append(round(cumul, 2))

    # Pick accuracy křivka (kumulativní % úspěšnosti)
    pick_sorted = sorted(settled, key=lambda t: t.get("settled_at", ""))
    acc_curve = []
    w = 0
    for i, t in enumerate(pick_sorted, 1):
        if t["pick_result"] == "won":
            w += 1
        acc_curve.append(round(w / i * 100, 1))

    # Kalibrace: úspěšnost podle pásma jistoty
    conf_bins = [
        {"label": "80–99%", "min": 80, "count": 0, "won": 0},
        {"label": "60–79%", "min": 60, "count": 0, "won": 0},
        {"label": "40–59%", "min": 40, "count": 0, "won": 0},
        {"label": "<40%",   "min": 0,  "count": 0, "won": 0},
    ]
    for t in settled:
        c = t.get("confidence", 0)
        for b in conf_bins:
            if c >= b["min"]:
                b["count"] += 1
                if t["pick_result"] == "won":
                    b["won"] += 1
                break
    for b in conf_bins:
        b["accuracy"] = round(b["won"] / b["count"] * 100, 1) if b["count"] else None

    # Top 10 lig (počet vyhodnocených tipů)
    lg_map: dict = {}
    for t in settled:
        lg = t.get("league", "?")
        if lg not in lg_map:
            lg_map[lg] = {"count": 0, "won": 0}
        lg_map[lg]["count"] += 1
        if t["pick_result"] == "won":
            lg_map[lg]["won"] += 1
    league_rows = sorted(lg_map.items(), key=lambda x: x[1]["count"], reverse=True)[:12]
    leagues = [
        {"league": lg, "count": d["count"], "won": d["won"],
         "accuracy": round(d["won"] / d["count"] * 100, 1) if d["count"] else 0}
        for lg, d in league_rows
    ]

    # Poslední séria (streak)
    streak = 0
    streak_type = None
    for t in reversed(pick_sorted):
        r = t["pick_result"]
        if streak_type is None:
            streak_type = r
        if r == streak_type:
            streak += 1
        else:
            break

    return {
        "total":            len(tips),
        "settled":          len(settled),
        "open":             len(open_),
        "won":              len(won),
        "accuracy":         round(len(won) / len(settled) * 100, 1) if settled else None,
        "sharp_tips":       len(sharp),
        "sharp_won":        len(sharp_won),
        "sharp_accuracy":   round(len(sharp_won) / len(sharp) * 100, 1) if sharp else None,
        "dc_tips":          len(dc_tips),
        "dc_won":           len(dc_won),
        "dc_accuracy":      round(len(dc_won) / len(dc_tips) * 100, 1) if dc_tips else None,
        "value_tips":       len(val_tips),
        "value_won":        len(val_won),
        "value_accuracy":   round(len(val_won) / len(val_tips) * 100, 1) if val_tips else None,
        "value_profit":     round(val_profit, 2),
        "value_roi":        round(val_profit / len(val_tips) * 100, 1) if val_tips else None,
        "goal_tips":        len(goal_tips),
        "goal_won":         len(goal_won),
        "goal_accuracy":    round(len(goal_won) / len(goal_tips) * 100, 1) if goal_tips else None,
        "corner_tips":      len(corner_tips),
        "corner_won":       len(corner_won),
        "corner_accuracy":  round(len(corner_won) / len(corner_tips) * 100, 1) if corner_tips else None,
        "corner_unverifiable": corner_unverif,
        "roi_curve":        roi_curve,
        "acc_curve":        acc_curve,
        "conf_bins":        conf_bins,
        "leagues":          leagues,
        "streak":           streak,
        "streak_type":      streak_type,
    }
