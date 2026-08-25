# -*- coding: utf-8 -*-
"""Keš stažených zápasů klíčovaná PO JEDNOTLIVÝCH DNECH, v SQLite.

Dřív (viz git historie data_sources.py) byla keš jeden JSON soubor na
CELÝ ROZSAH dat (cache_soccer_2026-08-24_2026-08-27.json apod.). Appka ale
o zápasy žádá v překrývajících se oknech z různých karet – dashboard chce
1 den, Doporučené 3 dny × 3 sporty, Hledat 14 dní, prewarm 3 dny – a
každé jiné okno bylo úplně jiný soubor, i když se dny ve skutečnosti
z 90 % překrývaly. Stejný den se tak z ESPN stahoval znovu a znovu podle
toho, kdo se zrovna ptal, a to byla hlavní příčina zbytečného provozu
(a na Render free tieru přímo příčina překročení měsíčního limitu).

Tenhle modul ukládá zápasy PO DNI: jeden den = jeden řádek v tabulce
`days` (kdy byl naposledy stažen) + N řádků v tabulce `matches`. Dotaz na
libovolný rozsah dat pak zjistí, které dny v tom rozsahu chybí nebo jsou
zastaralé, dotáhne JEN ty (sloučené do souvislých úseků, ať se šetří počet
ESPN volání) a zbytek vezme z databáze bez jediného síťového požadavku.

SQLite je zvolené záměrně místo dalšího JSON souboru: potřebujeme rychlé
"který z těchto 14 dní chybí" dotazy a souběžný přístup z několika vláken
(request thready, settle smyčka, prewarm) bez ručního zamykání souboru –
přesně na tohle je SQLite s WAL režimem stavěné, a je to součást standardní
knihovny Pythonu, takže nepřidává žádnou závislost.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import threading
import time

from . import storage

_DB_PATH = os.path.join(storage._DIR, "matches.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS days (
    sport TEXT NOT NULL,
    date TEXT NOT NULL,
    fetched_at REAL NOT NULL,
    PRIMARY KEY (sport, date)
);
CREATE TABLE IF NOT EXISTS matches (
    sport TEXT NOT NULL,
    date TEXT NOT NULL,
    match_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (sport, date, match_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_day ON matches(sport, date);
"""

_init_lock = threading.Lock()
_initialized = False


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_DB_PATH, timeout=15, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")   # čtenáři nečekají na zapisovatele
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _ensure_schema() -> None:
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        conn = _connect()
        try:
            conn.executescript(_SCHEMA)
            conn.commit()
            if not conn.execute("SELECT 1 FROM days LIMIT 1").fetchone():
                _migrate_stare_keše(conn)
        finally:
            conn.close()
        _initialized = True


_STARY_NAZEV = re.compile(r"^cache_([a-z]+)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.json$")


def _migrate_stare_keše(conn: sqlite3.Connection) -> None:
    """Jednorázově naimportuje staré JSON keše do nové databáze, ať přechod
    na nový formát neznamená hned po nasazení hromadné znovustažení všeho
    z ESPN. Volá se jen když je databáze úplně prázdná (první spuštění po
    aktualizaci)."""
    try:
        soubory = glob.glob(os.path.join(storage._DIR, "cache_*.json"))
        dny = {}   # (sport, date) -> [fetched_at, {match_id: data}]
        for f in soubory:
            m = _STARY_NAZEV.match(os.path.basename(f))
            if not m:
                continue
            sport = m.group(1)
            try:
                mtime = os.path.getmtime(f)
                with open(f, encoding="utf-8-sig") as fh:
                    matches = json.load(fh)
            except Exception:
                continue
            for mm in matches or []:
                d = mm.get("date")
                mid = mm.get("id")
                if not d or not mid:
                    continue
                klic = (sport, d)
                if klic not in dny:
                    dny[klic] = [mtime, {}]
                dny[klic][0] = max(dny[klic][0], mtime)
                dny[klic][1][mid] = mm
        for (sport, d), (fetched_at, matches_by_id) in dny.items():
            conn.execute("INSERT OR REPLACE INTO days (sport, date, fetched_at) VALUES (?,?,?)",
                        (sport, d, fetched_at))
            for mid, mm in matches_by_id.items():
                conn.execute(
                    "INSERT OR REPLACE INTO matches (sport, date, match_id, data) VALUES (?,?,?,?)",
                    (sport, d, mid, json.dumps(mm, ensure_ascii=False)))
        conn.commit()
    except Exception:
        pass   # migrace nesmí nikdy zablokovat start – v horším případě se prostě vše stáhne znovu


