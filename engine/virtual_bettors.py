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

import datetime
import random
import time
import uuid

from . import storage
from .bankroll import eval_outcome
from .goals_model import cz_num, team_form

FILE = "virtual_bettors.json"
DAILY_STAKE_CAP_PCT = 0.35   # žádný sázkař nevsadí v jeden den víc než 35 % banku (i Martingale)
DEFAULT_START_BALANCE = 200.0   # startovní bank každého sázkaře
MIN_STAKE_PER_TICKET = 5.0      # jakmile výpočet vyjde pod 5 Kč, tiket se přeskočí
MAX_STAKE_PER_TICKET = 10.0     # nikdo nikdy nevsadí víc než tohle na jeden tiket
EXPERIENCE_WINDOW = 20          # kolik posledních VYHODNOCENÝCH sázek se počítá do skóre zkušenosti


def _experience_scale(bettor: dict) -> float:
    """Kolik ze spočítané sázky si sázkař 'zaslouží' vsadit podle své
    dovednosti a nasbírané zkušenosti. Novic bez historie sází zlomek,
    stabilní ziskový sázkař plnou sázku, propadák se stahuje.

    Vzorec:
      experience = min(1, N_settled_recent / EXPERIENCE_WINDOW)
      skill      = clamp(0.5, 1.5, 1 + ROI_recent/100)
      scale      = 0.35 + 0.65 * experience * skill    -> rozsah cca 0.35..1.32

    Prakticky: nový sázkař vsadí 35 % vypočtené sázky, po ~20 vyhodnocených
    sázkách jde na 100 % (pokud si vede alespoň v nule), špatné výsledky
    ho stáhnou zpět, dobré výsledky mírně nadhodnotí."""
    bets = bettor.get("bets", [])
    settled = [b for b in bets if b.get("status") in ("won", "lost")]
    if not settled:
        return 0.35
    recent = sorted(settled, key=lambda b: b.get("settled_ts") or b.get("ts", 0))[-EXPERIENCE_WINDOW:]
    n = len(recent)
    experience = min(1.0, n / EXPERIENCE_WINDOW)
    staked = sum(b.get("stake", 0) for b in recent)
    pnl = sum(b.get("pnl", 0) for b in recent)
    roi = (pnl / staked) if staked else 0.0
    skill = max(0.5, min(1.5, 1.0 + roi))    # roi -50 % -> 0.5, +30 % -> 1.3
    return round(0.35 + 0.65 * experience * skill, 3)


def _kelly_stake(prob, odds, balance, fraction, floor_pct=0.0, cap_pct=1.0, confidence_scale=1.0):
    b = odds - 1.0
    if b <= 0:
        return 0.0
    edge = prob * odds - 1.0
    if edge <= 0:
        return 0.0
    f = max(0.0, (prob * b - (1 - prob)) / b) * fraction * max(0.0, min(1.0, confidence_scale))
    stake = balance * f
    stake = max(stake, balance * floor_pct) if floor_pct else stake
    return round(min(stake, balance * cap_pct), 2)


def _conf_scale(c):
    """Stejná logika jako v agent.py: nový/málo sledovaný tým -> menší vklad
    i při stejném edge (rating_confidence 0-1 z ml_features kandidáta)."""
    conf = (c.get("ml_features") or {}).get("rating_confidence", 1.0)
    return 0.5 + 0.5 * conf


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
        stake = _kelly_stake(c["prob"], c["odds"], bal, 1.0, cap_pct=0.25, confidence_scale=_conf_scale(c))
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
        stake = _kelly_stake(c["prob"], c["odds"], bal, 0.25, cap_pct=0.15, confidence_scale=_conf_scale(c))
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


def _form_score(form: list) -> float:
    """Poslední zápasy váží víc než starší – nejnovější výsledek má 2x váhu
    nejstaršího z pětice. Vrací 0-1 (0 = samé prohry, 1 = samé výhry)."""
    if not form:
        return 0.5   # bez historie = neutrální, žádná výhoda ani nevýhoda
    weights = [1.0 + 0.25 * i for i in range(len(form))]   # novější = vyšší váha
    pts = {"W": 1.0, "D": 0.5, "L": 0.0}
    return sum(pts[r] * w for r, w in zip(form, weights)) / sum(weights)


def _s_form_rio(pool, b, bal):
    """Forma Rio – sází na tým v citelně lepší formě než soupeř (rozdíl
    formy aspoň 0.3 na škále 0-1), a jen když k tomu kurz dává aspoň
    minimální edge. Forma sama o sobě nestačí – bez edge by to bylo jen
    sázení na oblíbence, ne na příležitost."""
    by_match = {}
    for c in pool:
        if c["outcome"] not in ("home", "away") or c["market"] != "winner":
            continue
        by_match.setdefault(c["match_id"], {})[c["outcome"]] = c

    out = []
    for mid, sides in by_match.items():
        home, away = sides.get("home"), sides.get("away")
        if not home or not away:
            continue
        fh = _form_score(home.get("form_home") or [])
        fa = _form_score(away.get("form_away") or [])
        diff = fh - fa
        if abs(diff) < 0.3:
            continue   # forma moc podobná, žádná jasná výhoda
        better = home if diff > 0 else away
        if better["edge"] < 0.03:
            continue   # forma bez value je jen sázka na oblíbence
        out.append((better, round(bal * 0.03, 2)))
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
    base = b.get("start_balance", DEFAULT_START_BALANCE) * 0.02
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


# --- druhá desítka: trhy, progrese a pásma kurzů -----------------------------
def _one_per_match(cands, limit):
    """Nejvýš jedna sázka na zápas – jinak by sázkař vsadil na Over i Under
    téhož zápasu a sám sobě si vyrušil výsledek."""
    seen, out = set(), []
    for c in cands:
        if c["match_id"] in seen:
            continue
        seen.add(c["match_id"])
        out.append(c)
        if len(out) >= limit:
            break
    return out


def _s_home(pool, b, bal):
    """Domácí Dalibor – vždy na domácí, sází na výhodu domácího prostředí."""
    c = sorted([x for x in pool if x["outcome"] == "home" and x["prob"] >= 0.40],
               key=lambda x: -x["prob"])
    return [(x, round(bal * 0.03, 2)) for x in _one_per_match(c, 4)]


def _s_overs(pool, b, bal):
    """Gólový Gustav – jen Over linie, věří, že se góly dávají."""
    c = sorted([x for x in pool if x["outcome"].startswith("over") and x["prob"] >= 0.60],
               key=lambda x: -x["prob"])
    return [(x, round(bal * 0.04, 2)) for x in _one_per_match(c, 5)]


def _s_unders(pool, b, bal):
    """Betonový Bedřich – jen Under linie, věří na uzavřené zápasy."""
    c = sorted([x for x in pool if x["outcome"].startswith("under") and x["prob"] >= 0.60],
               key=lambda x: -x["prob"])
    return [(x, round(bal * 0.04, 2)) for x in _one_per_match(c, 5)]


def _fib_stake(streak, unit):
    a, bb = 1, 1
    for _ in range(min(streak, 10)):
        a, bb = bb, a + bb
    return unit * a


def _s_fibonacci(pool, b, bal):
    """Fibonacci Filip – po prohře posune vklad na další Fibonacciho číslo."""
    c = sorted([x for x in pool if x["prob"] >= 0.60], key=lambda x: -x["prob"])
    unit = bal * 0.02
    stake = min(_fib_stake(b.get("loss_streak", 0), unit), bal * 0.25)
    return [(x, round(stake, 2)) for x in _one_per_match(c, 2)]


def _s_dalembert(pool, b, bal):
    """D'Alembert Denisa – po prohře +1 jednotka, po výhře -1. Mírnější progrese."""
    c = sorted([x for x in pool if x["prob"] >= 0.58], key=lambda x: -x["prob"])
    unit = bal * 0.015
    stake = min(unit * (1 + b.get("loss_streak", 0)), bal * 0.20)
    return [(x, round(stake, 2)) for x in _one_per_match(c, 3)]


def _s_paroli(pool, b, bal):
    """Paroli Pavla – opak Martingalu: zvyšuje po VÝHŘE, po prohře zpět na základ.
    Riskuje jen vyhrané peníze, ne dorovnávání ztrát."""
    c = sorted([x for x in pool if x["prob"] >= 0.60], key=lambda x: -x["prob"])
    unit = bal * 0.02
    stake = min(unit * (2 ** min(b.get("win_streak", 0), 3)), bal * 0.20)
    return [(x, round(stake, 2)) for x in _one_per_match(c, 3)]


def _s_low_odds(pool, b, bal):
    """Jistotář Jarda – jen kurzy do 1.5, hodně malých jistých výher."""
    c = sorted([x for x in pool if x["odds"] <= 1.5 and x["prob"] >= 0.65],
               key=lambda x: -x["prob"])
    return [(x, round(bal * 0.06, 2)) for x in _one_per_match(c, 5)]


def _s_high_odds(pool, b, bal):
    """Riskér Radim – jen kurzy od 3.0 výš, malé vklady, čeká na trefu."""
    c = sorted([x for x in pool if x["odds"] >= 3.0], key=lambda x: -x["prob"])
    return [(x, round(bal * 0.01, 2)) for x in _one_per_match(c, 6)]


def _s_calibrated(pool, b, bal):
    """Kalibrovaný Karel – nevěří syrové jistotě modelu, ale opravené podle
    skutečné historické úspěšnosti."""
    from . import calibration
    c = []
    for x in pool:
        cal = calibration.calibrate(x["prob"], x["outcome"])
        if cal >= 0.62 and cal * x["odds"] - 1 > 0:
            c.append((cal, x))
    c.sort(key=lambda t: -t[0])
    return [(x, round(bal * 0.04, 2)) for x in _one_per_match([x for _, x in c], 4)]


def _s_spread(pool, b, bal):
    """Diverzifikátor Dita – hodně malých sázek, ale nejvýš jedna na ligu,
    aby ji nepoložil jeden špatný den v jedné soutěži."""
    c = sorted([x for x in pool if x["prob"] >= 0.58], key=lambda x: -x["prob"])
    seen_lg, seen_m, out = set(), set(), []
    for x in c:
        if x["league"] in seen_lg or x["match_id"] in seen_m:
            continue
        seen_lg.add(x["league"]); seen_m.add(x["match_id"])
        out.append((x, round(bal * 0.015, 2)))
        if len(out) >= 8:
            break
    return out


# ---------------------------------------------------------------------------
# Skupiny sázkařů podle typu tiketu
# ---------------------------------------------------------------------------
GROUPS = {
    "single": {"label": "Jednotlivé sázky", "emoji": "1️⃣",
               "desc": "Jeden tip = jeden tiket. Základní srovnání strategií."},
    "acca":   {"label": "Více sázek na tiketu", "emoji": "🎫",
               "desc": "Akumulátor z několika ZÁPASŮ – musí vyjít všechny, kurzy se násobí."},
    "combo":  {"label": "Kombinované zápasy", "emoji": "🔗",
               "desc": "Několik trhů JEDNOHO zápasu na jednom tiketu (jako kombi u sázkovek). "
                       "Pravděpodobnost se počítá společně ze skóre gridu, ne součinem – "
                       "trhy jednoho zápasu spolu souvisí."},
    "ai":     {"label": "AI sázkaři", "emoji": "🤖",
               "desc": "Rozhodují podle natrénovaného ML modelu (XGBoost), ne podle "
                       "Poissonova modelu skóre – druhý, nezávislý pohled na každý zápas. "
                       "Bez natrénovaného modelu nesází vůbec."},
}


def _legs_payload(legs):
    return [{"match_id": c["match_id"], "match": c["match"], "league": c.get("league", ""),
             "outcome": c["outcome"], "label": c["label"], "name": c["name"],
             "odds": round(float(c["odds"]), 2), "prob": round(float(c["prob"]), 4),
             "date": c.get("date", ""), "time": c.get("time", ""),
             "sport": c.get("sport", "soccer"), "slug": c.get("slug", ""),
             "result": None} for c in legs]


def _ticket(legs, kind):
    """Tiket z více výběrů. Kurz je součin (tak ho počítají i sázkovky), ale
    pravděpodobnost se u kombinace jednoho zápasu MUSÍ počítat společně –
    trhy téhož zápasu jsou korelované a součin by dal úplně jiné číslo."""
    odds = 1.0
    for c in legs:
        odds *= float(c["odds"])
    if kind == "combo":
        from . import goals_model
        prob = goals_model.combo_probability(legs[0].get("exp_goals"),
                                             [c["outcome"] for c in legs])
    else:
        prob = 1.0
        for c in legs:
            prob *= float(c["prob"])
    return {"kind": kind, "legs": legs, "odds": odds, "prob": prob,
            "match_id": "", "match": None}


# --- třetí desítka: akumulátory přes víc zápasů ------------------------------
def _acca_pick(pool, n, key, filt=None, one_per_league=False):
    """Vybere n výběrů z RŮZNÝCH zápasů pro akumulátor."""
    cands = sorted([c for c in pool if (filt is None or filt(c))], key=key)
    seen_m, seen_lg, legs = set(), set(), []
    for c in cands:
        if c["match_id"] in seen_m or (one_per_league and c["league"] in seen_lg):
            continue
        seen_m.add(c["match_id"]); seen_lg.add(c["league"])
        legs.append(c)
        if len(legs) >= n:
            break
    return legs if len(legs) == n else []


def _s_acca_duo(pool, b, bal):
    """Dvojka Dušan – dvě nejjistější, malý kurz, ale musí vyjít obě."""
    legs = _acca_pick(pool, 2, lambda c: -c["prob"], lambda c: c["prob"] >= 0.70)
    return [(_ticket(legs, "acca"), round(bal * 0.04, 2))] if legs else []


def _s_acca_trio(pool, b, bal):
    """Trojka Tomáš – klasická trojka z tutovek."""
    legs = _acca_pick(pool, 3, lambda c: -c["prob"], lambda c: c["prob"] >= 0.65)
    return [(_ticket(legs, "acca"), round(bal * 0.03, 2))] if legs else []


