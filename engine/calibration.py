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
_CACHE = {"ts": 0, "data": None}


def _age_weight(settled_epoch) -> float:
    """Exponenciální útlum váhy vzorku podle stáří – novější settled sázky
    odráží aktuální chování modelu (po opravách ratingu apod.) líp než staré,
    které kalibrovaly chyby, jež už dnes neplatí."""
    if not settled_epoch:
        return 1.0
    age_days = max(0.0, (time.time() - settled_epoch) / 86400.0)
    return 0.5 ** (age_days / _HALF_LIFE_DAYS)


def market_of(outcome: str) -> str:
    """Zařadí trh do skupiny. Kalibrovat všechno jednou křivkou je hrubé –
    1X2, gólové linie a handicap mají každý jinou systematickou odchylku."""
    o = (outcome or "").lower()
    if o.startswith("over") or o.startswith("under"):
        return "totals"
    if o.startswith("ah_"):
        return "handicap"
    if o in ("home", "draw", "away", "1x", "12", "x2"):
        return "winner"
    return "other"


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
                mk = {"pick_prob": market_of(t.get("pick")),
                      "goal_prob": "totals", "corner_prob": "other",
                      "dc_prob": "winner"}.get(prob_key, "other")
                out.append((float(p), 1.0 if r == "won" else 0.0, w, mk))

    try:
        from . import virtual_bettors
        for bettor in virtual_bettors.load_state().values():
            for bet in bettor.get("bets", []):
                p = bet.get("prob")
                if p and bet.get("status") in ("won", "lost"):
                    w = _age_weight(bet.get("settled_ts"))
                    out.append((float(p), 1.0 if bet["status"] == "won" else 0.0, w,
                                market_of(bet.get("outcome"))))
    except Exception:
        pass   # aréna nesmí nikdy shodit kalibraci agenta, kdyby v ní byl problém

    return out


def _pav(triples: list) -> list:
    """Vážená Pool Adjacent Violators – izotonická regrese. Vrací [(x, y_kalibrované)]."""
    triples = sorted((t[0], t[1], t[2]) for t in triples)
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


_MIN_MARKET_SAMPLES = 120   # vlastní křivka trhu až od dost velkého vzorku


def rebuild() -> dict:
    """Přepočítá kalibrační křivky z historie. Volá se po settle.

    Kromě jedné celkové křivky staví i křivku pro každý typ trhu (1X2,
    gólové linie, handicap) – každý má jinou systematickou odchylku a
    společná křivka je všechny průměruje dohromady. Křivka trhu se použije,
    až když má sama dost vzorků; jinak se spadne na celkovou."""
    samples = _samples()
    n = len(samples)
    if n < _MIN_SAMPLES:
        data = {"n": n, "built_at": int(time.time()), "curve": None, "markets": {}}
        storage.save(_FILE, data)
        _CACHE.update(ts=0)
        return data

    def build(rows):
        c = _pav(rows)
        return [[round(x, 4), round(y, 4)] for x, y in c]

    markets = {}
    by_market = {}
    for row in samples:
        by_market.setdefault(row[3], []).append(row)
    for mk, rows in by_market.items():
        if mk != "other" and len(rows) >= _MIN_MARKET_SAMPLES:
            markets[mk] = {"n": len(rows), "curve": build(rows)}

    data = {"n": n, "built_at": int(time.time()), "curve": build(samples),
            "markets": markets}
    storage.save(_FILE, data)
    _CACHE.update(ts=0)   # invalidace – příští calibrate() si načte novou křivku
    return data


def _load_curve(market: str = None):
    now = time.time()
    if _CACHE.get("data") is None or now - _CACHE["ts"] >= 300:
        _CACHE.update(ts=now, data=storage.load(_FILE, {}) or {})
    data = _CACHE["data"] or {}
    if market:
        m = (data.get("markets") or {}).get(market)
        if m and m.get("curve"):
            return m["curve"], m.get("n", 0)
    return data.get("curve") or [], data.get("n", 0)


def calibrate(p: float, outcome: str = None) -> float:
    """Model prob → kalibrovaná prob (lineární interpolace izotonické křivky,
    směs se syrovou hodnotou podle množství dat). Bez dat vrací p beze změny.

    outcome (nepovinné): když je zadaný a jeho trh má vlastní křivku s dost
    vzorky, použije se ta místo společné."""
    curve, n = _load_curve(market_of(outcome) if outcome else None)
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
        "markets": {mk: {"n": m.get("n", 0),
                         "example": {"0.60": calibrate(0.60, _EX.get(mk)),
                                     "0.75": calibrate(0.75, _EX.get(mk))}}
                    for mk, m in (data.get("markets") or {}).items()},
    }


# zástupný outcome pro každý trh – jen kvůli ukázce v diagnostice
_EX = {"winner": "home", "totals": "over2.5", "handicap": "ah_home_-0.5"}
