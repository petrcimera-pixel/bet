# -*- coding: utf-8 -*-
"""
Načítání fotbalových zápasů z celého světa, rozdělených podle lig.

Primární zdroj: veřejné ESPN API (BEZ registrace, bez klíče) – pokrývá
desítky lig napříč světadíly. Pro každou ligu se stáhne rozpis na daný den;
dotazy běží paralelně.

Fallback: TheSportsDB (veřejný klíč "3") a nakonec vestavěný demo dataset,
aby aplikace fungovala vždy.

Výsledky se kešují do data/cache_<datum>.json.
"""

import re
import time
import datetime as _dt
from concurrent.futures import ThreadPoolExecutor

import requests

from . import storage

TIMEOUT = 15  # ESPN API needs more time for 244 leagues
ESPN = "https://site.api.espn.com/apis/site/v2/sports/{sport}/{slug}/scoreboard"
ESPN_SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/{sport}/{slug}/summary"
ESPN_LIST = "https://sports.core.api.espn.com/v2/sports/soccer/leagues?limit=1000"
TSDB = "https://www.thesportsdb.com/api/v1/json/3/eventsday.php"
LEAGUES_TTL = 7 * 86400   # seznam lig se obnovuje jednou týdně

# ---------------------------------------------------------------------------
# Podporované sporty (všechny přes stejné ESPN API)
# soccer = remízy možné (1X2); ostatní = dvoucestné (1/2) + body místo gólů
# ---------------------------------------------------------------------------
SPORTS = {
    "soccer": {
        "label": "⚽ Fotbal", "two_way": False, "unit": "gólů",
        "dynamic": True, "avg_total": 2.7, "sd_total": 1.7,
        "lines": [0.5, 1.5, 2.5, 3.5, 4.5],
    },
    "basketball": {
        "label": "🏀 Basketbal", "two_way": True, "unit": "bodů",
        "leagues": [("nba", "USA"), ("wnba", "USA"),
                    ("mens-college-basketball", "USA"), ("euroleague", "Europe")],
        "avg_total": 224.0, "sd_total": 19.0, "lines": [210.5, 220.5, 230.5],
    },
    "hockey": {
        "label": "🏒 Hokej", "two_way": True, "unit": "gólů",
        "leagues": [("nhl", "USA")],
        "avg_total": 6.1, "sd_total": 2.2, "lines": [4.5, 5.5, 6.5, 7.5],
    },
    "football": {
        "label": "🏈 Am. fotbal", "two_way": True, "unit": "bodů",
        "leagues": [("nfl", "USA"), ("college-football", "USA")],
        "avg_total": 45.0, "sd_total": 13.5, "lines": [41.5, 45.5, 49.5],
    },
}


def sport_cfg(sport: str) -> dict:
    return SPORTS.get(sport, SPORTS["soccer"])

# ---------------------------------------------------------------------------
# Mapování prefixu slugu (kód země / konfederace) → země
# ---------------------------------------------------------------------------
_PREFIX_COUNTRY = {
    # Evropa
    "eng": "England", "esp": "Spain", "ita": "Italy", "ger": "Germany",
    "fra": "France", "ned": "Netherlands", "por": "Portugal", "bel": "Belgium",
    "sco": "Scotland", "tur": "Turkey", "gre": "Greece", "aut": "Austria",
    "sui": "Switzerland", "den": "Denmark", "nor": "Norway", "swe": "Sweden",
    "rus": "Russia", "ukr": "Ukraine", "pol": "Poland", "cze": "Czech Republic",
    "cro": "Croatia", "rou": "Romania", "cyp": "Cyprus", "irl": "Ireland",
    "ir1": "Iran",
    # Amerika
    "usa": "USA", "mex": "Mexico", "can": "Canada", "crc": "Costa Rica",
    "hon": "Honduras", "gua": "Guatemala", "slv": "El Salvador",
    "bra": "Brazil", "arg": "Argentina", "chi": "Chile", "col": "Colombia",
    "uru": "Uruguay", "par": "Paraguay", "per": "Peru", "ecu": "Ecuador",
    "ven": "Venezuela", "bol": "Bolivia",
    # Afrika / Asie / Oceánie
    "rsa": "South Africa", "egy": "Egypt", "ksa": "Saudi Arabia",
    "chn": "China", "jpn": "Japan", "kor": "South Korea", "ind": "India",
    "idn": "Indonesia", "mys": "Malaysia", "sgp": "Singapore", "tha": "Thailand",
    "aus": "Australia",
    # Konfederace a globální soutěže
    "uefa": "Europe", "conmebol": "South America", "concacaf": "North America",
    "caf": "Africa", "afc": "Asia", "aff": "Asia", "ofc": "Oceania",
    "gha": "Ghana", "ken": "Kenya", "nga": "Nigeria", "uga": "Uganda",
    "fifa": "World", "global": "World", "nonfifa": "World", "friendly": "World",
    "club": "World", "campeones": "World", "euroamericana": "World",
    "bangabandhu": "World",
}


