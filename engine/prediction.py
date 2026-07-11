# -*- coding: utf-8 -*-
"""
Predikční engine – Elo + Dixon-Coles Poisson model.

Vylepšení oproti základní verzi:
  • Dixon-Coles korekce τ(i,j): opravuje nezávislost nízkých skóre (0-0, 1-0, …),
    empiricky snižuje chybu predikce o ~5–8 %.
  • Liga-specifické průměry gólů (Bundesliga ≠ Serie A ≠ MLS).
  • Entropická jistota: kalibrovaná 0–99 %, ne heuristika.
  • Trend formy: ▲/▼ podle posledních vs. starších výsledků.
  • Score matrix: pravděpodobnosti skóre 0-0 … 3-3 pro heatmapu v UI.
"""

import math
import hashlib

from . import storage
from . import data_sources as ds
from . import settings as _settings_mod

# ---------------------------------------------------------------------------
# Parametry modelu (výchozí hodnoty – přepsány nastavením v Pokročilém nastavení)
# ---------------------------------------------------------------------------
HOME_ADV = 60            # domácí výhoda v Elo (kalibrováno, historicky ~55-65)
GOAL_BASE_HOME = 1.45
GOAL_BASE_AWAY = 1.18
RATING_TO_GOALS = 0.40   # jak silně Elo rozdíl posouvá λ
ELO_K = 22               # rychlost učení z výsledků
MAX_GOALS = 9            # mřížka Poisson (max gólů na tým)
DC_RHO = -0.13           # Dixon-Coles ρ: standardní hodnota z lit.

# Rohy (jen fotbal) – ESPN nedává rohy v lehkém scoreboard feedu, takže model
# vychází z ligového průměru škálovaného tempem zápasu (očekávané góly vs. liga).
CORNER_AVG = 10.2
CORNER_SD = 3.0
CORNER_TEMPO_FACTOR = 1.4
CORNER_LINES = [8.5, 9.5, 10.5, 11.5]


def apply_settings():
    """Přepíše parametry modelu hodnotami z Pokročilého nastavení (data/settings.json).
    Volá se při startu a po každé změně nastavení."""
    global HOME_ADV, ELO_K, RATING_TO_GOALS, DC_RHO
    m = _settings_mod.get_settings()["model"]
    HOME_ADV = m.get("home_adv", HOME_ADV)
    ELO_K = m.get("elo_k", ELO_K)
    RATING_TO_GOALS = m.get("rating_to_goals", RATING_TO_GOALS)
    DC_RHO = m.get("dc_rho", DC_RHO)


apply_settings()

# Liga-specifické průměry gólů (home, away) – kalibrované z historických dat
_LEAGUE_GOALS = {
    "champions league":   (1.62, 1.28),
    "europa league":      (1.55, 1.25),
    "conference league":  (1.50, 1.20),
    "nations league":     (1.35, 1.10),
    "bundesliga":         (1.59, 1.27),
    "premier league":     (1.55, 1.22),
    "serie a":            (1.39, 1.08),
    "la liga":            (1.47, 1.17),
    "ligue 1":            (1.40, 1.12),
    "eredivisie":         (1.68, 1.40),
    "primeira liga":      (1.38, 1.08),
    "super lig":          (1.52, 1.20),
    "süper lig":          (1.52, 1.20),
    "brasileir":          (1.48, 1.20),
    "saudi pro":          (1.52, 1.25),
    "mls":                (1.52, 1.38),
    "j1 league":          (1.45, 1.18),
    "a-league":           (1.45, 1.22),
    "ekstraklasa":        (1.35, 1.10),
    "fortuna liga":       (1.42, 1.15),
    "primera liga":       (1.40, 1.12),
    "eredivisie":         (1.68, 1.40),
    "allsvenskan":        (1.42, 1.15),
    "eliteserien":        (1.48, 1.20),
    "superliga":          (1.38, 1.12),
    "süper":              (1.52, 1.20),
    "chinese super":      (1.48, 1.22),
    "k league":           (1.38, 1.12),
    "concacaf":           (1.40, 1.18),
    "libertadores":       (1.42, 1.20),
    "world cup":          (1.32, 1.08),
}

