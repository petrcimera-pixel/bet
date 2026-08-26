# -*- coding: utf-8 -*-
"""Historie karty Doporučené – co appka doporučila a jak to dopadlo.

Karta /api/recommended počítá tipy za běhu (nic si nepamatuje), takže bez
tohohle modulu nešlo zpětně ověřit, jestli doporučení sedí. Zaznamenává se
každý tip, který se na kartě RESKUTEČNĚ zobrazil (prošel prahem
pravděpodobnosti i kladnou EV) – ne všechny spočítané kandidáty.

Vyhodnocení se věší na existující settle smyčku (viz _settle_recent
v app.py): jakmile ta pro nějaký zápas zjistí skóre, stejný dict `results`
se předá i sem. Žádné vlastní síťové dotazy navíc – prakticky každý
doporučený zápas má stejně tak i uložený tip v tips_db (save_tips ukládá
všechny nadcházející predikce s reálným kurzem), takže je settle smyčka
už cíleně sleduje.
"""
from __future__ import annotations

import time

from . import storage
from .bankroll import eval_outcome

_STORE_FILE = "recommended_history.json"
_MAX_ZAZNAMU = 5000   # ať soubor neroste bez konce (~300 KB při plném stavu)


def _load() -> dict:
    return storage.load(_STORE_FILE, {"tipy": {}})


def _save(db: dict) -> None:
    storage.save(_STORE_FILE, db)


def _klic(match_id: str, outcome: str) -> str:
    return f"{match_id}|{outcome}"


def zaznamenej(tipy: list) -> int:
    """Uloží tipy, které se PRÁVĚ zobrazily na kartě Doporučené. Existující
    záznam (stejný zápas + trh) se nepřepisuje, ať vyhodnocený tip nezmizí,
    až appka přestane zápas doporučovat (např. kurz se mezitím posunul)."""
    if not tipy:
        return 0
    db = _load()
    ulozene = db["tipy"]
    now = time.time()
    n = 0
    for t in tipy:
        mid = t.get("match_id")
        outcome = t.get("outcome") or t.get("label")
        if not mid or not outcome:
            continue
        klic = _klic(mid, outcome)
        if klic in ulozene:
            continue
        ulozene[klic] = {
            "match_id": mid, "match": t.get("match"), "home": t.get("home"),
            "away": t.get("away"), "league": t.get("league"), "sport": t.get("sport", "soccer"),
            "date": t.get("date"), "time": t.get("time"),
            "label": t.get("label"), "name": t.get("name"), "market": t.get("market"),
            "outcome": outcome, "odds": t.get("odds"), "prob": t.get("prob"), "ev": t.get("ev"),
            "pasmo": t.get("pasmo"),
            "saved_at": now, "status": "open", "result": None, "settled_at": None,
        }
        n += 1

    if len(ulozene) > _MAX_ZAZNAMU:
        # Nejstarší VYŘEŠENÉ záznamy pryč jako první – otevřené se mažou,
        # jen pokud fakt nezbývá nic jiného (o tu historii jde nejvíc).
        serazene = sorted(ulozene.items(), key=lambda kv: (kv[1]["status"] == "open", kv[1]["saved_at"]))
        db["tipy"] = dict(serazene[-_MAX_ZAZNAMU:])
    if n:
        _save(db)
    return n


def vyhodnot(results: dict) -> int:
    """Vyhodnotí otevřené záznamy proti `results` ({match_id: {home,away}})
    – stejný dict, který appka stejně dostane z ESPN pro settle tipů/sázek."""
    if not results:
        return 0
    db = _load()
    ulozene = db["tipy"]
    n = 0
    for klic, z in ulozene.items():
        if z["status"] != "open":
            continue
        skore = results.get(z["match_id"])
        if not skore:
            continue
        vysledek = eval_outcome(z["outcome"], skore["home"], skore["away"])
        if vysledek is None:
            continue
        z["status"] = vysledek
        z["result"] = {"home": skore["home"], "away": skore["away"]}
        z["settled_at"] = time.time()
        n += 1
    if n:
        _save(db)
    return n


def historie(limit: int = 60) -> list:
    """Nejnovější záznamy první (podle uložení), bez ohledu na stav."""
    db = _load()
    polozky = sorted(db["tipy"].values(), key=lambda z: z["saved_at"], reverse=True)
    return polozky[:limit]


def shrnuti(dny: int = 30) -> dict:
    """Přesnost doporučení za posledních N dní – jen vyhodnocené záznamy."""
    hranice = time.time() - dny * 86400
    db = _load()
    vyresene = [z for z in db["tipy"].values()
                if z["status"] in ("won", "lost") and z["saved_at"] >= hranice]
    vyhry = sum(1 for z in vyresene if z["status"] == "won")
    return {
        "n": len(vyresene), "vyhry": vyhry,
        "presnost": round(vyhry / len(vyresene) * 100, 1) if vyresene else None,
        "dny": dny,
    }
