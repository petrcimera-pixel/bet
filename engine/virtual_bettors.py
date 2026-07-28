# -*- coding: utf-8 -*-
"""
10 virtuálních sázkařů – každý má vlastní bank (1000 Kč), vlastní strategii
výběru sázek i vlastní způsob určení výše vkladu. Sází na STEJNÁ reálná
data (predikce z engine/goals_model.py, jen trhy s reálnými kurzy ESPN),
takže rozdíly ve výsledku jsou čistě dané strategií – slouží ke zkoumání,
která přistupuje k sázení nejlépe.

Běží nezávisle na hlavním bankrollu (agent.py) – vlastní úložiště
data/virtual_bettors.json, vlastní vyhodnocování napojené na stejné ESPN
výsledky, co používá settle smyčka pro tipy/sázky.
"""

import random
import time
import uuid

from . import storage
from .bankroll import eval_outcome

FILE = "virtual_bettors.json"
DAILY_STAKE_CAP_PCT = 0.35   # žádný sázkař nevsadí v jeden den víc než 35 % banku (i Martingale)


def _kelly_stake(prob, odds, balance, fraction, floor_pct=0.0, cap_pct=1.0):
    b = odds - 1.0
    if b <= 0:
        return 0.0
    edge = prob * odds - 1.0
    if edge <= 0:
        return 0.0
    f = max(0.0, (prob * b - (1 - prob)) / b) * fraction
    stake = balance * f
    stake = max(stake, balance * floor_pct) if floor_pct else stake
    return round(min(stake, balance * cap_pct), 2)


# ---------------------------------------------------------------------------
# 10 profilů – jméno, charakteristika a rozhodovací funkce
# ---------------------------------------------------------------------------
def _s_kelly(pool, b, bal):
    """Kelly Kateřina – plný Kelly na každý zápas s pozitivním edge, žádný práh jistoty."""
    by_match = {}
    for c in pool:
        if c["prob"] * c["odds"] - 1.0 <= 0:
            continue
        if c["match_id"] not in by_match or c["edge"] > by_match[c["match_id"]]["edge"]:
            by_match[c["match_id"]] = c
    out = []
    for c in list(by_match.values())[:6]:
        stake = _kelly_stake(c["prob"], c["odds"], bal, 1.0, cap_pct=0.25)
        if stake >= 1:
            out.append((c, stake))
    return out


def _s_quarter_kelly(pool, b, bal):
    """Čtvrtinový Čeněk – kvartový Kelly, jistota aspoň 55 %."""
    cands = [c for c in pool if c["prob"] >= 0.55]
    by_match = {}
    for c in cands:
        if c["match_id"] not in by_match or c["prob"] > by_match[c["match_id"]]["prob"]:
            by_match[c["match_id"]] = c
    out = []
    for c in list(by_match.values())[:5]:
        stake = _kelly_stake(c["prob"], c["odds"], bal, 0.25, cap_pct=0.15)
        if stake >= 1:
            out.append((c, stake))
    return out


def _s_conservative(pool, b, bal):
    """Konzervativní Klára – jen tutovky nad 80 % jistoty, flat 3 % banku."""
    cands = sorted([c for c in pool if c["prob"] >= 0.80], key=lambda c: -c["prob"])
    by_match, out = set(), []
    for c in cands:
        if c["match_id"] in by_match:
            continue
        by_match.add(c["match_id"])
        out.append((c, round(bal * 0.03, 2)))
        if len(out) >= 4:
            break
    return out


def _s_value_hunter(pool, b, bal):
    """Value Hunter Viktor – loví jen podhodnocené kurzy (edge >= 8 p.b.), na jistotě nezáleží."""
    cands = sorted([c for c in pool if c["edge"] >= 0.08], key=lambda c: -c["edge"])
    by_match, out = set(), []
    for c in cands:
        if c["match_id"] in by_match:
            continue
        by_match.add(c["match_id"])
        out.append((c, round(bal * 0.04, 2)))
        if len(out) >= 3:
            break
    return out


def _s_favorite(pool, b, bal):
    """Favorit Fanda – vždy vsadí na favorita zápasu (nejvyšší pravděpodobnost), bez ohledu na value."""
    winner = [c for c in pool if c["market"] == "winner"]
    by_match = {}
    for c in winner:
        if c["match_id"] not in by_match or c["prob"] > by_match[c["match_id"]]["prob"]:
            by_match[c["match_id"]] = c
    out = [(c, round(bal * 0.05, 2)) for c in list(by_match.values())[:3]]
    return out