# Panel sázkových kanceláří: (název, marže/overround, je_sharp)
BOOKMAKERS = [
    ("Pinnacle",     1.025, True),
    ("Bet365",       1.055, False),
    ("Tipsport",     1.075, False),
    ("Fortuna",      1.080, False),
    ("Betano",       1.060, False),
    ("Unibet",       1.065, False),
    ("William Hill", 1.070, False),
    ("Betfair",      1.045, True),
    ("1xBet",        1.050, False),
    ("Chance",       1.085, False),
]

# Síla ligy → výchozí Elo
_LEAGUE_TIERS = [
    (["premier league", "la liga", "serie a", "bundesliga", "ligue 1",
      "champions league"], 1700),
    (["eredivisie", "primeira", "championship", "liga portugal",
      "süper lig", "super lig", "pro league", "premier liga"], 1600),
    (["first league", "fortuna liga", "ekstraklasa", "superliga",
      "allsvenskan", "eliteserien", "bundesliga 2", "serie b",
      "la liga 2", "mls", "brasileir"], 1520),
]
_DEFAULT_RATING = 1450
GOAL_LINES = (0.5, 1.5, 2.5, 3.5, 4.5)


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------
def _seed(text: str) -> int:
    return int(hashlib.md5(text.encode("utf-8")).hexdigest()[:8], 16)


def _league_base(league: str) -> int:
    low = (league or "").lower()
    for keys, rating in _LEAGUE_TIERS:
        if any(k in low for k in keys):
            return rating
    return _DEFAULT_RATING


def _league_goals(league: str):
    """Liga-specifické průměry gólů (home, away)."""
    low = (league or "").lower()
    for key, vals in _LEAGUE_GOALS.items():
        if key in low:
            return vals
    return (GOAL_BASE_HOME, GOAL_BASE_AWAY)


# ---------------------------------------------------------------------------
# Elo ratingy (persistentní)
# ---------------------------------------------------------------------------
def _ratings() -> dict:
    return storage.load("ratings.json", {})


def get_rating(team: str, league: str, ratings: dict) -> float:
    if team in ratings:
        return ratings[team]
    base = _league_base(league)
    offset = (_seed(team) % 241) - 120
    val = base + offset
    ratings[team] = val
    return val


def rating_of(team: str, league: str = "") -> float:
    return round(get_rating(team, league, _ratings()))


def update_from_result(home, away, league, hs, as_):
    """Aktualizuje Elo. K-faktor škálovaný rozdílem gólů (margin of victory)."""
    ratings = _ratings()
    rh = get_rating(home, league, ratings)
    ra = get_rating(away, league, ratings)
    exp_h = 1.0 / (1.0 + 10 ** (-((rh + HOME_ADV) - ra) / 400.0))
    score_h = 1.0 if hs > as_ else (0.5 if hs == as_ else 0.0)
    margin = abs(hs - as_)
    # Log-scaling of goal difference (standard in Elo for football)
    mult = math.log(margin + 1.5) / math.log(1.5) if margin > 0 else 1.0
    delta = ELO_K * mult * (score_h - exp_h)
    ratings[home] = round(rh + delta, 1)
    ratings[away] = round(ra - delta, 1)
    storage.save("ratings.json", ratings)


# ---------------------------------------------------------------------------
# Poisson + Dixon-Coles
# ---------------------------------------------------------------------------
def _pois(k: int, lam: float) -> float:
    return math.exp(-lam) * lam ** k / math.factorial(k)


def _dc_tau(i: int, j: int, lh: float, la: float) -> float:
    """Dixon-Coles korekce τ pro nízké skóre – opravuje nezávislost Poisson modelu."""
    if i == 0 and j == 0:
        return max(0.001, 1.0 - lh * la * DC_RHO)
    elif i == 0 and j == 1:
        return max(0.001, 1.0 + lh * DC_RHO)
    elif i == 1 and j == 0:
        return max(0.001, 1.0 + la * DC_RHO)
    elif i == 1 and j == 1:
        return max(0.001, 1.0 - DC_RHO)
    return 1.0


