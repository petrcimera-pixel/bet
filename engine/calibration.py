# -*- coding: utf-8 -*-
"""
Kalibrace pravděpodobností modelu podle skutečných výsledků.

Model je systematicky překalibrovaný (říká 78 %, realita ~50 %). Z historie
vyhodnocených tipů (tips.json) se izotonickou regresí (PAV) naučí korekční
křivka model_prob → skutečná úspěšnost. Agent pak "tutovky" vybírá podle
KALIBROVANÉ pravděpodobnosti, ne podle syrového výstupu modelu.

Křivka se ukládá do data/calibration.json a přepočítává po každém settle.
"""

import time
import datetime

from . import storage

_FILE = "calibration.json"
_MIN_SAMPLES = 80      # pod tímto počtem se kalibrace nepoužije (identita)
_BLEND_N = 150         # váha izotonie = n/(n+_BLEND_N) – malá data táhnou k syrové p
_HALF_LIFE_DAYS = 60   # stáří vzorku, po kterém má poloviční váhu v kalibraci
_CACHE = {"ts": 0, "curve": None, "n": 0}


def _age_weight(settled_epoch) -> float:
    """Exponenciální útlum váhy vzorku podle stáří – novější settled sázky
    odráží aktuální chování modelu (po opravách ratingu apod.) líp než staré,
    které kalibrovaly chyby, jež už dnes neplatí."""
    if not settled_epoch:
        return 1.0
    age_days = max(0.0, (time.time() - settled_epoch) / 86400.0)
    return 0.5 ** (age_days / _HALF_LIFE_DAYS)


def _samples() -> list:
    """(model_prob, won, weight) trojice ze všech vyhodnocených trhů v tips.json
    PLUS ze settled sázek všech 10 virtuálních sázkařů (engine/virtual_bettors.py).
    Aréna dává mnohem větší a různorodější vzorek než samotné (konzervativní,
    jen tutovkové) tipy agenta – kalibrace tak s reálným provozem appky
    konverguje výrazně rychleji k _MIN_SAMPLES a je statisticky robustnější.
    Weight klesá se stářím vzorku (viz _age_weight)."""
    db = storage.load("tips.json", {"tips": []})
    out = []
    for t in db.get("tips", []):
        settled_at = t.get("settled_at")
        try:
            settled_epoch = datetime.datetime.fromisoformat(settled_at).timestamp() if settled_at else None
        except (TypeError, ValueError):
            settled_epoch = None
        w = _age_weight(settled_epoch)
        for prob_key, res_key in (("pick_prob", "pick_result"),
                                  ("goal_prob", "goal_result"),
                                  ("corner_prob", "corner_result"),
                                  ("dc_prob", "dc_result")):
            p = t.get(prob_key)
            r = t.get(res_key)
            if p and r in ("won", "lost"):
                out.append((float(p), 1.0 if r == "won" else 0.0, w))

    try:
        from . import virtual_bettors
        for bettor in virtual_bettors.load_state().values():
            for bet in bettor.get("bets", []):
                p = bet.get("prob")
                if p and bet.get("status") in ("won", "lost"):
                    w = _age_weight(bet.get("settled_ts"))
                    out.append((float(p), 1.0 if bet["status"] == "won" else 0.0, w))
    except Exception:
        pass   # aréna nesmí nikdy shodit kalibraci agenta, kdyby v ní byl problém

    return out


def _pav(triples: list) -> list:
    """Vážená Pool Adjacent Violators – izotonická regrese. Vrací [(x, y_kalibrované)]."""
    triples = sorted(triples)
    # bloky: [suma_w*y, suma_w, x_min, x_max]
    blocks = [[y * w, w, x, x] for x, y, w in triples]
    i = 0
    while i < len(blocks) - 1:
        a, b = blocks[i], blocks[i + 1]
        if a[0] / a[1] > b[0] / b[1]:          # porušení monotonie → slij bloky
            merged = [a[0] + b[0], a[1] + b[1], a[2], b[3]]
            blocks[i:i + 2] = [merged]
            i = max(0, i - 1)
        else:
            i += 1
    return [((blk[2] + blk[3]) / 2, blk[0] / blk[1]) for blk in blocks]


def rebuild() -> dict:
    """Přepočítá kalibrační křivku z historie. Volá se po settle."""
    samples = _samples()
    n = len(samples)
    if n < _MIN_SAMPLES:
        data = {"n": n, "built_at": int(time.time()), "curve": None}
        storage.save(_FILE, data)
        _CACHE.update(ts=0)
        return data
    curve = _pav(samples)
    data = {"n": n, "built_at": int(time.time()),
            "curve": [[round(x, 4), round(y, 4)] for x, y in curve]}
    storage.save(_FILE, data)
    _CACHE.update(ts=0)   # invalidace – příští calibrate() si načte novou křivku
    return data


def _load_curve():
    now = time.time()
    if _CACHE["curve"] is not None and now - _CACHE["ts"] < 300:
        return _CACHE["curve"], _CACHE["n"]
    data = storage.load(_FILE, {}) or {}
    _CACHE.update(ts=now, curve=data.get("curve") or [], n=data.get("n", 0))
    return _CACHE["curve"], _CACHE["n"]


def calibrate(p: float) -> float:
    """Model prob → kalibrovaná prob (lineární interpolace izotonické křivky,
    směs se syrovou hodnotou podle množství dat). Bez dat vrací p beze změny."""
    curve, n = _load_curve()
    if not curve or n < _MIN_SAMPLES:
        return p
    # interpolace
    if p <= curve[0][0]:
        iso = curve[0][1]
    elif p >= curve[-1][0]:
        iso = curve[-1][1]
    else:
        iso = curve[-1][1]
        for i in range(len(curve) - 1):
            x0, y0 = curve[i]
            x1, y1 = curve[i + 1]
            if x0 <= p <= x1:
                iso = y0 + (y1 - y0) * ((p - x0) / (x1 - x0)) if x1 > x0 else y0
                break
    w = n / (n + _BLEND_N)
    out = w * iso + (1 - w) * p
    return max(0.02, min(0.98, round(out, 4)))


def status() -> dict:
    """Stav kalibrace pro UI/API."""
    data = storage.load(_FILE, {}) or {}
    return {
        "n_samples": data.get("n", 0),
        "active": bool(data.get("curve")) and data.get("n", 0) >= _MIN_SAMPLES,
        "built_at": data.get("built_at"),
        "example": {"0.60": calibrate(0.60), "0.75": calibrate(0.75),
                    "0.85": calibrate(0.85)},
    }
