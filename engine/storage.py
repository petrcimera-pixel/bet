# -*- coding: utf-8 -*-
"""Jednoduché ukládání stavu do JSON souborů v ./data."""

import os, json, glob, threading, time
from collections import OrderedDict

_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
_LOCK = threading.Lock()

# In-memory cache klíčovaná podle mtime souboru. Bez ní se velké soubory
# (hlavně tips.json, roste bez omezení – stovky KB až desítky MB po týdnech
# běhu) parsovaly z disku znovu při KAŽDÉM API volání, což pod jedním
# gunicorn workerem na Renderu dokázalo appku zcela ucpat (frontend polluje
# /api/settle/status a dashboard každých 5–30 s).
#
# POZOR: load() vrací PŘÍMOU referenci na cache, ne kopii (deepcopy velkého
# tips.json při každém čtení dvojnásobil paměť i čas a appku na Renderu
# shazoval na OOM). Bezpečné to je proto, že celý kód drží konvenci
# "načti → uprav in-place → hned ulož" (viz tips_db.py, bankroll.py) – mezi
# načtením a uložením se objekt nikdy nezahazuje ani nedrží přes více
# requestů. Čistě čtecí přístupy (filtrování, iterace) objekt nemutují.
#
# LRU s omezenou velikostí, ne obyčejný dict – appka během dne prochází
# desítky/stovky RŮZNÝCH per-liga-den ESPN cache souborů
# (cache_{sport}_{start}_{end}.json, viz data_sources.py), a obyčejný dict
# by je držel v paměti NAVŽDY, i den poté, co appka na daný den/ligu už
# nikdy nesáhne. Na Render free tieru (512 MB) to byl skutečný důvod
# opakovaných OOM pádů dnes. OrderedDict + move_to_end při každém
# přístupu = nejčastěji používané soubory (bankroll.json, tips.json,
# team_ratings.json...) zůstávají "nahoře" a nikdy se nezahodí, zatímco
# staré jednorázové cache soubory se dřív nebo později vytlačí.
_CACHE = OrderedDict()   # name -> (mtime, data)
_CACHE_MAX_ENTRIES = 60


def _path(name: str) -> str:
    return os.path.join(_DIR, name)


def remove_matching(pattern: str) -> int:
    """Smaže soubory v ./data odpovídající glob patternu (např. 'cache_*.json'). Vrací počet smazaných."""
    n = 0
    for f in glob.glob(os.path.join(_DIR, pattern)):
        try:
            os.remove(f)
            n += 1
        except OSError:
            pass
    return n


def _evict_if_needed() -> None:
    while len(_CACHE) > _CACHE_MAX_ENTRIES:
        _CACHE.popitem(last=False)   # nejdéle nepoužitý záznam (LRU)


def load(name: str, default):
    """Pozor na past, kvůli které appka přišla o celou historii arény:
    když čtení selže (nejčastěji proto, že soubor zrovna někdo přepisuje a
    načte se rozepsaný JSON), vrací se `default`. Volající, který si na
    default odpovídá vytvořením prázdného výchozího stavu a hned ho uloží
    (viz virtual_bettors.load_state), tím nenávratně smaže data.

    Proto se tu čtení nejdřív pár × zopakuje a pak sáhne po poslední známé
    dobré verzi z cache. Default se vrací až jako poslední možnost –
    a stavoví volající si navíc musí sami ověřit, že soubor fakt
    neexistuje, než na základě defaultu něco resetují."""
    path = _path(name)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _CACHE.pop(name, None)
        return default          # soubor opravdu není – default je v pořádku

    cached = _CACHE.get(name)
    if cached and cached[0] == mtime:
        _CACHE.move_to_end(name)
        return cached[1]

    # utf-8-sig: soubory upravené externě (PowerShell) mohou mít BOM
    # Krátký retry: nejčastější příčina selhání je souběžný zápis (jiný
    # proces/vlákno zrovna soubor přepisuje), což trvá desítky milisekund.
    posledni_chyba = None
    for pokus in range(3):
        try:
            with open(path, encoding="utf-8-sig") as f:
                data = json.load(f)
            break
        except Exception as e:
            posledni_chyba = e
            if pokus < 2:
                time.sleep(0.15)
    else:
        data = None

    if posledni_chyba is not None and data is None:
        # Radši vrátit poslední známou dobrou verzi než default – rozdíl
        # mezi "trochu zastaralá data" a "smazaná historie" je zásadní.
        if cached:
            print(f"[storage] {name}: čtení selhalo ({posledni_chyba}), "
                  f"používám poslední načtenou verzi z cache")
            _CACHE.move_to_end(name)
            return cached[1]
        # Bez cache nezbývá než default. NEVYHAZUJEME výjimku – u kešovaných
        # ESPN souborů je poškozený obsah běžná věc a znamená jen "načti
        # znovu". Ochrana cenných stavových souborů proti přepsání prázdným
        # výchozím stavem je u volajícího (viz virtual_bettors.load_state,
        # který si existenci souboru ověřuje sám).
        print(f"[storage] {name}: čtení selhalo ({posledni_chyba}), vracím default")
        return default

    _CACHE[name] = (mtime, data)
    _CACHE.move_to_end(name)
    _evict_if_needed()
    return data