def _s_acca_penta(pool, b, bal):
    """Pětka Pepa – pět tipů, malý vklad, velký kurz."""
    legs = _acca_pick(pool, 5, lambda c: -c["prob"], lambda c: c["prob"] >= 0.60)
    return [(_ticket(legs, "acca"), round(bal * 0.015, 2))] if legs else []


def _s_acca_jackpot(pool, b, bal):
    """Jackpot Jindra – osm tipů, drobný vklad, sní o velké výhře."""
    legs = _acca_pick(pool, 8, lambda c: -c["prob"], lambda c: c["prob"] >= 0.55)
    return [(_ticket(legs, "acca"), round(bal * 0.008, 2))] if legs else []


def _s_acca_value(pool, b, bal):
    """Hodnotový Hubert – trojka poskládaná z nejlepších náskoků, ne z jistot."""
    legs = _acca_pick(pool, 3, lambda c: -c["edge"], lambda c: c["edge"] >= 0.03)
    return [(_ticket(legs, "acca"), round(bal * 0.025, 2))] if legs else []


def _s_acca_spread(pool, b, bal):
    """Rozložený Rosťa – čtyřka, ale každý tip z jiné ligy."""
    legs = _acca_pick(pool, 4, lambda c: -c["prob"], lambda c: c["prob"] >= 0.62,
                      one_per_league=True)
    return [(_ticket(legs, "acca"), round(bal * 0.02, 2))] if legs else []


def _s_acca_overs(pool, b, bal):
    """Gólová Gabriela – trojka jen z Over linií."""
    legs = _acca_pick(pool, 3, lambda c: -c["prob"],
                      lambda c: c["outcome"].startswith("over") and c["prob"] >= 0.62)
    return [(_ticket(legs, "acca"), round(bal * 0.03, 2))] if legs else []


def _s_acca_favs(pool, b, bal):
    """Favoritová Františka – trojka jen z vítězů zápasu."""
    legs = _acca_pick(pool, 3, lambda c: -c["prob"],
                      lambda c: c["market"] == "winner" and c["prob"] >= 0.55)
    return [(_ticket(legs, "acca"), round(bal * 0.03, 2))] if legs else []


def _s_acca_double(pool, b, bal):
    """Dvojitý Drahoš – dvě dvojky místo jedné čtyřky, rozloží riziko."""
    cands = sorted([c for c in pool if c["prob"] >= 0.68], key=lambda c: -c["prob"])
    picked, seen, out = [], set(), []
    for c in cands:
        if c["match_id"] in seen:
            continue
        seen.add(c["match_id"]); picked.append(c)
        if len(picked) >= 4:
            break
    for i in (0, 2):
        if len(picked) >= i + 2:
            out.append((_ticket(picked[i:i + 2], "acca"), round(bal * 0.02, 2)))
    return out


def _s_acca_progressive(pool, b, bal):
    """Stoupavý Standa – po prohře přidá do tiketu jeden tip navíc."""
    n = min(2 + b.get("loss_streak", 0), 6)
    legs = _acca_pick(pool, n, lambda c: -c["prob"], lambda c: c["prob"] >= 0.60)
    return [(_ticket(legs, "acca"), round(bal * 0.02, 2))] if legs else []


# --- pět nových akumulátorových strategií (rozšíření kategorie na 15 členů)


def _s_acca_short(pool, b, bal):
    """Tříprocentní Trio – tři jistoty, ale kurz musí dohromady dát aspoň 3.0.
    Kombinuje výběr podle jistoty s podmínkou minimálního potenciálního zisku."""
    cands = sorted([c for c in pool if c["prob"] >= 0.65], key=lambda c: -c["prob"])
    seen, legs = set(), []
    for c in cands:
        if c["match_id"] in seen:
            continue
        seen.add(c["match_id"]); legs.append(c)
        if len(legs) >= 3:
            break
    if len(legs) < 3:
        return []
    total_odds = 1.0
    for c in legs:
        total_odds *= c["odds"]
    if total_odds < 3.0:
        return []   # tři skoro-jistoty za 1.5 dohromady se nevyplatí
    return [(_ticket(legs, "acca"), round(bal * 0.03, 2))]


def _s_acca_sport_mix(pool, b, bal):
    """Sportovní Mix – čtyřka poskládaná z různých sportů (fotbal + basket + hokej…),
    ať výsledek nezávisí na jediné soutěži."""
    by_sport = {}
    for c in sorted(pool, key=lambda c: -c["prob"]):
        if c["prob"] < 0.60:
            continue
        by_sport.setdefault(c["sport"], []).append(c)
    legs = []
    for sp in by_sport:
        legs.append(by_sport[sp][0])
        if len(legs) >= 4:
            break
    if len(legs) < 3:
        return []
    return [(_ticket(legs, "acca"), round(bal * 0.02, 2))]


def _s_acca_home_wins(pool, b, bal):
    """Domácí Blok – akumulátor jen z výher domácích, čtyři zápasy."""
    legs = _acca_pick(pool, 4, lambda c: -c["prob"],
                      lambda c: c["outcome"] == "home" and c["prob"] >= 0.50,
                      one_per_league=True)
    return [(_ticket(legs, "acca"), round(bal * 0.02, 2))] if legs else []


def _s_acca_underdogs(pool, b, bal):
    """Underdog Aku – akumulátor z outsiderů s solidní šancí, malý vklad,
    velký kurz. Kombinuje "riziková value" s tiketem."""
    legs = _acca_pick(pool, 3,
                      lambda c: -(c["prob"] * c["odds"]),
                      lambda c: c["odds"] >= 2.2 and c["prob"] >= 0.35)
    return [(_ticket(legs, "acca"), round(bal * 0.012, 2))] if legs else []


def _s_acca_kelly_blend(pool, b, bal):
    """Kelly Acca – trojka, ale vklad podle Kelly kritéria (na součin
    pravděpodobností a kurzů). Konzervativnější než plochý vklad."""
    legs = _acca_pick(pool, 3, lambda c: -c["prob"], lambda c: c["prob"] >= 0.62)
    if not legs:
        return []
    t = _ticket(legs, "acca")
    kelly = _kelly_stake(t["prob"], t["odds"], bal, fraction=0.30, cap_pct=0.05)
    return [(t, kelly)] if kelly >= 1 else []


# --- čtvrtá desítka: kombinace trhů v JEDNOM zápase --------------------------
def _by_match(pool):
    d = {}
    for c in pool:
        d.setdefault(c["match_id"], []).append(c)
    return d


def _combo_pick(pool, wanted, min_prob=0.0, limit=1, sort_key=None):
    """Poskládá kombinaci z trhů TÉHOŽ zápasu. wanted = seznam funkcí, každá
    vybere jednu nohu; kombinace vznikne jen když se najdou všechny."""
    matches = _by_match(pool)
    scored = []
    for mid, cands in matches.items():
        ranked = sorted(cands, key=lambda c: -c["prob"])
        legs = []
        for want in wanted:
            # hledat jen mezi trhy, které v tiketu ještě nejsou – jinak by
            # dva stejné filtry vybraly tutéž nohu a kombinace by nevznikla
            taken = {id(x) for x in legs}
            hit = next((c for c in ranked if id(c) not in taken and want(c)), None)
            if not hit:
                legs = []
                break
            legs.append(hit)
        if not legs or not legs[0].get("exp_goals"):
            continue
        t = _ticket(legs, "combo")
        if t["prob"] >= min_prob and t["odds"] > 1.05:
            scored.append(t)
    scored.sort(key=sort_key or (lambda t: -t["prob"]))
    return scored[:limit]


def _s_combo_win_over(pool, b, bal):
    """Vítěz+Góly Vilém – favorit vyhraje A padne aspoň pár gólů."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] in ("home", "away") and c["prob"] >= 0.45,
                            lambda c: c["outcome"].startswith("over")], min_prob=0.25, limit=2)
    return [(t, round(bal * 0.025, 2)) for t in ts]


def _s_combo_win_under(pool, b, bal):
    """Uzavřený Uwe – favorit vyhraje, ale zápas bude opatrný."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] in ("home", "away") and c["prob"] >= 0.45,
                            lambda c: c["outcome"].startswith("under")], min_prob=0.25, limit=2)
    return [(t, round(bal * 0.025, 2)) for t in ts]


def _s_combo_btts_over(pool, b, bal):
    """Přestřelka Přemysl – remíza nepadne a góly ano.

    Pozn.: "oba dají gól" (BTTS) by sedělo líp, jenže ESPN na tenhle trh
    kurz nedává, takže se do nabídky vůbec nedostane."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] in ("home", "away"),
                            lambda c: c["outcome"].startswith("over")],
                     min_prob=0.25, limit=2, sort_key=lambda t: -t["odds"])
    return [(t, round(bal * 0.025, 2)) for t in ts]


def _s_combo_ah_over(pool, b, bal):
    """Handicapový Hynek – handicap plus gólová linie."""
    ts = _combo_pick(pool, [lambda c: c["outcome"].startswith("ah_"),
                            lambda c: c["outcome"].startswith("over")], min_prob=0.25, limit=2)
    return [(t, round(bal * 0.025, 2)) for t in ts]


def _s_combo_safe(pool, b, bal):
    """Jistá Jiřina – jen kombinace, které i po spojení drží nad 60 %."""
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.70,
                            lambda c: c["prob"] >= 0.62], min_prob=0.50, limit=3)
    return [(t, round(bal * 0.03, 2)) for t in ts]


def _s_combo_risky(pool, b, bal):
    """Odvážný Otakar – kombinace s co nejvyšším kurzem, drobný vklad."""
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.30,
                            lambda c: c["prob"] >= 0.30], min_prob=0.08,
                     limit=3, sort_key=lambda t: -t["odds"])
    return [(t, round(bal * 0.01, 2)) for t in ts]


def _s_combo_value(pool, b, bal):
    """Výhodný Vendelín – kombinace jen tehdy, když má i po spojení kladné EV."""
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.50, lambda c: c["prob"] >= 0.50],
                     min_prob=0.20, limit=6, sort_key=lambda t: -(t["prob"] * t["odds"]))
    ok = [t for t in ts if t["prob"] * t["odds"] - 1 > 0.05][:2]
    return [(t, round(bal * 0.03, 2)) for t in ok]


def _s_combo_triple(pool, b, bal):
    """Trojkombinační Teodor – tři trhy jednoho zápasu naráz."""
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.55, lambda c: c["prob"] >= 0.45,
                            lambda c: c["prob"] >= 0.35], min_prob=0.10, limit=1)
    return [(t, round(bal * 0.02, 2)) for t in ts]


def _s_combo_home_btts(pool, b, bal):
    """Domácí Dominik – domácí vyhrají a k tomu pokryjí handicap."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] == "home",
                            lambda c: c["outcome"].startswith("ah_home")],
                     min_prob=0.20, limit=2)
    return [(t, round(bal * 0.025, 2)) for t in ts]


def _s_combo_calibrated(pool, b, bal):
    """Kalibrovaná Kamila – kombinace posuzuje podle opravené pravděpodobnosti."""
    from . import calibration
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.62, lambda c: c["prob"] >= 0.58],
                     min_prob=0.25, limit=6)
    ok = [t for t in ts if calibration.calibrate(t["prob"]) * t["odds"] - 1 > 0][:2]
    return [(t, round(bal * 0.025, 2)) for t in ok]


# --- pět nových kombinačních strategií (rozšíření kategorie na 15 členů)


def _s_combo_away_win(pool, b, bal):
    """Hostující Hrdina – host vyhraje a k tomu Under (uzavřený venkovní zápas)."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] == "away" and c["prob"] >= 0.35,
                            lambda c: c["outcome"].startswith("under") and c["prob"] >= 0.50],
                     min_prob=0.15, limit=2)
    return [(t, round(bal * 0.02, 2)) for t in ts]


def _s_combo_draw_low(pool, b, bal):
    """Nerozhodně Nikola – remíza plus Under (opatrné zápasy končí často 1:1, 0:0)."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] == "draw" and c["prob"] >= 0.22,
                            lambda c: c["outcome"].startswith("under") and c["prob"] >= 0.55],
                     min_prob=0.10, limit=2)
    return [(t, round(bal * 0.02, 2)) for t in ts]


def _s_combo_dc_over(pool, b, bal):
    """Dvojtip Dorotka – dvojtip (1X, 12, X2) plus Over. Dvojtip
    má vyšší jistotu, Over pak přidá hodnotu."""
    ts = _combo_pick(pool, [lambda c: c["outcome"] in ("dc_1x", "dc_x2", "dc_12") and c["prob"] >= 0.65,
                            lambda c: c["outcome"].startswith("over") and c["prob"] >= 0.55],
                     min_prob=0.35, limit=2)
    return [(t, round(bal * 0.03, 2)) for t in ts]


def _s_combo_super_safe(pool, b, bal):
    """Ultra Jistá Uršula – jen kombinace nad 75 % spojené pravděpodobnosti,
    malý kurz, ale prakticky jistá výhra. Frustrujícně málo tiketů,
    ale žádné velké ztráty."""
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.80, lambda c: c["prob"] >= 0.75],
                     min_prob=0.70, limit=3)
    return [(t, round(bal * 0.035, 2)) for t in ts]


def _s_combo_quad(pool, b, bal):
    """Čtyřkombinace Čestmír – čtyři trhy jednoho zápasu naráz.
    Extrémně agresivní, drobný vklad."""
    ts = _combo_pick(pool, [lambda c: c["prob"] >= 0.60,
                            lambda c: c["prob"] >= 0.55,
                            lambda c: c["prob"] >= 0.45,
                            lambda c: c["prob"] >= 0.40],
                     min_prob=0.08, limit=1)
    return [(t, round(bal * 0.012, 2)) for t in ts]


AI_MIN_WIN_PROB = 0.58   # pod tuhle hranici AI sázkaři radši nesází, i když je model natrénovaný


