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

import datetime
import math
import unicodedata

from . import storage
from . import data_sources as ds


def _norm_team(name: str) -> str:
    """Kanonický klíč pro tým v ratings/history slovnících – bez diakritiky.

    ESPN a football-data.co.uk (viz footballdata.py, archivní historie)
    zapisují stejný tým jinak: "Beşiktaş" vs "Besiktas", "Grêmio" vs
    "Gremio". Bez normalizace appka drží DVĚ oddělené, řídké položky
    ratingu pro tentýž tým místo jedné bohaté – 73 týmů (146 záznamů)
    takhle fragmentovaných po archivním backfillu. Zobrazované jméno
    (v UI, tiketech) se NEMĚNÍ – tohle je jen interní klíč."""
    if not name:
        return name
    decomposed = unicodedata.normalize("NFKD", name)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).strip()

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


# ---------------------------------------------------------------------------
# České popisky trhů
# ---------------------------------------------------------------------------
def cz_num(x) -> str:
    """Číslo s desetinnou čárkou, jak se píše česky (4.5 -> "4,5")."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return str(x)
    return (f"{f:.10g}").replace(".", ",")


def cz_unit(unit: str, n) -> str:
    """Správný tvar jednotky po čísle. Po desetinném čísle je v češtině
    2. pád množného čísla ("4,5 gólu"), po celém čísle se skloňuje podle něj."""
    base = "gól" if (unit or "").startswith("gól") else "bod"
    try:
        f = float(n)
    except (TypeError, ValueError):
        return base + "ů"
    if f != int(f):
        return base + "u"          # 4,5 gólu / 220,5 bodu
    i = int(f)
    if i == 1:
        return base                # 1 gól
    if 2 <= i <= 4:
        return base + "y"          # 3 góly
    return base + "ů"              # 5 gólů


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
    team = _norm_team(team)
    if team not in ratings:
        ratings[team] = {"a": 1.0, "d": 1.0, "n": 0}
    r = ratings[team]
    # Home/away specifické podklíče vedle celkového ratingu – doplní se i u
    # týmů založených před touhle funkcí (starý ratings.json), ať se appka
    # nezasekne na KeyError při čtení dat z minula.
    r.setdefault("a_home", r["a"]); r.setdefault("d_home", r["d"]); r.setdefault("n_home", 0)
    r.setdefault("a_away", r["a"]); r.setdefault("d_away", r["d"]); r.setdefault("n_away", 0)
    return r


HOME_AWAY_MIN_N = 8   # kolik domácích/venkovních zápasů je potřeba, než se specifický rating použije místo celkového


def effective_ab(rating: dict, loc: str) -> tuple:
    """Attack/defense pro KONKRÉTNÍ stranu (doma/venku), pokud už na ni tým
    má dost vlastních zápasů – jinak fallback na celkový rating.

    Důvod: tým může hrát doma výrazně jinak než venku (typicky silnější
    doma), ale dokud nemá aspoň HOME_AWAY_MIN_N zápasů na tu konkrétní
    stranu, je specifický odhad příliš zašuměný a celkový rating je
    spolehlivější startovní bod."""
    if loc == "home" and rating.get("n_home", 0) >= HOME_AWAY_MIN_N:
        return rating["a_home"], rating["d_home"]
    if loc == "away" and rating.get("n_away", 0) >= HOME_AWAY_MIN_N:
        return rating["a_away"], rating["d_away"]
    return rating["a"], rating["d"]


def rating_of(team: str) -> dict:
    return dict(get_rating(team, _ratings()))


_APPLIED_FILE = "ratings_applied.json"


def _applied_ids() -> set:
    return set((storage.load(_APPLIED_FILE, {}) or {}).get("ids") or [])


def _mark_applied(ids) -> None:
    cur = _applied_ids() | set(ids)
    # držet jen rozumné množství – starší zápasy se stejně znovu nestahují
    storage.save(_APPLIED_FILE, {"ids": sorted(cur)[-20000:]})


_HISTORY_FILE = "team_history.json"
_HISTORY_MAX_PER_TEAM = 20   # kolik posledních zápasů se drží na tým – forma a H2H víc nepotřebují


def _team_history() -> dict:
    return storage.load(_HISTORY_FILE, {})


def _record_team_history(home: str, away: str, league: str, hs: int, as_: int,
                          date: str, sport: str, hist: dict = None) -> dict:
    """Zapíše zápas do historie OBOU týmů – používá se pro formu (posledních
    N výsledků) a head-to-head (vzájemné zápasy). Nezávislé na ratingech,
    takže se dá číst i pro sporty/situace, kde by rating byl nespolehlivý.

    hist: když je předaný (dávkové zpracování, viz backfill_ratings), upraví
    se v paměti a NEUKLOŽÍ se – volající uloží jednou po celé dávce. Bez
    téhle možnosti by dávka se stovkami/tisíci zápasů dělala load+save
    CELÉHO (rostoucího) souboru při každém jednom zápase – kvadraticky
    pomalé, přesně to appku zpomalilo, když se poprvé pustil velký backfill."""
    own_hist = hist is None
    if own_hist:
        hist = _team_history()
    entry_h = {"date": date, "opponent": away, "league": league, "sport": sport,
               "loc": "home", "gf": hs, "ga": as_,
               "result": "W" if hs > as_ else "L" if hs < as_ else "D"}
    entry_a = {"date": date, "opponent": home, "league": league, "sport": sport,
               "loc": "away", "gf": as_, "ga": hs,
               "result": "W" if as_ > hs else "L" if as_ < hs else "D"}
    for team, entry in ((_norm_team(home), entry_h), (_norm_team(away), entry_a)):
        lst = hist.setdefault(team, [])
        lst.append(entry)
        lst.sort(key=lambda e: e.get("date", ""))
        del lst[:-_HISTORY_MAX_PER_TEAM]   # jen posledních N, ať soubor neroste bez konce
    if own_hist:
        storage.save(_HISTORY_FILE, hist)
    return hist


def team_form(team: str, n: int = 5) -> list:
    """Posledních n výsledků týmu jako list 'W'/'D'/'L', nejnovější poslední."""
    hist = _team_history().get(_norm_team(team), [])
    return [e["result"] for e in hist[-n:]]


def head_to_head(team_a: str, team_b: str, n: int = 5) -> list:
    """Posledních n vzájemných zápasů mezi dvěma týmy, nejnovější první."""
    hist = _team_history().get(_norm_team(team_a), [])
    team_b_norm = _norm_team(team_b)
    matches = [e for e in hist if _norm_team(e.get("opponent", "")) == team_b_norm]
    return list(reversed(matches[-n:]))


def update_from_result(home: str, away: str, league: str, hs: int, as_: int,
                        sport: str = "soccer", slug: str = "",
                        match_id: str = None, date: str = None,
                        _ratings_cache: dict = None, _history_cache: dict = None,
                        _applied_cache: set = None) -> bool:
    """Po vyhodnoceném zápase posune attack/defense obou týmů směrem k tomu,
    co skutečně předvedly oproti očekávání – učení se zpomaluje s počtem
    odehraných zápasů (n).

    sport je nutný: bez něj by se nefotbalové skóre porovnávalo s fotbalovou
    baseline a rating by se po jediném zápase utrhl na strop.

    _ratings_cache/_history_cache/_applied_cache: pro DÁVKOVÉ volání
    (backfill_ratings) – když jsou předané, funkce je jen upraví v paměti a
    NEUKLÁDÁ, volající uloží jednou po celé dávce. Bez toho by se při
    stovkách/tisících zápasů v jedné dávce načítal a ukládal CELÝ soubor
    (rostoucí s historií) při KAŽDÉM jednotlivém zápase – kvadraticky
    pomalé. Normální provoz (settle loop po jednom zápase, ruční
    /api/result) parametry nepředává, chová se jako dřív."""
    # Každý zápas smí rating ovlivnit jen jednou. Bez téhle pojistky by
    # opakovaná kontrola výsledků (nebo dávkové natažení historie) tentýž
    # výsledek započítala vícekrát a rating by se nafoukl.
    if match_id is not None:
        own_applied = _applied_cache is None
        applied = _applied_cache if _applied_cache is not None else _applied_ids()
        if str(match_id) in applied:
            return False
        applied.add(str(match_id))
        if own_applied:
            _mark_applied([str(match_id)])

    # Historie zápasů (forma, H2H) – nezávislá na ratingu, zapisuje se vždycky
    # spolu s ním, ať zůstanou konzistentní. datum bez volajícím předaného
    # data padá na dnešek – lepší přibližné pořadí než žádné.
    _record_team_history(home, away, league, hs, as_,
                         date or datetime.date.today().isoformat(), sport,
                         hist=_history_cache)

    own_ratings = _ratings_cache is None
    ratings = _ratings_cache if _ratings_cache is not None else _ratings()
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

    # Home/away specifické páry – stejný vzorec, ale vlastní alpha (podle
    # n_home/n_away, ne celkového n) a vlastní počítadlo. Domácí tým se učí
    # jen na SVÝCH domácích zápasech, hostující tým jen na SVÝCH venkovních –
    # jinak by týmy, co doma hrají silněji, tenhle rozdíl nikdy nezachytily.
    #
    # exp_h (a tedy ratio_h) už NEOBSAHUJE žádný extra fixní bonus navíc
    # (viz expected_scores – dřív se tam HOME_ADV_FACTOR násobilo podruhé,
    # což split učilo proti kontaminovanému očekávání a v průměru táhlo
    # a_home POD realitu). Teď je ratio_h čistě "skutečnost vs. co model
    # čekal z ratingu + ligového základu", takže se dá použít přímo.
    ratio_h_home = ratio_h
    alpha_h_home = max(0.06, 2.0 / (rh.get("n_home", 0) + 3.0))
    alpha_a_away = max(0.06, 2.0 / (ra.get("n_away", 0) + 3.0))
    rh["a_home"] = _clamp(rh.get("a_home", rh["a"]) * (1 + alpha_h_home * (ratio_h_home - 1)))
    ra["d_away"] = _clamp(ra.get("d_away", ra["d"]) * (1 + alpha_h_home * (ratio_h_home - 1)))
    ra["a_away"] = _clamp(ra.get("a_away", ra["a"]) * (1 + alpha_a_away * (ratio_a - 1)))
    rh["d_home"] = _clamp(rh.get("d_home", rh["d"]) * (1 + alpha_a_away * (ratio_a - 1)))
    rh["n_home"] = rh.get("n_home", 0) + 1
    ra["n_away"] = ra.get("n_away", 0) + 1

    rh["n"] += 1
    ra["n"] += 1
    if own_ratings:
        _save_ratings(ratings)
    return True


def cleanup_empty_ratings() -> dict:
    """Smaže záznamy týmů s n=0 (nikdy neodehráli zápas v appce – vznikly
    jen tím, že se na ně někdy zeptala predikce budoucího zápasu, viz
    get_rating). Nejsou škodlivé, jen zbytečně nafukují team_ratings.json
    (paměť na Render free tieru je omezená) – při další predikci se
    stejný tým znovu vytvoří s neutrálním ratingem, takže se nic
    neztrácí, jen se to nedrží v paměti/na disku předem."""
    ratings = _ratings()
    dead = [k for k, v in ratings.items() if v.get("n", 0) == 0]
    for k in dead:
        del ratings[k]
    _save_ratings(ratings)
    return {"removed": len(dead), "remaining": len(ratings)}


def reset_home_away_split() -> dict:
    """Jednorázová oprava: donedávna se a_home/d_home učily proti
    očekávání, které UŽ obsahovalo fixní HOME_ADV_FACTOR bonus (dvojité
    započítání domácí výhody) - u týmů s dost domácími zápasy to v
    průměru srazilo a_home POD reálnou hodnotu, takže model dával
    domácím jen ~31 % šance na výhru místo reálných ~43 % (viz
    update_from_result, kde se teď ratio_h_home počítá proti neutrálnímu
    očekávání bez tohohle bonusu).

    Existující a_home/d_home/a_away/d_away se ale opravou vzorce samy
    nespraví - jsou to už nahromaděné, zkreslené hodnoty. Resetuje je na
    neutrální (rovné celkovému a/d) a n_home/n_away na 0, ať
    effective_ab() dočasně padá zpátky na celkový rating (bez zkreslení)
    a split se od teď učí znovu, tentokrát opraveným vzorcem."""
    ratings = _ratings()
    n = 0
    for r in ratings.values():
        if r.get("n_home", 0) == 0 and r.get("n_away", 0) == 0:
            continue
        r["a_home"], r["d_home"] = r["a"], r["d"]
        r["a_away"], r["d_away"] = r["a"], r["d"]
        r["n_home"], r["n_away"] = 0, 0
        n += 1
    _save_ratings(ratings)
    return {"teams_reset": n}


def merge_duplicate_team_names() -> dict:
    """Jednorázová oprava: appka donedávna neuměla _norm_team() (bez
    diakritiky), takže tentýž tým zapsaný různě mezi zdroji (ESPN
    "Beşiktaş" vs football-data.co.uk "Besiktas") měl DVĚ oddělené,
    řídké položky ratingu/historie místo jedné bohaté. Pro každou takovou
    skupinu nechá tu s VÍC odehranými zápasy (spolehlivější signál) a
    chudší zahodí - nezkouší je numericky sléva – dvě různé EMA stopy by
    se blendem nesprávně zkreslily. Po zavedení _norm_team() do
    get_rating/team_form/atd. se appka do budoucna už nikdy takhle
    nerozštěpí; tohle jen uklidí, co se nastřádalo předtím."""
    ratings = _ratings()
    r_groups = {}
    for name in list(ratings):
        r_groups.setdefault(_norm_team(name), []).append(name)
    r_merged = 0
    for canon, names in r_groups.items():
        if len(names) == 1:
            if names[0] != canon:
                ratings[canon] = ratings.pop(names[0])
            continue
        names.sort(key=lambda n: ratings[n].get("n", 0), reverse=True)
        entry = ratings.pop(names[0])
        for loser in names[1:]:
            del ratings[loser]
            r_merged += 1
        ratings[canon] = entry
    _save_ratings(ratings)

    hist = _team_history()
    h_groups = {}
    for name in list(hist):
        h_groups.setdefault(_norm_team(name), []).append(name)
    h_merged = 0
    for canon, names in h_groups.items():
        if len(names) == 1:
            if names[0] != canon:
                hist[canon] = hist.pop(names[0])
            continue
        combined = []
        for n in names:
            combined.extend(hist.pop(n))
        combined.sort(key=lambda e: e.get("date", ""))
        del combined[:-_HISTORY_MAX_PER_TEAM]
        hist[canon] = combined
        h_merged += len(names) - 1
    storage.save(_HISTORY_FILE, hist)

    return {"ratings_groups_merged": r_merged, "history_names_merged": h_merged}


def backfill_ratings(days_back: int = 60, sport: str = "soccer",
                      chunk_days: int = 10, progress=None) -> dict:
    """Dožene ratingy z odehraných zápasů v minulosti.

    Model se jinak učí jen z toho, co si sám vyhodnotí, takže po čerstvém
    startu má většina týmů jediný odehraný zápas a predikce jsou nutně ploché.
    ESPN ale historii dává zdarma – tahle dávka ji projde odzadu dopředu a
    postupně z ní ratingy poskládá. Pořadí je chronologické, aby se učení
    zpomalovalo se skutečně narůstající zkušeností, ne náhodně."""
    today = ds.today_str()
    start = ds.add_days(today, -abs(days_back))
    matches, seen = [], set()

    d = start
    while d < today:
        end = min(ds.add_days(d, chunk_days - 1), ds.add_days(today, -1))
        try:
            for m in ds.fetch_range(d, end, sport=sport):
                if m.get("home_score") is None or m.get("away_score") is None:
                    continue
                if m.get("live") or str(m.get("id")) in seen:
                    continue
                seen.add(str(m["id"]))
                matches.append(m)
        except Exception:
            pass
        if progress:
            progress(d, end, len(matches))
        d = ds.add_days(end, 1)

    matches.sort(key=lambda m: (m.get("date", ""), m.get("time", "")))
    applied = skipped = 0
    # Dávkový mód: ratings i historie se načtou JEDNOU, upravují se v paměti
    # pro celou dávku, uloží se JEDNOU na konci. Bez toho by při tisících
    # zápasů dělalo update_from_result load+save celého (rostoucího) souboru
    # při KAŽDÉM jednotlivém zápase – kvadraticky pomalé, to appku poprvé
    # zpomalilo na týdny místo minut.
    batch_ratings = _ratings()
    batch_history = _team_history()
    batch_applied = _applied_ids()
    for m in matches:
        try:
            ok = update_from_result(m["home"], m["away"], m.get("league", ""),
                                    m["home_score"], m["away_score"],
                                    sport, m.get("slug", ""), match_id=m["id"],
                                    date=m.get("date"),
                                    _ratings_cache=batch_ratings, _history_cache=batch_history,
                                    _applied_cache=batch_applied)
            applied += 1 if ok else 0
            skipped += 0 if ok else 1
        except Exception:
            skipped += 1
    _save_ratings(batch_ratings)
    storage.save(_HISTORY_FILE, batch_history)
    storage.save(_APPLIED_FILE, {"ids": sorted(batch_applied)[-20000:]})

    ratings = batch_ratings
    played = [v for v in ratings.values() if v.get("n", 0) > 0]
    ns = sorted(v["n"] for v in played)
    return {
        "found": len(matches), "applied": applied, "skipped": skipped,
        "days_back": abs(days_back), "sport": sport,
        "teams_with_history": len(played),
        "median_games": ns[len(ns) // 2] if ns else 0,
        "avg_games": round(sum(ns) / len(ns), 1) if ns else 0,
    }


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


def _outcome_hits(outcome: str, i: int, j: int) -> bool:
    """Splňuje skóre i:j daný trh? Slouží ke společné pravděpodobnosti kombinací."""
    total = i + j
    if outcome == "home":
        return i > j
    if outcome == "away":
        return j > i
    if outcome == "draw":
        return i == j
    if outcome == "btts_yes":
        return i > 0 and j > 0
    if outcome == "btts_no":
        return not (i > 0 and j > 0)
    if outcome == "dc_1x":
        return i >= j
    if outcome == "dc_12":
        return i != j
    if outcome == "dc_x2":
        return i <= j
    if outcome == "dnb_home":
        return i > j
    if outcome == "dnb_away":
        return j > i
    if outcome.startswith("over"):
        return total > float(outcome[4:])
    if outcome.startswith("under"):
        return total < float(outcome[5:])
    if outcome.startswith("ah_"):
        try:
            _, side, line = outcome.split("_", 2)
            adj = (i + float(line)) - j if side == "home" else (j + float(line)) - i
            return adj > 0
        except (TypeError, ValueError):
            return False
    return False


def combo_probability(exp_goals: dict, outcomes) -> float:
    """Společná pravděpodobnost více trhů TÉHOŽ zápasu.

    Násobit jednotlivé pravděpodobnosti tady NELZE – trhy jednoho zápasu jsou
    silně korelované ("výhra domácích" a "Over 2.5" spolu souvisí), takže by
    součin dal úplně jiné číslo než realita. Počítá se proto přímo ze
    scoreline gridu: sečtou se pravděpodobnosti všech skóre, která splňují
    VŠECHNY zvolené trhy najednou."""
    if not exp_goals or exp_goals.get("home") is None:
        return 0.0
    grid = _score_grid(max(0.05, float(exp_goals["home"])), max(0.05, float(exp_goals["away"])))
    p = 0.0
    for (i, j), q in grid.items():
        if all(_outcome_hits(o, i, j) for o in outcomes):
            p += q
    return p


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


# ---------------------------------------------------------------------------
# Rozšířené model-only trhy (ESPN na ně kurzy nedává, takže se na ně NIKDY
# nesází – jen se zobrazují v detailu zápasu s odznakem "jen model", ať je
# vidět, co model o zápase ví. Stejný princip jako u BTTS o pár řádků výš.)
# ---------------------------------------------------------------------------
def _margin_probs(grid: dict) -> dict:
    """Pravděpodobnost gólového náskoku vítěze: remíza / 1 gól / 2 góly /
    3+ gólů. Přímý součet přes scoreline grid podle rozdílu skóre."""
    buckets = {"draw": 0.0, "margin_1": 0.0, "margin_2": 0.0, "margin_3plus": 0.0}
    for (i, j), p in grid.items():
        d = abs(i - j)
        if d == 0:
            buckets["draw"] += p
        elif d == 1:
            buckets["margin_1"] += p
        elif d == 2:
            buckets["margin_2"] += p
        else:
            buckets["margin_3plus"] += p
    return {k: round(v, 4) for k, v in buckets.items()}


def _team_total_probs(lam: float, lines=(0.5, 1.5, 2.5)) -> list:
    """Over/under na počet gólů JEDNOHO týmu (ne celého zápasu) – marginální
    Poissonova distribuce s intenzitou lam."""
    out = []
    for line in lines:
        # P(góly > line) = 1 - P(góly <= floor(line)), Poisson CDF v celých číslech
        k_max = int(math.floor(line))
        cdf = sum(_pois(k, lam) for k in range(k_max + 1))
        out.append({"line": line, "over": round(1 - cdf, 4), "under": round(cdf, 4)})
    return out


def _first_to_score_probs(lam_h: float, lam_a: float, grid: dict) -> dict:
    """Kdo dá první gól. Aproximace jako Poissonův "race" – když góly obou
    týmů přicházejí nezávislými Poissonovými procesy rozprostřenými rovnoměrně
    přes zápas, pravděpodobnost, že domácí skóruje dřív, je úměrná poměru
    jejich intenzit gólů. P(žádný gól) se vezme přímo ze scoreline gridu
    (přesná hodnota P(0:0)), zbytek se rozdělí podle lam_h : lam_a."""
    p_no_goals = grid.get((0, 0), 0.0)
    total_lam = lam_h + lam_a
    if total_lam <= 0:
        return {"home": 0.0, "away": 0.0, "no_goals": round(p_no_goals, 4)}
    p_rest = 1 - p_no_goals
    return {
        "home": round(p_rest * (lam_h / total_lam), 4),
        "away": round(p_rest * (lam_a / total_lam), 4),
        "no_goals": round(p_no_goals, 4),
    }


# Podíl gólů padajících v 1. poločase – empirický průměr napříč soutěžemi
# (2. poločas bývá otevřenější, unavenější obrany, víc střídání/rizika).
# Je to zjednodušující předpoklad stejný pro všechny zápasy, ne naučená
# hodnota – přesnost poločasových odhadů je proto nižší než u trhů
# počítaných přímo ze scoreline gridu celého zápasu.
HALF_TIME_SHARE = 0.45


def _half_time_probs(lam_h: float, lam_a: float) -> dict:
    """Odhad gólů podle poločasu. Vrací over/under linie pro 1./2. poločas
    a pravděpodobnost, ve kterém poločase padne víc gólů (číselná konvoluce
    dvou nezávislých Poissonových součtů, ne uzavřený vzorec)."""
    h1_lam = (lam_h + lam_a) * HALF_TIME_SHARE
    h2_lam = (lam_h + lam_a) * (1 - HALF_TIME_SHARE)

    def _over_lines(total_lam, lines=(0.5, 1.5)):
        out = []
        for line in lines:
            k_max = int(math.floor(line))
            cdf = sum(_pois(k, total_lam) for k in range(k_max + 1))
            out.append({"line": line, "over": round(1 - cdf, 4), "under": round(cdf, 4)})
        return out

    # Která půle bude gólovější – diskrétní konvoluce přes rozumný rozsah,
    # levné (max 12x12 kombinací), přesnější než uzavřený Skellamův vzorec
    # pro čtenáře k ověření.
    rng = range(0, 12)
    p_h1_more = p_h2_more = p_equal = 0.0
    for a in rng:
        pa = _pois(a, h1_lam)
        for b in rng:
            pb = _pois(b, h2_lam)
            q = pa * pb
            if a > b:
                p_h1_more += q
            elif b > a:
                p_h2_more += q
            else:
                p_equal += q

    return {
        "first_half": _over_lines(h1_lam),
        "second_half": _over_lines(h2_lam),
        "more_goals_half": {
            "first": round(p_h1_more, 4),
            "second": round(p_h2_more, 4),
            "equal": round(p_equal, 4),
        },
        "assumption": f"{int(HALF_TIME_SHARE * 100)} % gólů v 1. poločase (empirický odhad, ne naučená hodnota)",
    }


def _exact_total_probs(lam_total: float, buckets=(0, 1, 2, 3, 4, 5)) -> list:
    """Přesný POČET gólů v zápase (ne skóre) – "2 góly", "3 góly"…, poslední
    bucket je "6 a více". Marginální Poissonova distribuce ze součtu
    intenzit obou týmů, stejná jako u nad/pod linií."""
    out = []
    cum = 0.0
    for k in buckets:
        p = _pois(k, lam_total)
        cum += p
        out.append({"goals": k, "prob": round(p, 4)})
    out.append({"goals": f"{buckets[-1] + 1}+", "prob": round(max(0.0, 1 - cum), 4)})
    return out


def _exact_team_goals_probs(lam: float, buckets=(0, 1, 2, 3)) -> list:
    """Přesný počet gólů JEDNOHO týmu – "0", "1", "2", "3", "4 a více"."""
    out = []
    cum = 0.0
    for k in buckets:
        p = _pois(k, lam)
        cum += p
        out.append({"goals": k, "prob": round(p, 4)})
    out.append({"goals": f"{buckets[-1] + 1}+", "prob": round(max(0.0, 1 - cum), 4)})
    return out


def _odd_even_probs(grid: dict) -> dict:
    """Sudý/lichý celkový počet gólů v zápase – přímý součet přes grid."""
    odd = sum(p for (i, j), p in grid.items() if (i + j) % 2 == 1)
    return {"even": round(1 - odd, 4), "odd": round(odd, 4)}


def _winner_and_team_goals_probs(grid: dict, keys) -> dict:
    """Kombinace 'výsledek zápasu' × 'góly konkrétního týmu nad/pod 1.5' –
    šest kombinací (3 výsledky × over/under), počítané ze SPOLEČNÉHO gridu,
    ne součinem dvou marginálních pravděpodobností (ty spolu korelují –
    stejné pravidlo jako u kombi sázek arény)."""
    line = 1.5
    out = {}
    for side, label in (("home", "domácí"), ("away", "hosté")):
        idx = 0 if side == "home" else 1
        for res_key in keys:
            for ou, cond in (("over", lambda g: g > line), ("under", lambda g: g <= line)):
                p = sum(prob for score, prob in grid.items()
                        if _outcome_hits(res_key, score[0], score[1]) and cond(score[idx]))
                out[f"{res_key}_{side}_{ou}"] = round(p, 4)
    return out


def _winner_and_total_probs(grid: dict, keys, lines=(2.5,)) -> dict:
    """Kombinace 'výsledek zápasu' × 'celkový počet gólů nad/pod linii' –
    ze společného gridu (koreluje – výhra favorita 3:0 často znamená i
    Over, takže součin marginálů by podhodnotil pravděpodobnost)."""
    out = {}
    for line in lines:
        for res_key in keys:
            for ou, cond in (("over", lambda g: g > line), ("under", lambda g: g <= line)):
                p = sum(prob for score, prob in grid.items()
                        if _outcome_hits(res_key, score[0], score[1]) and cond(score[0] + score[1]))
                # bez tečky v klíči (over2.5 -> over25) – ať jde bez
                # bracket notace přečíst i z JS šablon v UI
                out[f"{res_key}_{ou}{str(line).replace('.', '')}"] = round(p, 4)
    return out


def _winner_and_first_scorer_probs(grid: dict, keys, first: dict) -> dict:
    """Kombinace 'výsledek zápasu' × 'kdo dá první gól'.

    POZOR – jediný z rozšířených trhů, který NENÍ počítaný čistě ze
    společného gridu. Scoreline grid zachycuje jen FINÁLNÍ skóre, ne
    časové pořadí gólů, takže přesná společná pravděpodobnost by
    vyžadovala samostatný model rozložení gólů v čase (mimo rozsah
    aplikace). Místo toho se použije nezávislostní aproximace:
    P(výsledek) × P(první gól dal tým X) – u zápasů, kde favorit skóruje
    první a pak zápas kontroluje, to hodnotu mírně podhodnotí, ale je to
    poctivější než tvrdit přesnost, kterou grid nemá."""
    out = {}
    p_first_total = max(1e-9, first.get("home", 0) + first.get("away", 0) + first.get("no_goals", 0))
    for res_key in keys:
        p_result = sum(prob for score, prob in grid.items() if _outcome_hits(res_key, score[0], score[1]))
        for side in ("home", "away"):
            out[f"{res_key}_{side}_first"] = round(p_result * (first.get(side, 0) / p_first_total), 4)
    return out


def _half_exact_goals_probs(lam_h1: float, buckets=(0, 1, 2, 3)) -> list:
    """Přesný počet gólů v 1. poločase (ne over/under linie)."""
    out = []
    cum = 0.0
    for k in buckets:
        p = _pois(k, lam_h1)
        cum += p
        out.append({"goals": k, "prob": round(p, 4)})
    out.append({"goals": f"{buckets[-1] + 1}+", "prob": round(max(0.0, 1 - cum), 4)})
    return out


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

    U fotbalu je domácí výhoda CELÁ už v LEAGUE_GOALS/DEFAULT_GOALS (home
    > away pro každou ligu, viz base_goals) – dřív se tu navíc násobilo
    HOME_ADV_FACTOR, což ji fakticky počítalo dvakrát (efektivní bonus
    ~1.22-1.27 z LEAGUE_GOALS × další 1.12 navrch = ~1.37-1.42). Benchmark
    proti zavíracímu kurzu Pinnacle to potvrdil: průměrná model home
    pravděpodobnost 0.469 vs skutečná home win rate 0.429 - po odstranění
    duplicitního násobiče sedí přesně (0.429 vs 0.429) a Brier skóre se
    dál zlepšilo. U ostatních sportů je domácí výhoda celá v base_goals()
    jako přerozdělení (podmínka níž se jich netýkala ani předtím)."""
    base_h, base_a = base_goals(league, sport, slug)
    damp = _rating_damping(sport, slug, league) if sport and sport != "soccer" else 1.0
    exp_h = base_h * (a_h * d_a) ** damp
    exp_a = base_a * (a_a * d_h) ** damp
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


