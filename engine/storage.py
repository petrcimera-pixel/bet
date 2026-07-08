# -*- coding: utf-8 -*-
"""Jednoduché ukládání stavu do JSON souborů v ./data."""

import os, json, glob, threading

_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
_LOCK = threading.Lock()


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


def load(name: str, default):
    # utf-8-sig: soubory upravené externě (PowerShell) mohou mít BOM
    try:
        with open(_path(name), encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def save(name: str, data) -> None:
    with _LOCK:
        os.makedirs(_DIR, exist_ok=True)
        tmp = _path(name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _path(name))


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