def _ai_score_pool(pool, min_win_prob):
    """Společný krok pro všechny AI sázkaře: obohatí kandidáty z poolu o
    win_prob z natrénovaného ML modelu (engine/ml_learner.py – stejný, co
    používá agent jako veto), přeskočí ty pod prahem. Bez natrénovaného
    modelu vrátí prázdno – žádný AI sázkař nemá hádat.

    Skóruje CELÝ pool JEDNÍM dávkovým voláním (ml_learner.predict_batch),
    ne kandidát po kandidátovi ve smyčce – pool má klidně tisíce položek
    (fotbal+basketbal+hokej dohromady) a tisíce jednotlivých volání modelu
    dokázaly na omezeném CPU (Render free tier) zaměstnat appku natolik
    dlouho, že přestala odpovídat na cokoliv jiného."""
    from . import ml_learner
    learner = ml_learner.get_learner()
    if learner.model is None or not pool:
        return []
    feats = [{"odds": c["odds"], "prob": c["prob"], "prediction": c["outcome"],
              "league": c.get("league"), **(c.get("ml_features") or {})} for c in pool]
    preds = ml_learner.predict_batch(feats)
    scored = []
    for c, pred in zip(pool, preds):
        if pred.get("model_status") != "ready":
            continue
        win_prob = pred.get("win_prob", 0.5)
        if win_prob < min_win_prob:
            continue
        # ai_prob nahrazuje "prob" pro tenhle kandidát – kombinace/akumulátory
        # se pak skládají a řadí podle NÁZORU MODELU, ne podle Poissonova
        # modelu, i když technicky pořád stojí na stejném poli "prob".
        scored.append({**c, "prob": win_prob, "raw_prob": c["prob"], "ai_prob": win_prob})
    return scored


def _s_ai_model(pool, b, bal):
    """AI Adam – nerozhoduje podle syrové ani kalibrované pravděpodobnosti
    z Poissonova modelu, ale podle SAMOSTATNĚ natrénovaného XGBoost modelu.
    Ten se učí přímo z toho, jak sázky arény doopravdy dopadly - je to
    druhý, nezávislý "názor" na každý zápas, ne jen jiné prahování
    stejného čísla."""
    params = normalize_params(b.get("params"))
    if params.get("pause_after_losses") and b.get("loss_streak", 0) >= int(params["pause_after_losses"]):
        return []
    min_win_prob = float(params.get("ai_min_win_prob", AI_MIN_WIN_PROB))
    scored = _ai_score_pool(pool, min_win_prob)
    # Řadit podle ML-implikovaného EV (win_prob × kurz), ne jen podle
    # win_prob samotné - vysoká šance na výhru s kurzem 1.05 nemá cenu.
    scored.sort(key=lambda c: -(c["prob"] * c["odds"]))

    mult = _progression_multiplier(params, b)
    out, seen_m, seen_lg = [], set(), set()
    for c in scored:
        if c["match_id"] in seen_m:
            continue
        if params.get("one_per_league") and c["league"] in seen_lg:
            continue
        stake = round(min(bal * float(params.get("stake_pct", 0.025)) * mult, bal * DAILY_STAKE_CAP_PCT), 2)
        if stake < 1:
            continue
        seen_m.add(c["match_id"]); seen_lg.add(c["league"])
        out.append((c, stake))
        if len(out) >= int(params.get("max_bets", 3)):
            break
    return out


def _s_ai_combo(pool, b, bal):
    """AI Karel – kombinace dvou trhů STEJNÉHO zápasu, ale obě nohy musí
    projít přes natrénovaný ML model (win_prob nad prahem), ne přes
    syrovou/kalibrovanou pravděpodobnost jako ostatní kombo sázkaři."""
    params = normalize_params(b.get("params"))
    if params.get("pause_after_losses") and b.get("loss_streak", 0) >= int(params["pause_after_losses"]):
        return []
    min_win_prob = float(params.get("ai_min_win_prob", AI_MIN_WIN_PROB))
    ai_pool = _ai_score_pool(pool, min_win_prob)
    if not ai_pool:
        return []
    n_legs = int(params.get("legs", 2))
    if n_legs <= 2:
        # Dvounohý tiket: jedna noha vítěz, druhá jiný trh (góly/handicap/
        # dvojtip). Bez týhle diverzity model občas vybere dvě silně
        # překrývající se varianty téže otázky (např. "1 nebo 2" a "X nebo 2"
        # najednou) - _combo_pick to správně spočítá jako prakticky nulovou
        # společnou pravděpodobnost (viz combo_probability ve scoreline gridu),
        # takže by AI Karel nikdy nic nenašel.
        wanted = [lambda c: c.get("market") == "winner", lambda c: c.get("market") != "winner"]
    else:
        wanted = [lambda c: True for _ in range(n_legs)]   # filtr na win_prob je už v _ai_score_pool
    ts = _combo_pick(ai_pool, wanted, min_prob=0.02, limit=int(params.get("max_bets", 2)),
                     sort_key=lambda t: -(t["prob"] * t["odds"]))
    mult = _progression_multiplier(params, b)
    out = []
    for t in ts:
        stake = round(min(bal * float(params.get("stake_pct", 0.02)) * mult, bal * DAILY_STAKE_CAP_PCT), 2)
        if stake < 1:
            continue
        out.append((t, stake))
    return out


def _s_ai_acca(pool, b, bal):
    """AI Klára – akumulátor z RŮZNÝCH zápasů, každá noha musí mít ML
    win_prob nad prahem (ne syrovou/kalibrovanou pravděpodobnost)."""
    params = normalize_params(b.get("params"))
    if params.get("pause_after_losses") and b.get("loss_streak", 0) >= int(params["pause_after_losses"]):
        return []
    min_win_prob = float(params.get("ai_min_win_prob", AI_MIN_WIN_PROB))
    ai_pool = _ai_score_pool(pool, min_win_prob)
    if not ai_pool:
        return []
    n_legs = int(params.get("legs", 3))
    legs = _acca_pick(ai_pool, n_legs, lambda c: -(c["prob"] * c["odds"]))
    if not legs:
        return []
    t = _ticket(legs, "acca")
    mult = _progression_multiplier(params, b)
    stake = round(min(bal * float(params.get("stake_pct", 0.02)) * mult, bal * DAILY_STAKE_CAP_PCT), 2)
    return [(t, stake)] if stake >= 1 else []


PROFILES = [
    {"id": "kelly", "name": "Kelly Kateřina", "emoji": "📐",
     "tagline": "Plný Kelly kritérium – matematicky optimální růst banku, ale vysoká volatilita.",
     "strategy": _s_kelly, "group": "single"},
    {"id": "quarter", "name": "Čtvrtinový Čeněk", "emoji": "🎯",
     "tagline": "Kvartový Kelly (25 %) – rozumný kompromis mezi růstem a rizikem.",
     "strategy": _s_quarter_kelly, "group": "single"},
    {"id": "conservative", "name": "Konzervativní Klára", "emoji": "🛡️",
     "tagline": "Jen tutovky nad 80 % jistoty, flat 3 % banku – málo sázek, málo rizika.",
     "strategy": _s_conservative, "group": "single"},
    {"id": "value", "name": "Value Hunter Viktor", "emoji": "🔍",
     "tagline": "Loví podhodnocené kurzy (edge 8+ p.b.), na absolutní jistotě mu nezáleží.",
     "strategy": _s_value_hunter, "group": "single"},
    {"id": "favorite", "name": "Favorit Fanda", "emoji": "⭐",
     "tagline": "Vždy vsadí na favorita zápasu, i když kurz nemá žádnou value.",
     "strategy": _s_favorite, "group": "single"},
    {"id": "underdog", "name": "Outsider Olda", "emoji": "🎲",
     "tagline": "Honí nejvyšší kurz s aspoň 15% šancí – vysoké riziko, vysoký výnos.",
     "strategy": _s_underdog, "group": "single"},
    # Poznámka: dříve zde byli Martingale Magda, Náhodný Norbert (kontrolní
    # skupina) a Opatrná Olga – vyřazeni v rámci zúžení skupiny 'single' na
    # 15 členů. Progresivní systémy (martingale, fibonacci, D'Alembert) mají
    # matematicky negativní očekávání a náhodný/přehnaně opatrný sázkař mají
    # dlouhodobě nejnižší výsledky.
    {"id": "disciplined", "name": "Disciplinovaný Dan", "emoji": "📋",
     "tagline": "Flat 5 %, max 2 sázky denně, diverzifikuje napříč ligami.",
     "strategy": _s_disciplined, "group": "single"},
    # --- druhá desítka ---
    {"id": "home", "name": "Domácí Dalibor", "emoji": "🏠",
     "tagline": "Vždy na domácí tým – sází čistě na výhodu domácího prostředí.",
     "strategy": _s_home, "group": "single"},
    {"id": "overs", "name": "Gólový Gustav", "emoji": "⚡",
     "tagline": "Jen Over linie – věří, že góly padnou.",
     "strategy": _s_overs, "group": "single"},
    {"id": "unders", "name": "Betonový Bedřich", "emoji": "🧱",
     "tagline": "Jen Under linie – věří na uzavřené obranné zápasy.",
     "strategy": _s_unders, "group": "single"},
    {"id": "paroli", "name": "Paroli Pavla", "emoji": "🚀",
     "tagline": "Opak Martingalu: zvyšuje po výhře, riskuje jen vyhrané peníze.",
     "strategy": _s_paroli, "group": "single"},
    {"id": "lowodds", "name": "Jistotář Jarda", "emoji": "🔒",
     "tagline": "Jen kurzy do 1.5 – hodně malých jistých výher.",
     "strategy": _s_low_odds, "group": "single"},
    {"id": "calibrated", "name": "Kalibrovaný Karel", "emoji": "🎚️",
     "tagline": "Nevěří syrové jistotě modelu, ale opravené podle skutečné úspěšnosti.",
     "strategy": _s_calibrated, "group": "single"},
    {"id": "spread", "name": "Diverzifikátor Dita", "emoji": "🕸️",
     "tagline": "Hodně malých sázek, ale nejvýš jedna na ligu – rozloží riziko.",
     "strategy": _s_spread, "group": "single"},
    {"id": "form_rio", "name": "Forma Rio", "emoji": "📶",
     "tagline": "Sází na tým v citelně lepší formě (posledních 5 zápasů) než soupeř – ale jen když k tomu kurz dává i value.",
     "strategy": _s_form_rio, "group": "single"},

    # --- třetí desítka: akumulátory přes víc zápasů ---
    {"id": "acca_duo", "name": "Dvojka Dušan", "emoji": "🎫",
     "tagline": "Dvě nejjistější na jednom tiketu – musí vyjít obě.",
     "strategy": _s_acca_duo, "group": "acca"},
    {"id": "acca_trio", "name": "Trojka Tomáš", "emoji": "🎰",
     "tagline": "Klasická trojka z tutovek.",
     "strategy": _s_acca_trio, "group": "acca"},
    {"id": "acca_penta", "name": "Pětka Pepa", "emoji": "🖐️",
     "tagline": "Pět tipů, malý vklad, velký kurz.",
     "strategy": _s_acca_penta, "group": "acca"},
    {"id": "acca_jackpot", "name": "Jackpot Jindra", "emoji": "💰",
     "tagline": "Osm tipů a drobný vklad – sní o velké výhře.",
     "strategy": _s_acca_jackpot, "group": "acca"},
    {"id": "acca_value", "name": "Hodnotový Hubert", "emoji": "🔍",
     "tagline": "Trojka poskládaná z nejlepších náskoků, ne z jistot.",
     "strategy": _s_acca_value, "group": "acca"},
    {"id": "acca_spread", "name": "Rozložený Rosťa", "emoji": "🗺️",
     "tagline": "Čtyřka, ale každý tip z jiné ligy.",
     "strategy": _s_acca_spread, "group": "acca"},
    {"id": "acca_overs", "name": "Gólová Gabriela", "emoji": "⚡",
     "tagline": "Trojka jen z Over linií.",
     "strategy": _s_acca_overs, "group": "acca"},
    {"id": "acca_favs", "name": "Favoritová Františka", "emoji": "⭐",
     "tagline": "Trojka jen z vítězů zápasu.",
     "strategy": _s_acca_favs, "group": "acca"},
    {"id": "acca_double", "name": "Dvojitý Drahoš", "emoji": "♊",
     "tagline": "Dvě dvojky místo jedné čtyřky – rozloží riziko.",
     "strategy": _s_acca_double, "group": "acca"},
    {"id": "acca_progressive", "name": "Stoupavý Standa", "emoji": "📶",
     "tagline": "Po prohře přidá do tiketu jeden tip navíc.",
     "strategy": _s_acca_progressive, "group": "acca"},
    # --- rozšíření kategorie 'acca' na 15 členů (5 nových strategií) ---
    {"id": "acca_short", "name": "Tříprocentní Trio Tereza", "emoji": "🎯",
     "tagline": "Trojka jistot, ale jen když součin kurzů je aspoň 3.0.",
     "strategy": _s_acca_short, "group": "acca"},
    {"id": "acca_sport_mix", "name": "Sportovní Mix Milan", "emoji": "🎽",
     "tagline": "Čtyřka poskládaná z různých sportů, aby výsledek nezávisel na jedné soutěži.",
     "strategy": _s_acca_sport_mix, "group": "acca"},
    {"id": "acca_home_wins", "name": "Domácí Blok Božena", "emoji": "🏟️",
     "tagline": "Čtyřka jen z výher domácích, každý zápas z jiné ligy.",
     "strategy": _s_acca_home_wins, "group": "acca"},
    {"id": "acca_underdogs", "name": "Underdog Aku Uršula", "emoji": "🚧",
     "tagline": "Trojka outsiderů s vysokou hodnotou – drobný vklad, obří kurz.",
     "strategy": _s_acca_underdogs, "group": "acca"},
    {"id": "acca_kelly_blend", "name": "Kelly Acca Alena", "emoji": "🧮",
     "tagline": "Trojka jistot s vkladem podle Kelly kritéria místo pevné částky.",
     "strategy": _s_acca_kelly_blend, "group": "acca"},
    # --- čtvrtá desítka: kombinace trhů v jednom zápase ---
    {"id": "combo_win_over", "name": "Vítěz+Góly Vilém", "emoji": "🔗",
     "tagline": "Favorit vyhraje A padne aspoň pár gólů.",
     "strategy": _s_combo_win_over, "group": "combo"},
    {"id": "combo_win_under", "name": "Uzavřený Uwe", "emoji": "🔒",
     "tagline": "Favorit vyhraje, ale zápas bude opatrný.",
     "strategy": _s_combo_win_under, "group": "combo"},
    {"id": "combo_btts_over", "name": "Přestřelka Přemysl", "emoji": "🎇",
     "tagline": "Oba dají gól a padne jich hodně.",
     "strategy": _s_combo_btts_over, "group": "combo"},
    {"id": "combo_ah_over", "name": "Handicapový Hynek", "emoji": "⚖️",
     "tagline": "Handicap plus gólová linie na jednom tiketu.",
     "strategy": _s_combo_ah_over, "group": "combo"},
    {"id": "combo_safe", "name": "Jistá Jiřina", "emoji": "🛡️",
     "tagline": "Jen kombinace, které i po spojení drží nad 60 %.",
     "strategy": _s_combo_safe, "group": "combo"},
    {"id": "combo_risky", "name": "Odvážný Otakar", "emoji": "💥",
     "tagline": "Kombinace s co nejvyšším kurzem, drobný vklad.",
     "strategy": _s_combo_risky, "group": "combo"},
    {"id": "combo_value", "name": "Výhodný Vendelín", "emoji": "📈",
     "tagline": "Kombinuje jen když má i po spojení kladné EV.",
     "strategy": _s_combo_value, "group": "combo"},
    {"id": "combo_triple", "name": "Trojkombinační Teodor", "emoji": "🧩",
     "tagline": "Tři trhy jednoho zápasu naráz.",
     "strategy": _s_combo_triple, "group": "combo"},
    {"id": "combo_home_btts", "name": "Domácí Dominik", "emoji": "🏠",
     "tagline": "Domácí vyhrají a oba týmy dají gól.",
     "strategy": _s_combo_home_btts, "group": "combo"},
    {"id": "combo_calibrated", "name": "Kalibrovaná Kamila", "emoji": "🎚️",
     "tagline": "Kombinace posuzuje podle opravené pravděpodobnosti.",
     "strategy": _s_combo_calibrated, "group": "combo"},
    # --- rozšíření kategorie 'combo' na 15 členů (5 nových strategií) ---
    {"id": "combo_away_win", "name": "Hostující Hrdina Hanuš", "emoji": "🛫",
     "tagline": "Host vyhraje a k tomu Under – uzavřený venkovní zápas.",
     "strategy": _s_combo_away_win, "group": "combo"},
    {"id": "combo_draw_low", "name": "Nerozhodně Nikola", "emoji": "🤝",
     "tagline": "Remíza plus Under – opatrné zápasy končí často 1:1 nebo 0:0.",
     "strategy": _s_combo_draw_low, "group": "combo"},
    {"id": "combo_dc_over", "name": "Dvojtip Dorotka", "emoji": "✌️",
     "tagline": "Dvojtip (1X, 12, X2) plus Over – vyšší jistota, přidaná hodnota v gólech.",
     "strategy": _s_combo_dc_over, "group": "combo"},
    {"id": "combo_super_safe", "name": "Ultra Jistá Uršula", "emoji": "🔐",
     "tagline": "Jen kombinace nad 75 % spojené pravděpodobnosti – málo tiketů, žádné velké ztráty.",
     "strategy": _s_combo_super_safe, "group": "combo"},
    {"id": "combo_quad", "name": "Čtyřkombinace Čestmír", "emoji": "🎲",
     "tagline": "Čtyři trhy jednoho zápasu naráz – extrémně agresivní, drobný vklad.",
     "strategy": _s_combo_quad, "group": "combo"},
    # --- AI sázkaři: rozhodují podle natrénovaného ML modelu, ne podle
    # Poissonova modelu ani jeho kalibrace – druhý, nezávislý pohled, po
    # jednom pro každou kategorii ---
    {"id": "ai_model", "name": "AI Adam", "emoji": "🤖",
     "tagline": "Sází podle natrénovaného ML modelu (XGBoost) místo syrové "
                "pravděpodobnosti z modelu skóre – dokud model není natrénovaný "
                "na dost datech, radši nesází vůbec.",
     "strategy": _s_ai_model, "group": "ai"},
    {"id": "ai_combo", "name": "AI Karel", "emoji": "🤖🔗",
     "tagline": "Kombinace dvou trhů jednoho zápasu – obě nohy musí projít "
                "přes natrénovaný ML model, ne přes syrovou pravděpodobnost.",
     "strategy": _s_ai_combo, "group": "ai"},
    {"id": "ai_acca", "name": "AI Klára", "emoji": "🤖🎯",
     "tagline": "Akumulátor tří zápasů – každá noha musí projít přes "
                "natrénovaný ML model, ne přes syrovou pravděpodobnost.",
     "strategy": _s_ai_acca, "group": "ai"},
]
_BY_ID = {p["id"]: p for p in PROFILES}


