# -*- coding: utf-8 -*-
"""
Volitelné napojení na REÁLNÉ kurzy přes The Odds API (the-odds-api.com).

Bez API klíče se nic nemění – aplikace jede na modelovaných kurzech.
Když uživatel vloží svůj (bezplatný) klíč v Nastavení banku, stáhnou se
živé kurzy více sázkovek a u odpovídajících zápasů se jimi nahradí
modelovaný panel (value se pak počítá proti SKUTEČNÝM kurzům).

Pozn.: The Odds API vyžaduje bezplatnou registraci kvůli API klíči.
"""

import re
import time
import requests

from . import storage

BASE = "https://api.the-odds-api.com/v4"
TIMEOUT = 12
CACHE_TTL = 3600         # živé kurzy se kešují 1 hodinu (free kvóta = 500 dotazů/měsíc)
_CACHE = {}

# ESPN sport → sport key(y) The Odds API (skupinové „upcoming" pokrývá vše)
_SPORT_GROUP = {
    "soccer": "soccer", "basketball": "basketball",
    "hockey": "icehockey", "football": "americanfootball",
}


def get_key() -> str:
    import os
    return ((storage.load("config.json", {}) or {}).get("odds_api_key", "")
            or os.environ.get("ODDS_API_KEY", ""))


def set_key(key: str) -> None:
    cfg = storage.load("config.json", {}) or {}
    cfg["odds_api_key"] = (key or "").strip()
    storage.save("config.json", cfg)
    _CACHE.clear()


def has_key() -> bool:
    return bool(get_key())


def _norm(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"\b(fc|cf|sc|afc|ac|club|cd|sv|us|if|bk)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def _match_key(home: str, away: str) -> str:
    return _norm(home) + "|" + _norm(away)


def fetch_index(sport: str) -> dict:
    """Vrátí index {normalizované 'home|away' → [ {name, odds:{home,draw,away}} ]}."""
    key = get_key()
    if not key:
        return {}
    now = time.time()
    cached = _CACHE.get(sport)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]

    # Disková keš přežije restart serveru – bez ní každý restart pálil kvótu znovu
    disk_name = f"odds_cache_{sport}.json"
    if not storage.is_cache_stale(disk_name, ttl_hours=1):
        disk = storage.load(disk_name, None)
        if disk is not None:
            _CACHE[sport] = (now, disk)
            return disk

    group = _SPORT_GROUP.get(sport, "soccer")
    url = f"{BASE}/sports/{group}/odds"
    try:
        r = requests.get(url, params={
            "apiKey": key, "regions": "eu,uk", "markets": "h2h",
            "oddsFormat": "decimal"}, timeout=TIMEOUT)
        r.raise_for_status()
        events = r.json()
    except Exception:
        # když dotaz selže (vyčerpaná kvóta…), použij i starší diskovou keš
        disk = storage.load(disk_name, None)
        if disk is not None:
            _CACHE[sport] = (now, disk)
            return disk
        return {}

    index = {}
    for ev in events:
        home, away = ev.get("home_team"), ev.get("away_team")
        if not home or not away:
            continue
        books = []
        for bk in ev.get("bookmakers", []):
            h2h = next((m for m in bk.get("markets", []) if m.get("key") == "h2h"), None)
            if not h2h:
                continue
            o = {}
            for oc in h2h.get("outcomes", []):
                nm = oc.get("name")
                if nm == home:
                    o["home"] = oc.get("price")
                elif nm == away:
                    o["away"] = oc.get("price")
                elif nm == "Draw":
                    o["draw"] = oc.get("price")
            if "home" in o and "away" in o:
                books.append({"name": bk.get("title", "?"), "sharp": False, "odds": o})
        if books:
            index[_match_key(home, away)] = books
    _CACHE[sport] = (now, index)
    storage.save(f"odds_cache_{sport}.json", index)
    return index


def lookup(index: dict, home: str, away: str):
    """Najde reálné kurzy pro zápas (s tolerancí na drobné rozdíly v názvech)."""
    if not index:
        return None
    k = _match_key(home, away)
    if k in index:
        return index[k]
    nh, na = _norm(home), _norm(away)
    for mk, books in index.items():
        ih, ia = mk.split("|")
        if (nh in ih or ih in nh) and (na in ia or ia in na):
            return books
    return None