def stale_or_missing(sport: str, dates: list, ttl_hours: float) -> list:
    """Dny z `dates`, které v databázi buď vůbec nejsou, nebo jsou starší
    než ttl_hours. Pořadí zachováno."""
    _ensure_schema()
    if not dates:
        return []
    cutoff = time.time() - ttl_hours * 3600
    conn = _connect()
    try:
        placeholders = ",".join("?" * len(dates))
        radky = conn.execute(
            f"SELECT date, fetched_at FROM days WHERE sport=? AND date IN ({placeholders})",
            (sport, *dates)).fetchall()
        cerstve = {d for d, fa in radky if fa >= cutoff}
        return [d for d in dates if d not in cerstve]
    finally:
        conn.close()


def get_days(sport: str, dates: list) -> list:
    """Všechny zápasy pro dané dny, seřazené dle data/času. Dny, které v DB
    nejsou vůbec, prostě nic nepřidají – volající si o jejich stažení musí
    říct sám přes stale_or_missing()."""
    _ensure_schema()
    if not dates:
        return []
    conn = _connect()
    try:
        placeholders = ",".join("?" * len(dates))
        radky = conn.execute(
            f"SELECT data FROM matches WHERE sport=? AND date IN ({placeholders})",
            (sport, *dates)).fetchall()
        out = [json.loads(r[0]) for r in radky]
        out.sort(key=lambda m: (m.get("date", ""), m.get("time", "")))
        return out
    finally:
        conn.close()


def save_days(sport: str, dates: list, matches: list) -> None:
    """Uloží zápasy pro DANÝ ROZSAH DNŮ a označí VŠECHNY tyto dny jako právě
    stažené – i ty, pro které matches žádný zápas neobsahuje. Bez tohohle by
    den bez zápasů (běžné mimo sezónu/o svátcích) vypadal navždy jako
    "nestažený" a appka by ho zkoušela stáhnout znovu při každém dotazu."""
    _ensure_schema()
    if not dates:
        return
    now = time.time()
    podle_dne = {}
    dates_set = set(dates)
    for m in matches:
        d = m.get("date")
        mid = m.get("id")
        if not d or not mid or d not in dates_set:
            continue
        podle_dne.setdefault(d, {})[mid] = m
    conn = _connect()
    try:
        for d in dates:
            conn.execute("INSERT OR REPLACE INTO days (sport, date, fetched_at) VALUES (?,?,?)",
                        (sport, d, now))
            conn.execute("DELETE FROM matches WHERE sport=? AND date=?", (sport, d))
            for mid, mm in podle_dne.get(d, {}).items():
                conn.execute(
                    "INSERT OR REPLACE INTO matches (sport, date, match_id, data) VALUES (?,?,?,?)",
                    (sport, d, mid, json.dumps(mm, ensure_ascii=False)))
        conn.commit()
    finally:
        conn.close()


def clear_all() -> int:
    """Zahodí celou keš (např. při změně zdroje dat). Vrací počet smazaných dnů."""
    _ensure_schema()
    conn = _connect()
    try:
        n = conn.execute("SELECT COUNT(*) FROM days").fetchone()[0]
        conn.execute("DELETE FROM days")
        conn.execute("DELETE FROM matches")
        conn.commit()
        return n
    finally:
        conn.close()


def cleanup_old(max_age_days: int = 21) -> int:
    """Smaže dny starší než max_age_days (podle DATA zápasu, ne podle toho,
    kdy se stáhly) – appka se dopředu ptá nanejvýš 14 dní, zpětně prakticky
    vůbec, takže starší dny už nikdo nežádá."""
    _ensure_schema()
    from .data_sources import add_days
    cutoff = add_days(time.strftime("%Y-%m-%d"), -max_age_days)
    conn = _connect()
    try:
        n = conn.execute("SELECT COUNT(*) FROM days WHERE date < ?", (cutoff,)).fetchone()[0]
        conn.execute("DELETE FROM days WHERE date < ?", (cutoff,))
        conn.execute("DELETE FROM matches WHERE date < ?", (cutoff,))
        conn.commit()
        return n
    finally:
        conn.close()


def stats() -> dict:
    _ensure_schema()
    conn = _connect()
    try:
        n_days = conn.execute("SELECT COUNT(*) FROM days").fetchone()[0]
        n_matches = conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
        try:
            db_bytes = os.path.getsize(_DB_PATH)
        except OSError:
            db_bytes = 0
        return {"days": n_days, "matches": n_matches, "db_bytes": db_bytes}
    finally:
        conn.close()