# ---------------------------------------------------------------------------
# Vlastní sázkaři – strategie poskládaná z parametrů z průvodce
# ---------------------------------------------------------------------------
MARKETS = {
    "any":    ("cokoliv", lambda c: True),
    "winner": ("jen vítěz zápasu (1X2)", lambda c: c["market"] == "winner"),
    "home":   ("jen domácí", lambda c: c["outcome"] == "home"),
    "away":   ("jen hosté", lambda c: c["outcome"] == "away"),
    "over":   ("jen Over linie", lambda c: c["outcome"].startswith("over")),
    "under":  ("jen Under linie", lambda c: c["outcome"].startswith("under")),
}
PROGRESSIONS = {
    "none":       "plochý vklad",
    "martingale": "po prohře dvojnásobek",
    "fibonacci":  "po prohře další Fibonacciho číslo",
    "dalembert":  "po prohře +1 jednotka",
    "paroli":     "po výhře dvojnásobek",
}
STAKE_MODES = {"flat": "pevné % banku", "kelly": "Kelly kritérium"}


def default_params() -> dict:
    return {"min_prob": 0.60, "min_odds": 1.20, "max_odds": 10.0,
            "market": "any", "stake_mode": "flat", "stake_pct": 0.03,
            "kelly_fraction": 0.25, "max_bets": 3, "progression": "none",
            "one_per_league": False, "pause_after_losses": 0,
            # legs/leg_min_prob: jen pro group="combo"/"acca" (viz _s_custom_combo,
            # _s_custom_acca) - kolik nohou tiket má a jaká minimální pravděpodobnost
            # se u KAŽDÉ z nich vyžaduje. require_positive_ev: filtr navíc podle
            # KALIBROVANÉ pravděpodobnosti (ne syrové z modelu) - syrová pravděpodobnost
            # bývá přehnaně sebejistá, takže sázka s "dobrým EV" podle ní ve
            # skutečnosti dlouhodobě prodělává (zjištěno na aréně: jednotlivé sázky
            # měly 53% win rate, ale přesto -12,9 % ROI).
            "legs": 2, "leg_min_prob": 0.55, "require_positive_ev": False,
            "ai_min_win_prob": AI_MIN_WIN_PROB}


def normalize_params(params: dict) -> dict:
    """Očistí parametry z průvodce – neznámé nebo nesmyslné hodnoty spadnou na
    výchozí. Bez toho by prázdný formulář vyrobil sázkaře s trhem "" a prázdnou
    progresí, který by se pak choval nepředvídatelně."""
    d = default_params()
    p = {**d, **(params or {})}

    def num(key, lo, hi):
        try:
            return max(lo, min(hi, float(p.get(key))))
        except (TypeError, ValueError):
            return d[key]

    out = {
        "market": p.get("market") if p.get("market") in MARKETS else d["market"],
        "progression": p.get("progression") if p.get("progression") in PROGRESSIONS else d["progression"],
        "stake_mode": p.get("stake_mode") if p.get("stake_mode") in STAKE_MODES else d["stake_mode"],
        "min_prob": num("min_prob", 0.01, 0.99),
        "min_odds": num("min_odds", 1.01, 100.0),
        "max_odds": num("max_odds", 1.01, 1000.0),
        "stake_pct": num("stake_pct", 0.001, DAILY_STAKE_CAP_PCT),
        "kelly_fraction": num("kelly_fraction", 0.01, 1.0),
        "max_bets": int(num("max_bets", 1, 20)),
        "pause_after_losses": int(num("pause_after_losses", 0, 20)),
        "one_per_league": bool(p.get("one_per_league")),
        "legs": int(num("legs", 2, 5)),
        "leg_min_prob": num("leg_min_prob", 0.01, 0.99),
        "require_positive_ev": bool(p.get("require_positive_ev")),
    }
    if out["max_odds"] < out["min_odds"]:
        out["max_odds"] = out["min_odds"]
    return out


def _progression_multiplier(params, b):
    prog = params.get("progression", "none")
    losses = b.get("loss_streak", 0)
    wins = b.get("win_streak", 0)
    if prog == "martingale":
        return 2 ** min(losses, 5)
    if prog == "fibonacci":
        a, bb = 1, 1
        for _ in range(min(losses, 10)):
            a, bb = bb, a + bb
        return a
    if prog == "dalembert":
        return 1 + losses
    if prog == "paroli":
        return 2 ** min(wins, 3)
    return 1


def _s_custom(pool, b, bal):
    """Strategie vlastního sázkaře – řídí se parametry z průvodce, ne kódem."""
    params = normalize_params(b.get("params"))
    if params.get("pause_after_losses") and b.get("loss_streak", 0) >= int(params["pause_after_losses"]):
        return []
    ok = MARKETS.get(params.get("market", "any"), MARKETS["any"])[1]
    cands = [c for c in pool
             if c["prob"] >= float(params["min_prob"])
             and float(params["min_odds"]) <= c["odds"] <= float(params["max_odds"])
             and ok(c)]
    if params.get("require_positive_ev"):
        cands = [c for c in cands if _calibrated_ev(c["prob"], c["odds"]) > 0]
    cands.sort(key=lambda c: -c["prob"])

    mult = _progression_multiplier(params, b)
    out, seen_m, seen_lg = [], set(), set()
    for c in cands:
        if c["match_id"] in seen_m:
            continue
        if params.get("one_per_league") and c["league"] in seen_lg:
            continue
        if params.get("stake_mode") == "kelly":
            stake = _kelly_stake(c["prob"], c["odds"], bal, float(params.get("kelly_fraction", 0.25)),
                                 cap_pct=0.25, confidence_scale=_conf_scale(c))
        else:
            stake = bal * float(params.get("stake_pct", 0.03))
        stake = round(min(stake * mult, bal * DAILY_STAKE_CAP_PCT), 2)
        if stake < 1:
            continue
        seen_m.add(c["match_id"]); seen_lg.add(c["league"])
        out.append((c, stake))
        if len(out) >= int(params.get("max_bets", 3)):
            break
    return out


def _calibrated_ev(prob: float, odds: float) -> float:
    """EV podle KALIBROVANÉ pravděpodobnosti, ne syrové z modelu. Syrová
    pravděpodobnost bývá přehnaně sebejistá – aréna ukázala, že jednotlivé
    sázky s ní mají solidní 53% win rate, ale i tak -12,9 % ROI, protože
    "výhodné" kurzy podle syrové p ve skutečnosti marži sázkovky nepokryjí."""
    from . import calibration
    return calibration.calibrate(prob) * odds - 1.0


def _s_custom_combo(pool, b, bal):
    """Generický kombo sázkař (parametry z generate_optimal_bettor, group="combo") –
    N nohou (params['legs']) STEJNÉHO zápasu, každá musí mít prob >= leg_min_prob."""
    params = normalize_params(b.get("params"))
    if params.get("pause_after_losses") and b.get("loss_streak", 0) >= int(params["pause_after_losses"]):
        return []
    n_legs = int(params.get("legs", 2))
    leg_min = float(params.get("leg_min_prob", 0.55))
    wanted = [lambda c, lp=leg_min: c["prob"] >= lp for _ in range(n_legs)]
    ts = _combo_pick(pool, wanted, min_prob=0.05, limit=int(params.get("max_bets", 2)),
                     sort_key=lambda t: -(t["prob"] * t["odds"]))
    if params.get("require_positive_ev"):
        ts = [t for t in ts if _calibrated_ev(t["prob"], t["odds"]) > 0]
    mult = _progression_multiplier(params, b)
    out = []
    for t in ts:
        stake = round(min(bal * float(params.get("stake_pct", 0.02)) * mult, bal * DAILY_STAKE_CAP_PCT), 2)
        if stake < 1:
            continue
        out.append((t, stake))
    return out


def _s_custom_acca(pool, b, bal):
    """Generický akumulátorový sázkař (group="acca") – N nohou z RŮZNÝCH
    zápasů, každá musí mít prob >= leg_min_prob."""
    params = normalize_params(b.get("params"))
    if params.get("pause_after_losses") and b.get("loss_streak", 0) >= int(params["pause_after_losses"]):
        return []
    n_legs = int(params.get("legs", 3))
    leg_min = float(params.get("leg_min_prob", 0.55))
    legs = _acca_pick(pool, n_legs, lambda c: -(c["prob"] * c["odds"]),
                      lambda c: c["prob"] >= leg_min)
    if not legs:
        return []
    t = _ticket(legs, "acca")
    if params.get("require_positive_ev") and _calibrated_ev(t["prob"], t["odds"]) <= 0:
        return []
    mult = _progression_multiplier(params, b)
    stake = round(min(bal * float(params.get("stake_pct", 0.02)) * mult, bal * DAILY_STAKE_CAP_PCT), 2)
    return [(t, stake)] if stake >= 1 else []


