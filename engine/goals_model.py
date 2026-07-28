# -*- coding: utf-8 -*-
"""
Predikční engine v2 – model očekávaných gólů (goal-ratio rating) + Dixon-Coles.

Zásadní změna oproti staré verzi (engine/prediction.py):
  • Rating týmu = pomer skutečně dané/obdržené góly vs. očekávání (ne Elo
    z výher/proher) – přímo měří útočnou a obrannou sílu, ne jen výsledek.
    Update je exponenciální klouzavý průměr s klesající rychlostí učení
    (víc zápasů odehráno → menší váha nového výsledku).
  • ŽÁDNÉ fingované kurzy sázkovek. Stará verze si při chybějících reálných
    kurzech simulovala celý panel bookmakerů (náhodný šum kolem modelu) a
    tvářila se, že jde o skutečnou "value" analýzu – to je zavádějící.
    Tenhle model buď použije SKUTEČNÉ kurzy z ESPN, nebo žádnou "value"/EV
    nenabízí – jen pravděpodobnost podle modelu.
  • Jistota = přímo max(pravděpodobnost), ne entropická heuristika navíc.
"""

import math

from . import storage
from . import data_sources as ds

MAX_GOALS = 8
DC_RHO = -0.13          # Dixon-Coles korekce nízkých skóre (standardní hodnota z literatury)
HOME_ADV_FACTOR = 1.12  # násobek λ domácích za výhodu domácího prostředí
RATING_MIN, RATING_MAX = 0.4, 2.6
EDGE_MIN = 0.03         # min. rozdíl (model_prob - implied_prob), aby se sázka počítala za "value"

# Ligové průměry gólů (home, away) – čistě popisná kalibrační data, ne "stará
# metodika": používají se jako neutrální startovní bod pro nové týmy/ligy,
# rating pak škáluje kolem nich podle skutečných výsledků.
LEAGUE_GOALS = {
    "champions league": (1.62, 1.28), "europa league": (1.55, 1.25),
    "conference league": (1.50, 1.20), "nations league": (1.35, 1.10),
    "bundesliga": (1.59, 1.27), "premier league": (1.55, 1.22),
    "serie a": (1.39, 1.08), "la liga": (1.47, 1.17), "ligue 1": (1.40, 1.12),
    "eredivisie": (1.68, 1.40), "primeira liga": (1.38, 1.08),
    "super lig": (1.52, 1.20), "süper lig": (1.52, 1.20),
    "brasileir": (1.48, 1.20), "saudi pro": (1.52, 1.25),
    "mls": (1.52, 1.38), "j1 league": (1.45, 1.18), "a-league": (1.45, 1.22),
    "ekstraklasa": (1.35, 1.10), "fortuna liga": (1.42, 1.15),
    "allsvenskan": (1.42, 1.15), "eliteserien": (1.48, 1.20),
    "world cup": (1.32, 1.08), "concacaf": (1.40, 1.18),
    "libertadores": (1.42, 1.20),
}
DEFAULT_GOALS = (1.35, 1.10)


def league_goals(league: str):
    low = (league or "").lower()
    for key, vals in LEAGUE_GOALS.items():
        if key in low:
            return vals
    return DEFAULT_GOALS


# ---------------------------------------------------------------------------
# Rating: attack/defense multiplikátory, EMA update z odehraných zápasů
# ---------------------------------------------------------------------------
def _ratings() -> dict:
    return storage.load("team_ratings.json", {})


def _save_ratings(r: dict) -> None:
    storage.save("team_ratings.json", r)


def get_rating(team: str, ratings: dict) -> dict:
    if team not in ratings:
        ratings[team] = {"a": 1.0, "d": 1.0, "n": 0}
    return ratings[team]


def rating_of(team: str) -> dict:
    return dict(get_rating(team, _ratings()))


