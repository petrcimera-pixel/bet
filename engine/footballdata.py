# -*- coding: utf-8 -*-
"""
football-data.co.uk – zdarma dostupný archiv odehraných zápasů TOP evropských
lig, včetně ZAVÍRACÍCH kurzů Pinnacle.

Proč to appka potřebuje:
  • Hloubka historie pro ratingy. ESPN dá pár měsíců zpátky, tohle roky –
    a rating potřebuje desítky zápasů na tým, aby predikce nebyla plochá.
  • Zavírací kurz Pinnacle je v sázkařském světě etalon skutečné
    pravděpodobnosti (Pinnacle bere ostré sázky a nemá je proč krátit).
    Porovnáním s ním se dá poctivě změřit, jestli model ví něco navíc –
    na rozdíl od CLV proti ESPN, kde se appka porovnává sama se sebou.
  • Rohy (HC/AC) – kurz na ně nikde není, ale historická data ano, takže
    z nich jde aspoň postavit model.

Pokrývá jen top evropské ligy (ne Jižní Ameriku, kde teď agent sází nejvíc)
a jen odehranou historii, ne živé zápasy. Doplněk, ne náhrada ESPN.
"""

import csv
import io
import time

import requests

from . import storage

BASE = "https://www.football-data.co.uk/mmz4281"
TIMEOUT = 25

# kód football-data → (název ligy, jak ji zná ESPN/model)
LEAGUES = {
    "E0":  "English Premier League",
    "E1":  "English League Championship",
    "SC0": "Scottish Premiership",
    "D1":  "German Bundesliga",
    "D2":  "German 2. Bundesliga",
    "I1":  "Italian Serie A",
    "SP1": "Spanish LaLiga",
    "F1":  "French Ligue 1",
    "N1":  "Dutch Eredivisie",
    "B1":  "Belgian First Division A",
    "P1":  "Portuguese Primeira Liga",
    "T1":  "Turkish Super Lig",
    "G1":  "Greek Super League",
}


def seasons_back(n: int = 3) -> list:
    """Kódy posledních n sezón ve tvaru, jaký používá football-data ("2425")."""
    y = time.localtime().tm_year
    # sezóna 24/25 = "2425"; do konce června se počítá ještě ta předchozí
    start = y - 1 if time.localtime().tm_mon < 7 else y
    return [f"{str(a)[2:]}{str(a + 1)[2:]}" for a in range(start - n + 1, start + 1)]


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def _date(v):
    """"16/08/2024" → "2024-08-16" (starší soubory mají dvouciferný rok)."""
    try:
        d, m, y = str(v).split("/")
        if len(y) == 2:
            y = ("20" if int(y) < 70 else "19") + y
        return f"{y}-{int(m):02d}-{int(d):02d}"
    except Exception:
        return None


def fetch_league(code: str, season: str) -> list:
    """Stáhne a rozparsuje jednu ligu a sezónu. Vrací odehrané zápasy."""
    url = f"{BASE}/{season}/{code}.csv"
    cache_name = f"fd_{code}_{season}.json"
    cached = storage.load(cache_name, None)
    # hotová sezóna se nemění – drž ji dlouho, běžící obnovuj po dni
    if cached is not None and not storage.is_cache_stale(cache_name, ttl_hours=24):
        return cached
    try:
        r = requests.get(url, timeout=TIMEOUT)
        if r.status_code != 200:
            return cached or []
        rows = list(csv.DictReader(io.StringIO(r.text)))
    except Exception:
        return cached or []

    out = []
    for x in rows:
        d = _date(x.get("Date"))
        hs, as_ = _int(x.get("FTHG")), _int(x.get("FTAG"))
        home, away = (x.get("HomeTeam") or "").strip(), (x.get("AwayTeam") or "").strip()
        if not d or hs is None or as_ is None or not home or not away:
            continue
        out.append({
            "id": f"fd-{code}-{season}-{d}-{home}-{away}".replace(" ", "_"),
            "source": "football-data",
            "sport": "soccer", "slug": f"fd:{code}",
            "league": LEAGUES.get(code, code), "country": "",
            "home": home, "away": away,
            "date": d, "time": (x.get("Time") or "").strip(),
            "home_score": hs, "away_score": as_,
            "corners": {"home": _int(x.get("HC")), "away": _int(x.get("AC"))},
            # zavírací kurzy Pinnacle – etalon; když chybí, aspoň Bet365
            "closing": {
                "home": _num(x.get("PSCH")) or _num(x.get("B365H")),
                "draw": _num(x.get("PSCD")) or _num(x.get("B365D")),
                "away": _num(x.get("PSCA")) or _num(x.get("B365A")),
                "over25": _num(x.get("B365>2.5")),
                "under25": _num(x.get("B365<2.5")),
            },
            "status": "FT", "live": False, "real_odds": None,
        })
    storage.save(cache_name, out)
    return out