def describe_params(params: dict) -> str:
    """Lidský popis strategie – ať sázkař z průvodce má stejně srozumitelnou
    charakteristiku jako ti vestavění."""
    p = normalize_params(params)
    bits = [f"jistota od {round(p['min_prob'] * 100)} %",
            f"kurz {cz_num(p['min_odds'])}–{cz_num(p['max_odds'])}"]
    if p.get("market") != "any":
        bits.append(MARKETS.get(p["market"], ("?", None))[0])
    bits.append(f"{cz_num(round(p['stake_pct'] * 100, 1))} % banku"
                if p.get("stake_mode") == "flat"
                else f"Kelly {round(float(p.get('kelly_fraction', 0.25)) * 100)} %")
    if p.get("progression") != "none":
        bits.append(PROGRESSIONS.get(p["progression"], p["progression"]))
    n = int(p["max_bets"])
    bits.append(f"max {n} " + ("sázka" if n == 1 else "sázky" if n < 5 else "sázek"))
    if p.get("one_per_league"):
        bits.append("nejvýš 1 na ligu")
    if p.get("pause_after_losses"):
        bits.append(f"pauza po {p['pause_after_losses']} prohrách")
    return ", ".join(bits).capitalize() + "."


# Jméno se generuje z povahy strategie, ať sedí k tomu, co sázkař dělá.
# Přídavné jméno je ve dvou rodech, aby nevznikaly zrůdnosti typu
# "Počtářský Pavla" – jména jsou proto rozdělená podle rodu.
_NAME_BY_TRAIT = {
    "martingale": ("Dvojnásobný", "Dvojnásobná", "📈"),
    "fibonacci":  ("Spirálový", "Spirálová", "🌀"),
    "dalembert":  ("Vyvážený", "Vyvážená", "⚖️"),
    "paroli":     ("Rozjetý", "Rozjetá", "🚀"),
    "over":       ("Ofenzivní", "Ofenzivní", "⚡"),
    "under":      ("Obranný", "Obranná", "🧱"),
    "home":       ("Domácký", "Domácká", "🏠"),
    "away":       ("Cestovní", "Cestovní", "✈️"),
    "winner":     ("Vítězný", "Vítězná", "🏆"),
    "kelly":      ("Počtářský", "Počtářská", "📐"),
    "safe":       ("Opatrný", "Opatrná", "🐢"),
    "risky":      ("Riskantní", "Riskantní", "💥"),
    "steady":     ("Klidný", "Klidná", "🎯"),
}
_MALE = ["Adam", "Bohuš", "Cyril", "David", "Emil", "Filip", "Gustav", "Hynek",
         "Ivan", "Jakub", "Karel", "Lubor", "Marek", "Norbert", "Oldřich",
         "Petr", "Radim", "Slavoj", "Tomáš", "Viktor", "Zdeněk"]
_FEMALE = ["Alena", "Blanka", "Cecílie", "Denisa", "Eliška", "Františka", "Gita",
           "Hana", "Iva", "Jitka", "Klára", "Lenka", "Magda", "Nela", "Olga",
           "Pavla", "Renata", "Simona", "Tereza", "Vlasta", "Zuzana"]


def generate_name(params: dict, taken=()) -> tuple:
    """(jméno, emoji) odvozené z povahy strategie – "Ofenzivní Gustav" apod.
    Aliterace (stejné počáteční písmeno) se použije, když je volná."""
    p = normalize_params(params)
    if p.get("progression") != "none":
        trait = p["progression"]
    elif p.get("market") in ("over", "under", "home", "away", "winner"):
        trait = p["market"]
    elif p.get("stake_mode") == "kelly":
        trait = "kelly"
    elif p.get("min_prob", 0) >= 0.75:
        trait = "safe"
    elif p.get("min_odds", 0) >= 3.0 or p.get("stake_pct", 0) >= 0.08:
        trait = "risky"
    else:
        trait = "steady"
    masc, fem, emoji = _NAME_BY_TRAIT.get(trait, ("Nový", "Nová", "🎲"))
    taken = set(taken)
    male = random.choice([True, False])
    for use_male in ([male, not male] if True else []):
        adj = masc if use_male else fem
        names = _MALE if use_male else _FEMALE
        letter = adj[0].upper()
        ordered = [n for n in names if n.startswith(letter)] + [n for n in names if not n.startswith(letter)]
        for first in ordered:
            name = f"{adj} {first}"
            if name not in taken:
                return name, emoji
    return f"{masc} {uuid.uuid4().hex[:4]}", emoji


# ---------------------------------------------------------------------------
# Generátor sázkařů – hledá v NASBÍRANÉ HISTORII (napříč VŠEMI sázkaři),
# jaké kombinace parametrů (rozsah kurzu, jistota, typ trhu) mají skutečně
# nejlepší ROI, a z nich složí parametry pro nového sázkaře. Je to datově
# řízené, ne inspirované nějakým vzorem – čerpá jen z toho, co appka sama
# naměřila.
# ---------------------------------------------------------------------------
GEN_MIN_TOTAL_BETS = 40    # kolik vyhodnocených sázek napříč aparátem je potřeba, než má smysl něco počítat
GEN_MIN_BUCKET_BETS = 8    # kolik sázek musí mít samotný segment (kurz/trh), než se bere vážně

ODDS_BUCKETS = [
    (1.01, 1.30, "1,01–1,30"), (1.30, 1.60, "1,30–1,60"), (1.60, 2.00, "1,60–2,00"),
    (2.00, 3.00, "2,00–3,00"), (3.00, 100.0, "3,00+"),
]
PROB_BUCKETS = [
    (0.0, 0.55, "pod 55 %"), (0.55, 0.65, "55–65 %"), (0.65, 0.75, "65–75 %"),
    (0.75, 0.85, "75–85 %"), (0.85, 1.01, "nad 85 %"),
]
MARKET_OF = {
    "winner": ("home", "away", "draw", "dc_1x", "dc_12", "dc_x2", "dnb_home", "dnb_away"),
}


def _all_settled_bets() -> list:
    """Všechny vyhodnocené (won/lost) JEDNOTLIVÉ sázky napříč všemi sázkaři
    arény, s doplněným 'market' polem (winner/goals/handicap/jiné)."""
    st = load_state()
    out = []
    for b in st.values():
        for bet in b.get("bets", []):
            if bet.get("status") not in ("won", "lost") or bet.get("legs"):
                continue   # tikety mají jinou dynamiku, viz _all_settled_tickets
            oc = bet.get("outcome", "")
            if oc in MARKET_OF["winner"]:
                market = "winner"
            elif oc.startswith(("over", "under")):
                market = "goals"
            elif oc.startswith("ah_"):
                market = "handicap"
            else:
                market = "jiné"
            out.append({**bet, "market": market})
    return out


def _all_settled_tickets(kind: str) -> list:
    """Všechny vyhodnocené tikety daného druhu ("combo"/"acca") napříč
    sázkaři arény, s doplněným 'leg_min_prob' (nejslabší noha tiketu –
    tou se dá tiket "vyladit" stejně jako jednotlivá sázka svou prob)."""
    st = load_state()
    out = []
    for b in st.values():
        for bet in b.get("bets", []):
            if bet.get("status") not in ("won", "lost") or bet.get("kind") != kind:
                continue
            legs = bet.get("legs") or []
            leg_probs = [l.get("prob", 0) for l in legs]
            out.append({**bet, "leg_min_prob": min(leg_probs) if leg_probs else 0.0})
    return out


def _bucket_stats(bets: list, key_fn, buckets) -> list:
    """Rozdělí sázky do binů (podle key_fn), spočítá n/win_rate/ROI pro
    každý. Bez dost dat (< GEN_MIN_BUCKET_BETS) bin ignoruje – jinak by
    generátor mohl postavit sázkaře na 3 náhodných výhrách."""
    out = []
    for lo, hi, label in buckets:
        sub = [b for b in bets if lo <= key_fn(b) < hi]
        if len(sub) < GEN_MIN_BUCKET_BETS:
            continue
        staked = sum(b.get("stake", 0) for b in sub)
        pnl = sum(b.get("pnl", 0) for b in sub)
        won = sum(1 for b in sub if b["status"] == "won")
        out.append({
            "range": (lo, hi), "label": label, "n": len(sub),
            "win_rate": round(won / len(sub) * 100, 1),
            "roi": round(pnl / staked * 100, 1) if staked else 0.0,
        })
    return out


def analyze_best_params(group: str = "single") -> dict:
    """Najde nejvýnosnější rozsah kurzu a jistoty z NASBÍRANÉ historie
    arény pro danou skupinu ("single"/"combo"/"acca"). Combo/acca se dřív
    z generátoru úplně vynechávaly (_all_settled_bets výslovně přeskakuje
    tikety) – proto "Vygenerovat z dat" uměl postavit jen sázkaře na
    jednotlivé sázky, i když aréna má celou dobu i kombinace a akumulátory.
    Vrací navržené parametry + odůvodnění, nebo available=False."""
    if group == "single":
        bets = _all_settled_bets()
        prob_key = lambda b: b.get("prob", 0)
    else:
        bets = _all_settled_tickets(group)
        prob_key = lambda b: b.get("leg_min_prob", 0)

    if len(bets) < GEN_MIN_TOTAL_BETS:
        return {"available": False, "reason": "not_enough_data", "group": group,
                "have": len(bets), "need": GEN_MIN_TOTAL_BETS}

    odds_stats = _bucket_stats(bets, lambda b: b.get("odds", 0), ODDS_BUCKETS)
    prob_stats = _bucket_stats(bets, prob_key, PROB_BUCKETS)

    market_stats = []
    if group == "single":
        for mk in ("winner", "goals", "handicap"):
            sub = [b for b in bets if b["market"] == mk]
            if len(sub) < GEN_MIN_BUCKET_BETS:
                continue
            staked = sum(b.get("stake", 0) for b in sub)
            pnl = sum(b.get("pnl", 0) for b in sub)
            market_stats.append({
                "market": mk, "n": len(sub),
                "roi": round(pnl / staked * 100, 1) if staked else 0.0,
            })

    if not odds_stats or not prob_stats:
        return {"available": False, "reason": "not_enough_bucket_data", "group": group, "have": len(bets)}

    best_odds = max(odds_stats, key=lambda x: x["roi"])
    best_prob = max(prob_stats, key=lambda x: x["roi"])
    best_market = max(market_stats, key=lambda x: x["roi"]) if market_stats else None

    # Pokud je nejlepší ROI segment stejně pod nulou jako všechno ostatní,
    # nemá smysl z toho vyrábět sázkaře – radši to appka řekne narovinu.
    if best_odds["roi"] <= 0 and best_prob["roi"] <= 0:
        return {"available": False, "reason": "no_profitable_segment", "group": group,
                "have": len(bets), "best_odds_roi": best_odds["roi"], "best_prob_roi": best_prob["roi"]}

    params = default_params()
    params["min_odds"] = round(best_odds["range"][0], 2)
    params["max_odds"] = round(min(best_odds["range"][1], 100.0), 2)
    if group == "single":
        params["min_prob"] = round(best_prob["range"][0], 2) if best_prob["range"][0] > 0 else 0.5
        if best_market and best_market["market"] != "goals":
            # market="any" pokrývá goals i winner i handicap; jediné omezitelné
            # market filtry v custom systému jsou home/away/over/under/winner
            if best_market["market"] == "winner":
                params["market"] = "winner"
        params["stake_pct"] = 0.025
        params["max_bets"] = 3
    else:
        params["leg_min_prob"] = round(best_prob["range"][0], 2) if best_prob["range"][0] > 0 else 0.55
        params["legs"] = 2 if group == "combo" else 3
        # menší vklad než u jednotlivých sázek – tikety mají o dost nižší
        # win rate (víc nohou musí sednout najednou), takže i menší chyba
        # v odhadu segmentu bolí víc.
        params["stake_pct"] = 0.02
        params["max_bets"] = 2
    # Nová generace vždycky filtruje na KALIBROVANOU pravděpodobnost, ne
    # syrovou z modelu – aréna ukázala, že syrová prob dá slušný win rate,
    # ale i tak záporné ROI, protože nadhodnocuje jistotu (viz _calibrated_ev).
    params["require_positive_ev"] = True

    return {
        "available": True, "group": group,
        "params": normalize_params(params),
        "evidence": {
            "total_bets_analyzed": len(bets),
            "best_odds_bucket": best_odds,
            "best_prob_bucket": best_prob,
            "best_market": best_market,
            "all_odds_buckets": odds_stats,
            "all_prob_buckets": prob_stats,
            "all_markets": market_stats,
        },
    }


_GEN_NAME_PREFIX = {"single": "Analytik", "combo": "Kombinér", "acca": "Akumulátor"}
_GEN_EMOJI = {"single": "🧬", "combo": "🧬🔗", "acca": "🧬🎯"}


def generate_optimal_bettor(group: str = "single") -> dict:
    """Vytvoří nového sázkaře s parametry odvozenými z analyze_best_params()
    pro danou skupinu. Jméno a tagline explicitně říkají, že vznikl z dat,
    ne z šablony."""
    analysis = analyze_best_params(group)
    if not analysis.get("available"):
        return {"created": False, **analysis}

    st = load_state()
    ev = analysis["evidence"]
    params = analysis["params"]

    prefix = _GEN_NAME_PREFIX.get(group, "Analytik")
    emoji = _GEN_EMOJI.get(group, "🧬")   # vlastní odznak pro AI-generované, ať je na první pohled odlišitelný

    # Pořadové číslo, aby šlo mít víc generací a rozlišit je
    gen_n = 1 + sum(1 for v in st.values() if str(v.get("name", "")).startswith(prefix))
    name = f"{prefix} {gen_n}"

    MARKET_CZ = {"winner": "vítěz", "goals": "góly", "handicap": "handicap"}
    unit = "vyhodnocených sázek" if group == "single" else "vyhodnocených tiketů"
    prob_label = "jistota" if group == "single" else f"jistota nohy ({params['legs']}× v tiketu)"
    tagline = (
        f"Vygenerováno z {ev['total_bets_analyzed']} {unit} arény: "
        f"kurzy {ev['best_odds_bucket']['label']} (ROI {cz_num(ev['best_odds_bucket']['roi'])} %), "
        f"{prob_label} {ev['best_prob_bucket']['label']} (ROI {cz_num(ev['best_prob_bucket']['roi'])} %)"
        + (f", trh {MARKET_CZ.get(ev['best_market']['market'], ev['best_market']['market'])}"
           if ev.get('best_market') else "")
        + ", jen kalibrované kladné EV."
    )

    bettor = add_bettor(params, name=name, emoji=emoji, start_balance=DEFAULT_START_BALANCE)
    bettor["bid"] = bettor.get("id")
    st2 = load_state()
    st2[bettor["id"]]["tagline"] = tagline
    st2[bettor["id"]]["group"] = group
    st2[bettor["id"]]["generated"] = True
    save_state(st2)

    return {"created": True, "bettor": bettor, "tagline": tagline, "evidence": ev,
            "params": params, "group": group}