def update_from_result(home: str, away: str, league: str, hs: int, as_: int) -> None:
    """Po vyhodnoceném zápase posune attack/defense obou týmů směrem k tomu,
    co skutečně předvedly oproti očekávání – učení se zpomaluje s počtem
    odehraných zápasů (n)."""
    ratings = _ratings()
    rh, ra = get_rating(home, ratings), get_rating(away, ratings)
    base_h, base_a = league_goals(league)

    exp_h = max(0.35, base_h * rh["a"] * ra["d"])
    exp_a = max(0.35, base_a * ra["a"] * rh["d"])

    alpha_h = 2.0 / (rh["n"] + 3.0)
    alpha_a = 2.0 / (ra["n"] + 3.0)

    ratio_h = hs / exp_h
    ratio_a = as_ / exp_a

    rh["a"] = _clamp(rh["a"] * (1 + alpha_h * (ratio_h - 1)))
    ra["d"] = _clamp(ra["d"] * (1 + alpha_h * (ratio_h - 1)))
    ra["a"] = _clamp(ra["a"] * (1 + alpha_a * (ratio_a - 1)))
    rh["d"] = _clamp(rh["d"] * (1 + alpha_a * (ratio_a - 1)))

    rh["n"] += 1
    ra["n"] += 1
    _save_ratings(ratings)


def _clamp(v: float) -> float:
    return round(max(RATING_MIN, min(RATING_MAX, v)), 4)


# ---------------------------------------------------------------------------
# Poisson + Dixon-Coles scoreline grid
# ---------------------------------------------------------------------------
def _pois(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def _dc_tau(i: int, j: int, lh: float, la: float) -> float:
    if i == 0 and j == 0:
        return max(0.001, 1.0 - lh * la * DC_RHO)
    if i == 0 and j == 1:
        return max(0.001, 1.0 + lh * DC_RHO)
    if i == 1 and j == 0:
        return max(0.001, 1.0 + la * DC_RHO)
    if i == 1 and j == 1:
        return max(0.001, 1.0 - DC_RHO)
    return 1.0


def _score_grid(lh: float, la: float) -> dict:
    ph = [_pois(i, lh) for i in range(MAX_GOALS + 1)]
    pa = [_pois(i, la) for i in range(MAX_GOALS + 1)]
    grid = {}
    for i in range(MAX_GOALS + 1):
        for j in range(MAX_GOALS + 1):
            grid[(i, j)] = ph[i] * pa[j] * _dc_tau(i, j, lh, la)
    total = sum(grid.values()) or 1.0
    return {k: v / total for k, v in grid.items()}


def _markets_1x2(grid: dict) -> dict:
    p_home = p_draw = p_away = 0.0
    for (i, j), p in grid.items():
        if i > j:
            p_home += p
        elif i == j:
            p_draw += p
        else:
            p_away += p
    return {"home": p_home, "draw": p_draw, "away": p_away}


def _over_prob(grid: dict, line: float) -> float:
    return sum(p for (i, j), p in grid.items() if i + j > line)


def _btts_prob(grid: dict) -> float:
    return sum(p for (i, j), p in grid.items() if i > 0 and j > 0)


def _top_scores(grid: dict, n=5):
    items = sorted(grid.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"score": f"{i}:{j}", "prob": round(p, 4)} for (i, j), p in items]


def _normal_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _over_prob_normal(line: float, mean: float, sd: float) -> float:
    return 1.0 - _normal_cdf((line - mean) / sd)


GOAL_LINES = (0.5, 1.5, 2.5, 3.5, 4.5)


# ---------------------------------------------------------------------------
# Reálné kurzy → EV/edge (JEN pokud ESPN reálné kurzy poskytlo, nikdy fake)
# ---------------------------------------------------------------------------
def _priced(model_prob: float, real_odds) -> dict:
    out = {"prob": round(model_prob, 4), "odds": None, "ev": None, "edge": None, "is_value": False, "real": False}
    if not real_odds:
        return out
    implied = 1.0 / real_odds
    ev = model_prob * real_odds - 1.0
    edge = model_prob - implied
    out.update({
        "odds": real_odds, "ev": round(ev, 4), "edge": round(edge, 4),
        "is_value": ev > 0.02 and edge > EDGE_MIN, "real": True,
    })
    return out


