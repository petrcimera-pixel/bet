# -*- coding: utf-8 -*-
"""
Pokročilé nastavení aplikace – parametry modelu, vzhled a správa dat.
Ukládá se do data/settings.json. Sázkové/API nastavení (Kelly frakce, měna,
API klíč kurzů) zůstává v bankroll.json / config.json (engine.bankroll /
engine.odds_api) – Nastavení v UI na ně jen odkazuje, ať nevzniká duplicitní stav.
"""

from . import storage

_DEFAULTS = {
    # Poznámka: dřív tu byla i sekce "model" (dc_rho, home_adv, elo_k,
    # rating_to_goals...) – pozůstatek starého Elo enginu (engine/prediction.py,
    # nahrazeného goals-ratio modelem v goals_model.py). Appka ji nikde
    # nečetla ani nezobrazovala v UI, čistě mrtvý kód matoucí pro údržbu -
    # goals_model.py má svoje vlastní konstanty (HOME_ADV_FACTOR, DC_RHO)
    # přímo v sobě, ne přes tohle nastavení.
    "appearance": {
        "theme": "dark",          # dark | light
        "density": "comfortable",  # comfortable | compact
        "accent": "blue",         # blue | violet | green | amber
    },
    "agent": {
        "enabled": False,         # bet agent automaticky sází ostré tipy
        "bet_today": True,        # sázet i na dnešní zápasy (ne jen zítřejší)
        "stake_mode": "kelly",    # "kelly" (doporučeno) | "flat" (plochý vklad)
        "stake": 10.0,            # plochý vklad na 1 tiket (Kč) – použije se jen v režimu "flat"
        "kelly_fraction": 0.25,   # frakční Kelly pro agenta (nezávislé na Kelly frakci banku)
        "max_daily_stake_pct": 0.25,  # strop: max. podíl banku prosázený za 1 kalendářní den
        "only_sharp": True,       # sázet jen ostré tipy (favorit ≥55 % / value)
        "only_real_odds": False,  # sázet JEN na zápasy s reálnými kurzy z The Odds API
        "auto_run": False,        # automaticky spouštět agenta podle rozvrhu
        "auto_run_hours": "8,12,16,20", # hodiny spuštění (čárkou oddělené, 24h formát)
        "auto_retrain": True,     # automaticky přetrénovat ML po X nových settled sázkách
        "auto_retrain_threshold": 10,  # kolik nových settled sázek spustí retrain
        # --- Tutovka strategie (multi-market) ---
        "min_prob": 0.75,         # minimální pravděpodobnost tipu (tutovka = 75 %+)
        "min_odds": 1.20,         # minimální kurz (pod 1.20 se sázka nevyplatí)
        "markets": {              # které trhy agent analyzuje
            "winner": True,       # vítěz 1X2 (resp. 1/2 u two-way sportů)
            "goals": True,        # góly over/under
            "btts": True,         # oba týmy skórují
            "corners": True,      # rohy over/under (jen fotbal, modelované kurzy)
        },
        "sports": ["soccer", "hockey", "basketball"],  # které sporty agent pokrývá
        # --- Tikety (AKO) ---
        "daily_ticket": True,     # denní AKO z 2–3 tutovek (celkový kurz ~2–3)
        "daily_ticket_legs": 3,   # max. tipů na denním tiketu
        "ticket_stake": 20.0,     # vklad na tiket (Kč)
        "weekend_ticket": True,   # páteční velký tiket (4–6 tipů na víkend)
        "weekend_ticket_legs": 5, # max. tipů na víkendovém tiketu
    },
}


def get_settings() -> dict:
    st = storage.load("settings.json", None)
    if st is None:
        st = {k: dict(v) for k, v in _DEFAULTS.items()}
        storage.save("settings.json", st)
        return st
    # doplň chybějící klíče (např. po aktualizaci appky přidávající nové nastavení)
    changed = False
    for section, defaults in _DEFAULTS.items():
        cur = st.setdefault(section, {})
        for k, v in defaults.items():
            if k not in cur:
                cur[k] = v
                changed = True
    if changed:
        storage.save("settings.json", st)
    return st


def update_settings(section: str, values: dict) -> dict:
    if section not in _DEFAULTS:
        raise ValueError(f"Neznámá sekce nastavení: {section}")
    st = get_settings()
    for k, v in values.items():
        if k not in _DEFAULTS[section]:
            continue
        st[section][k] = v
    storage.save("settings.json", st)
    return st


def reset_settings() -> dict:
    st = {k: dict(v) for k, v in _DEFAULTS.items()}
    storage.save("settings.json", st)
    return st


# ---------------------------------------------------------------------------
# Správa dat
# ---------------------------------------------------------------------------
def clear_prediction_cache() -> int:
    """Smaže keš stažených zápasů (cache_*.json) – další načtení natáhne čerstvá data z ESPN."""
    return storage.remove_matching("cache_*.json")


def reset_tips_db() -> None:
    storage.save("tips.json", {"tips": []})


def export_all() -> dict:
    """Vrátí kompletní export uživatelských dat (bez API klíčů) pro zálohu.

    Dřív četlo "ratings.json" – soubor, co po přepisu na goals-ratio engine
    (viz goals_model.py) už vůbec neexistuje (skutečný je team_ratings.json).
    Záloha tak tiše vynechávala nejcennější data appky – naučené ratingy
    tisíců týmů. Teď bere správný soubor a navíc i team_history.json
    (forma/H2H), bez kterého by import obnovil ratingy, ale ne historii."""
    return {
        "settings": get_settings(),
        "bankroll": storage.load("bankroll.json", {}),
        "tips": storage.load("tips.json", {"tips": []}),
        "ratings": storage.load("team_ratings.json", {}),
        "team_history": storage.load("team_history.json", {}),
    }


def import_all(data: dict) -> None:
    if "settings" in data:
        storage.save("settings.json", data["settings"])
    if "bankroll" in data:
        storage.save("bankroll.json", data["bankroll"])
    if "tips" in data:
        storage.save("tips.json", data["tips"])
    if "ratings" in data:
        storage.save("team_ratings.json", data["ratings"])
    if "team_history" in data:
        storage.save("team_history.json", data["team_history"])