def add_bettor(params: dict, name: str = None, emoji: str = None,
               start_balance: float = DEFAULT_START_BALANCE) -> dict:
    st = load_state()
    params = normalize_params(params)
    if not name:
        name, gen_emoji = generate_name(params, taken=[v.get("name") for v in st.values()])
        emoji = emoji or gen_emoji
    bid = "cust_" + uuid.uuid4().hex[:8]
    st[bid] = {
        "name": name, "emoji": emoji or "🎲", "tagline": describe_params(params),
        "balance": float(start_balance), "start_balance": float(start_balance),
        "bets": [], "last_run_date": None, "ran_hours": [], "loss_streak": 0,
        "win_streak": 0, "custom": True, "params": params, "group": "single",
        "transactions": [{"ts": int(time.time()), "type": "start",
                          "amount": float(start_balance), "note": "Počáteční vklad"}],
    }
    save_state(st)
    return {"id": bid, **st[bid]}


def reset_all(start_balance: float = DEFAULT_START_BALANCE) -> dict:
    """Kompletně vynuluje historii sázek u VŠECH sázkařů (vestavěných
    i vlastních) a nastaví jim nový počáteční bank. Sázkaři samotní
    zůstávají – jen se jim smaže bankroll a všechny sázky, aby začali
    znovu od nuly. Zkušenost (dovednost) tím pádem znovu naroste na plno
    až po ~20 nových vyhodnocených sázkách."""
    st = load_state()
    n = 0
    for bid, b in st.items():
        b["balance"] = float(start_balance)
        b["start_balance"] = float(start_balance)
        b["bets"] = []
        b["last_run_date"] = None
        b["ran_hours"] = []
        b["loss_streak"] = 0
        b["win_streak"] = 0
        # Aktualizovat skupinu/název/tagline z PROFILES – bez toho by se změny
        # v definici profilu (třeba přiřazení do jiné kategorie) po resetu
        # neprojevily. Vlastní sázkaři (custom=True) v PROFILES nejsou, takže
        # se u nich zachová původní skupina.
        prof = _BY_ID.get(bid)
        if prof and not b.get("custom"):
            b["group"] = prof.get("group", b.get("group", "single"))
            b["name"] = prof["name"]
            b["emoji"] = prof["emoji"]
            b["tagline"] = prof["tagline"]
        b["transactions"] = [{"ts": int(time.time()), "type": "start",
                              "amount": float(start_balance), "note": "Reset"}]
        n += 1
    save_state(st)
    return {"reset": n, "start_balance": float(start_balance)}


def reset_bettor(bid: str, start_balance: float = DEFAULT_START_BALANCE) -> dict:
    """Stejné jako reset_all, ale jen pro JEDNOHO sázkaře – pravé tlačítko
    myši → "Resetovat sázky" u konkrétní karty v aréně."""
    st = load_state()
    b = st.get(bid)
    if b is None:
        return {"reset": False, "error": "not_found"}
    b["balance"] = float(start_balance)
    b["start_balance"] = float(start_balance)
    b["bets"] = []
    b["last_run_date"] = None
    b["ran_hours"] = []
    b["loss_streak"] = 0
    b["win_streak"] = 0
    prof = _BY_ID.get(bid)
    if prof and not b.get("custom"):
        b["group"] = prof.get("group", b.get("group", "single"))
        b["name"] = prof["name"]
        b["emoji"] = prof["emoji"]
        b["tagline"] = prof["tagline"]
    b["transactions"] = [{"ts": int(time.time()), "type": "start",
                          "amount": float(start_balance), "note": "Reset"}]
    save_state(st)
    return {"reset": True, "id": bid, "start_balance": float(start_balance)}


def retrain_bettor(bid: str) -> dict:
    """Přetrénování za jedním konkrétním sázkařem – pravé tlačítko myši →
    "Přetrénovat" u karty v aréně.

    Skládá se ze dvou kroků, oba sdílené napříč celou arénou (žádný
    sázkař nemá vlastní izolovaný model – ML model i kalibrace jsou
    společné appce), plus třetí krok navíc pro vlastní/vygenerované
    sázkaře, kteří MAJÍ svoje vlastní tunable parametry:
      1. ml_learner.train_model() – přetrénuje sdílený XGBoost model
         (na němž stojí AI Adam/Karel/Klára) na nejnovější historii.
      2. calibration.rebuild() – přepočítá kalibrační křivku (na ní
         stojí filtr require_positive_ev u vygenerovaných sázkařů).
      3. U custom/vygenerovaných sázkařů navíc znovu spustí
         analyze_best_params() pro jejich skupinu a přeladí JEHO VLASTNÍ
         parametry (min_odds/min_prob/leg_min_prob/...) podle nejčerstvějších
         dat arény – ne jen sdílený model."""
    from . import ml_learner, calibration
    st = load_state()
    b = st.get(bid)
    if b is None:
        return {"retrained": False, "error": "not_found"}

    out = {"retrained": True, "id": bid}
    try:
        out["ml_train"] = ml_learner.train_model(days=30)
    except Exception as e:
        out["ml_train"] = False
        out["ml_train_error"] = str(e)
    try:
        calibration.rebuild()
        out["calibration"] = True
    except Exception as e:
        out["calibration"] = False
        out["calibration_error"] = str(e)

    if b.get("custom"):
        analysis = analyze_best_params(b.get("group", "single"))
        out["params_updated"] = bool(analysis.get("available"))
        if analysis.get("available"):
            b["params"] = analysis["params"]
            b["tagline"] = describe_params(analysis["params"])
            save_state(st)
        out["analysis"] = analysis
    else:
        out["params_updated"] = False   # vestavění sázkaři nemají tunable parametry

    return out


def delete_bettor(bid: str) -> bool:
    st = load_state()
    if bid not in st:
        return False
    del st[bid]
    save_state(st)
    _deleted_ids().add(bid)
    return True


def _deleted_ids() -> set:
    """Smazaní vestavění sázkaři se nesmí při dalším startu vrátit."""
    d = storage.load("bettors_deleted.json", {"ids": []}) or {"ids": []}
    ids = set(d.get("ids") or [])

    class _S(set):
        def add(self, x):
            super().add(x)
            storage.save("bettors_deleted.json", {"ids": sorted(self)})
    return _S(ids)


def deposit(bid: str, amount: float, note: str = "") -> dict:
    """Vklad peněz sázkaři. Zapíše se do historie transakcí a zvýší bank i
    start_balance – jinak by se dodané peníze počítaly jako zisk."""
    st = load_state()
    b = st.get(bid)
    if not b:
        return None
    amount = round(float(amount), 2)
    if amount == 0:
        return None
    b["balance"] = round(b["balance"] + amount, 2)
    b["start_balance"] = round(b.get("start_balance", 0) + amount, 2)
    b.setdefault("transactions", []).insert(0, {
        "ts": int(time.time()),
        "type": "deposit" if amount > 0 else "withdraw",
        "amount": amount, "note": note or "",
    })
    save_state(st)
    return {"id": bid, "balance": b["balance"], "start_balance": b["start_balance"]}


# ---------------------------------------------------------------------------
# Úložiště
# ---------------------------------------------------------------------------
def _default_state():
    return {
        p["id"]: {
            "name": p["name"], "emoji": p["emoji"], "tagline": p["tagline"],
            "group": p.get("group", "single"),
            "balance": DEFAULT_START_BALANCE, "start_balance": DEFAULT_START_BALANCE,
            "bets": [], "last_run_date": None, "ran_hours": [], "loss_streak": 0,
        } for p in PROFILES
    }


def load_state():
    st = storage.load(FILE, None)
    if st is None:
        st = _default_state()
        storage.save(FILE, st)
    # doplní chybějící vestavěné sázkaře (když PROFILES přibydou), ale NE ty,
    # které uživatel smazal – jinak by se po restartu vraceli
    deleted = set((storage.load("bettors_deleted.json", {}) or {}).get("ids") or [])
    changed = False
    for p in PROFILES:
        if p["id"] not in st and p["id"] not in deleted:
            st[p["id"]] = _default_state()[p["id"]]
            changed = True
        elif p["id"] in st and not st[p["id"]].get("custom"):
            # Definice v PROFILES se mohla změnit (např. sázkař přeřazený do
            # jiné skupiny – viz AI Adam/Karel/Klára přesunutí do "ai") –
            # bez týhle synchronizace by appka dál používala starou hodnotu
            # uloženou ze dne, kdy sázkař poprvé vznikl.
            b = st[p["id"]]
            if b.get("group") != p.get("group"):
                b["group"] = p.get("group", "single")
                changed = True
    # Vyřazené vestavěné sázkaře (kteří už v PROFILES nejsou – např. slabé
    # single strategie odebrané při zúžení skupiny na 15) taky odstranit ze
    # stavu, aby se dál nezobrazovali. Vlastní sázkaři se nedotýkají.
    profile_ids = {p["id"] for p in PROFILES}
    for bid in list(st.keys()):
        b = st[bid]
        if not b.get("custom") and bid not in profile_ids:
            del st[bid]
            changed = True
    if changed:
        storage.save(FILE, st)
    return st


def _strategy_for(bid, b):
    """Vestavěný sázkař má strategii v kódu, vlastní ji skládá z parametrů –
    podle group (single/combo/acca), protože každá staví tiket jinak."""
    if b.get("custom"):
        grp = b.get("group", "single")
        if grp == "combo":
            return _s_custom_combo
        if grp == "acca":
            return _s_custom_acca
        return _s_custom
    prof = _BY_ID.get(bid)
    return prof["strategy"] if prof else None


def save_state(st):
    storage.save(FILE, st)


# ---------------------------------------------------------------------------
# Kandidáti (jen trhy s reálnými kurzy ESPN – žádné fingované)
# ---------------------------------------------------------------------------
VIG_CAP = 0.08   # trhy s marží nad 8 % jsou moc drahé – ani perfektní model tam nenajde value
LOSS_STREAK_COOLDOWN = 3   # po 3 prohrách v řadě si sázkař dá pauzu jedno kolo
SPORT_ROI_MIN_BETS = 15    # kolik vyhodnocených sázek ve sportu je potřeba pro rozhodnutí

def _blacklisted_sports(bettor: dict) -> set:
    """Sporty, kde má sázkař po ≥15 sázkách záporné ROI. V dalších kolech je
    přeskočí. Slouží k automatickému zúžení sázení tam, kde daná strategie
    prokazatelně nefunguje – bez ručního zásahu."""
    by_sport = {}
    for bet in bettor.get("bets", []):
        if bet.get("status") not in ("won", "lost"):
            continue
        s = bet.get("sport") or "?"
        d = by_sport.setdefault(s, {"stake": 0.0, "pnl": 0.0, "n": 0})
        d["stake"] += bet.get("stake", 0.0)
        d["pnl"] += bet.get("pnl", 0.0)
        d["n"] += 1
    return {s for s, d in by_sport.items()
            if d["n"] >= SPORT_ROI_MIN_BETS and d["stake"] > 0 and d["pnl"] / d["stake"] < 0}

def _candidates_for(p):
    keys = ("home", "away") if p.get("two_way") else ("home", "draw", "away")
    out = []
    for k, bet in (p.get("bets") or {}).items():
        if not bet.get("real") or not bet.get("odds") or not bet.get("prob"):
            continue
        # Filtr proti drahým trhům. Marže je vlastnost trhu (1X2 / totals / ...);
        # pokud ji známe, přeskočíme kandidáta, kterého sázkovka moc "přebalila".
        vig = bet.get("market_vig")
        if vig is not None and vig > VIG_CAP:
            continue
        out.append({
            "outcome": k, "label": bet.get("label", "?"), "name": bet.get("name", bet.get("label", "?")),
            "odds": float(bet["odds"]), "prob": float(bet["prob"]),
            "ev": bet.get("ev", 0.0) or 0.0, "edge": bet.get("edge", 0.0) or 0.0,
            "market": "winner" if k in keys else "goals",
            "market_vig": vig,
        })
    return out


def _build_pool(predictions):
    pool = []
    for p in predictions:
        # Jen zápasy, které ještě ani nezačaly – ne odehrané (result), ne
        # právě probíhající (live). "Zápasy, které budou", ne které už
        # proběhly nebo probíhají.
        if p.get("result") is not None or p.get("live"):
            continue
        rh, ra = p.get("rating_home") or {}, p.get("rating_away") or {}
        eg = p.get("exp_goals") or {}
        ml_features = {
            "attack_home": rh.get("a", 1.0), "defense_home": rh.get("d", 1.0),
            "attack_away": ra.get("a", 1.0), "defense_away": ra.get("d", 1.0),
            "exp_goals_home": eg.get("home"), "exp_goals_away": eg.get("away"),
            "rating_confidence": min(1.0, (rh.get("n", 0) + ra.get("n", 0)) / 40.0),
        }
        # Forma obou týmů (posledních 5 výsledků) – pro strategie, které
        # sází podle toho, kdo je "v ráži", ne jen podle ratingu.
        form_h = team_form(p["home"])
        form_a = team_form(p["away"])
        for c in _candidates_for(p):
            pool.append({
                **c, "match_id": p["id"], "match": f'{p["home"]} – {p["away"]}',
                "league": p.get("league", "Unknown"), "date": p.get("date", ""),
                "time": p.get("time", ""), "sport": p.get("sport", "soccer"), "slug": p.get("slug", ""),
                "ml_features": ml_features,
                # potřeba pro kombinace v rámci zápasu – společná
                # pravděpodobnost se počítá ze scoreline gridu, ne součinem
                "exp_goals": eg if eg.get("home") is not None else None,
                "two_way": bool(p.get("two_way")),
                "home_team": p["home"], "away_team": p["away"],
                "form_home": form_h, "form_away": form_a,
            })
    return pool