def _s_underdog(pool, b, bal):
    """Outsider Olda – hledá nejvyšší kurz s aspoň 15% šancí (vysoké riziko/výnos)."""
    cands = [c for c in pool if c["prob"] >= 0.15]
    by_match = {}
    for c in cands:
        if c["match_id"] not in by_match or c["odds"] > by_match[c["match_id"]]["odds"]:
            by_match[c["match_id"]] = c
    ranked = sorted(by_match.values(), key=lambda c: -c["odds"])
    return [(c, round(bal * 0.05, 2)) for c in ranked[:3]]


def _s_martingale(pool, b, bal):
    """Martingale Magda – po prohře zdvojnásobí příští sázku (klasický rizikový systém).
    Sází jen 1× denně na nejjistější tutovku, ať je progrese sledovatelná."""
    if not pool:
        return []
    best = max(pool, key=lambda c: c["prob"])
    streak = b.get("loss_streak", 0)
    base = b.get("start_balance", 1000.0) * 0.02
    stake = min(base * (2 ** streak), bal * DAILY_STAKE_CAP_PCT)
    if stake < 1:
        return []
    return [(best, round(stake, 2))]


def _s_random(pool, b, bal):
    """Náhodný Norbert – kontrolní skupina: náhodný zápas, náhodný výsledek, náhodná výše vkladu."""
    if not pool:
        return []
    picks = random.sample(pool, min(3, len(pool)))
    out = []
    seen = set()
    for c in picks:
        if c["match_id"] in seen:
            continue
        seen.add(c["match_id"])
        pct = random.uniform(0.01, 0.05)
        out.append((c, round(bal * pct, 2)))
    return out


def _s_disciplined(pool, b, bal):
    """Disciplinovaný Dan – flat 5 % banku, max 2 sázky denně, diverzifikuje napříč ligami."""
    cands = sorted([c for c in pool if c["prob"] >= 0.6], key=lambda c: -c["prob"])
    out, used_leagues, used_matches = [], set(), set()
    for c in cands:
        if c["match_id"] in used_matches or c["league"] in used_leagues:
            continue
        used_matches.add(c["match_id"])
        used_leagues.add(c["league"])
        out.append((c, round(bal * 0.05, 2)))
        if len(out) >= 2:
            break
    return out


def _s_cautious(pool, b, bal):
    """Opatrná Olga – 1 % banku, jen jistota nad 85 %, po 2 prohrách v řadě si dá pauzu."""
    if b.get("loss_streak", 0) >= 2:
        return []
    cands = [c for c in pool if c["prob"] >= 0.85]
    if not cands:
        return []
    best = max(cands, key=lambda c: c["prob"])
    return [(best, round(bal * 0.01, 2))]


PROFILES = [
    {"id": "kelly", "name": "Kelly Kateřina", "emoji": "📐",
     "tagline": "Plný Kelly kritérium – matematicky optimální růst banku, ale vysoká volatilita.",
     "strategy": _s_kelly},
    {"id": "quarter", "name": "Čtvrtinový Čeněk", "emoji": "🎯",
     "tagline": "Kvartový Kelly (25 %) – rozumný kompromis mezi růstem a rizikem.",
     "strategy": _s_quarter_kelly},
    {"id": "conservative", "name": "Konzervativní Klára", "emoji": "🛡️",
     "tagline": "Jen tutovky nad 80 % jistoty, flat 3 % banku – málo sázek, málo rizika.",
     "strategy": _s_conservative},
    {"id": "value", "name": "Value Hunter Viktor", "emoji": "🔍",
     "tagline": "Loví podhodnocené kurzy (edge 8+ p.b.), na absolutní jistotě mu nezáleží.",
     "strategy": _s_value_hunter},
    {"id": "favorite", "name": "Favorit Fanda", "emoji": "⭐",
     "tagline": "Vždy vsadí na favorita zápasu, i když kurz nemá žádnou value.",
     "strategy": _s_favorite},
    {"id": "underdog", "name": "Outsider Olda", "emoji": "🎲",
     "tagline": "Honí nejvyšší kurz s aspoň 15% šancí – vysoké riziko, vysoký výnos.",
     "strategy": _s_underdog},
    {"id": "martingale", "name": "Martingale Magda", "emoji": "📈",
     "tagline": "Po prohře zdvojnásobí vklad – klasický (rizikový) progresivní systém.",
     "strategy": _s_martingale},
    {"id": "random", "name": "Náhodný Norbert", "emoji": "🎰",
     "tagline": "Kontrolní skupina: sází náhodně. Srovnávací základna pro ostatní strategie.",
     "strategy": _s_random},
    {"id": "disciplined", "name": "Disciplinovaný Dan", "emoji": "📋",
     "tagline": "Flat 5 %, max 2 sázky denně, diverzifikuje napříč ligami.",
     "strategy": _s_disciplined},
    {"id": "cautious", "name": "Opatrná Olga", "emoji": "🐢",
     "tagline": "Jen 1 % banku, jistota 85%+, po 2 prohrách v řadě si dá pauzu.",
     "strategy": _s_cautious},
]
_BY_ID = {p["id"]: p for p in PROFILES}