def _country_for(slug: str) -> str:
    return _PREFIX_COUNTRY.get(slug.split(".")[0], "")


# ---------------------------------------------------------------------------
# Seznam lig – dynamicky z ESPN (všech ~244 lig), s týdenní keší
# ---------------------------------------------------------------------------
def league_slugs(sport: str = "soccer") -> list:
    """Vrátí [(slug, country), …]. Fotbal = všech ~244 lig dynamicky; ostatní sporty
    používají kurátorovaný seznam z konfigurace SPORTS."""
    cfg = sport_cfg(sport)
    if not cfg.get("dynamic"):
        return list(cfg.get("leagues", []))

    cached = storage.load("leagues.json", None)
    if cached and time.time() - cached.get("ts", 0) < LEAGUES_TTL and cached.get("slugs"):
        return [tuple(x) for x in cached["slugs"]]

    try:
        r = requests.get(ESPN_LIST, timeout=TIMEOUT)
        r.raise_for_status()
        items = r.json().get("items") or []
        slugs = []
        for it in items:
            mo = re.search(r"/leagues/([^?]+)", it.get("$ref", ""))
            if mo:
                slug = mo.group(1)
                slugs.append((slug, _country_for(slug)))
        if slugs:
            storage.save("leagues.json", {"ts": int(time.time()), "slugs": slugs})
            return slugs
    except Exception:
        pass
    return list(CURATED)   # záloha


# ---------------------------------------------------------------------------
# Kurátorovaný seznam lig – záloha, když dynamický seznam selže
# ---------------------------------------------------------------------------
CURATED = [
    # Evropa – TOP
    ("eng.1", "England"), ("eng.2", "England"), ("eng.fa", "England"),
    ("esp.1", "Spain"), ("esp.2", "Spain"),
    ("ita.1", "Italy"), ("ita.2", "Italy"),
    ("ger.1", "Germany"), ("ger.2", "Germany"),
    ("fra.1", "France"), ("fra.2", "France"),
    ("ned.1", "Netherlands"), ("por.1", "Portugal"), ("bel.1", "Belgium"),
    ("tur.1", "Turkey"), ("gre.1", "Greece"), ("sco.1", "Scotland"),
    ("sui.1", "Switzerland"), ("aut.1", "Austria"), ("rus.1", "Russia"),
    ("ukr.1", "Ukraine"), ("den.1", "Denmark"), ("nor.1", "Norway"),
    ("swe.1", "Sweden"), ("pol.1", "Poland"), ("cze.1", "Czech Republic"),
    ("cro.1", "Croatia"), ("rou.1", "Romania"),
    # Amerika
    ("usa.1", "USA"), ("mex.1", "Mexico"), ("bra.1", "Brazil"),
    ("arg.1", "Argentina"), ("col.1", "Colombia"), ("chi.1", "Chile"),
    ("uru.1", "Uruguay"), ("ecu.1", "Ecuador"), ("per.1", "Peru"),
    # Asie / Afrika / Oceánie
    ("jpn.1", "Japan"), ("kor.1", "South Korea"), ("chn.1", "China"),
    ("aus.1", "Australia"), ("ksa.1", "Saudi Arabia"), ("rsa.1", "South Africa"),
    ("egy.1", "Egypt"),
    # Poháry a reprezentace
    ("uefa.champions", "Europe"), ("uefa.europa", "Europe"),
    ("uefa.europa.conf", "Europe"), ("uefa.nations", "Europe"),
    ("conmebol.libertadores", "South America"),
    ("concacaf.champions", "North America"),
    ("fifa.world", "World"), ("fifa.friendly", "World"),
]

