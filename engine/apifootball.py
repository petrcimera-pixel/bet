# -*- coding: utf-8 -*-
"""
Doplňkový zdroj zápasů z API-Football (api-sports.io).

Proč vůbec: ESPN vede jen 220 fotbalových soutěží a některé evropské ligy
mezi nimi nejsou vůbec – česká, polská, slovenská, ukrajinská, chorvatská,
srbská, maďarská. Tenhle modul je doplní, ESPN zůstává primární zdroj.

Bez API klíče se nic nemění – appka jede čistě na ESPN.

Bezplatný tarif má 100 dotazů/den, což na rozpisy stačí (jeden dotaz vrátí
VŠECHNY ligy daného dne), ale ne na kurzy – ty se tahají zvlášť a stránkovaně.
Zápasy z tohohle zdroje proto zatím jedou bez kurzů, tedy jen s odhadem
modelu a bez value sázek. Appka si kurzy nikdy nevymýšlí.
"""

import datetime as _dt
import time

import requests

from . import storage

BASE = "https://v3.football.api-sports.io"
TIMEOUT = 12
DAY_TTL = 6 * 3600        # rozpis jednoho dne se drží 6 h (šetří kvótu)
DAILY_BUDGET = 80         # strop dotazů za den – rezerva pod free limitem 100
_STATE_FILE = "apifootball_usage.json"

# Stavy zápasu podle API-Football
_LIVE = {"1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE", "SUSP"}
_DONE = {"FT", "AET", "PEN"}


def get_key() -> str:
    import os
    return ((storage.load("config.json", {}) or {}).get("apifootball_key", "")
            or os.environ.get("APIFOOTBALL_KEY", ""))


def set_key(key: str) -> None:
    cfg = storage.load("config.json", {}) or {}
    cfg["apifootball_key"] = (key or "").strip()
    storage.save("config.json", cfg)


def has_key() -> bool:
    return bool(get_key())


# ---------------------------------------------------------------------------
# Hlídání kvóty – bezplatný tarif má 100 dotazů/den, reset o půlnoci UTC
# ---------------------------------------------------------------------------
def _usage() -> dict:
    st = storage.load(_STATE_FILE, {}) or {}
    today = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")
    if st.get("date") != today:
        st = {"date": today, "used": 0}
    return st


def _bump_usage() -> None:
    st = _usage()
    st["used"] = st.get("used", 0) + 1
    storage.save(_STATE_FILE, st)


def usage_status() -> dict:
    st = _usage()
    used = st.get("used", 0)
    return {"enabled": has_key(), "used_today": used,
            "budget": DAILY_BUDGET, "remaining": max(0, DAILY_BUDGET - used),
            "date": st.get("date")}


def _budget_left() -> bool:
    return _usage().get("used", 0) < DAILY_BUDGET


# ---------------------------------------------------------------------------
# Stahování
# ---------------------------------------------------------------------------
def _get(path: str, params: dict):
    key = get_key()
    if not key or not _budget_left():
        return None
    try:
        r = requests.get(f"{BASE}/{path}", params=params, timeout=TIMEOUT,
                         headers={"x-apisports-key": key})
        _bump_usage()
        if r.status_code != 200:
            return None
        d = r.json()
        # API vrací chyby v těle s HTTP 200 (např. vyčerpaná kvóta, špatný klíč)
        if d.get("errors"):
            return None
        return d.get("response") or []
    except Exception:
        return None


def _to_match(fx: dict, sport: str = "soccer") -> dict:
    """Převod odpovědi API-Football do stejného tvaru, jaký vrací ESPN parser –
    díky tomu s ním model, agent i vyhodnocování pracují beze změny."""
    f = fx.get("fixture") or {}
    lg = fx.get("league") or {}
    tm = fx.get("teams") or {}
    gl = fx.get("goals") or {}
    home, away = tm.get("home") or {}, tm.get("away") or {}
    hn, an = home.get("name"), away.get("name")
    if not hn or not an:
        return None

    iso = f.get("date") or ""          # 2026-08-01T18:00:00+00:00
    try:
        dt = _dt.datetime.fromisoformat(iso).astimezone(_dt.timezone.utc)
        date_s, time_s = dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")
    except Exception:
        date_s, time_s = iso[:10], iso[11:16]

    short = ((f.get("status") or {}).get("short") or "").upper()
    is_live = short in _LIVE
    done = short in _DONE
    hs, as_ = gl.get("home"), gl.get("away")
    if not (done or is_live):
        hs = as_ = None

    return {
        # prefix v slugu je routovací značka – podle něj se pozná, že se zápas
        # má dovyhodnocovat přes tenhle zdroj, ne přes ESPN
        "id": f"apif-{f.get('id')}",
        "sport": sport,
        "slug": f"apif:{lg.get('id')}",
        "league": lg.get("name") or "",
        "country": lg.get("country") or "",
        "home": hn, "away": an,
        "home_id": str(home.get("id") or ""),
        "away_id": str(away.get("id") or ""),
        "date": date_s, "time": time_s,
        "home_score": hs, "away_score": as_,
        "status": (f.get("status") or {}).get("long") or short,
        "live": is_live,
        "real_odds": None,   # kurzy jsou ve free tarifu mimo kvótu (viz docstring)
    }


def fetch_day(date_str: str, sport: str = "soccer") -> list:
    """Všechny zápasy daného dne napříč VŠEMI ligami – jeden dotaz."""
    if not has_key():
        return []
    cache_name = f"apif_{sport}_{date_str}.json"
    cached = storage.load(cache_name, None)
    if cached is not None and not storage.is_cache_stale(cache_name, ttl_hours=DAY_TTL / 3600):
        return cached

    resp = _get("fixtures", {"date": date_str})
    if resp is None:
        return cached or []      # kvóta/chyba → radši stará data než žádná
    out = [m for m in (_to_match(fx, sport) for fx in resp) if m]
    storage.save(cache_name, out)
    return out


def fetch_range(start: str, end: str, sport: str = "soccer") -> list:
    """Zápasy pro rozsah dat. API-Football umí filtrovat jen po dnech, takže
    jeden dotaz na den – proto je strop kvóty důležitý."""
    if not has_key():
        return []
    out = []
    d = start
    while d <= end:
        out.extend(fetch_day(d, sport))
        d = (_dt.date.fromisoformat(d) + _dt.timedelta(days=1)).isoformat()
    return out


def fetch_league_scores(sport: str, slug: str, date_str: str) -> list:
    """Výsledky jedné ligy pro jeden den – pro vyhodnocování sázek.
    Denní rozpis se stejně kešuje celý, takže se jen přefiltruje."""
    if not has_key() or not str(slug).startswith("apif:"):
        return []
    return [m for m in fetch_day(date_str, sport) if m.get("slug") == slug]