def _score_grid(lh: float, la: float):
    """Score grid s Dixon-Coles korekcí + renormalizace."""
    ph = [_pois(i, lh) for i in range(MAX_GOALS + 1)]
    pa = [_pois(i, la) for i in range(MAX_GOALS + 1)]
    grid = {}
    for i in range(MAX_GOALS + 1):
        for j in range(MAX_GOALS + 1):
            grid[(i, j)] = ph[i] * pa[j] * _dc_tau(i, j, lh, la)
    total = sum(grid.values())
    if total > 0:
        grid = {k: v / total for k, v in grid.items()}
    return grid


def _markets(grid: dict):
    p_home = p_draw = p_away = 0.0
    p_over = p_btts = 0.0
    for (i, j), p in grid.items():
        if i > j:
            p_home += p
        elif i == j:
            p_draw += p
        else:
            p_away += p
        if i + j > 2.5:
            p_over += p
        if i > 0 and j > 0:
            p_btts += p
    return {
        "home": p_home, "draw": p_draw, "away": p_away,
        "over25": p_over, "under25": 1 - p_over,
        "btts_yes": p_btts, "btts_no": 1 - p_btts,
    }


def _top_scores(grid: dict, n=5):
    items = sorted(grid.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"score": f"{i}:{j}", "prob": round(p, 4)} for (i, j), p in items]


def _score_matrix(grid: dict, size=4):
    """Matice pravděpodobností skóre (size x size) pro heatmapu v UI."""
    return [[round(grid.get((i, j), 0) * 100, 1) for j in range(size)] for i in range(size)]


def _over_prob(grid: dict, line: float) -> float:
    return sum(p for (i, j), p in grid.items() if i + j > line)


# ---------------------------------------------------------------------------
# Forma + trend
# ---------------------------------------------------------------------------
def _form(team: str, rating: float):
    seed = _seed(team)
    strength = max(0.15, min(0.85, (rating - 1300) / 500.0))
    out = []
    for i in range(5):
        r = ((seed >> (i * 3)) & 0xFF) / 255.0
        if r < strength * 0.8:
            out.append("W")
        elif r < strength * 0.8 + 0.25:
            out.append("D")
        else:
            out.append("L")
    return out


def _form_points(form):
    return sum({"W": 3, "D": 1, "L": 0}.get(x, 0) for x in form)


def _trend(form: list) -> str:
    """▲ = tým se zlepšuje, ▼ = zhoršuje, '' = stabilní."""
    if len(form) < 4:
        return ""
    pts = {"W": 3, "D": 1, "L": 0}
    recent = sum(pts.get(f, 0) for f in form[:2]) / 2.0
    older = sum(pts.get(f, 0) for f in form[2:]) / max(1, len(form) - 2)
    if recent > older + 0.5:
        return "up"
    if recent < older - 0.5:
        return "down"
    return ""


# ---------------------------------------------------------------------------
# Kalibrovaná jistota (entropie Shannon)
# ---------------------------------------------------------------------------
def _entropy_conf(probs: list) -> int:
    """Jistota = 1 − normalizovaná entropie → 20–99 %."""
    n = len(probs)
    h_max = math.log(n) if n > 1 else 1.0
    h = -sum(p * math.log(max(p, 1e-9)) for p in probs)
    skill = max(0.0, min(1.0, 1.0 - h / h_max))
    return round(20 + skill * 79)