def predict_match(m: dict) -> dict:
    sport = m.get("sport", "soccer")
    cfg = ds.sport_cfg(sport)
    ratings = _ratings()
    rh = get_rating(m["home"], ratings)
    ra = get_rating(m["away"], ratings)

    bets = {}
    top_scores = []
    unit = cfg.get("unit", "gólů")
    real_odds = (m.get("real_odds") or {}).get("odds") or {}

    if cfg.get("two_way"):
        keys = ("home", "away")
        # bez skóre gridu – jen síla útok/obrana → pravděpodobnost výhry
        strength_h = rh["a"] / max(0.4, ra["d"])
        strength_a = ra["a"] / max(0.4, rh["d"])
        strength_h *= HOME_ADV_FACTOR
        total = strength_h + strength_a
        probs = {"home": strength_h / total, "away": strength_a / total}
        exp_goals = None
        exp_total = cfg["avg_total"]
        mean_total = cfg["avg_total"]
        line_fn = lambda L: _over_prob_normal(L, mean_total, cfg["sd_total"])
        names = {"home": f'1 · {m["home"]}', "away": f'2 · {m["away"]}'}
    else:
        keys = ("home", "draw", "away")
        base_h, base_a = league_goals(m["league"])
        lam_h = max(0.25, min(4.8, base_h * rh["a"] * ra["d"] * HOME_ADV_FACTOR))
        lam_a = max(0.25, min(4.8, base_a * ra["a"] * rh["d"]))
        grid = _score_grid(lam_h, lam_a)
        probs = _markets_1x2(grid)
        exp_goals = {"home": round(lam_h, 2), "away": round(lam_a, 2)}
        exp_total = round(lam_h + lam_a, 2)
        top_scores = _top_scores(grid)
        line_fn = lambda L: _over_prob(grid, L)
        names = {"home": f'1 · {m["home"]}', "draw": "X · remíza", "away": f'2 · {m["away"]}'}

    labels = {"home": "1", "draw": "X", "away": "2"}
    for k in keys:
        bets[k] = dict(_priced(probs[k], real_odds.get(k)), label=labels[k], name=names[k])

    goal_lines = []
    totals = (m.get("real_odds") or {}).get("totals")
    for line in cfg["lines"]:
        po = line_fn(line)
        over_odds = totals["over"] if (totals and totals.get("line") == line) else None
        under_odds = totals["under"] if (totals and totals.get("line") == line) else None
        over = dict(_priced(po, over_odds), label=f"Over {line}", name=f"Více než {line} {unit}")
        under = dict(_priced(1 - po, under_odds), label=f"Under {line}", name=f"Méně než {line} {unit}")
        goal_lines.append({"line": line, "over": over, "under": under})
        bets[f"over{line}"] = over
        bets[f"under{line}"] = under

    if not cfg.get("two_way"):
        btts_p = _btts_prob(grid)
        bets["btts_yes"] = dict(_priced(btts_p, None), label="BTTS Ano", name="Oba týmy dají gól")
        bets["btts_no"] = dict(_priced(1 - btts_p, None), label="BTTS Ne", name="Aspoň jeden tým nedá gól")

    pick = max(keys, key=lambda k: probs[k])
    confidence = round(max(probs.values()) * 100)

    # nejlepší "value" sázka = nejvyšší EV mezi trhy, kde máme reálné kurzy;
    # pokud žádné reálné kurzy nejsou, best_value je None (žádné fingování)
    real_bets = {k: v for k, v in bets.items() if v.get("real")}
    best_value = None
    if real_bets:
        best_key = max(real_bets, key=lambda k: real_bets[k]["ev"])
        best_value = dict(real_bets[best_key], outcome=best_key)

    return {
        "id": m["id"], "sport": sport, "slug": m.get("slug", ""),
        "two_way": bool(cfg.get("two_way")), "unit": unit,
        "league": m["league"], "country": m.get("country", ""),
        "home": m["home"], "away": m["away"],
        "home_id": m.get("home_id", ""), "away_id": m.get("away_id", ""),
        "time": m.get("time", ""), "date": m.get("date", ""),
        "status": m.get("status", ""), "live": m.get("live", False),
        "rating_home": rh, "rating_away": ra,
        "exp_goals": exp_goals, "exp_total": exp_total,
        "probs": {k: round(v, 4) for k, v in probs.items()},
        "pick": pick, "pick_label": labels[pick], "confidence": confidence,
        "value": {k: v for k, v in bets.items() if v.get("real")},
        "best_value": best_value,
        "bets": bets,
        "goal_lines": goal_lines,
        "top_scores": top_scores,
        "odds_source": "real" if real_bets else "model",
        "result": _result(m),
    }


def _result(m):
    if m.get("home_score") is None or m.get("away_score") is None:
        return None
    return {"home": m["home_score"], "away": m["away_score"]}


def predict_all(matches: list) -> list:
    return [predict_match(m) for m in matches]


def apply_settings():
    """Kompatibilní no-op – starý model měl ladicí parametry (HOME_ADV, ELO_K...)
    přepsatelné z Nastavení. Nový model se učí přímo z reálných výsledků
    (goal-ratio rating), žádné ruční ladění není potřeba."""
    pass
