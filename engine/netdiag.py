# -*- coding: utf-8 -*-
"""
Diagnostika síťové dostupnosti serveru (Windows).

Když appka běží jako domácí server, na připojení z jiného zařízení musí sedět
tři věci najednou. Stačí jedna špatně a spojení mlčky nefunguje, aniž by bylo
z čeho poznat proč:

  1. server naslouchá na 0.0.0.0 (ne jen na 127.0.0.1)
  2. ve firewallu je puštěný port
  3. síť je označená jako Soukromá – pravidlo se totiž kvůli bezpečnosti
     přidává jen pro soukromý profil, na Veřejné síti neplatí

Tenhle modul to zjistí a umí i navrhnout/provést opravu.
"""

import os
import subprocess

RULE_NAME = "KurzAnalytik"


def _ps(script: str, timeout: int = 20):
    """Spustí PowerShell a vrátí (ok, výstup). Na jiných systémech než Windows
    tiše selže – diagnostika je záměrně jen doplněk, nesmí nic shodit."""
    if os.name != "nt":
        return False, "jen pro Windows"
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode == 0, (r.stdout or r.stderr or "").strip()
    except Exception as e:
        return False, str(e)


def is_admin() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def firewall_rule() -> dict:
    ok, out = _ps(
        f"$r = Get-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue; "
        "if ($r) { ($r | Select-Object -First 1).Enabled } else { 'MISSING' }")
    if not ok:
        return {"known": False, "exists": False, "enabled": False}
    val = (out or "").strip()
    return {"known": True, "exists": val != "MISSING",
            "enabled": val.lower() in ("true", "1", "enabled")}


def network_profiles() -> list:
    ok, out = _ps(
        "Get-NetConnectionProfile | ForEach-Object "
        "{ $_.InterfaceAlias + '|' + $_.NetworkCategory }")
    if not ok or not out:
        return []
    res = []
    for line in out.splitlines():
        if "|" in line:
            alias, cat = line.split("|", 1)
            res.append({"interface": alias.strip(), "category": cat.strip()})
    return res


_CACHE = {}
CACHE_TTL = 120


def diagnose(bind_host: str, port: int, force: bool = False) -> dict:
    """Souhrn: co je v pořádku, co brání připojení a jak to spravit.

    Výsledek se cachuje – každé volání spouští tři PowerShelly a trvá
    kolem šesti sekund, což by jinak zdrželo načtení Nastavení. Stav sítě
    se navíc mění zřídka; po opravě si autofix() cache sám zahodí."""
    import time as _t
    key = (bind_host, port)
    hit = _CACHE.get(key)
    if hit and not force and _t.time() - hit[0] < CACHE_TTL:
        return hit[1]
    res = _diagnose_uncached(bind_host, port)
    _CACHE[key] = (_t.time(), res)
    return res


def _diagnose_uncached(bind_host: str, port: int) -> dict:
    listening_all = bind_host in ("0.0.0.0", "::")
    fw = firewall_rule()
    profiles = network_profiles()
    public = [p for p in profiles if p["category"].lower() == "public"]

    problems = []
    if not listening_all:
        problems.append({
            "key": "bind",
            "text": f"Server naslouchá jen na {bind_host}, takže je dostupný pouze "
                    "z tohoto počítače.",
            "fix": "Spouštěj ho přes deploy\\run_server.bat (nastaví HOST=0.0.0.0), "
                   "nebo si ho nainstaluj jako službu instalátorem.",
            "auto": False,
        })
    if fw["known"] and not fw["exists"]:
        problems.append({
            "key": "firewall",
            "text": f"Ve firewallu chybí pravidlo pro port {port} – Windows spojení zvenčí zahodí.",
            "fix": f"Přidat pravidlo pro port {port} (jen soukromá/doménová síť).",
            "auto": True,
        })
    elif fw["known"] and fw["exists"] and not fw["enabled"]:
        problems.append({
            "key": "firewall_disabled",
            "text": "Pravidlo firewallu existuje, ale je vypnuté.",
            "fix": "Zapnout pravidlo.",
            "auto": True,
        })
    if public:
        names = ", ".join(p["interface"] for p in public)
        problems.append({
            "key": "public_profile",
            "text": f"Síť „{names}“ je označená jako Veřejná. Pravidlo firewallu se "
                    "kvůli bezpečnosti přidává jen pro soukromou síť, takže na veřejné neplatí.",
            "fix": "Přepnout síť na Soukromou (Nastavení → Síť a internet → Wi-Fi → "
                   "vlastnosti sítě → Soukromá).",
            "auto": True,
        })

    return {
        "ok": not problems,
        "is_admin": is_admin(),
        "listening_all": listening_all,
        "firewall": fw,
        "profiles": profiles,
        "problems": problems,
        "can_autofix": any(p["auto"] for p in problems),
    }


def autofix(port: int, set_private: bool = True) -> dict:
    """Zkusí opravit firewall a profil sítě. Vyžaduje práva správce – bez nich
    to Windows odmítne a vrátíme to na rovinu, ne tiché selhání."""
    if os.name != "nt":
        return {"ok": False, "error": "Automatická oprava funguje jen na Windows."}
    _CACHE.clear()   # po zásahu už uložený stav neplatí
    if not is_admin():
        return {"ok": False, "needs_admin": True,
                "error": "Na změnu firewallu a profilu sítě jsou potřeba práva správce. "
                         "Spusť aplikaci (nebo instalátor) jako správce."}
    done, errors = [], []

    ok, out = _ps(
        f"Remove-NetFirewallRule -DisplayName '{RULE_NAME}' -ErrorAction SilentlyContinue; "
        f"New-NetFirewallRule -DisplayName '{RULE_NAME}' -Direction Inbound -Action Allow "
        f"-Protocol TCP -LocalPort {int(port)} -Profile Private,Domain | Out-Null; 'OK'")
    if ok:
        done.append(f"Ve firewallu je puštěný port {port} (jen soukromá a doménová síť).")
        # ping je první věc, kterou člověk při hledání chyby zkusí – ať nelže
        _ps(f"Remove-NetFirewallRule -DisplayName '{RULE_NAME} ping' -ErrorAction SilentlyContinue; "
            f"New-NetFirewallRule -DisplayName '{RULE_NAME} ping' -Direction Inbound -Action Allow "
            "-Protocol ICMPv4 -IcmpType 8 -Profile Private,Domain | Out-Null; 'OK'")
    else:
        errors.append(f"Pravidlo firewallu se nepodařilo přidat: {out}")

    if set_private:
        ok2, out2 = _ps(
            "$c = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }; "
            "if ($c) { $c | Set-NetConnectionProfile -NetworkCategory Private; "
            "($c | ForEach-Object { $_.InterfaceAlias }) -join ', ' } else { 'NONE' }")
        if ok2:
            if (out2 or "").strip() != "NONE":
                done.append(f"Síť přepnuta na Soukromou: {out2.strip()}")
        else:
            errors.append(f"Profil sítě se nepodařilo přepnout: {out2}")

    return {"ok": not errors, "done": done, "errors": errors}