_FLAGS = {
    "England": "🏴", "Spain": "🇪🇸", "Italy": "🇮🇹", "Germany": "🇩🇪",
    "France": "🇫🇷", "Netherlands": "🇳🇱", "Portugal": "🇵🇹", "Belgium": "🇧🇪",
    "Czech Republic": "🇨🇿", "Scotland": "🏴", "Turkey": "🇹🇷", "Greece": "🇬🇷",
    "Switzerland": "🇨🇭", "Austria": "🇦🇹", "Russia": "🇷🇺", "Ukraine": "🇺🇦",
    "Denmark": "🇩🇰", "Norway": "🇳🇴", "Sweden": "🇸🇪", "Poland": "🇵🇱",
    "Croatia": "🇭🇷", "Romania": "🇷🇴", "USA": "🇺🇸", "Mexico": "🇲🇽",
    "Brazil": "🇧🇷", "Argentina": "🇦🇷", "Colombia": "🇨🇴", "Chile": "🇨🇱",
    "Uruguay": "🇺🇾", "Ecuador": "🇪🇨", "Peru": "🇵🇪", "Japan": "🇯🇵",
    "South Korea": "🇰🇷", "China": "🇨🇳", "Australia": "🇦🇺",
    "Saudi Arabia": "🇸🇦", "South Africa": "🇿🇦", "Egypt": "🇪🇬",
    "Cyprus": "🇨🇾", "Ireland": "🇮🇪", "Iran": "🇮🇷", "Canada": "🇨🇦",
    "Costa Rica": "🇨🇷", "Honduras": "🇭🇳", "Guatemala": "🇬🇹",
    "El Salvador": "🇸🇻", "Venezuela": "🇻🇪", "Bolivia": "🇧🇴",
    "Paraguay": "🇵🇾", "India": "🇮🇳", "Indonesia": "🇮🇩", "Malaysia": "🇲🇾",
    "Singapore": "🇸🇬", "Thailand": "🇹🇭", "Ghana": "🇬🇭", "Kenya": "🇰🇪",
    "Nigeria": "🇳🇬", "Uganda": "🇺🇬",
    "Europe": "🇪🇺", "South America": "🌎", "North America": "🌎",
    "Africa": "🌍", "Asia": "🌏", "Oceania": "🌏", "World": "🌍",
}


def flag(country: str) -> str:
    return _FLAGS.get((country or "").strip(), "⚽")


# ---------------------------------------------------------------------------
# Priorita lig – velké soutěže nahoru
# ---------------------------------------------------------------------------
_RANK = [
    "fifa world cup", "uefa champions league", "uefa europa league",
    "english premier league", "spanish laliga", "italian serie a",
    "german bundesliga", "french ligue 1", "uefa europa conference",
    "uefa nations", "english league championship", "dutch eredivisie",
    "portuguese primeira", "saudi pro", "turkish super", "belgian",
    "scottish premiership", "mls", "mexican liga", "brazilian serie a",
    "argentine liga profesional", "primeira liga", "uefa", "conmebol",
    "concacaf",
]
_LOWER = ("serie b", "serie c", "league one", "league two", "national league",
          "tweede", "segunda", "2. ", " ii", "u17", "u18", "u19", "u20",
          "u21", "u23", "women", "reserve", "nacional b", "primera b",
          "primera c", "laliga 2", "ncaa", "youth", "amateur", "regionalliga")


def league_rank(name: str) -> int:
    """Nižší číslo = výš v seznamu. Velké ligy nahoru, nižší/mládež/ženy dolů."""
    low = (name or "").lower()
    rank = 100
    for i, pat in enumerate(_RANK):
        if pat in low:
            rank = i
            break
    if any(t in low for t in _LOWER):
        rank += 200
    return rank