def save(name: str, data) -> None:
    with _LOCK:
        os.makedirs(_DIR, exist_ok=True)
        tmp = _path(name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(name))
        # rovnou naplň cache aktuálním mtime, ať následující load() ve stejném
        # requestu nemusí znovu číst z disku
        try:
            _CACHE[name] = (os.path.getmtime(_path(name)), data)
            _CACHE.move_to_end(name)
            _evict_if_needed()
        except OSError:
            _CACHE.pop(name, None)


def get_cache_mtime(name: str) -> float:
    """Vrací čas poslední modifikace cache souboru, nebo 0 pokud soubor neexistuje."""
    try:
        return os.path.getmtime(_path(name))
    except OSError:
        return 0


def is_cache_stale(name: str, ttl_hours: int = 12) -> bool:
    """Ověřuje zda je cache starší než ttl_hours. Vrací True pokud je cache zastaralá."""
    import time
    mtime = get_cache_mtime(name)
    return time.time() - mtime > ttl_hours * 3600


def cache_stats() -> dict:
    """Stav keše pro diagnostický panel: kolik souborů leží na disku (a
    kolik místa zabírají) vs. kolik jich appka aktuálně drží v paměti
    (LRU, viz _CACHE nahoře). Zápasy appka od data_sources.py drží v
    match_store.py (SQLite, po dnech) – ten se počítá zvlášť."""
    disk_files, disk_bytes = 0, 0
    for pat in ("apif_*.json",):   # cache_*.json nahradilo match_store.py
        for f in glob.glob(os.path.join(_DIR, pat)):
            disk_files += 1
            try:
                disk_bytes += os.path.getsize(f)
            except OSError:
                pass
    try:
        from . import match_store
        zapasy = match_store.stats()
    except Exception:
        zapasy = {"days": 0, "matches": 0, "db_bytes": 0}
    return {
        "memory_entries": len(_CACHE),
        "memory_max_entries": _CACHE_MAX_ENTRIES,
        "disk_files": disk_files,
        "disk_bytes": disk_bytes,
        "match_store": zapasy,
    }


def clear_match_caches() -> int:
    """Zahodí keše rozpisů zápasů. Volá se, když se změní zdroj dat – jinak by
    se nově dostupné ligy objevily až po vypršení 12h TTL."""
    n = 0
    for pat in ("apif_*.json",):
        for f in glob.glob(os.path.join(_DIR, pat)):
            try:
                os.remove(f)
                n += 1
            except OSError:
                pass
    try:
        from . import match_store
        n += match_store.clear_all()
    except Exception:
        pass
    _CACHE.clear()
    return n


def cleanup_old_caches(max_age_days: int = 14) -> int:
    """Smaže staré cache soubory a staré dny v match_store.py. Volá se při startu."""
    import time
    cutoff = time.time() - max_age_days * 86400
    n = 0
    for f in glob.glob(os.path.join(_DIR, "apif_*.json")):
        try:
            if os.path.getmtime(f) < cutoff:
                os.remove(f)
                n += 1
        except OSError:
            pass
    try:
        from . import match_store
        n += match_store.cleanup_old(max_age_days=21)
    except Exception:
        pass
    return n
