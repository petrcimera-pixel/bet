# -*- coding: utf-8 -*-
"""
Trvalé úložiště dat přes GitHub Gist – řeší efemérní disk na Render.com.

Render při každém deployi/restartu resetuje soubory na stav z GitHub repa,
takže sázky, bank i historie tipů by se ztratily. Tento modul je zálohuje
do privátního GitHub Gistu a při startu obnovuje.

Aktivace: nastav env proměnné
    GITHUB_TOKEN  – personal access token se scope "gist"
    GIST_ID       – ID existujícího gistu (vytvoř prázdný gist ručně)

Bez těchto proměnných modul nic nedělá (lokální běh je nepotřebuje).
"""

import hashlib
import json
import os
import threading
import time

import requests

from . import storage

# Soubory, které se zálohují (runtime stav – NE cache, ta se dopočítá)
FILES = ["bankroll.json", "tips.json", "settings.json", "team_ratings.json",
         "calibration.json", "config.json", "learning_metrics.json",
         "agent_last_run.json", "virtual_bettors.json"]
# JSONL soubory (řádkový formát, ne JSON) – zálohují se jako syrový text,
# ne přes storage.load/save (ten by je parsoval jako JSON a spadl). Bez
# tohoto se ML learner (engine/ml_learner.py) trénovací log ztrácel při
# každém Render deployi, protože nebyl zálohovaný vůbec.
RAW_FILES = ["data/agent_feedback.jsonl"]
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
META = "persist_meta.json"     # {"pushed_at": ts} – rozhoduje, čí data jsou novější
_INTERVAL = 300                # push každých 5 minut (když se něco změnilo)
_API = "https://api.github.com/gists/{gist_id}"

_last_hash = None


def _cfg():
    return os.environ.get("GITHUB_TOKEN", ""), os.environ.get("GIST_ID", "")


def enabled() -> bool:
    token, gist = _cfg()
    return bool(token and gist)


def _headers(token):
    return {"Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json"}


def _raw_path(name: str) -> str:
    return os.path.join(_ROOT, name)


def _local_snapshot() -> dict:
    """Obsah sledovaných souborů (jen existující, neprázdné)."""
    out = {}
    for name in FILES:
        data = storage.load(name, None)
        if data is not None:
            out[name] = json.dumps(data, ensure_ascii=False)
    for name in RAW_FILES:
        try:
            with open(_raw_path(name), encoding="utf-8-sig") as f:
                content = f.read()
            if content.strip():
                out[name] = content
        except OSError:
            pass
    return out


def _snapshot_hash(snap: dict) -> str:
    h = hashlib.sha256()
    for name in sorted(snap):
        h.update(name.encode())
        h.update(snap[name].encode("utf-8"))
    return h.hexdigest()


def restore() -> int:
    """Při startu: pokud má gist NOVĚJŠÍ data než lokální disk, obnov je.
    (Po deployi na Render jsou lokální soubory staré kopie z repa.)
    Vrací počet obnovených souborů."""
    token, gist_id = _cfg()
    if not enabled():
        return 0

    try:
        r = requests.get(_API.format(gist_id=gist_id), headers=_headers(token), timeout=20)
        r.raise_for_status()
        files = r.json().get("files") or {}
    except Exception as e:
        print(f"[persist] Obnova z gistu selhala: {e}")
        return 0

    def _content(fname):
        f = files.get(fname)
        if not f:
            return None
        c = f.get("content")
        if f.get("truncated") and f.get("raw_url"):
            try:
                c = requests.get(f["raw_url"], timeout=30).text
            except Exception:
                return None
        return c

    meta_raw = _content(META)
    try:
        gist_ts = json.loads(meta_raw).get("pushed_at", 0) if meta_raw else 0
    except Exception:
        gist_ts = 0
    local_ts = (storage.load(META, {}) or {}).get("pushed_at", 0)
    if gist_ts <= local_ts:
        return 0   # lokální data jsou stejně stará nebo novější – nech je

    n = 0
    for name in FILES:
        raw = _content(name)
        if raw is None:
            continue
        try:
            storage.save(name, json.loads(raw))
            n += 1
        except Exception:
            pass
    for name in RAW_FILES:
        raw = _content(name)
        if raw is None:
            continue
        try:
            path = _raw_path(name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(raw)
            n += 1
        except Exception:
            pass
    storage.save(META, {"pushed_at": gist_ts})
    print(f"[persist] Obnoveno {n} souborů z gistu (záloha z {time.strftime('%d.%m. %H:%M', time.localtime(gist_ts))})")
    return n


def push(force: bool = False, extra_files: dict = None) -> bool:
    """Nahraje aktuální stav do gistu (jen když se od minula změnil).
    force=True přeskočí kontrolu změny (použito při jednorázovém resetu).
    extra_files přibalí do stejného PATCH requestu (např. reset marker)."""
    global _last_hash
    token, gist_id = _cfg()
    if not enabled():
        return False
    snap = _local_snapshot()
    if not snap and not extra_files:
        return False
    h = _snapshot_hash(snap)
    if h == _last_hash and not force:
        return False   # beze změny – šetři API kvótu
    now = int(time.time())
    payload = {"files": {name: {"content": content} for name, content in snap.items()}}
    payload["files"][META] = {"content": json.dumps({"pushed_at": now})}
    for name, content in (extra_files or {}).items():
        payload["files"][name] = {"content": content}
    try:
        r = requests.patch(_API.format(gist_id=gist_id), headers=_headers(token),
                           json=payload, timeout=30)
        r.raise_for_status()
    except Exception as e:
        print(f"[persist] Push do gistu selhal: {e}")
        return False
    _last_hash = h
    storage.save(META, {"pushed_at": now})
    return True


def sync_loop():
    """Background smyčka: každých 5 min zálohuj změněná data do gistu."""
    if not enabled():
        return
    time.sleep(60)   # po startu chvíli počkej (probíhá prewarm/restore)
    while True:
        try:
            if push():
                print("[persist] Data zazálohována do gistu")
        except Exception as e:
            print(f"[persist] Chyba: {e}")
        time.sleep(_INTERVAL)


def _restore_then_loop():
    try:
        restore()
    except Exception as e:
        print(f"[persist] {e}")
    sync_loop()


def start():
    """Obnova při startu + spuštění zálohovací smyčky – VŠE v jednom
    background threadu. restore() dělá síťová volání na GitHub API (mohou
    trvat několik sekund) – pokud by běžela synchronně při importu modulu
    (jak dělal gunicorn worker na Renderu), blokovala by start appky natolik,
    že Render mohl health-check vyhodnotit jako selhaný a worker opakovaně
    restartovat, ještě než appka stihla přijmout první request."""
    if not enabled():
        return
    threading.Thread(target=_restore_then_loop, daemon=True).start()


def status() -> dict:
    return {
        "enabled": enabled(),
        "last_push": (storage.load(META, {}) or {}).get("pushed_at"),
        "files": FILES + RAW_FILES,
    }