# ---------------------------------------------------------------------------
# Sázení – podle rozvrhu (stejné hodiny jako auto-run agenta v Nastavení),
# víckrát denně místo jen jednou. Každý sázkař navíc nikdy nevsadí na
# zápas, na který už (kdykoliv dřív) vsadil.
# ---------------------------------------------------------------------------
def _run_one_bettor(bid, b, pool, today_str: str, current_hour: int = None,
                    allowed_hours: list = None, force: bool = False) -> int:
    """Odsází jedno kolo za JEDNOHO sázkaře – mění `b` na místě (bety,
    balance, ran_hours...), volající si state uloží sám. Vrací počet
    nově umístěných sázek/tiketů. Sdíleno mezi run_all (smyčka přes
    všechny) a run_one (jen jeden, z pravého tlačítka v UI)."""
    strategy = _strategy_for(bid, b)
    if strategy is None:
        return 0
    if b.get("last_run_date") != today_str:
        b["last_run_date"] = today_str
        b["ran_hours"] = []

    if not force:
        if current_hour is None or allowed_hours is None:
            return 0
        if current_hour not in allowed_hours:
            return 0
        if current_hour in b.get("ran_hours", []):
            return 0   # tuhle naplánovanou hodinu už dnes odsázel

    if not pool:
        return 0

    # Cooldown po sérii proher – dá pauzu jedno kolo, aby nespáchal víc
    # škody než dobra. Pak se počítadlo resetne a zkusí to znovu.
    if b.get("loss_streak", 0) >= LOSS_STREAK_COOLDOWN:
        b["loss_streak"] = 0   # jedno kolo pauzy stačí – další už zase sází
        return 0

    # Nikdy dvakrát na stejný zápas – bez ohledu na to, kolikrát denně
    # sázkař běží, pool se mu vždy filtruje na zápasy, na které ještě nevsadil.
    already = {bet["match_id"] for bet in b["bets"]}
    # Sport blacklist – přeskočí sporty, kde má tenhle sázkař ≥15 sázek
    # a záporné ROI. Automatická sebeobrana proti systematicky ztrátovým
    # oblastem, bez ručního zásahu.
    blacklisted = _blacklisted_sports(b)
    bettor_pool = [c for c in pool
                   if c["match_id"] not in already
                   and c.get("sport") not in blacklisted]

    try:
        decisions = strategy(bettor_pool, b, b["balance"]) if bettor_pool else []
    except Exception:
        decisions = []
    placed = 0
    used_matches = set()
    # Ochrana proti totálnímu vytunelování: jednotlivá sázka nesmí nikdy
    # přesáhnout 20 % AKTUÁLNÍHO banku bez ohledu na to, co strategie
    # (např. plný Kelly) sama spočítá. Pod 10 % startovního banku (vážná
    # série proher) se strop dál zpřísní na 5 %, ať i "agresivní"
    # strategie nemůže bank definitivně dorazit jednou špatnou sázkou.
    single_bet_cap = 0.05 if b["balance"] < b.get("start_balance", DEFAULT_START_BALANCE) * 0.10 else 0.20
    # Váha dovedností/zkušeností – nový sázkař sází zlomek, ustálený
    # ziskový plnou sázku, propadák se stahuje. Viz _experience_scale.
    skill = _experience_scale(b)
    for c, stake in decisions:
        legs = c.get("legs")
        # zápasy, které tiket obsadí (u tiketu všechny jeho nohy)
        ids = [l["match_id"] for l in legs] if legs else [c["match_id"]]
        if any(i in used_matches for i in ids):
            continue
        stake = stake * skill
        # Když strategie vůbec něco navrhla (nenulově), zaokrouhlí se to
        # do rozsahu MIN..MAX Kč. Dřív jsme sázku pod MIN úplně přeskočili,
        # jenže s malým bankem (200 Kč) + experience nováčka (×0.35) vyšlo
        # skoro každé strategii pod 5 Kč a sázelo jen Kelly Kateřina.
        # Uživatelův záměr byl "min 5, max 10 na tiket", ne "kdo netrefí
        # svůj předepsaný výpočet, prostě nesází".
        if stake < 0.5 or stake > b["balance"]:
            continue
        stake = max(MIN_STAKE_PER_TICKET,
                    min(stake, b["balance"], b["balance"] * single_bet_cap, MAX_STAKE_PER_TICKET))
        stake = round(stake, 2)
        if stake > b["balance"]:
            continue
        if legs:
            # Tiket z více výběrů: akumulátor (různé zápasy) nebo kombinace
            # trhů jednoho zápasu. Nejbližší výkop rozhoduje, kdy se tiket
            # začne vyhodnocovat.
            dated = sorted((l.get("date", ""), l.get("time", "")) for l in legs if l.get("date"))
            d0, t0 = dated[0] if dated else ("", "")
            kind = c.get("kind", "acca")
            title = (legs[0]["match"] if kind == "combo"
                     else f"Tiket {len(legs)}× ({legs[0]['match'].split(' – ')[0]}…)")
            bet = {
                "id": uuid.uuid4().hex[:10], "ts": int(time.time()),
                "kind": kind, "match_id": "", "match": title,
                "league": legs[0].get("league", ""),
                "match_date": d0, "match_time": t0,
                "sport": legs[0].get("sport", "soccer"), "slug": legs[0].get("slug", ""),
                "outcome": kind, "label": f"{'KOMBI' if kind == 'combo' else 'AKO'} {len(legs)}",
                "name": " + ".join(l["name"] for l in legs),
                "odds": round(float(c["odds"]), 2), "prob": round(float(c["prob"]), 4),
                "legs": _legs_payload(legs),
                "stake": stake, "status": "open", "pnl": 0.0, "settled_ts": None,
                "ml_features": dict(legs[0].get("ml_features") or {}),
            }
        else:
            bet = {
                "id": uuid.uuid4().hex[:10], "ts": int(time.time()),
                "kind": "single",
                "match_id": c["match_id"], "match": c["match"], "league": c["league"],
                "match_date": c["date"], "match_time": c["time"], "sport": c["sport"], "slug": c["slug"],
                "outcome": c["outcome"], "label": c["label"], "name": c["name"],
                "odds": round(c["odds"], 2), "prob": round(c["prob"], 4),
                "stake": stake, "status": "open", "pnl": 0.0, "settled_ts": None,
                "ml_features": dict(c.get("ml_features") or {}, edge=c.get("edge", 0.0)),
            }
        b["balance"] = round(b["balance"] - stake, 2)
        b["bets"].insert(0, bet)
        used_matches.update(ids)
        placed += 1
    if current_hour is not None and current_hour not in b.get("ran_hours", []):
        b.setdefault("ran_hours", []).append(current_hour)
    return placed


def run_all(predictions, today_str: str, current_hour: int = None, allowed_hours: list = None,
            force: bool = False) -> dict:
    """current_hour/allowed_hours: hodinový rozvrh (stejný jako Nastavení →
    Auto-run agenta). force=True (ruční tlačítko "Spustit kolo teď")
    obchází rozvrh úplně, ale pořád respektuje "nikdy dvakrát na stejný
    zápas" a bezpečnostní stropy."""
    st = load_state()
    pool = _build_pool(predictions)
    placed_total = {}

    # projít VŠECHNY sázkaře ve stavu (vestavěné i vlastní), ne jen PROFILES
    for bid in list(st.keys()):
        b = st[bid]
        placed_total[bid] = _run_one_bettor(bid, b, pool, today_str, current_hour, allowed_hours, force)
    save_state(st)
    return placed_total


def run_one(bid: str, predictions, today_str: str) -> dict:
    """Odsází kolo jen za JEDNOHO sázkaře (pravé tlačítko myši → "Vytvořit
    sázky" u konkrétního sázkaře v aréně) - obchází rozvrh stejně jako
    ruční "Spustit kolo teď", jen pro jednoho místo pro všechny."""
    st = load_state()
    b = st.get(bid)
    if b is None:
        return {"placed": 0, "error": "not_found"}
    pool = _build_pool(predictions)
    placed = _run_one_bettor(bid, b, pool, today_str, force=True)
    save_state(st)
    return {"placed": placed}


def staked_since(bid: str, ts: int) -> float:
    """Kolik daný sázkař vsadil od zadaného času – pro shrnutí posledního kola."""
    b = load_state().get(bid) or {}
    return round(sum(x["stake"] for x in b.get("bets", []) if x.get("ts", 0) >= ts), 2)


def void_matches(match_ids) -> int:
    """Vrátí vklady u sázek na odložené/zrušené zápasy (void = žádný zisk ani
    ztráta). Bez toho by sázkařům trvale visely v otevřených a peníze by jim
    zůstaly zablokované."""
    ids = {str(x) for x in (match_ids or ())}
    if not ids:
        return 0
    st = load_state()
    n = 0
    for b in st.values():
        for bet in b.get("bets", []):
            if bet.get("status") == "open" and str(bet.get("match_id")) in ids:
                bet["status"] = "void"
                bet["pnl"] = 0.0
                bet["settled_ts"] = int(time.time())
                b["balance"] = round(b["balance"] + bet["stake"], 2)
                n += 1
    if n:
        save_state(st)
    return n


def _settle_ticket(bet, results):
    """Vyhodnotí tiket z více výběrů. Vrací 'won'/'lost'/'void', nebo None
    když aspoň jedna noha ještě nemá výsledek – tiket pak zůstane otevřený.

    Prohraná noha shazuje celý tiket hned, i kdyby zbytek ještě nebyl odehraný
    (to dělají i sázkovky). Zrušená noha se počítá jako kurz 1.0, takže tiket
    může pořád vyhrát, jen s nižším výnosem."""
    legs = bet.get("legs") or []
    pending = False
    live_odds = 1.0
    for leg in legs:
        if leg.get("result") in ("won", "lost", "void"):
            r = leg["result"]
        else:
            res = results.get(leg["match_id"])
            r = eval_outcome(leg["outcome"], res["home"], res["away"]) if res else None
            if r:
                leg["result"] = r
                leg["score"] = {"home": res["home"], "away": res["away"]}
        if r == "lost":
            return "lost"
        if r is None:
            pending = True
        elif r == "won":
            live_odds *= float(leg["odds"])
    if pending:
        return None
    # všechny nohy vyřešené a žádná neprohrála
    if live_odds <= 1.0:
        return "void"          # všechny nohy zrušené
    bet["odds"] = round(live_odds, 2)
    return "won"


def settle_all(results: dict) -> int:
    """results: {match_id: {'home':h,'away':a}} – stejná data jako settle pro
    reálné tipy/sázky (viz app.py _settle_recent)."""
    if not results:
        return 0
    st = load_state()
    n = 0
    for bid, b in st.items():
        streak = b.get("loss_streak", 0)
        wins = b.get("win_streak", 0)      # série výher – pro Paroli (opak Martingalu)
        for bet in b["bets"]:
            if bet["status"] != "open":
                continue
            if bet.get("legs"):
                r = _settle_ticket(bet, results)
                if not r:
                    continue          # aspoň jedna noha ještě nezná výsledek
                res = None
            else:
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
                wins += 1
            elif r == "void":
                bet["pnl"] = 0.0
                b["balance"] = round(b["balance"] + bet["stake"], 2)
            else:
                bet["pnl"] = round(-bet["stake"], 2)
                streak += 1
                wins = 0
            bet["status"] = r
            bet["settled_ts"] = int(time.time())
            if res:
                bet["result"] = {"home": res["home"], "away": res["away"]}
            n += 1
            _record_ml_feedback(bid, bet, r)
        b["loss_streak"] = streak
        b["win_streak"] = wins
    if n:
        save_state(st)
    return n


def _record_ml_feedback(bettor_id, bet, result):
    """Pošle settled sázku do ML Learning (engine/ml_learner.py) – aréna
    dává MNOHEM větší a různorodější trénovací vzorek než jen agentovy
    vlastní (konzervativní, jen tutovkové) sázky, takže model má šanci se
    reálně něco naučit v rozumném čase."""
    try:
        from . import ml_learner
        home, away = (bet["match"].split(" – ", 1) + [""])[:2]
        ml_learner.record_bet_outcome(
            bet_id=f'vb-{bettor_id}-{bet["id"]}', match_id=bet["match_id"],
            prediction=bet["outcome"], odds=bet["odds"], stake=bet["stake"],
            outcome=result, home_team=home, away_team=away,
            league=bet.get("league", "Unknown"), match_date=bet.get("match_date", ""),
            features={"odds": bet["odds"], "prob": bet["prob"], **(bet.get("ml_features") or {})},
        )
    except Exception:
        pass   # ML logging nesmí nikdy shodit vyhodnocování sázek


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
    # CLV napříč jednotlivými sázkami i nohami tiketů – nejspolehlivější
    # ukazatel skutečné výhody nezávislý na krátkodobé smůle výsledků.
    clvs = []
    for x in b["bets"]:
        if x.get("legs"):
            clvs.extend(l["clv"] for l in x["legs"] if l.get("clv") is not None)
        elif x.get("clv") is not None:
            clvs.append(x["clv"])
    return {
        "id": bid, "name": b["name"], "emoji": b["emoji"], "tagline": b["tagline"],
        "group": b.get("group") or (_BY_ID.get(bid, {}) or {}).get("group", "single"),
        "custom": bool(b.get("custom")),
        "deposited": round(sum(t["amount"] for t in (b.get("transactions") or [])
                               if t.get("type") in ("deposit", "withdraw")), 2),
        "balance": b["balance"], "start_balance": b["start_balance"],
        # Realizovaný zisk z VYHODNOCENÝCH sázek. balance - start_balance by
        # počítalo i vklady zamrzlé v otevřených sázkách jako by byly prohrané,
        # takže vedle sebe svítilo "-55 Kč" a "ROI +64,9 %".
        "profit": round(pnl, 2),
        "open_stake": round(sum(x["stake"] for x in b["bets"] if x["status"] == "open"), 2),
        "roi": round(pnl / staked * 100, 1) if staked else 0.0,
        "placed": len(b["bets"]), "settled": len(settled), "won": won,
        "win_rate": round(won / len(settled) * 100, 1) if settled else None,
        # void (odložený zápas) není otevřená sázka – vklad se už vrátil
        "open_count": sum(1 for x in b["bets"] if x["status"] == "open"),
        "void_count": sum(1 for x in b["bets"] if x["status"] == "void"),
        "equity": equity,
        "avg_clv": round(sum(clvs) / len(clvs) * 100, 2) if clvs else None,
        "clv_n": len(clvs),
    }