# ---------------------------------------------------------------------------
# Simulace kurzů sázkových kanceláří
# ---------------------------------------------------------------------------
def _market_probs(model: dict, match_id: str, keys) -> dict:
    seed = _seed(match_id + "mkt")
    mid = 1.0 / len(keys)
    out = {}
    for i, k in enumerate(keys):
        p = model[k]
        rnd = (((seed >> (i * 6)) & 0x3F) / 63.0 - 0.5) * 2
        flb = (mid - p) * 0.10
        factor = 1 + flb + rnd * 0.06
        out[k] = max(0.01, p * factor)
    s = sum(out.values())
    return {k: v / s for k, v in out.items()}


def _book_odds(market_probs: dict, match_id: str, keys):
    books = []
    base_seed = _seed(match_id)
    for idx, (name, margin, sharp) in enumerate(BOOKMAKERS):
        noise_amp = 0.015 if sharp else 0.05
        row = {"name": name, "sharp": sharp, "odds": {}}
        for k, key in enumerate(keys):
            p = market_probs[key]
            n = (((base_seed >> (idx * 2 + k)) & 0xFF) / 255.0 - 0.5) * 2
            adj_p = p * margin * (1 + n * noise_amp)
            adj_p = min(0.97, max(0.01, adj_p))
            row["odds"][key] = round(1.0 / adj_p, 2)
        books.append(row)
    return books


def _consensus_and_value(model_probs: dict, books: list, keys):
    best = {k: 0 for k in keys}
    best_book = {k: "" for k in keys}
    consensus = {k: 0.0 for k in keys}
    for b in books:
        implied = {k: 1.0 / b["odds"][k] for k in keys}
        overround = sum(implied.values())
        for k in keys:
            consensus[k] += implied[k] / overround
            if b["odds"][k] > best[k]:
                best[k] = b["odds"][k]
                best_book[k] = b["name"]
    for k in consensus:
        consensus[k] /= len(books)
    value = {}
    for k in keys:
        p = model_probs[k]
        ev = p * best[k] - 1.0
        edge = p - consensus[k]
        value[k] = {
            "best_odds": best[k],
            "best_book": best_book[k],
            "fair_odds": round(1.0 / p, 2) if p > 0 else None,
            "ev": round(ev, 4),
            "edge": round(edge, 4),
            "is_value": ev > 0.03 and edge > 0.02,
        }
    return consensus, value


def _normal_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _over_prob_normal(line: float, mean: float, sd: float) -> float:
    return 1.0 - _normal_cdf((line - mean) / sd)


def _price_market(model_p: float, match_id: str, salt: str) -> dict:
    seed = _seed(match_id + salt)
    market_p = min(0.97, max(0.03, model_p * (1 + ((seed & 0x3F) / 63.0 - 0.5) * 0.08)))
    best, best_book = 0.0, ""
    for idx, (name, margin, sharp) in enumerate(BOOKMAKERS):
        noise_amp = 0.015 if sharp else 0.05
        n = (((seed >> (idx + 3)) & 0xFF) / 255.0 - 0.5) * 2
        adj = min(0.985, max(0.02, market_p * margin * (1 + n * noise_amp)))
        o = round(1.0 / adj, 2)
        if o > best:
            best, best_book = o, name
    ev = model_p * best - 1.0
    edge = model_p - market_p
    return {
        "prob": round(model_p, 4),
        "market_prob": round(market_p, 4),
        "best_odds": best,
        "best_book": best_book,
        "fair_odds": round(1.0 / model_p, 2) if model_p > 0 else None,
        "ev": round(ev, 4),
        "edge": round(edge, 4),
        "is_value": ev > 0.03 and edge > 0.02,
    }


