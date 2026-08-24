# -*- coding: utf-8 -*-
"""Živý log toho, co appka právě dělá – kruhový buffer v paměti.

Appka toho hodně dělá na pozadí (vyhodnocování výsledků, kola sázkařů,
retrain modelu, zálohy), ale jediná stopa byla v server.log, ke kterému
se z prohlížeče nedostaneš. Tenhle modul totéž drží i v paměti, aby to
šlo číst přes API a sledovat živě v appce.

Nic se nikde neinstrumentuje: příchytka se zavěsí na sys.stdout/stderr a
na logging, takže zachytí VŠECHNY existující print() i HTTP požadavky
z Werkzeugu. Původní výstup jde dál na konzoli a do server.log beze změny.

Kategorie se bere z prefixu, který už appka používá ("[settle_bg] ...").
"""
from __future__ import annotations

import logging
import re
import sys
import threading
import time
from collections import deque

MAX_ZAZNAMU = 800          # ~pár hodin běžného provozu, strop kvůli paměti
_BUFFER: deque = deque(maxlen=MAX_ZAZNAMU)
_LOCK = threading.Lock()
_SEQ = 0                   # roste navždy, klient si podle něj řekne o nové

_PREFIX = re.compile(r"^\[([a-zA-Z0-9_.-]+)\]\s*(.*)$", re.S)
# Werkzeug: '127.0.0.1 - - [24/Aug/2026 00:37:12] "GET /api/x HTTP/1.1" 200 -'
_HTTP = re.compile(r'"(?P<metoda>[A-Z]+) (?P<cesta>\S+) HTTP/[\d.]+" (?P<kod>\d{3})')
# Werkzeug si výstup barví ANSI sekvencemi; bez odstranění se regexy výš
# netrefí a řádek pak spadne do kategorie "app" i s neviditelnými znaky.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
# Vlastní čtení logu se nezaznamenává – prohlížeč se ptá každé 2 s, takže
# by log během chvilky nebyl nic než záznamy o tom, že se čte log.
_NELOGOVAT = ("/api/log",)

_CHYBA = ("traceback", "exception", "chyba", "selhal", "error", "failed")
_VAROVANI = ("warning", "varov", "pozor", "přeskoč", "preskoc", "odmítám", "odmitam")


def _uroven(text: str) -> str:
    t = text.lower()
    if any(s in t for s in _CHYBA):
        return "chyba"
    if any(s in t for s in _VAROVANI):
        return "varovani"
    return "info"


def zaznam(text: str, kategorie: str = None, uroven: str = None) -> None:
    """Přidá řádek do živého logu. Volá se i automaticky z příchytek."""
    text = _ANSI.sub("", (text or "")).rstrip()
    if not text:
        return
    kat = kategorie
    if kat is None:
        m = _PREFIX.match(text)
        if m:
            kat, text = m.group(1), m.group(2)
        else:
            kat = "app"
    # HTTP požadavky se zkrátí na to podstatné – celý řádek Werkzeugu je
    # z 80 % časové razítko a verze protokolu.
    h = _HTTP.search(text)
    if h:
        cesta = h.group("cesta")
        if any(cesta.startswith(p) for p in _NELOGOVAT):
            return
        kat = "http"
        text = f"{h.group('metoda')} {cesta} → {h.group('kod')}"
        uroven = uroven or ("chyba" if h.group("kod")[0] in "45" else "info")

    global _SEQ
    with _LOCK:
        _SEQ += 1
        _BUFFER.append({
            "seq": _SEQ,
            "ts": time.time(),
            "kat": kat,
            "uroven": uroven or _uroven(text),
            "text": text[:1000],      # ať jeden splašený výpis nezabere vše
        })


def zaznamy(od_seq: int = 0, limit: int = 400) -> dict:
    """Záznamy novější než od_seq (0 = od začátku bufferu)."""
    with _LOCK:
        vybrane = [z for z in _BUFFER if z["seq"] > od_seq][-limit:]
        posledni = _BUFFER[-1]["seq"] if _BUFFER else 0
        celkem = len(_BUFFER)
    return {"zaznamy": vybrane, "posledni_seq": posledni,
            "v_bufferu": celkem, "strop": MAX_ZAZNAMU}


def kategorie() -> list:
    with _LOCK:
        return sorted({z["kat"] for z in _BUFFER})


class _Odbocka:
    """Průchozí obal streamu: zapíše dál a zároveň si řádek uloží.

    Píše se po částech, ne po řádcích, takže se text drží v mezipaměti,
    dokud nepřijde konec řádku – jinak by se jedna zpráva rozpadla na
    několik útržků.
    """

    def __init__(self, puvodni):
        self._puvodni = puvodni
        self._zbytek = ""

    def write(self, data):
        try:
            self._puvodni.write(data)
        except Exception:
            pass
        try:
            self._zbytek += data
            while "\n" in self._zbytek:
                radek, self._zbytek = self._zbytek.split("\n", 1)
                zaznam(radek)
        except Exception:
            self._zbytek = ""      # log nesmí nikdy shodit appku
        return len(data)

    def flush(self):
        try:
            self._puvodni.flush()
        except Exception:
            pass

    def isatty(self):
        try:
            return self._puvodni.isatty()
        except Exception:
            return False

    def __getattr__(self, name):
        return getattr(self._puvodni, name)


class _LogHandler(logging.Handler):
    """Zachytí i to, co jde přes logging (hlavně HTTP log Werkzeugu)."""

    def emit(self, record):
        try:
            uroven = {logging.ERROR: "chyba", logging.CRITICAL: "chyba",
                      logging.WARNING: "varovani"}.get(record.levelno)
            zaznam(self.format(record), uroven=uroven)
        except Exception:
            pass


_zapnuto = False


def zapni() -> None:
    """Zavěsí příchytky. Bezpečné volat opakovaně."""
    global _zapnuto
    if _zapnuto:
        return
    _zapnuto = True
    sys.stdout = _Odbocka(sys.stdout)
    sys.stderr = _Odbocka(sys.stderr)
    h = _LogHandler()
    h.setFormatter(logging.Formatter("%(message)s"))
    for jmeno in ("werkzeug", "waitress"):
        log = logging.getLogger(jmeno)
        log.addHandler(h)
        log.propagate = True
    zaznam("živý log spuštěn", kategorie="boot")