# ---------------------------------------------------------------------------
# Úložiště
# ---------------------------------------------------------------------------
def _default_state():
    return {
        p["id"]: {
            "name": p["name"], "emoji": p["emoji"], "tagline": p["tagline"],
            "balance": 1000.0, "start_balance": 1000.0,
            "bets": [], "last_run_date": None, "loss_streak": 0,
        } for p in PROFILES
    }


def load_state():
    st = storage.load(FILE, None)
    if st is None:
        st = _default_state()
        storage.save(FILE, st)
    # doplní chybějící sázkaře (kdyby se PROFILES v budoucnu rozšířily)
    changed = False
    for p in PROFILES:
        if p["id"] not in st:
            st[p["id"]] = _default_state()[p["id"]]
            changed = True
    if changed:
        storage.save(FILE, st)
    return st


def save_state(st):
    storage.save(FILE, st)


# ---------------------------------------------------------------------------
# Kandidáti (jen trhy s reálnými kurzy ESPN – žádné fingované)
# ---------------------------------------------------------------------------
def _candidates_for(p):
    keys = ("home", "away") if p.get("two_way") else ("home", "draw", "away")
    out = []
    for k, bet in (p.get("bets") or {}).items():
        if not bet.get("real") or not bet.get("odds") or not bet.get("prob"):
            continue
        out.append({
            "outcome": k, "label": bet.get("label", "?"), "name": bet.get("name", bet.get("label", "?")),
            "odds": float(bet["odds"]), "prob": float(bet["prob"]),
            "ev": bet.get("ev", 0.0) or 0.0, "edge": bet.get("edge", 0.0) or 0.0,
            "market": "winner" if k in keys else "goals",
        })
    return out


def _build_pool(predictions):
    pool = []
    for p in predictions:
        if p.get("result") is not None or p.get("live"):
            continue
        for c in _candidates_for(p):
            pool.append({
                **c, "match_id": p["id"], "match": f'{p["home"]} – {p["away"]}',
                "league": p.get("league", "Unknown"), "date": p.get("date", ""),
                "time": p.get("time", ""), "sport": p.get("sport", "soccer"), "slug": p.get("slug", ""),
            })
    return pool


# ---------------------------------------------------------------------------
# Sázení – jednou denně za sázkaře (stejný rytmus jako auto-agent)
# ---------------------------------------------------------------------------
def run_all(predictions, today_str: str) -> dict:
    st = load_state()
    pool = _build_pool(predictions)
    placed_total = {}
    for prof in PROFILES:
        b = st[prof["id"]]
        if b.get("last_run_date") == today_str:
            continue   # dnes už sázel
        b["last_run_date"] = today_str
        if not pool:
            continue
        try:
            decisions = prof["strategy"](pool, b, b["balance"])
        except Exception:
            decisions = []
        placed = 0
        used_matches = set()
        # Ochrana proti totálnímu vytunelování: jednotlivá sázka nesmí nikdy
        # přesáhnout 20 % AKTUÁLNÍHO banku bez ohledu na to, co strategie
        # (např. plný Kelly) sama spočítá. Pod 10 % startovního banku (vážná
        # série proher) se strop dál zpřísní na 5 %, ať i "agresivní"
        # strategie nemůže bank definitivně dorazit jednou špatnou sázkou.
        single_bet_cap = 0.05 if b["balance"] < b.get("start_balance", 1000.0) * 0.10 else 0.20
        for c, stake in decisions:
            if c["match_id"] in used_matches:
                continue
            stake = round(min(stake, b["balance"], b["balance"] * single_bet_cap), 2)
            if stake < 1 or stake > b["balance"]:
                continue
            bet = {
                "id": uuid.uuid4().hex[:10], "ts": int(time.time()),
                "match_id": c["match_id"], "match": c["match"], "league": c["league"],
                "match_date": c["date"], "match_time": c["time"], "sport": c["sport"], "slug": c["slug"],
                "outcome": c["outcome"], "label": c["label"], "name": c["name"],
                "odds": round(c["odds"], 2), "prob": round(c["prob"], 4),
                "stake": stake, "status": "open", "pnl": 0.0, "settled_ts": None,
            }
            b["balance"] = round(b["balance"] - stake, 2)
            b["bets"].insert(0, bet)
            used_matches.add(c["match_id"])
            placed += 1
        placed_total[prof["id"]] = placed
    save_state(st)
    return placed_total