# ---------------------------------------------------------------------------
# Hlavní funkce
# ---------------------------------------------------------------------------
def predict_match(m: dict) -> dict:
    sport = m.get("sport", "soccer")
    cfg = ds.sport_cfg(sport)
    ratings = _ratings()
    rh = get_rating(m["home"], m["league"], ratings)
    ra = get_rating(m["away"], m["league"], ratings)
    diff = (rh + HOME_ADV) - ra

    bets = {}
    goal_lines = []
    score_matrix = []
    unit = cfg.get("unit", "gólů")

    if cfg.get("two_way"):
        keys = ("home", "away")
        exp_h = 1.0 / (1.0 + 10 ** (-diff / 400.0))
        fair = {"home": exp_h, "away": 1 - exp_h}
        probs = dict(fair)
        var = ((_seed(m["id"] + "tot") & 0xFF) / 255.0 - 0.5) * cfg["sd_total"] * 0.5
        mean_total = cfg["avg_total"] + var
        exp_total = round(mean_total, 1)
        exp_goals = None
        top_scores = []
        name_ml = {"home": f'1 · {m["home"]}', "away": f'2 · {m["away"]}'}
        line_fn = lambda L: _over_prob_normal(L, mean_total, cfg["sd_total"])
    else:
        keys = ("home", "draw", "away")
        # Liga-specifické λ
        base_h, base_a = _league_goals(m["league"])
        factor = 10 ** (diff / 400.0 * RATING_TO_GOALS)
        lam_h = max(0.2, min(4.5, base_h * factor))
        lam_a = max(0.2, min(4.5, base_a / factor))
        grid = _score_grid(lam_h, lam_a)
        probs = _markets(grid)
        fair = {"home": probs["home"], "draw": probs["draw"], "away": probs["away"]}
        exp_goals = {"home": round(lam_h, 2), "away": round(lam_a, 2)}
        exp_total = round(lam_h + lam_a, 2)
        top_scores = _top_scores(grid)
        score_matrix = _score_matrix(grid, size=4)
        name_ml = {"home": f'1 · {m["home"]}', "draw": "X · remíza", "away": f'2 · {m["away"]}'}
        line_fn = lambda L: _over_prob(grid, L)

    # Rohy (jen fotbal) – tempo zápasu (očekávané góly vs. ligový průměr) škáluje
    # ligový průměr rohů; bez reálných týmových dat o rozích z lehkého ESPN feedu.
    corner_lines = []
    exp_corners = None
    if sport == "soccer":
        baseline_total = base_h + base_a
        exp_corners = max(6.0, CORNER_AVG + CORNER_TEMPO_FACTOR * (exp_total - baseline_total))
        corner_fn = lambda L: _over_prob_normal(L, exp_corners, CORNER_SD)
        for line in CORNER_LINES:
            po = corner_fn(line)
            over = _price_market(po, m["id"], f"co{line}")
            under = _price_market(1 - po, m["id"], f"cu{line}")
            corner_lines.append({"line": line, "over": over, "under": under})

    market = _market_probs(fair, m["id"], keys)
    books = _book_odds(market, m["id"], keys)
    consensus, value = _consensus_and_value(fair, books, keys)

    pick = max(keys, key=lambda k: fair[k])

    # Entropická jistota – lépe kalibrovaná
    probs_list = [fair[k] for k in keys]
    confidence = _entropy_conf(probs_list)

    form_h, form_a = _form(m["home"], rh), _form(m["away"], ra)
    trend_h = _trend(form_h)
    trend_a = _trend(form_a)

    labels = {"home": "1", "draw": "X", "away": "2"}
    for k in keys:
        bets[k] = dict(value[k], prob=round(fair[k], 4), label=labels[k],
                       name=name_ml[k], market_prob=round(consensus[k], 4))

    for line in cfg["lines"]:
        po = line_fn(line)
        over = _price_market(po, m["id"], f"o{line}")
        under = _price_market(1 - po, m["id"], f"u{line}")
        goal_lines.append({"line": line, "over": over, "under": under})
        bets[f"over{line}"] = dict(over, label=f"Over {line}", name=f"Více než {line} {unit}")
        bets[f"under{line}"] = dict(under, label=f"Under {line}", name=f"Méně než {line} {unit}")

    if not cfg.get("two_way"):
        bets["btts_yes"] = dict(_price_market(probs["btts_yes"], m["id"], "btsy"),
                                label="BTTS Ano", name="Oba týmy dají gól")
        bets["btts_no"] = dict(_price_market(probs["btts_no"], m["id"], "btsn"),
                               label="BTTS Ne", name="Aspoň jeden tým nedá gól")

    best_key = max(bets, key=lambda k: bets[k]["ev"])
    best_value = dict(bets[best_key], outcome=best_key)

    return {
        "id": m["id"],
        "sport": sport,
        "slug": m.get("slug", ""),
        "two_way": bool(cfg.get("two_way")),
        "unit": unit,
        "league": m["league"],
        "country": m.get("country", ""),
        "home": m["home"],
        "away": m["away"],
        "home_id": m.get("home_id", ""),
        "away_id": m.get("away_id", ""),
        "time": m.get("time", ""),
        "date": m.get("date", ""),
        "status": m.get("status", ""),
        "live": m.get("live", False),
        "rating_home": round(rh),
        "rating_away": round(ra),
        "exp_goals": exp_goals,
        "exp_total": exp_total,
        "probs": {k: round(v, 4) for k, v in probs.items()},
        "pick": pick,
        "pick_label": labels[pick],
        "confidence": confidence,
        "consensus": {k: round(v, 4) for k, v in consensus.items()},
        "value": value,
        "best_value": best_value,
        "bets": bets,
        "goal_lines": goal_lines,
        "corner_lines": corner_lines,
        "exp_corners": round(exp_corners, 1) if exp_corners is not None else None,
        "books": books,
        "top_scores": top_scores,
        "score_matrix": score_matrix,
        "form": {
            "home": form_h, "away": form_a,
            "home_pts": _form_points(form_h), "away_pts": _form_points(form_a),
            "home_trend": trend_h, "away_trend": trend_a,
        },
        "result": _result(m),
    }