def _clv(odds, consensus_odds):
    """Náskok kurzu nad tržním konsenzem (stejný vzorec jako bankroll._clv,
    ale pro arénu): >0 = sázkař vzal lepší cenu, než jaká byla těsně
    před výkopem. Na rozdíl od zisku dává smysl už po pár desítkách
    sázek, protože nezávisí na tom, jestli zrovna padl gól."""
    try:
        co = float(consensus_odds)
        if co > 0:
            return round(float(odds) / co - 1.0, 4)
    except (TypeError, ValueError):
        pass
    return None


def track_closing_odds(match_odds: dict) -> int:
    """Zapíše k VŠEM otevřeným sázkám arény (i nohám tiketů) aktuální kurz
    trhu – closing line value, viz bankroll.track_closing_odds (stejný
    princip, jen pro celou arénu místo jednoho agentova bankrollu).
    match_odds: {match_id: {outcome: odds}} z čerstvých predikcí."""
    if not match_odds:
        return 0
    st = load_state()
    n = 0
    for b in st.values():
        for bet in b.get("bets", []):
            if bet.get("status") != "open":
                continue
            legs = bet.get("legs")
            if legs:
                changed = False
                for leg in legs:
                    cur = (match_odds.get(leg.get("match_id")) or {}).get(leg.get("outcome"))
                    if not cur or leg.get("closing_odds") == cur:
                        continue
                    leg["closing_odds"] = round(float(cur), 3)
                    leg["clv"] = _clv(leg.get("odds"), cur)
                    changed = True
                if changed:
                    n += 1
            else:
                cur = (match_odds.get(bet.get("match_id")) or {}).get(bet.get("outcome"))
                if not cur or bet.get("closing_odds") == cur:
                    continue
                bet["closing_odds"] = round(float(cur), 3)
                bet["clv"] = _clv(bet.get("odds"), cur)
                n += 1
    if n:
        save_state(st)
    return n


def leaderboard() -> list:
    st = load_state()
    rows = [_bettor_stats(bid, b) for bid, b in st.items()]
    rows.sort(key=lambda r: r["profit"], reverse=True)
    # pořadí se počítá v rámci skupiny – porovnávat akumulátor s jednotlivou
    # sázkou nedává smysl, každá kategorie hraje jinou hru
    per_group = {}
    for r in rows:
        g = r.get("group", "single")
        per_group[g] = per_group.get(g, 0) + 1
        r["rank"] = per_group[g]
    return rows


def _perf_breakdown(bets: list, key: str) -> list:
    """Seskupí VYHODNOCENÉ sázky podle daného klíče (sport / league / kind /
    outcome_market) a spočítá n, win_rate, staked, pnl, ROI. Vrátí seřazené
    podle profitu sestupně – hned je vidět, kde sázkař vydělává a kde ne."""
    by = {}
    for x in bets:
        if x.get("status") not in ("won", "lost"):
            continue
        k = x.get(key) or "?"
        # sjednotit typ trhu (výhra vs góly vs handicap...)
        if key == "outcome":
            oc = x.get("outcome", "")
            if oc in ("home", "draw", "away") or oc.startswith("dc_") or oc.startswith("dnb_"):
                k = "vítěz"
            elif oc.startswith("over") or oc.startswith("under"):
                k = "góly"
            elif oc.startswith("ah_"):
                k = "handicap"
            elif oc in ("acca", "combo"):
                k = "tikety"
            else:
                k = "ostatní"
        d = by.setdefault(k, {"key": k, "n": 0, "won": 0, "staked": 0.0, "pnl": 0.0})
        d["n"] += 1
        d["won"] += (1 if x["status"] == "won" else 0)
        d["staked"] += x.get("stake", 0)
        d["pnl"] += x.get("pnl", 0)
    for d in by.values():
        d["win_rate"] = round(d["won"] / d["n"] * 100, 1) if d["n"] else 0.0
        d["roi"] = round(d["pnl"] / d["staked"] * 100, 1) if d["staked"] else 0.0
        d["pnl"] = round(d["pnl"], 2)
        d["staked"] = round(d["staked"], 2)
    return sorted(by.values(), key=lambda x: -x["pnl"])


_WEEKDAY_CZ = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"]
_HOUR_BUCKETS = [(5, 12, "ráno (5–12)"), (12, 17, "odpoledne (12–17)"),
                 (17, 22, "večer (17–22)"), (22, 29, "noc (22–5)")]


def _perf_breakdown_time(bets: list) -> dict:
    """Rozklad VYHODNOCENÝCH sázek podle dne v týdnu a denní doby výkopu –
    ukáže, jestli sázkař (a model pod ním) funguje v některé dny/hodiny
    systematicky lépe nebo hůř. Bez tohohle appka žádný takový vzorec
    nikde neukazovala, i když data (match_date/match_time u každé sázky)
    má celou dobu."""
    by_day, by_hour = {}, {}
    for x in bets:
        if x.get("status") not in ("won", "lost"):
            continue
        d, t = x.get("match_date"), x.get("match_time")
        wd_key = None
        if d:
            try:
                wd_key = _WEEKDAY_CZ[datetime.date.fromisoformat(d).weekday()]
            except (ValueError, TypeError):
                pass
        hr_key = None
        if t:
            try:
                hr = int(str(t).split(":")[0]) % 24
                if hr < 5:
                    hr += 24   # půlnoc až 5:00 patří do noční směny (22-5)
                for lo, hi, label in _HOUR_BUCKETS:
                    if lo <= hr < hi:
                        hr_key = label
                        break
            except (ValueError, TypeError):
                pass
        for key, store in ((wd_key, by_day), (hr_key, by_hour)):
            if key is None:
                continue
            d2 = store.setdefault(key, {"key": key, "n": 0, "won": 0, "staked": 0.0, "pnl": 0.0})
            d2["n"] += 1
            d2["won"] += 1 if x["status"] == "won" else 0
            d2["staked"] += x.get("stake", 0)
            d2["pnl"] += x.get("pnl", 0)

    def finalize(store, order):
        for d2 in store.values():
            d2["win_rate"] = round(d2["won"] / d2["n"] * 100, 1) if d2["n"] else 0.0
            d2["roi"] = round(d2["pnl"] / d2["staked"] * 100, 1) if d2["staked"] else 0.0
            d2["pnl"] = round(d2["pnl"], 2)
            d2["staked"] = round(d2["staked"], 2)
        return [store[k] for k in order if k in store]

    return {
        "weekday": finalize(by_day, _WEEKDAY_CZ),
        "hour": finalize(by_hour, [b[2] for b in _HOUR_BUCKETS]),
    }


def arena_time_breakdown() -> dict:
    """Stejné jako _perf_breakdown_time, ale napříč VŠEMI sázkami arény
    (ne jen jednoho sázkaře) – mnohem větší vzorek, ukáže vzorce v modelu
    samotném, ne jen šum jedné strategie."""
    st = load_state()
    all_bets = []
    for b in st.values():
        all_bets.extend(b.get("bets", []))
    return _perf_breakdown_time(all_bets)


def bettor_detail(bid: str) -> dict:
    st = load_state()
    b = st.get(bid)
    if not b:
        return {}
    stats = _bettor_stats(bid, b)
    stats["bets"] = b["bets"][:50]
    stats["transactions"] = (b.get("transactions") or [])[:50]
    stats["params"] = b.get("params")
    # Rozklad úspěšnosti – aby uživatel viděl, ve kterých sportech / na jakých
    # trzích sázkař vydělává a kde tratí. Automatický blacklist v run_all se
    # opírá o stejná data.
    stats["breakdown"] = {
        "sport": _perf_breakdown(b.get("bets", []), "sport"),
        "market": _perf_breakdown(b.get("bets", []), "outcome"),
        "league": _perf_breakdown(b.get("bets", []), "league"),
        **_perf_breakdown_time(b.get("bets", [])),
    }
    stats["blacklisted_sports"] = sorted(_blacklisted_sports(b))
    return stats


# ---------------------------------------------------------------------------
# Propojení s hlavním agentem – "která strategie v aréně vede a proč"
# ---------------------------------------------------------------------------
_MIN_SETTLED_FOR_INSIGHT = 3   # míň než 3 vyhodnocené sázky = ještě nic neříká

# Jen strategie, které mají čistý 1:1 překlad do nastavení agenta (min_prob,
# kurz, stake_mode...). Martingale (rizikový progresivní systém), Náhodný
# Norbert (kontrolní skupina) a čistě kurzově orientovaní (Outsider, Value
# Hunter, Favorit) nejdou takhle jednoduše "zapnout" – agent na ně nemá
# odpovídající přepínač, u nich se doporučení jen popíše slovně.
AGENT_SETTING_MAP = {
    "kelly":        {"stake_mode": "kelly", "kelly_fraction": 1.0, "min_prob": 0.50, "min_odds": 1.10},
    "quarter":      {"stake_mode": "kelly", "kelly_fraction": 0.25, "min_prob": 0.55, "min_odds": 1.10},
    "conservative": {"stake_mode": "flat", "min_prob": 0.80, "min_odds": 1.10},
    "disciplined":  {"stake_mode": "flat", "min_prob": 0.60, "max_daily_stake_pct": 0.10},
    "cautious":     {"stake_mode": "flat", "min_prob": 0.85, "min_odds": 1.10},
}


def leading_strategy_insight() -> dict:
    """Kdo v aréně aktuálně vede (dost velký vzorek, aby to něco znamenalo)
    a dá-li se z toho poskládat konkrétní doporučené nastavení pro agenta."""
    rows = [r for r in leaderboard() if r["settled"] >= _MIN_SETTLED_FOR_INSIGHT]
    if not rows:
        return {"available": False, "reason": "not_enough_data"}
    best = max(rows, key=lambda r: r["roi"])
    suggestion = AGENT_SETTING_MAP.get(best["id"])
    return {
        "available": True,
        "id": best["id"], "name": best["name"], "emoji": best["emoji"], "tagline": best["tagline"],
        "roi": best["roi"], "profit": best["profit"], "win_rate": best["win_rate"], "settled": best["settled"],
        "agent_settings": suggestion,   # None = tahle strategie nejde 1:1 nastavit agentovi
    }


# ---------------------------------------------------------------------------
# Kalibrace modelu – říká "75 % jistota" skutečně vyhrává ~75 % případů?
# ---------------------------------------------------------------------------
_CAL_BUCKETS = [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 1.01)]


def group_comparison() -> dict:
    """Vývoj banku po kategoriích – vyplácí se vůbec skládat tikety?

    Jednotlivé sázky, akumulátory a kombinace hrají jinou hru, takže je
    zajímavější jejich souhrnná křivka než pořadí jednotlivců."""
    st = load_state()
    out = {}
    for bid, b in st.items():
        g = b.get("group") or (_BY_ID.get(bid, {}) or {}).get("group", "single")
        d = out.setdefault(g, {"group": g, "label": GROUPS.get(g, {}).get("label", g),
                               "emoji": GROUPS.get(g, {}).get("emoji", ""),
                               "bettors": 0, "start": 0.0, "balance": 0.0,
                               "staked": 0.0, "pnl": 0.0, "settled": 0, "won": 0,
                               "open_stake": 0.0, "_events": [], "_clvs": []})
        d["bettors"] += 1
        d["start"] += b.get("start_balance", 0.0)
        d["balance"] += b.get("balance", 0.0)
        for x in b.get("bets", []):
            if x["status"] in ("won", "lost"):
                d["staked"] += x["stake"]
                d["pnl"] += x["pnl"]
                d["settled"] += 1
                d["won"] += 1 if x["status"] == "won" else 0
                d["_events"].append((x.get("settled_ts") or x["ts"], x["pnl"]))
            elif x["status"] == "open":
                d["open_stake"] += x["stake"]
            if x.get("legs"):
                d["_clvs"].extend(l["clv"] for l in x["legs"] if l.get("clv") is not None)
            elif x.get("clv") is not None:
                d["_clvs"].append(x["clv"])

    for d in out.values():
        cum, curve = 0.0, [0.0]
        for _, pnl in sorted(d.pop("_events")):
            cum = round(cum + pnl, 2)
            curve.append(cum)
        clvs = d.pop("_clvs")
        d["avg_clv"] = round(sum(clvs) / len(clvs) * 100, 2) if clvs else None
        # křivka se zkrátí na rozumný počet bodů, ať se dá vykreslit
        if len(curve) > 60:
            step = len(curve) / 60.0
            curve = [curve[min(len(curve) - 1, int(i * step))] for i in range(60)] + [curve[-1]]
        d["curve"] = curve
        for k in ("start", "balance", "staked", "pnl", "open_stake"):
            d[k] = round(d[k], 2)
        d["roi"] = round(d["pnl"] / d["staked"] * 100, 1) if d["staked"] else 0.0
        d["win_rate"] = round(d["won"] / d["settled"] * 100, 1) if d["settled"] else None
    order = ["single", "acca", "combo", "ai"]
    return {"groups": [out[g] for g in order if g in out]}


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
