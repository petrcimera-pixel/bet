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

# Průměrné celkové skóre pro konkrétní nefotbalové soutěže. SPORTS v
# data_sources drží jen JEDNU hodnotu na sport, jenže "basketball" pokrývá
# NBA i WNBA i univerzitní ligu, které se liší o desítky bodů – bez tohohle
# rozlišení by se WNBA (~163) poměřovala s NBA průměrem (224) a každý zápas
# by vycházel hluboko pod linií. Klíč = slug soutěže z ESPN.
LEAGUE_TOTALS = {
    "nba": 228.0,
    "wnba": 163.0,
    "mens-college-basketball": 145.0,
    "euroleague": 160.0,
    "nhl": 6.1,
    "nfl": 45.0,
    "college-football": 55.0,
}


def sport_totals(sport: str, slug: str = "", league: str = ""):
    """(průměrné celkové skóre, směrodatná odchylka) pro danou soutěž.

    Odchylka se škáluje se stejným poměrem jako průměr, aby zůstal zachovaný
    variační koeficient sportu (jinak by u nízkoskórových soutěží vycházelo
    nerealisticky široké rozpětí)."""
    cfg = ds.sport_cfg(sport)
    avg, sd = cfg.get("avg_total"), cfg.get("sd_total")
    if not avg or not sd:
        return avg, sd
    key = (slug or "").lower()
    override = LEAGUE_TOTALS.get(key)
    if override is None:
        low = (league or "").lower()
        for k, v in LEAGUE_TOTALS.items():
            if k.replace("-", " ") in low:
                override = v
                break
    if override and override != avg:
        return override, sd * (override / avg)
    return avg, sd


