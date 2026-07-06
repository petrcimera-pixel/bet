# -*- coding: utf-8 -*-
"""
Generátor akumulátorů (tiket dne) a kurzových alertů z denních predikcí.

Strategie tiketů:
  - safe    : jistota – nejvyšší confidence
  - value   : nejvyšší očekávaná hodnota (EV)
  - longshot: kombinace vysokých kurzů s rozumnou pravděpodobností
"""


def _leg(p, key):
    b = p["bets"][key]
    return {
        "match_id": p["id"],
        "match": f'{p["home"]} – {p["away"]}',
        "league": p["league"],
        "outcome": key,
        "label": b["label"],
        "odds": b["best_odds"],
        "book": b["best_book"],
        "prob": b["prob"],
        "confidence": p["confidence"],
        "ev": b["ev"],
    }


def _ticket(legs, name, desc):
    odds = 1.0
    prob = 1.0
    for l in legs:
        odds *= l["odds"]
        prob *= l["prob"]
    return {
        "name": name,
        "desc": desc,
        "legs": legs,
        "total_odds": round(odds, 2),
        "combined_prob": round(prob, 4),
        "ev": round(odds * prob - 1.0, 4),
        "fair_odds": round(1.0 / prob, 2) if prob > 0 else None,
    }


def build_tickets(predictions: list, size: int = 3) -> list:
    upcoming = [p for p in predictions if p["result"] is None]
    if len(upcoming) < size:
        size = max(1, len(upcoming))
    if not upcoming:
        return []

    tickets = []

    # SAFE – nejvyšší confidence (sázíme predikovaný výsledek)
    safe = sorted(upcoming, key=lambda p: p["confidence"], reverse=True)[:size]
    tickets.append(_ticket(
        [_leg(p, p["pick"]) for p in safe],
        "🛡️ Jistota dne",
        "Nejvyšší jistota predikce napříč ligami."))

    # VALUE – nejvyšší EV value sázky
    valued = sorted(
        [p for p in upcoming if p["best_value"]["is_value"]],
        key=lambda p: p["best_value"]["ev"], reverse=True)[:size]
    if valued:
        tickets.append(_ticket(
            [_leg(p, p["best_value"]["outcome"]) for p in valued],
            "💎 Value tiket",
            "Nejvyšší očekávaná hodnota (EV) – kurz nad férovou cenou."))

    # LONGSHOT – odvážnější kombinace vyšších kurzů
    def longshot_score(p):
        v = p["value"][p["pick"]]
        return v["best_odds"] if 0.30 <= p["probs"][p["pick"]] <= 0.6 else 0
    longs = sorted(upcoming, key=longshot_score, reverse=True)[:size]
    tickets.append(_ticket(
        [_leg(p, p["pick"]) for p in longs],
        "🚀 Odvážný tiket",
        "Vyšší kurzy s rozumnou pravděpodobností – risk za vyšší výhru."))

    return tickets


def build_alerts(predictions: list) -> list:
    """Upozornění: silné value (1X2 i rohy), rozkol mezi sázkovkami a vysoká jistota.
    Prahy kalibrované na reálné rozpětí dat (základní value threshold v modelu je
    ev>3 %, proto tu 5 %; jistota málokdy přesáhne 60 %, proto tu 65 %) – s
    přísnějšími prahy (8 %/80 %) byla záložka Alerty prakticky vždy prázdná."""
    alerts = []
    for p in predictions:
        if p["result"] is not None:
            continue
        match = f'{p["home"]} – {p["away"]}'
        bv = p["best_value"]
        if bv["is_value"] and bv["ev"] >= 0.05:
            alerts.append({
                "type": "value", "level": "high",
                "match": match,
                "text": f'Value {bv["best_odds"]} na „{bv["name"]}" '
                        f'u {bv["best_book"]} (+{bv["ev"]*100:.0f} % EV)',
            })
        # value na rohy (jen fotbal) – stejná logika jako u 1X2/gólů, jiný trh
        for cl in p.get("corner_lines") or []:
            for side in ("over", "under"):
                o = cl[side]
                if o.get("is_value") and o["ev"] >= 0.05:
                    alerts.append({
                        "type": "corner_value", "level": "high",
                        "match": match,
                        "text": f'Value {o["best_odds"]} na rohy '
                                f'„{"Více" if side == "over" else "Méně"} než {cl["line"]}" '
                                f'u {o["best_book"]} (+{o["ev"]*100:.0f} % EV)',
                    })
        # rozkol kurzů: rozptyl nejlepšího vs. nejhoršího kurzu na favorita
        key = p["pick"]
        odds_list = [b["odds"][key] for b in p["books"]]
        spread = (max(odds_list) - min(odds_list)) / min(odds_list)
        if spread >= 0.08:
            alerts.append({
                "type": "movement", "level": "mid",
                "match": match,
                "text": f'Velký rozkol kurzů na {_lbl(key)} '
                        f'({min(odds_list):.2f}–{max(odds_list):.2f}) – '
                        f'vyplatí se porovnat sázkovky.',
            })
        if p["confidence"] >= 65:
            alerts.append({
                "type": "confidence", "level": "info",
                "match": match,
                "text": f'Vysoká jistota {p["confidence"]} % na '
                        f'{_lbl(key)} ({p["home"] if key=="home" else p["away"] if key=="away" else "remízu"}).',
            })
    order = {"high": 0, "mid": 1, "info": 2}
    alerts.sort(key=lambda a: order.get(a["level"], 3))
    return alerts[:25]


def _lbl(key):
    return {"home": "1 (domácí)", "draw": "X (remíza)", "away": "2 (hosté)",
            "over25": "Over 2.5", "under25": "Under 2.5"}.get(key, key)