# Odpočinek mezi zápasy – únava po nabitém programu (poháry, dohrávky)
# stojí očekávané góly, delší pauza dá naopak malou vzpruhu. Hranice a
# velikost efektu jsou konzervativní odhad (ne vyladěné z dat), tak jako
# HOME_ADV_FACTOR – appka na to zatím nemá dost sledovaných případů, aby se
# to dalo natrénovat samo.
REST_FATIGUE_DAYS = 3     # <= tolik dní od posledního zápasu = únava
REST_FATIGUE_PENALTY = 0.06
REST_BONUS_DAYS = 7       # >= tolik dní volna = mírná vzpruha
REST_BONUS = 0.03


def _team_rest_days(team: str, match_date: str) -> int:
    """Kolik dní uplynulo od posledního zaznamenaného zápasu týmu do tohoto
    zápasu. None když chybí historie nebo datum – pak se nic neupravuje."""
    if not match_date:
        return None
    hist = _team_history().get(_norm_team(team)) or []
    if not hist:
        return None
    last_date = hist[-1].get("date")
    if not last_date:
        return None
    try:
        d1 = datetime.date.fromisoformat(last_date)
        d2 = datetime.date.fromisoformat(match_date)
        return (d2 - d1).days
    except (ValueError, TypeError):
        return None