def sport_lines(sport: str, slug: str = "", league: str = ""):
    """Gólové/bodové linie pro danou soutěž.

    SPORTS drží jedny linie na sport (basketbal 210.5/220.5/230.5 = NBA), což
    u soutěže s jiným skórováním nedává smysl – WNBA (~163 bodů) by u všech
    dostala Over 0 %. Když má soutěž vlastní průměr, linie se dopočítají
    kolem něj se stejným rozestupem, jaký má sport nastavený."""
    cfg = ds.sport_cfg(sport)
    lines = cfg.get("lines") or []
    avg_cfg = cfg.get("avg_total")
    avg, _sd = sport_totals(sport, slug, league)
    if not lines or not avg or not avg_cfg or abs(avg - avg_cfg) < 1e-9:
        return lines
    step = (lines[1] - lines[0]) if len(lines) > 1 else max(1.0, round(avg * 0.045))
    center = round(avg - 0.5) + 0.5           # ať linie končí na .5 (nelze remízovat)
    n = len(lines)
    start = -(n // 2)
    return [round(center + (start + i) * step, 1) for i in range(n)]


def league_goals(league: str):
    low = (league or "").lower()
    for key, vals in LEAGUE_GOALS.items():
        if key in low:
            return vals
    return DEFAULT_GOALS


def base_goals(league: str, sport: str = "soccer", slug: str = ""):
    """Očekávané skóre (domácí, hosté) pro neutrální týmy.

    LEAGUE_GOALS jsou výhradně fotbalová čísla – u ostatních sportů se musí
    vzít průměr z konfigurace sportu, jinak by se hokejové/basketbalové skóre
    poměřovalo proti fotbalovému ~1.35 a rating by okamžitě vystřelil na strop
    (jeden zápas WNBA 80:70 dělený 1.5 dá poměr přes 50)."""
    if sport and sport != "soccer":
        avg, _sd = sport_totals(sport, slug, league)
        if avg:
            # Domácí výhoda se tu zapracuje jako PŘEROZDĚLENÍ skóre mezi týmy,
            # ne jako přirážka k součtu – jinak by průměrný zápas dvou
            # neutrálních týmů vycházel o ~6 % nad ligovým průměrem.
            # (U fotbalu je rozdělení domácí/hosté už přímo v LEAGUE_GOALS.)
            hs = HOME_ADV_FACTOR / (1.0 + HOME_ADV_FACTOR)
            return (avg * hs, avg * (1.0 - hs))
    return league_goals(league)


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


def update_from_result(home: str, away: str, league: str, hs: int, as_: int,
                        sport: str = "soccer", slug: str = "") -> None:
    """Po vyhodnoceném zápase posune attack/defense obou týmů směrem k tomu,
    co skutečně předvedly oproti očekávání – učení se zpomaluje s počtem
    odehraných zápasů (n).

    sport je nutný: bez něj by se nefotbalové skóre porovnávalo s fotbalovou
    baseline a rating by se po jediném zápase utrhl na strop."""
    ratings = _ratings()
    rh, ra = get_rating(home, ratings), get_rating(away, ratings)

    # Stejný vzorec jako v predikci (viz expected_scores) – jinak by se rating
    # učil proti jinému očekávání, než model předpovídá, a domácí výhoda /
    # měřítko sportu by kontaminovaly čistou útočnou sílu.
    raw_h, raw_a = expected_scores(league, sport, rh["a"], rh["d"], ra["a"], ra["d"], slug)
    exp_h, exp_a = max(0.35, raw_h), max(0.35, raw_a)

    # Spodní hranice alpha zajišťuje, že rating i po desítkách zápasů pořád
    # citelně reaguje na aktuální formu, ne jen na "celoživotní" průměr.
    alpha_h = max(0.06, 2.0 / (rh["n"] + 3.0))
    alpha_a = max(0.06, 2.0 / (ra["n"] + 3.0))

    # Bayesovské vyhlazení poměru místo syrového hs/exp.
    #
    # Skóre je Poissonovská veličina, takže jeden zápas je hodně zašuměný
    # vzorek: tým s očekáváním 1.5 gólu nedá gól ve 22 % zápasů úplně běžně.
    # Syrový poměr by z toho udělal 0.0, tedy maximální trest – a protože se
    # rating násobí, jediná prohra 0:3 hned v prvním zápase (kde je alpha
    # nejvyšší) srazila útok rovnou na podlahu 0.4.
    #
    # (hs + base) / (exp + base) je střední hodnota posteriorní míry při
    # gamma prioru se střední hodnotou 1 a silou jednoho zápasu. Tlumí
    # extrémy na OBOU stranách a je nezávislé na měřítku sportu, takže
    # funguje stejně pro fotbal (~1.5) i basketbal (~86).
    prior_h, prior_a = base_goals(league, sport, slug)
    ratio_h = (hs + prior_h) / (exp_h + prior_h)
    ratio_a = (as_ + prior_a) / (exp_a + prior_a)

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


def _spread_prob(grid: dict, side: str, line: float) -> float:
    """Pravděpodobnost pokrytí handicapu. Přesná shoda (celočíselná linie)
    znamená vrácení vkladu, takže se do pravděpodobnosti výhry nepočítá."""
    p = 0.0
    for (i, j), q in grid.items():
        adj = (i + line) - j if side == "home" else (j + line) - i
        if adj > 0:
            p += q
    return p


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
MIN_VALUE_CONF = 0.25   # pod tímhle rating nic neví, takže nemá co nabídnout proti trhu


def _priced(model_prob: float, real_odds, confidence: float = 1.0) -> dict:
    """Ocenění trhu proti reálnému kurzu.

    confidence = jistota ratingu obou týmů. Bez ní model u neznámých týmů
    vrací ligový průměr (~45/29/26 u fotbalu) NEZÁVISLE na soupeři, což proti
    reálnému kurzu vypadá jako obrovská výhoda na outsiderovi: "St. Gallen
    porazí Benficu ve 26 %" proti trhu 5.6 % dá zdánlivé EV +371 %. Jenže to
    není znalost, jen nevědomost – model o těch týmech neví nic. Proto se
    value přiznává, až když rating stojí na dost odehraných zápasech, a
    požadovaný náskok se s klesající jistotou zvyšuje."""
    out = {"prob": round(model_prob, 4), "odds": None, "ev": None, "edge": None,
           "is_value": False, "real": False}
    if not real_odds:
        return out
    implied = 1.0 / real_odds
    ev = model_prob * real_odds - 1.0
    edge = model_prob - implied
    conf = max(0.0, min(1.0, confidence))
    # čím míň rating ví, tím větší náskok musí model prokázat
    edge_needed = EDGE_MIN + (1.0 - conf) * 0.20
    out.update({
        "odds": real_odds, "ev": round(ev, 4), "edge": round(edge, 4),
        "is_value": bool(conf >= MIN_VALUE_CONF and ev > 0.02 and edge > edge_needed),
        "real": True,
    })
    return out


_SOCCER_CV = 1.7 / 2.7   # variační koeficient fotbalu = referenční „plný vliv ratingu"


def expected_scores(league: str, sport: str, a_h: float, d_h: float,
                     a_a: float, d_a: float, slug: str = ""):
    """Očekávané skóre (domácí, hosté) z ratingů – JEDINÉ místo, kde se tenhle
    vzorec počítá. Používá ho jak predikce, tak učení z výsledku; kdyby se
    lišily, rating by se učil proti jinému očekávání, než jaké model předpovídá
    (přesně ten druh nekonzistence, co u domácí výhody dřív kontaminoval útok).

    U fotbalu se domácí výhoda přidává násobkem (LEAGUE_GOALS ji nese jen
    zčásti), u ostatních sportů je už celá v base_goals() jako přerozdělení."""
    base_h, base_a = base_goals(league, sport, slug)
    damp = _rating_damping(sport, slug, league) if sport and sport != "soccer" else 1.0
    exp_h = base_h * (a_h * d_a) ** damp
    exp_a = base_a * (a_a * d_h) ** damp
    if not sport or sport == "soccer":
        exp_h *= HOME_ADV_FACTOR
    return exp_h, exp_a


def _rating_damping(sport: str, slug: str = "", league: str = "") -> float:
    """Jak silně se rating promítne do očekávaného skóre (exponent, 0-1).

    Fotbal = 1.0 (plný vliv). Sporty, kde skóre kolísá relativně míň
    (basketbal), dostanou menší exponent, aby stejná odchylka ratingu
    neznamenala nesmyslně velký posun v součtu bodů."""
    avg, sd = sport_totals(sport, slug, league)
    if not avg or not sd:
        return 1.0
    return max(0.1, min(1.0, (sd / avg) / _SOCCER_CV))


def _shrink(val: float, conf: float) -> float:
    """Zplošťuje rating směrem k neutrální hodnotě 1.0 podle jistoty vzorku –
    u málo odehraných zápasů appka věří ratingu jen částečně (jinak by pár
    zápasů nováčka vytvořilo přehnaně jistou predikci)."""
    return 1.0 + conf * (val - 1.0)


def predict_match(m: dict) -> dict:
    sport = m.get("sport", "soccer")
    cfg = ds.sport_cfg(sport)
    ratings = _ratings()
    rh = get_rating(m["home"], ratings)
    ra = get_rating(m["away"], ratings)

    # Jistota vzorku (0-1, plná důvěra ratingu od ~40 odehraných zápasů obou
    # týmů dohromady) – používá se k Bayesovskému zplošťování pravděpodobnosti
    # u nových/málo sledovaných týmů, aby model nebyl přehnaně sebejistý.
    rating_confidence = min(1.0, (rh["n"] + ra["n"]) / 40.0)
    sh_a, sh_d = _shrink(rh["a"], rating_confidence), _shrink(rh["d"], rating_confidence)
    sa_a, sa_d = _shrink(ra["a"], rating_confidence), _shrink(ra["d"], rating_confidence)

    bets = {}
    top_scores = []
    unit = cfg.get("unit", "gólů")
    real_odds = (m.get("real_odds") or {}).get("odds") or {}

    if cfg.get("two_way"):
        keys = ("home", "away")
        # bez skóre gridu – jen síla útok/obrana → pravděpodobnost výhry
        strength_h = sh_a / max(0.4, sa_d)
        strength_a = sa_a / max(0.4, sh_d)
        strength_h *= HOME_ADV_FACTOR
        total = strength_h + strength_a
        probs = {"home": strength_h / total, "away": strength_a / total}
        # Očekávané skóre z ratingů – dřív tu byla natvrdo ligová konstanta
        # cfg["avg_total"], takže Over/Under vycházelo úplně stejně pro
        # souboj dvou elitně útočných i dvou defenzivních týmů (rating se
        # promítal jen do 1X2). Sázky na gólové linie tak byly u hokeje,
        # basketbalu a am. fotbalu oceněné podle konstanty, ne podle týmů.
        slug = m.get("slug", "")
        lg_avg, lg_sd = sport_totals(sport, slug, m["league"])
        exp_h, exp_a = expected_scores(m["league"], sport, sh_a, sh_d, sa_a, sa_d, slug)
        raw_total = exp_h + exp_a
        # Pojistka: držet součet v pásmu ±2.5 směrodatné odchylky kolem
        # průměru soutěže (plus podlaha, ať linie nespadne k nule).
        lo = max(lg_avg * 0.35, lg_avg - 2.5 * lg_sd)
        hi = lg_avg + 2.5 * lg_sd
        mean_total = max(lo, min(hi, raw_total))
        # Rozptyl škáluje s odmocninou průměru (poissonovský vztah), ať u
        # vysokoskórových zápasů nezůstává nerealisticky úzký.
        sd_total = max(0.4, lg_sd * math.sqrt(mean_total / lg_avg))
        scale = mean_total / raw_total if raw_total > 0 else 1.0
        exp_goals = {"home": round(exp_h * scale, 2), "away": round(exp_a * scale, 2)}
        exp_total = round(mean_total, 2)
        line_fn = lambda L: _over_prob_normal(L, mean_total, sd_total)
        names = {"home": f'1 · {m["home"]}', "away": f'2 · {m["away"]}'}
    else:
        keys = ("home", "draw", "away")
        raw_h, raw_a = expected_scores(m["league"], sport, sh_a, sh_d, sa_a, sa_d)
        lam_h = max(0.25, min(4.8, raw_h))
        lam_a = max(0.25, min(4.8, raw_a))
        grid = _score_grid(lam_h, lam_a)
        probs = _markets_1x2(grid)
        exp_goals = {"home": round(lam_h, 2), "away": round(lam_a, 2)}
        exp_total = round(lam_h + lam_a, 2)
        top_scores = _top_scores(grid)
        line_fn = lambda L: _over_prob(grid, L)
        names = {"home": f'1 · {m["home"]}', "draw": "X · remíza", "away": f'2 · {m["away"]}'}

    labels = {"home": "1", "draw": "X", "away": "2"}
    for k in keys:
        bets[k] = dict(_priced(probs[k], real_odds.get(k), rating_confidence), label=labels[k], name=names[k])

    goal_lines = []
    totals = (m.get("real_odds") or {}).get("totals")
    # Linie podle soutěže, ne podle sportu (WNBA má jiné než NBA) – a když
    # ESPN pošle reálnou linii, přidat ji, ať se dá ocenit proti skutečnému
    # kurzu i mimo náš odhadnutý rozestup.
    match_lines = list(sport_lines(sport, m.get("slug", ""), m["league"]))
    if totals and totals.get("line") is not None and totals["line"] not in match_lines:
        match_lines.append(totals["line"])
        match_lines.sort()
    for line in match_lines:
        po = line_fn(line)
        over_odds = totals["over"] if (totals and totals.get("line") == line) else None
        under_odds = totals["under"] if (totals and totals.get("line") == line) else None
        over = dict(_priced(po, over_odds, rating_confidence), label=f"Over {line}", name=f"Více než {line} {unit}")
        under = dict(_priced(1 - po, under_odds, rating_confidence), label=f"Under {line}", name=f"Méně než {line} {unit}")
        goal_lines.append({"line": line, "over": over, "under": under})
        bets[f"over{line}"] = over
        bets[f"under{line}"] = under

    if not cfg.get("two_way"):
        btts_p = _btts_prob(grid)
        bets["btts_yes"] = dict(_priced(btts_p, None), label="BTTS Ano", name="Oba týmy dají gól")
        bets["btts_no"] = dict(_priced(1 - btts_p, None), label="BTTS Ne", name="Aspoň jeden tým nedá gól")

    # Handicap – další trh s REÁLNÝMI kurzy, který ESPN dává (pointSpread).
    # Pravděpodobnost jde spočítat přímo ze scoreline gridu, takže model umí
    # ocenit i tenhle trh, ne jen 1X2 a gólové linie.
    spread = (m.get("real_odds") or {}).get("spread") or {}
    if spread and not cfg.get("two_way"):
        for side in ("home", "away"):
            sd = spread.get(side) or {}
            line = sd.get("line")
            if line is None:
                continue
            p_side = _spread_prob(grid, side, float(line))
            key = f"ah_{side}_{line}"
            team = m["home"] if side == "home" else m["away"]
            sign = f"+{line}" if float(line) > 0 else str(line)
            bets[key] = dict(_priced(p_side, sd.get("odds"), rating_confidence),
                             label=f"AH {sign}", name=f"{team} s handicapem {sign}")

    pick = max(keys, key=lambda k: probs[k])
    confidence = round(max(probs.values()) * 100)

    # nejlepší "value" sázka = nejvyšší EV mezi trhy, kde máme reálné kurzy;
    # pokud žádné reálné kurzy nejsou, best_value je None (žádné fingování)
    real_bets = {k: v for k, v in bets.items() if v.get("real")}
    best_value = None
    if real_bets:
        # Výběr podle nejvyššího EV dává smysl jen mezi skutečnými value tipy.
        # Bez nich by "nejlepší" byl vždycky největší outsider (nejvyšší kurz
        # × plochá pravděpodobnost) a karta zápasu by ho nabízela jako tip –
        # radši ukázat nejjistější trh, ne nejdivočejší.
        valued = {k: v for k, v in real_bets.items() if v.get("is_value")}
        if valued:
            best_key = max(valued, key=lambda k: valued[k]["ev"])
        else:
            best_key = max(real_bets, key=lambda k: real_bets[k]["prob"])
        best_value = dict(real_bets[best_key], outcome=best_key)

    return {
        "id": m["id"], "sport": sport, "slug": m.get("slug", ""),
        "two_way": bool(cfg.get("two_way")), "unit": unit,
        "league": m["league"], "country": m.get("country", ""),
        "home": m["home"], "away": m["away"],
        "home_id": m.get("home_id", ""), "away_id": m.get("away_id", ""),
        "time": m.get("time", ""), "date": m.get("date", ""),
        "status": m.get("status", ""), "live": m.get("live", False),
        "rating_home": rh, "rating_away": ra, "rating_confidence": round(rating_confidence, 3),
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