# ---------------------------------------------------------------------------
# Veřejné rozhraní
# ---------------------------------------------------------------------------
def fetch_range(start: str, end: str, use_cache: bool = True, sport: str = "soccer") -> list:
    """Vrátí zápasy daného sportu pro rozsah dat [start, end], seřazené dle data/času."""
    cache_name = f"cache_{sport}_{start}_{end}.json"
    if use_cache:
        cached = storage.load(cache_name, None)
        if cached is not None and not storage.is_cache_stale(cache_name, ttl_hours=12):
            return cached

    matches = _from_espn(start, end, sport)
    if not matches and sport == "soccer":
        matches = _from_thesportsdb(start)
    if not matches and sport == "soccer":
        matches = _demo(start)

    matches.sort(key=lambda m: (m.get("date", ""), m.get("time", "")))
    storage.save(cache_name, matches)
    return matches


def fetch_day(date_str: str, use_cache: bool = True, sport: str = "soccer") -> list:
    return fetch_range(date_str, date_str, use_cache, sport)


# ---------------------------------------------------------------------------
# ESPN – primární zdroj (paralelně přes všechny ligy, jedním dotazem na rozsah)
# ---------------------------------------------------------------------------
def _from_espn(start: str, end: str, sport: str = "soccer") -> list:
    s, e = start.replace("-", ""), end.replace("-", "")
    drange = s if s == e else f"{s}-{e}"
    out = []

    def grab(item):
        slug, country = item
        try:
            r = requests.get(ESPN.format(sport=sport, slug=slug),
                             params={"dates": drange}, timeout=TIMEOUT)
            r.raise_for_status()
            return _parse_espn(slug, country, r.json(), start, end, sport)
        except Exception:
            return []

    try:
        with ThreadPoolExecutor(max_workers=10) as ex:  # Reduced from 40 to prevent ESPN throttling
            for res in ex.map(grab, league_slugs(sport)):
                out.extend(res)
    except Exception:
        return []
    return out


def _parse_espn(slug, country, data, start, end, sport="soccer"):
    league_name = (data.get("leagues") or [{}])[0].get("name") or slug
    out = []
    for ev in data.get("events") or []:
        iso_day = (ev.get("date", "") or "")[:10]
        if iso_day and not (start <= iso_day <= end):
            continue   # liga ignorovala rozsah – odfiltruj zápasy mimo okno
        comps = ev.get("competitions") or []
        if not comps:
            continue
        c = comps[0]
        cs = c.get("competitors") or []
        home = next((x for x in cs if x.get("homeAway") == "home"), None)
        away = next((x for x in cs if x.get("homeAway") == "away"), None)
        if not home or not away:
            continue
        hteam = home.get("team", {})
        ateam = away.get("team", {})
        hn = hteam.get("displayName") or hteam.get("name")
        an = ateam.get("displayName") or ateam.get("name")
        if not hn or not an:
            continue

        iso = ev.get("date", "")                 # 2025-11-08T15:00Z (UTC)
        time_s = iso[11:16] if len(iso) >= 16 else ""

        stype = (c.get("status") or ev.get("status") or {}).get("type", {})
        completed = bool(stype.get("completed"))
        short = stype.get("shortDetail", "").strip()

        # Detekce live zápasů (nepřehráno, ale probíhá)
        _LIVE_KEYS = ("progress", "halftime", "half time", " 1st", " 2nd",
                      "extra time", "et ", "pen", "overtime")
        is_live = not completed and (
            any(k in short.lower() for k in _LIVE_KEYS) or
            (short and short[-1] == "'" and short[:-1].isdigit())  # "45'"
        )

        # Skóre: pro odehrané a live zápasy; pro nespuštěné = None
        raw_hs = _int(home.get("score"))
        raw_as = _int(away.get("score"))
        hs = raw_hs if (completed or is_live) else None
        as_ = raw_as if (completed or is_live) else None

        real_odds = _espn_odds(c)

        out.append({
            "id": str(ev.get("id") or f"{slug}-{hn}-{an}-{start}"),
            "sport": sport,
            "slug": slug,
            "league": league_name,
            "country": country,
            "home": hn,
            "away": an,
            "home_id": str(hteam.get("id") or ""),
            "away_id": str(ateam.get("id") or ""),
            "date": iso[:10] or start,
            "time": time_s,
            "home_score": hs,
            "away_score": as_,
            "status": short,
            "live": is_live,
            "real_odds": real_odds,
        })
    return out