def fetch_all(seasons=None, codes=None, progress=None) -> list:
    seasons = seasons or seasons_back(3)
    codes = codes or list(LEAGUES)
    out = []
    for s in seasons:
        for c in codes:
            got = fetch_league(c, s)
            out.extend(got)
            if progress:
                progress(c, s, len(got), len(out))
    out.sort(key=lambda m: (m["date"], m.get("time") or ""))
    return out


def backfill_ratings(seasons=None, codes=None, progress=None) -> dict:
    """Naplní ratingy z historie. Chronologicky, ať učení odpovídá tomu, kolik
    toho model v daný okamžik skutečně věděl."""
    from . import goals_model

    matches = fetch_all(seasons, codes, progress)
    applied = skipped = 0
    for m in matches:
        try:
            ok = goals_model.update_from_result(
                m["home"], m["away"], m["league"], m["home_score"], m["away_score"],
                "soccer", m["slug"], match_id=m["id"], date=m.get("date"))
            applied += 1 if ok else 0
            skipped += 0 if ok else 1
        except Exception:
            skipped += 1

    ratings = goals_model._ratings()
    ns = sorted(v["n"] for v in ratings.values() if v.get("n", 0) > 0)
    return {
        "found": len(matches), "applied": applied, "skipped": skipped,
        "seasons": seasons or seasons_back(3), "leagues": len(codes or LEAGUES),
        "teams_with_history": len(ns),
        "median_games": ns[len(ns) // 2] if ns else 0,
        "avg_games": round(sum(ns) / len(ns), 1) if ns else 0,
    }


def benchmark(seasons=None, codes=None, limit=4000) -> dict:
    """Porovná model se zavíracím kurzem Pinnacle.

    Tohle je jediné poctivé měření, jestli model něco umí: closing line je
    nejlepší veřejně dostupný odhad pravděpodobnosti, takže když ho model
    trvale neporazí, žádnou výhodu nemá. Měří se Brierovým skóre (menší =
    lepší) na 1X2 – u modelu i u trhu na týchž zápasech.
    """
    from . import goals_model

    matches = [m for m in fetch_all(seasons, codes)
               if all(m["closing"].get(k) for k in ("home", "draw", "away"))][-limit:]
    if not matches:
        return {"matches": 0}

    bs_model = bs_market = 0.0
    n = 0
    for m in matches:
        p = goals_model.predict_match(m)
        pr = p.get("probs") or {}
        if not pr.get("home"):
            continue
        c = m["closing"]
        imp = {k: 1.0 / c[k] for k in ("home", "draw", "away")}
        tot = sum(imp.values())
        mkt = {k: v / tot for k, v in imp.items()}      # odmarženo
        hs, as_ = m["home_score"], m["away_score"]
        actual = {"home": 1.0 if hs > as_ else 0.0,
                  "draw": 1.0 if hs == as_ else 0.0,
                  "away": 1.0 if as_ > hs else 0.0}
        bs_model += sum((pr.get(k, 0) - actual[k]) ** 2 for k in actual)
        bs_market += sum((mkt[k] - actual[k]) ** 2 for k in actual)
        n += 1

    if not n:
        return {"matches": 0}
    bm, bk = bs_model / n, bs_market / n
    return {
        "matches": n,
        "brier_model": round(bm, 4),
        "brier_market": round(bk, 4),
        "diff": round(bk - bm, 4),          # kladné = model je lepší než trh
        "model_beats_market": bm < bk,
        "note": ("Model je na těchto zápasech lepší než zavírací kurz."
                 if bm < bk else
                 "Model zatím zavírací kurz neporáží – to je běžné, trh je "
                 "silný protivník. Kladný rozdíl je cíl, ne samozřejmost."),
    }