def settle_all(results: dict) -> int:
    """results: {match_id: {'home':h,'away':a}} – stejná data jako settle pro
    reálné tipy/sázky (viz app.py _settle_recent)."""
    if not results:
        return 0
    st = load_state()
    n = 0
    for bid, b in st.items():
        streak = b.get("loss_streak", 0)
        for bet in b["bets"]:
            if bet["status"] != "open":
                continue
            res = results.get(bet["match_id"])
            if not res:
                continue
            r = eval_outcome(bet["outcome"], res["home"], res["away"])
            if not r:
                continue
            if r == "won":
                payout = round(bet["stake"] * bet["odds"], 2)
                bet["pnl"] = round(payout - bet["stake"], 2)
                b["balance"] = round(b["balance"] + payout, 2)
                streak = 0
            elif r == "void":
                bet["pnl"] = 0.0
                b["balance"] = round(b["balance"] + bet["stake"], 2)
            else:
                bet["pnl"] = round(-bet["stake"], 2)
                streak += 1
            bet["status"] = r
            bet["settled_ts"] = int(time.time())
            n += 1
        b["loss_streak"] = streak
    if n:
        save_state(st)
    return n


# ---------------------------------------------------------------------------
# Statistiky / žebříček
# ---------------------------------------------------------------------------
def _bettor_stats(bid, b):
    settled = [x for x in b["bets"] if x["status"] in ("won", "lost")]
    won = sum(1 for x in settled if x["status"] == "won")
    staked = sum(x["stake"] for x in settled)
    pnl = sum(x["pnl"] for x in settled)
    equity = [b["start_balance"]]
    cum = b["start_balance"]
    for x in sorted(settled, key=lambda x: x.get("settled_ts") or x["ts"]):
        cum = round(cum + x["pnl"], 2)
        equity.append(cum)
    return {
        "id": bid, "name": b["name"], "emoji": b["emoji"], "tagline": b["tagline"],
        "balance": b["balance"], "start_balance": b["start_balance"],
        "profit": round(b["balance"] - b["start_balance"], 2),
        "roi": round(pnl / staked * 100, 1) if staked else 0.0,
        "placed": len(b["bets"]), "settled": len(settled), "won": won,
        "win_rate": round(won / len(settled) * 100, 1) if settled else None,
        "open_count": len(b["bets"]) - len(settled),
        "equity": equity,
    }


def leaderboard() -> list:
    st = load_state()
    rows = [_bettor_stats(bid, b) for bid, b in st.items()]
    rows.sort(key=lambda r: r["profit"], reverse=True)
    for i, r in enumerate(rows):
        r["rank"] = i + 1
    return rows


def bettor_detail(bid: str) -> dict:
    st = load_state()
    b = st.get(bid)
    if not b:
        return {}
    stats = _bettor_stats(bid, b)
    stats["bets"] = b["bets"][:50]
    return stats


# ---------------------------------------------------------------------------
# Kalibrace modelu – říká "75 % jistota" skutečně vyhrává ~75 % případů?
# ---------------------------------------------------------------------------
_CAL_BUCKETS = [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 1.01)]


def calibration_data() -> list:
    """Napříč VŠEMI settled sázkami všech 10 sázkařů (velký, různorodý vzorek
    díky 10 různým strategiím) spočítá pro každý interval modelové
    pravděpodobnosti skutečnou úspěšnost. Ideálně kalibrovaný model má
    'skutečná úspěšnost' == střed intervalu; systematická odchylka = model
    je přehnaně/nedostatečně sebevědomý."""
    st = load_state()
    buckets = [{"lo": lo, "hi": hi, "n": 0, "wins": 0, "prob_sum": 0.0} for lo, hi in _CAL_BUCKETS]
    for b in st.values():
        for bet in b["bets"]:
            if bet["status"] not in ("won", "lost"):
                continue
            p = bet.get("prob", 0)
            for bucket in buckets:
                if bucket["lo"] <= p < bucket["hi"]:
                    bucket["n"] += 1
                    bucket["prob_sum"] += p
                    if bet["status"] == "won":
                        bucket["wins"] += 1
                    break
    out = []
    for bucket in buckets:
        n = bucket["n"]
        out.append({
            "range": f'{int(bucket["lo"]*100)}–{int(min(bucket["hi"],1.0)*100)}%',
            "n": n,
            "avg_predicted": round(bucket["prob_sum"] / n * 100, 1) if n else None,
            "actual_win_rate": round(bucket["wins"] / n * 100, 1) if n else None,
        })
    return out