def _amer_to_dec(s):
    """Americké kurzy (+280 / -110) → desetinné (3.80 / 1.909)."""
    try:
        v = int(str(s).replace("+", ""))
    except (ValueError, TypeError):
        return None
    if v == 0:
        return None
    return round(1 + (v / 100.0 if v > 0 else 100.0 / abs(v)), 3)


def _espn_odds(competition):
    """Reálné kurzy sázkovky (DraftKings/ESPN BET) přímo ze scoreboard API.
    Zdarma, bez kvóty – narozdíl od The Odds API. Vrací None když nejsou."""
    odds_list = competition.get("odds") or []
    if not odds_list:
        return None
    o = odds_list[0]
    ml = o.get("moneyline") or {}

    def pick(side):
        d = ml.get(side) or {}
        return (_amer_to_dec((d.get("close") or {}).get("odds"))
                or _amer_to_dec((d.get("open") or {}).get("odds")))

    ro = {"home": pick("home"), "away": pick("away")}
    draw = pick("draw")
    if draw:
        ro["draw"] = draw
    if not (ro["home"] and ro["away"]):
        return None
    provider = (o.get("provider") or {}).get("displayName") or "ESPN BET"
    return {"provider": provider, "odds": ro, "over_under": o.get("overUnder")}


def fetch_corners(sport: str, slug: str, event_id: str):
    """Skutečný počet rohů zápasu z ESPN summary endpointu (boxscore statistika
    'wonCorners'). Vrací {'home': H, 'away': A}, nebo None když data nejsou
    dostupná (ne každá liga má detailní boxscore statistiky)."""
    try:
        r = requests.get(ESPN_SUMMARY.format(sport=sport, slug=slug),
                         params={"event": event_id}, timeout=TIMEOUT)
        r.raise_for_status()
        d = r.json()
    except Exception:
        return None
    teams = (d.get("boxscore") or {}).get("teams") or []
    if len(teams) != 2:
        return None
    out = {}
    for t in teams:
        side = "home" if t.get("homeAway") == "home" else "away"
        stats = {s.get("name"): s.get("displayValue") for s in t.get("statistics") or []}
        val = stats.get("wonCorners")
        try:
            out[side] = int(float(val))
        except (TypeError, ValueError):
            return None
    if "home" not in out or "away" not in out:
        return None
    return out


# ---------------------------------------------------------------------------
# Skutečná forma a vzájemné zápasy (H2H) – načítá se on-demand z ESPN
# ---------------------------------------------------------------------------
def _score_val(c):
    s = c.get("score")
    return _int(s.get("value") if isinstance(s, dict) else s)


def team_events(sport: str, slug: str, team_id: str) -> list:
    """Všechny zápasy týmu ze sezóny (minulé i příští) z ESPN rozpisu."""
    if not team_id:
        return []
    url = (f"https://site.api.espn.com/apis/site/v2/sports/{sport}/{slug}"
           f"/teams/{team_id}/schedule")
    try:
        r = requests.get(url, timeout=TIMEOUT)
        r.raise_for_status()
        events = r.json().get("events") or []
    except Exception:
        return []
    out = []
    for ev in events:
        comp = (ev.get("competitions") or [{}])[0]
        completed = bool((comp.get("status") or {}).get("type", {}).get("completed"))
        cs = comp.get("competitors") or []
        me = next((x for x in cs if str(x.get("team", {}).get("id")) == str(team_id)), None)
        opp = next((x for x in cs if str(x.get("team", {}).get("id")) != str(team_id)), None)
        if not me or not opp:
            continue
        gf, ga = _score_val(me), _score_val(opp)
        res = None
        if completed and gf is not None and ga is not None:
            res = "W" if gf > ga else ("L" if gf < ga else "D")
        out.append({
            "date": (ev.get("date", "") or "")[:10],
            "opp": opp.get("team", {}).get("displayName") or opp.get("team", {}).get("abbreviation", "?"),
            "gf": gf, "ga": ga, "res": res, "completed": completed,
            "home": me.get("homeAway") == "home",
        })
    out.sort(key=lambda x: x["date"])
    return out