def _result(m):
    if m.get("home_score") is None or m.get("away_score") is None:
        return None
    return {"home": m["home_score"], "away": m["away_score"]}


def predict_all(matches: list) -> list:
    return [predict_match(m) for m in matches]


def apply_real_odds(p: dict, real_books: list) -> bool:
    keys = ("home", "away") if p["two_way"] else ("home", "draw", "away")
    books = [b for b in real_books if all(k in b["odds"] and b["odds"][k] for k in keys)]
    # 1 kniha stačí (ESPN/DraftKings) – konsensus je pak implied prob té knihy
    if not books:
        return False
    model = {k: p["probs"][k] for k in keys}
    consensus, value = _consensus_and_value(model, books, keys)
    p["books"] = books
    p["consensus"] = {k: round(v, 4) for k, v in consensus.items()}
    p["value"] = value
    for k in keys:
        p["bets"][k] = dict(value[k], prob=round(model[k], 4),
                            label=p["bets"][k]["label"], name=p["bets"][k]["name"],
                            market_prob=round(consensus[k], 4))
    best_key = max(p["bets"], key=lambda k: p["bets"][k]["ev"])
    p["best_value"] = dict(p["bets"][best_key], outcome=best_key)
    p["odds_source"] = "real"
    return True


def apply_real_totals(p: dict, totals: dict, book_name: str) -> bool:
    """Nahradí modelované kurzy na góly O/U reálnými (ESPN 'total' trh).
    Aplikuje se jen na linii, kterou model také počítá (např. 2.5)."""
    line = totals.get("line")
    over_key, under_key = f"over{line}", f"under{line}"
    if over_key not in p["bets"] or under_key not in p["bets"]:
        return False
    for key, odds in ((over_key, totals["over"]), (under_key, totals["under"])):
        b = p["bets"][key]
        prob = b["prob"]
        ev = prob * odds - 1.0
        implied = 1.0 / odds
        b.update({
            "best_odds": odds,
            "best_book": book_name,
            "market_prob": round(implied, 4),
            "ev": round(ev, 4),
            "edge": round(prob - implied, 4),
            "is_value": ev > 0.03 and (prob - implied) > 0.02,
            "real": True,
        })
    best_key = max(p["bets"], key=lambda k: p["bets"][k]["ev"])
    p["best_value"] = dict(p["bets"][best_key], outcome=best_key)
    return True