def _rest_factor(days) -> float:
    """Násobek očekávaných gólů týmu podle odpočinku. 1.0 = žádná úprava
    (chybějící data, nebo odpočinek v normálním pásmu)."""
    if days is None or days < 0:
        return 1.0
    if days <= REST_FATIGUE_DAYS:
        return 1.0 - REST_FATIGUE_PENALTY
    if days >= REST_BONUS_DAYS:
        return 1.0 + REST_BONUS
    return 1.0


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
    # Home/away specifický rating, pokud už na něj tým má dost vlastních
    # zápasů (viz effective_ab) – jinak fallback na celkový a/d, stejně
    # jako dřív.
    rh_a, rh_d = effective_ab(rh, "home")
    ra_a, ra_d = effective_ab(ra, "away")
    sh_a, sh_d = _shrink(rh_a, rating_confidence), _shrink(rh_d, rating_confidence)
    sa_a, sa_d = _shrink(ra_a, rating_confidence), _shrink(ra_d, rating_confidence)

    rest_days_home = _team_rest_days(m["home"], m.get("date"))
    rest_days_away = _team_rest_days(m["away"], m.get("date"))
    rest_home = _rest_factor(rest_days_home)
    rest_away = _rest_factor(rest_days_away)

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
        exp_h *= rest_home
        exp_a *= rest_away
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
        raw_h *= rest_home
        raw_a *= rest_away
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
    # 2way varianta marže: home + away (žádná remíza). Stejný smysl –
    # nad ~7-8 % je trh drahý a value hledat nemá cenu.
    if cfg.get("two_way") and all(bets.get(k, {}).get("real") for k in ("home", "away")):
        i1 = 1.0 / bets["home"]["odds"]
        i2 = 1.0 / bets["away"]["odds"]
        v = round(i1 + i2 - 1.0, 4)
        bets["home"]["market_vig"] = v
        bets["away"]["market_vig"] = v

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
        over = dict(_priced(po, over_odds, rating_confidence),
                    label=f"Více {cz_num(line)}",
                    name=f"Více než {cz_num(line)} {cz_unit(unit, line)}")
        under = dict(_priced(1 - po, under_odds, rating_confidence),
                     label=f"Méně {cz_num(line)}",
                     name=f"Méně než {cz_num(line)} {cz_unit(unit, line)}")
        goal_lines.append({"line": line, "over": over, "under": under})
        bets[f"over{line}"] = over
        bets[f"under{line}"] = under

    extra_markets = None
    if not cfg.get("two_way"):
        btts_p = _btts_prob(grid)
        bets["btts_yes"] = dict(_priced(btts_p, None), label="Oba dají gól", name="Oba týmy dají gól")
        bets["btts_no"] = dict(_priced(1 - btts_p, None), label="Nedají oba", name="Aspoň jeden tým nedá gól")

        # Rozšířené model-only trhy – ESPN na ně kurzy nikdy nedává, takže se
        # nikdy nesází (agent._candidates i virtual_bettors._candidates_for
        # berou jen bets s real=True). Slouží čistě k zobrazení v detailu
        # zápasu, ať je vidět, co model o zápase ví nad rámec sázkatelných trhů.
        first_to_score = _first_to_score_probs(lam_h, lam_a, grid)
        h1_lam = (lam_h + lam_a) * HALF_TIME_SHARE
        extra_markets = {
            "correct_score": _top_scores(grid, n=8),
            "margin": _margin_probs(grid),
            "team_totals": {
                "home": _team_total_probs(lam_h),
                "away": _team_total_probs(lam_a),
            },
            "first_to_score": first_to_score,
            "half_time": _half_time_probs(lam_h, lam_a),
            # --- doplněno podle inspirace z běžné nabídky sázkovek ---
            "exact_total_goals": _exact_total_probs(lam_h + lam_a),
            "exact_team_goals": {
                "home": _exact_team_goals_probs(lam_h),
                "away": _exact_team_goals_probs(lam_a),
            },
            "odd_even": _odd_even_probs(grid),
            "winner_and_team_goals": _winner_and_team_goals_probs(grid, keys),
            "winner_and_total": _winner_and_total_probs(grid, keys),
            "winner_and_first_scorer": _winner_and_first_scorer_probs(grid, keys, first_to_score),
            "half_exact_goals": {
                "first_half": _half_exact_goals_probs(h1_lam),
            },
        }

    # Dvojtip a "remíza zpět" – nejsou to nové kurzy od sázkovky, ale PŘESNÝ
    # přepočet z reálných kurzů na 1/X/2. Jsou to vzájemně se vylučující
    # výsledky, takže se implikované pravděpodobnosti prostě sečtou; marže
    # sázkovky se tím zachová. Stejně dvojtipy počítají i sázkovky samy.
    winner_vig = None
    if not cfg.get("two_way") and all(bets.get(k, {}).get("real") for k in ("home", "draw", "away")):
        i1 = 1.0 / bets["home"]["odds"]
        ix = 1.0 / bets["draw"]["odds"]
        i2 = 1.0 / bets["away"]["odds"]
        # Marže sázkovky = kolik "pře 100 %" zabaluje součet implikovaných
        # pravděpodobností. Nad ~8 % se prakticky nedá najít systematická
        # value – trh je moc drahý. Propagujeme to do každé nohy 1X2,
        # aby si agent i sázkaři mohli filtrovat drahé trhy.
        winner_vig = round(i1 + ix + i2 - 1.0, 4)
        for k in ("home", "draw", "away"):
            bets[k]["market_vig"] = winner_vig
        pr = probs
        for key, parts, imp, nm in (
            ("dc_1x", ("home", "draw"), i1 + ix, f'{m["home"]} nebo remíza'),
            ("dc_12", ("home", "away"), i1 + i2, "Padne vítěz (bez remízy)"),
            ("dc_x2", ("draw", "away"), ix + i2, f'Remíza nebo {m["away"]}'),
        ):
            bets[key] = dict(_priced(sum(pr[k] for k in parts), round(1.0 / imp, 3), rating_confidence),
                             label={"dc_1x": "1X", "dc_12": "12", "dc_x2": "X2"}[key], name=nm)
        # Remíza zpět: při remíze se vrací vklad, takže se cena odvozuje jen
        # z poměru výhra/prohra (o = 1 + p_soupere / p_naseho).
        for key, side, mine, theirs, nm in (
            ("dnb_home", "home", i1, i2, f'{m["home"]} (remíza zpět)'),
            ("dnb_away", "away", i2, i1, f'{m["away"]} (remíza zpět)'),
        ):
            cond = pr[side] / (pr["home"] + pr["away"]) if (pr["home"] + pr["away"]) > 0 else 0.0
            bets[key] = dict(_priced(cond, round(1.0 + theirs / mine, 3), rating_confidence),
                             label="1 rem. zpět" if side == "home" else "2 rem. zpět", name=nm)

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
            # znaménko se musí doplnit ručně – cz_num() ho z čísla nevyčte
            sign = ("+" if float(line) > 0 else "") + cz_num(line)
            bets[key] = dict(_priced(p_side, sd.get("odds"), rating_confidence),
                             label=f"Hendikep {sign}",
                             name=f"{team} s hendikepem {sign}")

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
        "rest_days": {"home": rest_days_home, "away": rest_days_away},
        "exp_goals": exp_goals, "exp_total": exp_total,
        "probs": {k: round(v, 4) for k, v in probs.items()},
        "pick": pick, "pick_label": labels[pick], "confidence": confidence,
        "value": {k: v for k, v in bets.items() if v.get("real")},
        "best_value": best_value,
        "bets": bets,
        "goal_lines": goal_lines,
        "top_scores": top_scores,
        "extra_markets": extra_markets,
        "odds_source": "real" if real_bets else "model",
        "winner_vig": winner_vig,   # marže sázkovky na 1X2/2way trhu (None když chybí odds)
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