def team_form(sport: str, slug: str, team_id: str, n: int = 6) -> list:
    """Posledních N odehraných zápasů týmu."""
    done = [e for e in team_events(sport, slug, team_id) if e["res"]]
    return list(reversed(done))[:n]


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# TheSportsDB – fallback (free klíč vrací jen vzorek zápasů)
# ---------------------------------------------------------------------------
def _from_thesportsdb(date_str: str) -> list:
    try:
        r = requests.get(TSDB, params={"d": date_str, "s": "Soccer"}, timeout=TIMEOUT)
        r.raise_for_status()
        events = r.json().get("events") or []
    except Exception:
        return []
    out = []
    for e in events:
        home = (e.get("strHomeTeam") or "").strip()
        away = (e.get("strAwayTeam") or "").strip()
        if not home or not away:
            continue
        out.append({
            "id": str(e.get("idEvent") or f"{home}-{away}-{date_str}"),
            "league": (e.get("strLeague") or "Ostatní").strip(),
            "country": (e.get("strCountry") or "").strip(),
            "home": home, "away": away,
            "date": e.get("dateEvent") or date_str,
            "time": (e.get("strTime") or "")[:5],
            "home_score": _int(e.get("intHomeScore")),
            "away_score": _int(e.get("intAwayScore")),
            "status": (e.get("strStatus") or "").strip(),
        })
    return out


# ---------------------------------------------------------------------------
# Demo dataset – offline režim
# ---------------------------------------------------------------------------
_DEMO_LEAGUES = {
    ("English Premier League", "England"): [
        ("Manchester City", "Arsenal"), ("Liverpool", "Chelsea"),
        ("Tottenham", "Manchester United"), ("Newcastle", "Aston Villa"),
        ("Brighton", "West Ham")],
    ("Spanish La Liga", "Spain"): [
        ("Real Madrid", "Sevilla"), ("Barcelona", "Real Betis"),
        ("Atletico Madrid", "Villarreal"), ("Real Sociedad", "Valencia")],
    ("Italian Serie A", "Italy"): [
        ("Inter", "Juventus"), ("AC Milan", "Napoli"),
        ("Roma", "Lazio"), ("Atalanta", "Fiorentina")],
    ("German Bundesliga", "Germany"): [
        ("Bayern Munich", "Borussia Dortmund"), ("RB Leipzig", "Bayer Leverkusen"),
        ("Eintracht Frankfurt", "VfB Stuttgart")],
    ("French Ligue 1", "France"): [
        ("Paris SG", "Marseille"), ("Monaco", "Lille"), ("Lyon", "Nice")],
    ("Czech First League", "Czech Republic"): [
        ("Slavia Praha", "Sparta Praha"), ("Viktoria Plzen", "Banik Ostrava"),
        ("Slovan Liberec", "Sigma Olomouc")],
}


def _demo(date_str: str) -> list:
    out = []
    for (league, country), games in _DEMO_LEAGUES.items():
        for i, (home, away) in enumerate(games):
            out.append({
                "id": f"demo-{league}-{i}-{date_str}",
                "league": league, "country": country,
                "home": home, "away": away,
                "date": date_str, "time": f"{15 + (i % 6):02d}:00",
                "home_score": None, "away_score": None, "status": "",
            })
    return out


def today_str() -> str:
    return _dt.date.today().isoformat()


def add_days(date_str: str, n: int) -> str:
    return (_dt.date.fromisoformat(date_str) + _dt.timedelta(days=n)).isoformat()
