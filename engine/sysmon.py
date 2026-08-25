# -*- coding: utf-8 -*-
"""Živé systémové metriky pro stavovou lištu (RAM/CPU/síť).

Volitelné – appka bez psutil (např. na hostingu, kde se ho nepodařilo
nainstalovat) prostě metriky neukáže, nic jiného na tom nezávisí.

CPU a síť potřebují DVA vzorky, aby dávaly smysl (je to poměr/rozdíl
za uplynulý čas, ne okamžitá hodnota) – proto se drží jeden sdílený
psutil.Process a poslední síťový snapshot mezi voláními. První volání po
startu appky proto vrátí cpu_pct 0.0 a net_* None; teprve druhé a další
volání (další poll ze stavové lišty) už vrátí reálná čísla.
"""
from __future__ import annotations

import threading
import time

try:
    import psutil
    _DOSTUPNY = True
except ImportError:
    _DOSTUPNY = False

_LOCK = threading.Lock()
_proc = None
_posledni_net = None   # (ts, bytes_sent, bytes_recv)


def _proces():
    global _proc
    if _proc is None:
        _proc = psutil.Process()
        _proc.cpu_percent(interval=None)   # zahodit první (vždy 0.0) vzorek
    return _proc


def snapshot() -> dict:
    """{"available": bool, "rss_mb", "cpu_pct", "net_up_kbps", "net_down_kbps"}.
    Síťové hodnoty jsou CELOSYSTÉMOVÉ (psutil neumí spolehlivě per-proces
    napříč platformami) – na lokálním PC je to v pořádku přiblížení k tomu,
    co appka právě stahuje, protože ESPN dotazy jsou naprostá většina provozu
    v okamžiku, kdy něco stahuje."""
    if not _DOSTUPNY:
        return {"available": False}
    try:
        with _LOCK:
            p = _proces()
            rss_mb = round(p.memory_info().rss / (1024 * 1024), 1)
            cpu_pct = p.cpu_percent(interval=None)

            global _posledni_net
            now = time.time()
            io = psutil.net_io_counters()
            net_up = net_down = None
            if _posledni_net is not None:
                t0, sent0, recv0 = _posledni_net
                dt = now - t0
                if dt > 0.5:   # moc krátký interval by dal nesmyslně vysoké kbps
                    net_up = round(max(0, io.bytes_sent - sent0) / dt / 1024, 1)
                    net_down = round(max(0, io.bytes_recv - recv0) / dt / 1024, 1)
            _posledni_net = (now, io.bytes_sent, io.bytes_recv)

        return {
            "available": True,
            "rss_mb": rss_mb,
            "cpu_pct": cpu_pct,
            "net_up_kbps": net_up,
            "net_down_kbps": net_down,
        }
    except Exception:
        return {"available": False}
