"""Import zápasů/kurzů z Tipsport.cz.

Tipsport má interní REST API (/rest/offer/v2/offer), které vrací kompletní
strukturovaná data (týmy, skóre, 1X2 kurzy, přesné ID zápasu pro deep-link) -
BEZ přihlášení. Problém: endpoint blokuje požadavky mimo skutečný prohlížeč
(anti-bot ochrana na TLS/hlavičkách) - appka si ho tedy nemůže tahat sama na
pozadí/přes cron. Data se místo toho stahují ručně přes reálný prohlížeč
(Claude/uživatel na tipsport.cz) a jednorázově importují sem přes
/api/tipsport/import. Slouží jako doplňkový zdroj pro porovnání s vlastním
modelem, ne jako náhrada ESPN feedu.
"""
from __future__ import annotations

import time

from engine import storage
from engine.goals_model import _norm_team
from engine import team_aliases

_STORE_FILE = "tipsport_matches.json"
_MAX_ENTRIES = 2000   # ať soubor neroste bez konce při opakovaných importech


def _canon(name: str) -> str:
    """Normalizovaný (bez diakritiky, malými písmeny) název přeložený přes
    team_aliases na kanonickou (ESPN-styl) podobu - "Bayern München" i
    "Bayern Munich" tak dají stejný klíč, ať zápas naimportuje kterýkoli
    zdroj. _norm_team sama diakritiku ořízne, ale nepřevádí na malá písmena
    (jinak by rozbila zobrazované jméno v ratingech) - tady na tom nezáleží,
    jde jen o interní srovnávací klíč."""
    return team_aliases.resolve(_norm_team(name).lower())


def _key(home: str, away: str, date: str) -> str:
    """Klíč pro spárování s vlastními zápasy - kanonický název + den
    (bez času, ten se mezi zdroji často liší o pár minut)."""
    day = (date or "")[:10]
    return f"{_canon(home)}|{_canon(away)}|{day}"


def _load() -> dict:
    return storage.load(_STORE_FILE, {})


def _save(store: dict) -> None:
    if len(store) > _MAX_ENTRIES:
        # nejstarší (podle imported_ts) zahodit
        items = sorted(store.items(), key=lambda kv: kv[1].get("imported_ts", 0))
        store = dict(items[-_MAX_ENTRIES:])
    storage.save(_STORE_FILE, store)


def import_matches(matches: list) -> dict:
    """matches: [{home, away, date, score:{home,away}|None,
    odds:{home,draw,away}|None, competition, url}, ...]
    Vrací {"imported": N, "updated": M}."""
    store = _load()
    now = int(time.time())
    n_new, n_upd = 0, 0
    for m in matches:
        home, away, date = m.get("home"), m.get("away"), m.get("date") or ""
        if not home or not away:
            continue
        key = _key(home, away, date)
        entry = {
            "home": home, "away": away, "date": date,
            "score": m.get("score"), "odds": m.get("odds"),
            "competition": m.get("competition"), "url": m.get("url"),
            "imported_ts": now,
        }
        if key in store:
            n_upd += 1
        else:
            n_new += 1
        store[key] = entry
    _save(store)
    return {"imported": n_new, "updated": n_upd, "total": len(store)}


def lookup(home: str, away: str, date: str) -> dict | None:
    """Najde importovaný Tipsport záznam pro daný zápas (podle názvů týmů
    a dne). Vrací None, pokud appka o tomhle zápase z Tipsportu nic neví."""
    store = _load()
    hit = store.get(_key(home, away, date))
    if hit:
        return hit
    # _canon (přes team_aliases) chytí známé přezdívky/exonyma; zbytek
    # (neznámé zkratky, překlepy) dorazí podřetězcovou shodou nad kanonickými
    # jmény, oběma směry (kratší název bývá podřetězcem delšího).
    day = (date or "")[:10]
    nh, na = _canon(home), _canon(away)

    def _match(a: str, b: str) -> bool:
        return bool(a) and bool(b) and (a in b or b in a)

    for key, entry in store.items():
        if not key.endswith(f"|{day}"):
            continue
        eh, ea = _canon(entry.get("home", "")), _canon(entry.get("away", ""))
        if _match(nh, eh) and _match(na, ea):
            return entry
    return None


def all_matches() -> list:
    return list(_load().values())
