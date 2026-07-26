#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
⚽ KurzAnalytik – lokální web aplikace na kurzové sázení.

Načítá fotbalové zápasy z celého světa rozdělené podle lig (TheSportsDB,
bez registrace), analyzuje je predikčním enginem (Elo + Poisson),
simuluje kurzy sázkových kanceláří a hledá value sázky. Obsahuje správu
banku s Kelly kritériem, generátor akumulátorů a kurzové alerty.

Spuštění:  python app.py   →   http://127.0.0.1:5000
"""

import os
import sys
import time as _time
import webbrowser
import threading
from concurrent.futures import ThreadPoolExecutor

# Spustitelné z libovolného adresáře (kvůli importům a šablonám)
_HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(_HERE)
sys.path.insert(0, _HERE)

# --- samoinstalace závislostí (stejný styl jako ostatní appky) -------------
def _ensure():
    import importlib.util, subprocess
    # numpy je potřeba nepodmíněně (backtester/explainer ho importují při startu)
    miss = [p for m, p in {"flask": "Flask", "requests": "requests",
                           "numpy": "numpy"}.items()
            if importlib.util.find_spec(m) is None]
    if miss:
        print("Instaluji závislosti:", ", ".join(miss))
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-q"] + miss)
_ensure()

from flask import Flask, jsonify, request, render_template, session, redirect, url_for
from functools import wraps

from engine import storage
from engine import data_sources as ds
from engine import prediction as pred
from engine import bankroll
from engine import accumulator as acc
from engine import odds_api
from engine import tips_db
from engine import settings as app_settings
from engine import agent
from engine import calibration
from engine import persist
from engine import backtester
from engine import explainer

# ML Learning (optional)
try:
    from engine import ml_learner
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False

try:
    from engine import monitoring
    MONITORING_AVAILABLE = True
except ImportError:
    MONITORING_AVAILABLE = False

from engine import bankroll_stats

app = Flask(__name__)
# SECRET_KEY z env; jinak náhodný per-start (session po restartu spadne,
# ale nikdo nemůže podvrhnout cookie se známým klíčem z veřejného repa)
app.secret_key = os.environ.get("SECRET_KEY") or os.urandom(32)

# Login credentials – přepsatelné přes env (APP_USERNAME / APP_PASSWORD)
_USERNAME = os.environ.get("APP_USERNAME", "admin")
_PASSWORD = os.environ.get("APP_PASSWORD", "8312172165")

# jednoduchá keš predikcí v paměti (klíč = datum)
_PRED_CACHE = {}

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "user" not in session:
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated_function

@app.before_request
def check_login():
    # Allow login and logout without auth
    if request.path in ["/login", "/logout"]:
        return

    # Check if user is authenticated
    if "user" not in session:
        # API call - return 401
        if request.path.startswith("/api/"):
            return jsonify({"error": "Unauthorized"}), 401
        # HTML page - redirect to login
        else:
            return redirect(url_for("login_page"))


def _predictions_for(date_str: str, days: int = 1, sport: str = "soccer", refresh=False):
    days = max(1, min(14, int(days)))
    end = ds.add_days(date_str, days - 1)
    key = f"{sport}~{date_str}~{end}"
    if not refresh and key in _PRED_CACHE:
        return _PRED_CACHE[key]
    matches = ds.fetch_range(date_str, end, use_cache=not refresh, sport=sport)
    predictions = pred.predict_all(matches)
    # Volitelné: nahradit modelované kurzy SKUTEČNÝMI (když je nastaven API klíč)
    if odds_api.has_key():
        index = odds_api.fetch_index(sport)
        if index:
            for p in predictions:
                rb = odds_api.lookup(index, p["home"], p["away"])
                if rb:
                    pred.apply_real_odds(p, rb)
    # ESPN kurzy (DraftKings) – zdarma, bez kvóty; doplní zápasy bez reálných kurzů
    for m, p in zip(matches, predictions):
        ro = m.get("real_odds")
        if not ro:
            continue
        if p.get("odds_source") != "real":
            book = [{"name": ro["provider"], "sharp": True, "odds": ro["odds"]}]
            pred.apply_real_odds(p, book)
        # reálné kurzy na góly over/under (trh "total")
        if ro.get("totals"):
            pred.apply_real_totals(p, ro["totals"], ro["provider"])
    _PRED_CACHE[key] = predictions
    # Automaticky uloží nové tipy na pozadí (nesynchronně, aby nezdržovalo odpověď)
    try:
        tips_db.save_tips([p for p in predictions if p.get("result") is None])
    except Exception:
        pass
    return predictions


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------
@app.route("/login", methods=["GET", "POST"])
def login_page():
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        if username == _USERNAME and password == _PASSWORD:
            session["user"] = username
            return redirect(url_for("index"))
        else:
            return render_template("login.html", error="Nesprávné jméno nebo heslo")
    return render_template("login.html")

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login_page"))

# ---------------------------------------------------------------------------
# Stránka
# ---------------------------------------------------------------------------
@app.route("/")
@login_required
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API – zápasy a predikce na den, seskupené podle lig
# ---------------------------------------------------------------------------
@app.route("/api/sports")
def api_sports():
    return jsonify({"sports": [{"id": k, "label": v["label"]} for k, v in ds.SPORTS.items()]})


@app.route("/api/matches")
def api_matches():
    date_str = request.args.get("date") or ds.today_str()
    days = request.args.get("days", 1)
    sport = request.args.get("sport", "soccer")
    refresh = request.args.get("refresh") == "1"
    predictions = _predictions_for(date_str, days=days, sport=sport, refresh=refresh)

    # Minimalizuj data pro UI – odstraň zbytečné odds detaily
    def slim_prediction(p):
        keys = ("home", "away") if p.get("two_way") else ("home", "draw", "away")
        odds = {k: p["bets"][k]["best_odds"] for k in keys if k in p.get("bets", {})}
        return {
            "id": p.get("id"),
            "sport": p.get("sport", "soccer"),
            "slug": p.get("slug", ""),
            "home": p["home"],
            "away": p["away"],
            "home_id": p.get("home_id", ""),
            "away_id": p.get("away_id", ""),
            "league": p["league"],
            "country": p["country"],
            "date": p.get("date"),
            "time": p.get("time"),
            "status": p.get("status", ""),
            "probs": p.get("probs", {}),
            "pick": p.get("pick"),
            "result": p.get("result"),
            "live": p.get("live", False),
            "best_value": p.get("best_value", {}),
            "odds": odds,
            "odds_source": p.get("odds_source", "sim"),
            "exp_goals": p.get("exp_goals"),
            "exp_total": p.get("exp_total"),
            "exp_corners": p.get("exp_corners"),
            "goal_lines": p.get("goal_lines", [])[:2],
            "corner_lines": p.get("corner_lines", [])[:1],
            "top_scores": p.get("top_scores", [])[:3],
        }

    slim_preds = [slim_prediction(p) for p in predictions]

    leagues = {}
    for p in slim_preds:
        lg = leagues.setdefault(p["league"], {
            "league": p["league"],
            "country": p["country"],
            "flag": ds.flag(p["country"]),
            "matches": [],
        })
        lg["matches"].append(p)

    league_list = sorted(
        leagues.values(),
        key=lambda l: (ds.league_rank(l["league"]), -len(l["matches"]), l["league"]))

    value_count = sum(1 for p in slim_preds if p["best_value"].get("is_value"))
    # Tip dne = nejvyšší EV value napříč nadcházejícími zápasy
    upcoming = [p for p in slim_preds if p["result"] is None and p["best_value"].get("is_value")]
    tip = max(upcoming, key=lambda p: p["best_value"].get("ev", 0), default=None)
    return jsonify({
        "date": date_str,
        "days": max(1, min(14, int(days))),
        "total_matches": len(slim_preds),
        "total_leagues": len(league_list),
        "value_count": value_count,
        "tip": tip,
        "leagues": league_list,
    })


@app.route("/api/tickets")
def api_tickets():
    date_str = request.args.get("date") or ds.today_str()
    days = request.args.get("days", 1)
    sport = request.args.get("sport", "soccer")
    predictions = _predictions_for(date_str, days=days, sport=sport)
    return jsonify({"tickets": acc.build_tickets(predictions)})


@app.route("/api/form")
def api_form():
    """Skutečná forma + vzájemné zápasy (H2H) z ESPN – on-demand pro detail zápasu."""
    sport = request.args.get("sport", "soccer")
    slug = request.args.get("slug", "")
    home_id = request.args.get("home_id", "")
    away_id = request.args.get("away_id", "")
    home = request.args.get("home", "")
    away = request.args.get("away", "")
    fh = ds.team_form(sport, slug, home_id)
    fa = ds.team_form(sport, slug, away_id)
    # H2H = zápasy domácích, kde soupeř byl tým hostů
    h2h = [g for g in fh if away and (away.lower() in g["opp"].lower() or g["opp"].lower() in away.lower())]
    return jsonify({"home": fh, "away": fa, "h2h": h2h})


@app.route("/api/backtest")
def api_backtest():
    """Zpětný test modelu na historickém okně: přesnost, Brier score, kalibrace, ROI value sázek."""
    sport = request.args.get("sport", "soccer")
    days = max(3, min(21, int(request.args.get("days", 14))))
    end = request.args.get("end") or ds.add_days(ds.today_str(), -3)
    start = ds.add_days(end, -(days - 1))
    preds = _predictions_for(start, days=days, sport=sport)

    evald = [p for p in preds if p.get("result")]
    n = len(evald)
    if not n:
        return jsonify({"n": 0, "start": start, "end": end})

    hits = brier = brier_uni = 0.0
    bins = [{"lo": i / 10, "hi": (i + 1) / 10, "count": 0, "pred": 0.0, "obs": 0} for i in range(10)]
    val_bets = val_profit = 0.0

    for p in evald:
        keys = ("home", "away") if p["two_way"] else ("home", "draw", "away")
        hs, as_ = p["result"]["home"], p["result"]["away"]
        actual = "home" if hs > as_ else ("away" if as_ > hs else "draw")
        if actual not in keys:
            actual = "home" if hs >= as_ else "away"   # dvoucestné bez remízy
        # Brier (vícetřídní) + uniformní baseline
        u = 1.0 / len(keys)
        for k in keys:
            y = 1.0 if k == actual else 0.0
            brier += (p["probs"][k] - y) ** 2
            brier_uni += (u - y) ** 2
        # přesnost predikce + kalibrace podle jistoty favorita
        correct = p["pick"] == actual
        hits += 1 if correct else 0
        pp = p["probs"][p["pick"]]
        b = bins[min(9, int(pp * 10))]
        b["count"] += 1
        b["pred"] += pp
        b["obs"] += 1 if correct else 0
        # ROI value sázek (vsadíme nejlepší value výběr za nejlepší kurz)
        bv = p["best_value"]
        if bv["is_value"]:
            r = bankroll.eval_outcome(bv["outcome"], hs, as_)
            if r:
                val_bets += 1
                val_profit += (bv["best_odds"] - 1) if r == "won" else -1

    for b in bins:
        if b["count"]:
            b["pred"] = round(b["pred"] / b["count"], 3)
            b["obs_rate"] = round(b["obs"] / b["count"], 3)
        else:
            b["obs_rate"] = None

    return jsonify({
        "n": n, "start": start, "end": end, "sport": sport,
        "accuracy": round(hits / n * 100, 1),
        "brier": round(brier / n, 4),
        "brier_uniform": round(brier_uni / n, 4),
        "skill": round((1 - (brier / n) / (brier_uni / n)) * 100, 1) if brier_uni else 0,
        "value_bets": int(val_bets),
        "value_roi": round(val_profit / val_bets * 100, 1) if val_bets else None,
        "value_profit": round(val_profit, 2),
        "bins": [b for b in bins if b["count"]],
    })


@app.route("/api/team")
def api_team():
    """Detail týmu: Elo rating, forma, příští zápasy, útok/obrana."""
    sport = request.args.get("sport", "soccer")
    slug = request.args.get("slug", "")
    team_id = request.args.get("team_id", "")
    name = request.args.get("name", "")
    league = request.args.get("league", "")
    evs = ds.team_events(sport, slug, team_id)
    past = [e for e in evs if e["res"]]
    last = list(reversed(past))[:10]
    upcoming = [e for e in evs if not e["completed"]][:6]
    gf = [e["gf"] for e in past if e["gf"] is not None]
    ga = [e["ga"] for e in past if e["ga"] is not None]
    wins = sum(1 for e in past if e["res"] == "W")
    return jsonify({
        "name": name,
        "rating": pred.rating_of(name, league),
        "form": last,
        "upcoming": upcoming,
        "played": len(past),
        "win_rate": round(wins / len(past) * 100) if past else 0,
        "avg_for": round(sum(gf) / len(gf), 2) if gf else None,
        "avg_against": round(sum(ga) / len(ga), 2) if ga else None,
    })


@app.route("/api/alerts")
def api_alerts():
    date_str = request.args.get("date") or ds.today_str()
    days = request.args.get("days", 1)
    sport = request.args.get("sport", "soccer")
    predictions = _predictions_for(date_str, days=days, sport=sport)
    return jsonify({"alerts": acc.build_alerts(predictions)})


# ---------------------------------------------------------------------------
# API – bankroll
# ---------------------------------------------------------------------------
@app.route("/api/bankroll")
def api_bankroll():
    return jsonify({"stats": bankroll.stats(), "bets": bankroll.state()["bets"][:50]})


@app.route("/api/bankroll/settings", methods=["POST"])
def api_bankroll_settings():
    d = request.get_json(force=True)
    bankroll.settings(
        start_balance=d.get("start_balance"),
        kelly_fraction=d.get("kelly_fraction"),
        currency=d.get("currency"),
    )
    return jsonify({"stats": bankroll.stats()})


@app.route("/api/odds/status")
def api_odds_status():
    return jsonify({"enabled": odds_api.has_key()})


@app.route("/api/odds/key", methods=["POST"])
def api_odds_key():
    d = request.get_json(force=True)
    odds_api.set_key(d.get("key", ""))
    _PRED_CACHE.clear()
    return jsonify({"enabled": odds_api.has_key()})


@app.route("/api/kelly")
def api_kelly():
    prob_s = request.args.get("prob")
    odds_s = request.args.get("odds")
    if not prob_s or not odds_s:
        return jsonify({"error": "Missing prob or odds parameter"}), 400
    try:
        prob = float(prob_s)
        odds = float(odds_s)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid prob or odds value"}), 400
    st = bankroll.state()
    stake = bankroll.kelly_stake(prob, odds, st["balance"], st["kelly_fraction"])
    return jsonify({"stake": stake, "balance": st["balance"],
                    "fraction": st["kelly_fraction"]})


@app.route("/api/bet", methods=["POST"])
def api_bet():
    d = request.get_json(force=True)
    try:
        bet = bankroll.place_bet(
            d["match_id"], d["label"], d["outcome"], d["odds"],
            d["prob"], d["stake"], d["home"], d["away"],
            consensus_odds=d.get("consensus_odds"),
            match_date=d.get("match_date"), match_time=d.get("match_time"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"bet": bet, "stats": bankroll.stats()})


@app.route("/api/bet/acca", methods=["POST"])
def api_acca():
    d = request.get_json(force=True)
    try:
        bet = bankroll.place_acca(d["legs"], d["stake"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"bet": bet, "stats": bankroll.stats()})


@app.route("/api/bet/settle", methods=["POST"])
def api_settle():
    d = request.get_json(force=True)
    try:
        bet = bankroll.settle_bet(d["bet_id"], d["result"])
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"bet": bet, "stats": bankroll.stats()})


_SETTLE_BATCH_TARGETS = 24    # max liga-dnů (requestů) na jeden průchod settle –
                              # drženo nízko: víc paralelních vláken/spojení = víc
                              # paměti, na Render free tieru (512 MB) to shazovalo
                              # proces ještě před dokončením PRVNÍHO průchodu

# Globální stav kontroly výsledků na pozadí
_settle_status = {
    "in_progress": False,
    "current_batch": [],
    "settled_so_far": 0,
    "total_pending": 0,
    "more_pending": False,
    "last_check": None,     # unix ts posledního dokončeného průchodu
}
_settle_lock = threading.Lock()
_last_slugless_fallback = 0.0   # throttle: plný sken 244 lig, ne každý průchod


def _settle_recent():
    """Sdílená logika vyhodnocení: CÍLENÉ dotazy jen na ligy, kde něco čeká.
    Každý otevřený tip/sázka nese slug ligy → místo skenu všech 244 lig na den
    se ptáme jen konkrétních lig (1 request na ligu a den, paralelně).
    Staré záznamy bez slugu se dořeší celoplošným skenem, až je cílená fronta
    prázdná. Vrací (results, corner_results, more_pending)."""
    today = ds.today_str()
    open_tips = tips_db.open_tips_until(today)   # od nejstarších, jen vyhodnotitelné
    open_bets = [b for b in bankroll.state()["bets"] if b["status"] == "open" and b.get("match_id")]

    # Cíle: (sport, slug, date) s váhou – sázky (reálný bank) váží 3× víc než tipy
    targets = {}
    slugless_days = {}   # (sport, date) – staré záznamy bez slugu
    for t in open_tips:
        if not t.get("date") or t["date"] > today:
            continue
        sport = t.get("sport", "soccer")
        if t.get("slug"):
            k = (sport, t["slug"], t["date"])
            targets[k] = targets.get(k, 0) + 1
        else:
            k = (sport, t["date"])
            slugless_days[k] = slugless_days.get(k, 0) + 1
    for b in open_bets:
        if not b.get("match_date") or b["match_date"] > today:
            continue
        sport = b.get("sport", "soccer")
        if b.get("slug"):
            k = (sport, b["slug"], b["match_date"])
            targets[k] = targets.get(k, 0) + 3
        else:
            k = (sport, b["match_date"])
            slugless_days[k] = slugless_days.get(k, 0) + 3

    # Nejstarší dny první, pak dle váhy; dávka = max N liga-dnů (N requestů)
    ordered = sorted(targets, key=lambda t: (t[2], -targets[t]))
    batch = ordered[:_SETTLE_BATCH_TARGETS]
    remaining = len(ordered) - len(batch)

    results = {}

    def _collect(matches):
        for m in matches:
            if m.get("home_score") is None or m.get("away_score") is None:
                continue
            if m.get("live"):
                continue   # neukončené, skóre se ještě může změnit
            results[m["id"]] = {"home": m["home_score"], "away": m["away_score"]}

    if batch:
        def _grab_league(t):
            sport, slug, date_str = t
            return ds.fetch_league_scores(sport, slug, date_str)
        # nízká paralelizace záměrně – víc vláken = víc paměti na síťová
        # spojení, na Render free tieru (512 MB) vyšší počty appku shazovaly
        with ThreadPoolExecutor(max_workers=min(4, len(batch))) as ex:
            for matches in ex.map(_grab_league, batch):
                _collect(matches)

    # Fallback pro záznamy bez slugu: celoplošný sken (všech 244 lig – drahé),
    # max 1 den za průchod, jen když cílená fronta je hotová, a navíc throttle
    # na 1× za 2 minuty – jinak by jakmile fronta klesne, běžel skoro pořád
    # a byl by to dominantní zdroj zátěže na paměť/síť.
    global _last_slugless_fallback
    if not remaining and slugless_days and _time.time() - _last_slugless_fallback > 120:
        _last_slugless_fallback = _time.time()
        oldest = sorted(slugless_days, key=lambda sd: (sd[1], -slugless_days[sd]))[:1]
        for sport, date_str in oldest:
            try:
                _collect(ds.fetch_range(date_str, date_str, use_cache=False, sport=sport))
            except Exception:
                pass
        remaining += max(0, len(slugless_days) - 1)
    elif slugless_days:
        remaining += len(slugless_days)   # zatím netknuté – ať more_pending zůstane pravdivé

    # Rohy se ověřují zvlášť přes ESPN boxscore (summary endpoint, statistika
    # "wonCorners") – jen pro zápasy, které právě skončily a mají otevřený
    # rohový tip. Ne každá liga má detailní boxscore, proto best-effort.
    corner_results = {}
    corner_targets = [
        (t.get("sport", "soccer"), t.get("slug", ""), t["id"])
        for t in open_tips
        if t.get("corner_outcome") and t["id"] in results and t.get("slug")
    ]
    # + rohové SÁZKY agenta (market="corners") – vyhodnocují se proti počtu rohů
    corner_targets += [
        (b.get("sport", "soccer"), b.get("slug", ""), b["match_id"])
        for b in open_bets
        if b.get("market") == "corners" and b["match_id"] in results and b.get("slug")
    ]
    corner_targets = list(dict.fromkeys(corner_targets))   # dedupe
    if corner_targets:
        def _grab_corners(target):
            sport, slug, mid = target
            try:
                return mid, ds.fetch_corners(sport, slug, mid)
            except Exception:
                return mid, None
        with ThreadPoolExecutor(max_workers=min(6, len(corner_targets))) as ex:
            for mid, c in ex.map(_grab_corners, corner_targets):
                if c:
                    corner_results[mid] = c

    return results, corner_results, remaining > 0


@app.route("/api/bet/autosettle", methods=["POST"])
def api_autosettle():
    """Vyhodnotí otevřené SÁZKY (bank) – natáhne čerstvé výsledky z ESPN (stejná
    robustní logika jako /api/tips/settle), takže funguje i po restartu appky
    nebo když zápas mezitím doběhl a nebyl v paměťové keši predikcí."""
    results, corner_results, more_pending = _settle_recent()
    tips_db.settle_tips(results, corner_results)   # ať zůstane synchronní s tipy
    n = bankroll.auto_settle(results, corner_results)
    return jsonify({"settled": n, "stats": bankroll.stats(),
                    "bets": bankroll.state()["bets"][:50], "more_pending": more_pending})


# ---------------------------------------------------------------------------
# API – databáze tipů modelu
# ---------------------------------------------------------------------------
@app.route("/api/tips")
def api_tips():
    sport  = request.args.get("sport")
    status = request.args.get("status")   # open / settled / won / lost
    limit  = int(request.args.get("limit", 200))
    offset = int(request.args.get("offset", 0))
    tips   = tips_db.get_tips(sport=sport, status=status, limit=limit, offset=offset)
    return jsonify({"tips": tips, "total": len(tips)})


@app.route("/api/tips/stats")
def api_tips_stats():
    sport = request.args.get("sport")
    return jsonify(tips_db.stats(sport=sport))


@app.route("/api/tips/settle", methods=["POST"])
def api_tips_settle():
    """Vyhodnotí otevřené tipy i sázky (bank) – čerstvá data z ESPN, viz _settle_recent()."""
    results, corner_results, more_pending = _settle_recent()
    n = tips_db.settle_tips(results, corner_results)
    n_bets = bankroll.auto_settle(results, corner_results)   # sázky vč. agenta a AKO tiketů
    _PRED_CACHE.clear()   # ať se i v UI hned zobrazí čerstvě stažené výsledky
    return jsonify({"settled": n, "settled_bets": n_bets, "stats": tips_db.stats(),
                    "more_pending": more_pending})


@app.route("/api/settle/status")
def api_settle_status():
    """Live stav automatické kontroly výsledků na pozadí + počty otevřených."""
    today = ds.today_str()
    open_tips = tips_db.open_tips_until(today)
    open_bets = [b for b in bankroll.state()["bets"]
                 if b["status"] == "open" and (b.get("match_date") or "") <= today]
    with _settle_lock:
        out = dict(_settle_status)
    out["open_tips"] = len(open_tips)
    out["open_bets"] = len(open_bets)
    return jsonify(out)


# ---------------------------------------------------------------------------
# API – Automatický sázecí agent (zítřejší tipy, plochý vklad z banku)
# ---------------------------------------------------------------------------
@app.route("/api/persist/status")
def api_persist_status():
    """Stav zálohování dat do GitHub Gistu (persistence na Renderu)."""
    return jsonify(persist.status())


@app.route("/api/calibration")
def api_calibration():
    """Stav kalibrace pravděpodobností (kolik dat, jak křivka opravuje)."""
    return jsonify(calibration.status())


@app.route("/api/calibration/rebuild", methods=["POST"])
def api_calibration_rebuild():
    return jsonify(calibration.rebuild())


@app.route("/api/dashboard")
def api_dashboard():
    """Data pro dashboard: tip dne, dnešní tiket agenta, včerejší bilance,
    úspěšnost tutovek a poslední automatický běh agenta."""
    import datetime as _dt
    today = ds.today_str()
    cfg = app_settings.get_settings()["agent"]

    # Tip dne = nejjistější tutovka z dnešních zápasů (fotbal, cached predikce).
    # NIKDY neblokuj na čerstvém ESPN fetchi (30–60 s) – když cache není,
    # vrať "warming" a nastartuj načtení na pozadí; frontend se doptá znovu.
    tip = None
    warming = False
    key = f"soccer~{today}~{today}"
    cache_file = f"cache_soccer_{today}_{today}.json"
    disk_ready = (storage.load(cache_file, None) is not None
                  and not storage.is_cache_stale(cache_file, ttl_hours=12))
    if key not in _PRED_CACHE and not disk_ready:
        # cache není → nastartuj fetch na pozadí, frontend se doptá za chvíli
        warming = True
        threading.Thread(target=lambda: _predictions_for(today, days=1, sport="soccer"),
                         daemon=True).start()
    else:
        try:
            preds = _predictions_for(today, days=1, sport="soccer")
            best_p, best_c = None, None
            for p in preds:
                if p.get("result") is not None or p.get("live"):
                    continue
                cands = agent._candidates(p, cfg)
                c = agent._best_tutovka(cands, float(cfg.get("min_prob", 0.75)),
                                        float(cfg.get("min_odds", 1.20)), only_real=False)
                if c and (best_c is None or c.get("cal_prob", c["prob"]) > best_c.get("cal_prob", best_c["prob"])):
                    best_p, best_c = p, c
            if best_c:
                tip = {
                    "match": f'{best_p["home"]} – {best_p["away"]}',
                    "league": best_p.get("league"),
                    "date": best_p.get("date"), "time": best_p.get("time"),
                    "name": best_c["name"], "label": best_c["label"],
                    "odds": best_c["odds"], "prob": best_c.get("cal_prob", best_c["prob"]),
                    "real": best_c["real"], "market": best_c["market"],
                }
        except Exception:
            pass

    bets = agent.agent_bets()
    yesterday = (_dt.date.today() - _dt.timedelta(days=1))

    def _settled_on(b, day):
        try:
            return _dt.date.fromtimestamp(b.get("settled_ts") or 0) == day
        except Exception:
            return False

    y_bets = [b for b in bets if b["status"] in ("won", "lost") and _settled_on(b, yesterday)]
    y_summary = {
        "settled": len(y_bets),
        "won": sum(1 for b in y_bets if b["status"] == "won"),
        "pnl": round(sum(b["pnl"] for b in y_bets), 2),
    }

    # Úspěšnost tutovek (single tipy s prob >= min_prob)
    min_prob = float(cfg.get("min_prob", 0.75))
    tut = [b for b in bets if b["status"] in ("won", "lost")
           and b.get("outcome") != "acca" and (b.get("prob") or 0) >= min_prob]
    tut_won = sum(1 for b in tut if b["status"] == "won")
    tutovka_stats = {
        "settled": len(tut), "won": tut_won,
        "accuracy": round(tut_won / len(tut) * 100, 1) if tut else None,
    }

    # Dnešní AKO tiket agenta
    ticket = None
    for b in bets:
        if b.get("outcome") == "acca":
            try:
                if _dt.date.fromtimestamp(b["ts"]) == _dt.date.today():
                    ticket = b
                    break
            except Exception:
                pass

    return jsonify({
        "tip": tip,
        "warming": warming,
        "ticket": ticket,
        "yesterday": y_summary,
        "tutovka": tutovka_stats,
        "last_run": storage.load("agent_last_run.json", None),
    })


@app.route("/api/agent")
def api_agent():
    """Stav agenta: nastavení, statistiky výkonu a jeho sázky."""
    return jsonify({
        "settings": app_settings.get_settings()["agent"],
        "stats": agent.agent_stats(),
        "league_stats": agent.league_stats(),
        "bets": agent.agent_bets()[:60],
        "balance": bankroll.state()["balance"],
    })


@app.route("/api/agent/settings", methods=["POST"])
def api_agent_settings():
    d = request.get_json(force=True)
    app_settings.update_settings("agent", {
        k: v for k, v in d.items()
        if k in ("enabled", "bet_today", "stake_mode", "stake", "kelly_fraction", "max_daily_stake_pct", "only_sharp", "only_real_odds", "auto_run", "auto_run_hours", "auto_retrain", "auto_retrain_threshold",
                 "min_prob", "min_odds", "markets", "sports",
                 "daily_ticket", "daily_ticket_legs", "ticket_stake", "weekend_ticket", "weekend_ticket_legs")
    })
    return jsonify(app_settings.get_settings()["agent"])


@app.route("/api/agent/run", methods=["POST"])
def api_agent_run():
    """Vsadí zítřejší ostré tipy. `auto=True` = tichý běh při startu appky
    (nic nedělá, když je agent vypnutý); tlačítko posílá force=True."""
    d = request.get_json(silent=True) or {}
    cfg = app_settings.get_settings()["agent"]
    if not cfg.get("enabled") and not d.get("force"):
        return jsonify({"skipped": "disabled"})
    start_date = ds.today_str() if cfg.get("bet_today") else ds.add_days(ds.today_str(), 1)
    days = 2 if cfg.get("bet_today") else 1
    predictions = []
    for sport in cfg.get("sports") or ["soccer"]:
        try:
            predictions.extend(_predictions_for(start_date, days=days, sport=sport))
        except Exception:
            pass   # výpadek jednoho sportu nesmí shodit celý běh
    result = agent.run(predictions)
    result["stats"] = agent.agent_stats()
    storage.save("agent_last_run.json", {
        "ts": int(_time.time()), "placed": result.get("placed", 0),
        "tickets": result.get("tickets", []), "balance": result.get("balance"),
        "mode": "manual",
    })
    return jsonify(result)


# ---------------------------------------------------------------------------
# API – Pokročilé nastavení a správa dat
# ---------------------------------------------------------------------------
@app.route("/api/settings")
def api_settings():
    return jsonify(app_settings.get_settings())


@app.route("/api/settings", methods=["POST"])
def api_settings_save():
    d = request.get_json(force=True)
    section = d.get("section")
    values = d.get("values", {})
    try:
        st = app_settings.update_settings(section, values)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if section == "model":
        pred.apply_settings()
        _PRED_CACHE.clear()   # parametry modelu se změnily, staré predikce už neplatí
    return jsonify(st)


@app.route("/api/settings/reset", methods=["POST"])
def api_settings_reset():
    st = app_settings.reset_settings()
    pred.apply_settings()
    _PRED_CACHE.clear()
    return jsonify(st)


@app.route("/api/data/clear-cache", methods=["POST"])
def api_data_clear_cache():
    n = app_settings.clear_prediction_cache()
    _PRED_CACHE.clear()
    return jsonify({"cleared": n})


@app.route("/api/data/reset-tips", methods=["POST"])
def api_data_reset_tips():
    app_settings.reset_tips_db()
    return jsonify({"ok": True})


@app.route("/api/data/export")
def api_data_export():
    return jsonify(app_settings.export_all())


@app.route("/api/data/import", methods=["POST"])
def api_data_import():
    d = request.get_json(force=True)
    try:
        app_settings.import_all(d)
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    pred.apply_settings()
    _PRED_CACHE.clear()
    return jsonify({"ok": True})


@app.route("/api/result", methods=["POST"])
def api_result():
    """Zadání reálného výsledku – engine aktualizuje Elo ratingy (učí se)."""
    d = request.get_json(force=True)
    pred.update_from_result(d["home"], d["away"], d.get("league", ""),
                            int(d["home_score"]), int(d["away_score"]))
    _PRED_CACHE.clear()
    return jsonify({"ok": True})


@app.route("/api/analytics")
def api_analytics():
    """Vrátí profesionální metriky: unit_count, sharpe_ratio, monthly_pnl, by_league."""
    s = bankroll.stats()
    return jsonify({
        "unit_count": s.get("unit_count"),
        "sharpe_ratio": s.get("sharpe_ratio"),
        "monthly_pnl": s.get("monthly_pnl", {}),
        "by_league": s.get("by_league", {}),
        "equity": s.get("equity", []),
        "profit": s.get("profit"),
        "roi": s.get("roi"),
        "win_rate": s.get("win_rate"),
    })


# Příprava na nasazení jako web: adresa/port jdou přepsat proměnnými prostředí
# (HOST=0.0.0.0 PORT=8080 python app.py). Lokální výchozí zůstává 127.0.0.1:5000.
# Pro veřejný provoz použij produkční WSGI server (waitress/gunicorn), ne app.run().
_HOST = os.environ.get("HOST", "127.0.0.1")
_PORT = int(os.environ.get("PORT", "5000"))


def _open_browser():
    webbrowser.open(f"http://{_HOST}:{_PORT}")


def _prewarm():
    """Na pozadí předehřeje predikce na dnešek (3denní okno), ať je první
    zobrazení svižné. Zkráceno ze 7 na 3 dny a zúženo na 244→top ligy by
    fetch_range udělal stejně, ale hlavně: nespouští se hned při startu,
    ať nekoliduje s ostatními background thready (settle, persist) v
    kritickém prvním minutě po bootu, kdy appka na Render free tieru
    (512 MB) opakovaně padala."""
    try:
        _time.sleep(10)   # ať gunicorn worker nejdřív stihne přijmout první requesty
        _predictions_for(ds.today_str(), days=3)
    except Exception:
        pass


def _settle_in_background():
    """Automatická kontrola výsledků – běží na pozadí neustále, opakovaně zpracovává
    otevřené sázky/tipy v dávkách. Aktualizuje _settle_status pro live progress v UI.
    Když není co řešit, čeká 10s a pak zkusí znovu."""
    import time

    # Rozestup od _prewarm (start +10s, běh desítky s) a persist (první push
    # v +60s) – ať v kritické první minutě po bootu neběží víc síťově těžkých
    # operací najednou (appka na Render free tieru na to opakovaně padala).
    time.sleep(45)

    while True:
        try:
            with _settle_lock:
                # Počet VYHODNOTITELNÝCH položek (zápas do dneška) na začátku běhu
                today = ds.today_str()
                open_bets = [b for b in bankroll.state()["bets"]
                            if b["status"] == "open" and b.get("match_id")
                            and (b.get("match_date") or "") <= today]
                open_tips = tips_db.open_tips_until(today)
                total = len(open_bets) + len(open_tips)

                if total == 0:
                    # Nic k vyřešení – dále v cyklu
                    _settle_status["in_progress"] = False
                    _settle_status["settled_so_far"] = 0
                else:
                    _settle_status["in_progress"] = True
                    _settle_status["current_batch"] = []
                    _settle_status["total_pending"] = total
                    _settle_status["settled_so_far"] = 0  # reset na začátku běhu

            if total == 0:
                # Nic k vyřešení – delší čekání (snížení CPU)
                time.sleep(30)
                continue

            # Natáhni a vyřeš jednu dávku
            results, corner_results, more_pending = _settle_recent()
            n_tips = tips_db.settle_tips(results, corner_results)
            n_bets = bankroll.auto_settle(results, corner_results)
            _PRED_CACHE.clear()
            _maybe_auto_retrain(n_tips + n_bets)
            if n_tips:
                try:
                    calibration.rebuild()   # nové výsledky → aktualizuj kalibrační křivku
                except Exception:
                    pass

            with _settle_lock:
                _settle_status["settled_so_far"] += n_tips + n_bets
                _settle_status["more_pending"] = more_pending
                _settle_status["last_check"] = int(_time.time())
                if not more_pending:
                    _settle_status["in_progress"] = False

            if n_tips + n_bets == 0:
                time.sleep(300)
            elif more_pending:
                time.sleep(3)
            else:
                time.sleep(60)

        except Exception as e:
            print(f"[settle_bg] Chyba: {e}")
            import traceback
            traceback.print_exc()
            with _settle_lock:
                _settle_status["in_progress"] = False
            time.sleep(10)  # více čekat při chybě


# ============================================================================
# AUTO-RUN AGENT (pozadí)
# ============================================================================

_auto_agent_last_run_date = {}  # {hour: "YYYY-MM-DD"} – aby se agent nespouštěl 2× za hodinu

def _auto_agent_loop():
    """Automaticky spouští agenta v nastavených hodinách (např. 8:00, 16:00).
    Kontroluje každých 60 s, zda nastal čas pro běh."""
    import time
    import datetime as _dt

    time.sleep(90)   # rozestup od ostatních background threadů, viz _settle_in_background

    while True:
        try:
            cfg = app_settings.get_settings()["agent"]
            if cfg.get("enabled") and cfg.get("auto_run"):
                now = _dt.datetime.now()
                today_str = now.strftime("%Y-%m-%d")
                hours_raw = str(cfg.get("auto_run_hours", "8,16"))
                try:
                    run_hours = [int(h.strip()) for h in hours_raw.split(",") if h.strip()]
                except ValueError:
                    run_hours = [8, 16]

                if now.hour in run_hours and _auto_agent_last_run_date.get(now.hour) != today_str:
                    print(f"[auto-agent] Automatický běh agenta v {now.hour}:00")
                    _auto_agent_last_run_date[now.hour] = today_str
                    try:
                        start_date = ds.today_str() if cfg.get("bet_today") else ds.add_days(ds.today_str(), 1)
                        days = 2 if cfg.get("bet_today") else 1
                        predictions = []
                        for sport in cfg.get("sports") or ["soccer"]:
                            try:
                                predictions.extend(_predictions_for(start_date, days=days, sport=sport))
                            except Exception:
                                pass
                        result = agent.run(predictions)
                        storage.save("agent_last_run.json", {
                            "ts": int(time.time()), "placed": result.get("placed", 0),
                            "tickets": result.get("tickets", []),
                            "balance": result.get("balance"), "mode": "auto",
                        })
                        print(f"[auto-agent] Hotovo: {result.get('placed', 0)} sázek, balance={result.get('balance')}")
                    except Exception as e:
                        print(f"[auto-agent] Chyba při běhu agenta: {e}")
        except Exception as e:
            print(f"[auto-agent] Chyba: {e}")

        time.sleep(60)


# ============================================================================
# AUTO-RETRAIN ML (pozadí – integrováno do settle smyčky)
# ============================================================================

_retrain_settled_count = 0  # kolik sázek se settled od posledního retrainu

def _maybe_auto_retrain(newly_settled: int):
    """Zavolá se po každém settle batchi. Pokud se nasbíralo dost nových
    settled sázek, automaticky přetrénuje ML model."""
    global _retrain_settled_count
    if newly_settled <= 0:
        return
    _retrain_settled_count += newly_settled

    cfg = app_settings.get_settings()["agent"]
    if not cfg.get("auto_retrain", True):
        return

    threshold = int(cfg.get("auto_retrain_threshold", 10))
    if _retrain_settled_count >= threshold:
        print(f"[auto-retrain] {_retrain_settled_count} nových settled sázek → spouštím retrain ML modelu")
        try:
            from engine import ml_learner
            success = ml_learner.train_model(days=30)
            if success:
                print("[auto-retrain] Model úspěšně přetrénován")
            else:
                print("[auto-retrain] Nedostatek dat pro trénink")
        except Exception as e:
            print(f"[auto-retrain] Chyba: {e}")
        _retrain_settled_count = 0


# ============================================================================
# ML LEARNING API ENDPOINTS
# ============================================================================

@app.route("/api/learning/stats", methods=["GET"])
def api_learning_stats():
    """Get agent learning statistics and model metrics."""
    try:
        from engine import ml_learner
        stats = ml_learner.get_learning_stats()
        return jsonify(stats)
    except Exception as e:
        return jsonify({"error": str(e), "status": "error"}), 500

@app.route("/api/learning/train", methods=["POST"])
def api_learning_train():
    """Trigger model training on recent feedback."""
    try:
        from engine import ml_learner
        success = ml_learner.train_model(days=30)
        stats = ml_learner.get_learning_stats()
        return jsonify({
            "success": success,
            "stats": stats,
            "message": "Model trained successfully" if success else "Not enough data to train"
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500

@app.route("/api/feedback/record", methods=["POST"])
def api_record_feedback():
    """Record a bet outcome for learning."""
    try:
        data = request.get_json()
        from engine import ml_learner

        record = ml_learner.record_bet_outcome(
            bet_id=data.get("bet_id"),
            match_id=data.get("match_id"),
            prediction=data.get("prediction"),
            odds=float(data.get("odds", 1.5)),
            stake=float(data.get("stake", 10)),
            outcome=data.get("outcome"),  # "won" / "lost" / "void"
            home_team=data.get("home_team"),
            away_team=data.get("away_team"),
            league=data.get("league"),
            match_date=data.get("match_date"),
            features=data.get("features")
        )

        return jsonify({
            "success": True,
            "record": record
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


# ============ BACKTESTING API ============

@app.route("/api/backtest/league", methods=["GET"])
@login_required
def api_backtest_league():
    """Backtest performance by league."""
    try:
        bt = backtester.Backtester()
        bets = bankroll.state()["bets"]
        results = bt.backtest_by_league(bets)
        return jsonify({"success": True, "results": results})
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/backtest/agent-vs-manual", methods=["GET"])
@login_required
def api_backtest_agent_vs_manual():
    """Compare agent vs manual bets."""
    try:
        bt = backtester.Backtester()
        bets = bankroll.state()["bets"]
        results = bt.backtest_agent_vs_manual(bets)
        return jsonify({"success": True, "results": results})
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/backtest/best-leagues", methods=["GET"])
@login_required
def api_best_leagues():
    """Get best performing leagues."""
    try:
        bt = backtester.Backtester()
        bets = bankroll.state()["bets"]
        top_n = int(request.args.get("top", 5))
        results = bt.get_best_leagues(bets, top_n)
        return jsonify({"success": True, "results": results})
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/backtest/odds-ranges", methods=["GET"])
@login_required
def api_backtest_odds():
    """Backtest performance by odds ranges."""
    try:
        bt = backtester.Backtester()
        bets = bankroll.state()["bets"]
        results = bt.backtest_by_odds_range(bets)
        return jsonify({"success": True, "results": results})
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


# ============ EXPLAINABILITY API ============

@app.route("/api/explain/<bet_id>", methods=["GET"])
@login_required
def api_explain_bet(bet_id):
    """Get SHAP-style explanation for a bet."""
    try:
        # ModelExplainer čeká instanci MLLearner, ne modul
        exp = explainer.ModelExplainer(ml_learner.get_learner() if ML_AVAILABLE else None)

        # Find bet in bankroll
        bets = bankroll.state()["bets"]
        bet = next((b for b in bets if b["id"] == bet_id), None)

        if not bet:
            return jsonify({"error": "Bet not found", "success": False}), 404

        # Generate explanation
        explanation = exp.explain_prediction(
            bet_id=bet_id,
            features={
                "odds": bet["odds"],
                "prob": bet["prob"],
                "stake": bet["stake"],
                "league": bet.get("league"),
                "prediction": bet["outcome"]
            },
            prediction_prob=bet["prob"],
            odds=bet["odds"],
            stake=bet["stake"]
        )

        return jsonify({"success": True, "explanation": explanation})
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/feature-importance", methods=["GET"])
@login_required
def api_feature_importance():
    """Get global feature importance."""
    try:
        if not ML_AVAILABLE:
            return jsonify({"success": False, "error": "ML not available"}), 500

        stats = ml_learner.get_learning_stats()
        importance = stats.get("feature_importance", {})

        return jsonify({
            "success": True,
            "feature_importance": importance,
            "top_features": sorted(importance.items(), key=lambda x: x[1], reverse=True)[:8]
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


# ============ ADVANCED ANALYTICS API ============

@app.route("/api/analytics/summary", methods=["GET"])
@login_required
def api_analytics_summary():
    """Get comprehensive analytics summary."""
    try:
        stats = bankroll.stats()
        bt = backtester.Backtester()
        bets = bankroll.state()["bets"]

        league_perf = bt.backtest_by_league(bets)
        agent_vs_manual = bt.backtest_agent_vs_manual(bets)
        best_leagues = bt.get_best_leagues(bets, 5)

        return jsonify({
            "success": True,
            "bankroll_stats": stats,
            "league_performance": league_perf,
            "agent_vs_manual": agent_vs_manual,
            "best_leagues": best_leagues,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


# ============ MONITORING API ============

@app.route("/api/monitoring/summary", methods=["GET"])
@login_required
def api_monitoring_summary():
    """Get monitoring and health summary."""
    try:
        if not MONITORING_AVAILABLE:
            return jsonify({"success": False, "error": "Monitoring not available"}), 500

        monitor = monitoring.PerformanceMonitor()
        summary = monitor.get_summary()

        return jsonify({
            "success": True,
            "monitoring": summary,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/monitoring/alerts", methods=["GET"])
@login_required
def api_monitoring_alerts():
    """Get recent alerts."""
    try:
        if not MONITORING_AVAILABLE:
            return jsonify({"success": False, "error": "Monitoring not available"}), 500

        monitor = monitoring.PerformanceMonitor()
        hours = int(request.args.get("hours", 24))
        alerts = monitor.get_active_alerts(hours=hours)

        return jsonify({
            "success": True,
            "alerts": alerts,
            "count": len(alerts),
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


# ============ BANKROLL STATISTICS API ============

@app.route("/api/bankroll/summary", methods=["GET"])
@login_required
def api_bankroll_summary():
    """Get comprehensive bankroll summary."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        summary = ba.get_summary()

        return jsonify({
            "success": True,
            "summary": summary,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/bankroll/daily", methods=["GET"])
@login_required
def api_bankroll_daily():
    """Get daily breakdown."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        daily = ba.get_daily_breakdown()

        return jsonify({
            "success": True,
            "daily": daily,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/bankroll/monthly", methods=["GET"])
@login_required
def api_bankroll_monthly():
    """Get monthly breakdown."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        monthly = ba.get_monthly_breakdown()

        return jsonify({
            "success": True,
            "monthly": monthly,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/bankroll/best-worst", methods=["GET"])
@login_required
def api_bankroll_best_worst():
    """Get best and worst days."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        n = int(request.args.get("n", 5))
        data = ba.get_best_worst_days(n)

        return jsonify({
            "success": True,
            "best_days": data["best"],
            "worst_days": data["worst"],
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/bankroll/streaks", methods=["GET"])
@login_required
def api_bankroll_streaks():
    """Get streak analysis."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        streaks = ba.get_streak_analysis()

        return jsonify({
            "success": True,
            "streaks": streaks,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/bankroll/hourly", methods=["GET"])
@login_required
def api_bankroll_hourly():
    """Get hourly distribution."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        hourly = ba.get_hourly_distribution()

        return jsonify({
            "success": True,
            "hourly": hourly,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


@app.route("/api/bankroll/roi-by-odds", methods=["GET"])
@login_required
def api_bankroll_roi_odds():
    """Get ROI by odds ranges."""
    try:
        st = bankroll.state()
        ba = bankroll_stats.BankrollAnalytics(st["bets"], start_balance=st["start_balance"])
        roi = ba.get_roi_by_odds()

        return jsonify({
            "success": True,
            "roi_by_odds": roi,
        })
    except Exception as e:
        return jsonify({"error": str(e), "success": False}), 500


_BG_STARTED = False


def _start_background_threads():
    """Spustí background smyčky (prewarm, settle, auto-agent). Volá se jak při
    lokálním běhu (python app.py), tak pod gunicornem na Renderu – tam se
    __main__ blok nikdy nespustí, takže bez tohoto by na serveru neběželo
    automatické načítání zápasů, vyhodnocování ani auto-run agenta."""
    global _BG_STARTED
    if _BG_STARTED:
        return
    _BG_STARTED = True
    n_cleaned = storage.cleanup_old_caches(max_age_days=14)
    if n_cleaned:
        print(f"[cleanup] Smazáno {n_cleaned} starých cache souborů")
    persist.start()   # obnova dat z gistu (Render) + zálohovací smyčka
    threading.Thread(target=_prewarm, daemon=True).start()
    threading.Thread(target=_settle_in_background, daemon=True).start()
    threading.Thread(target=_auto_agent_loop, daemon=True).start()


# Pod gunicornem (Render) se modul jen importuje – nastartuj pozadí hned tady.
if os.environ.get("RENDER") or "gunicorn" in os.environ.get("SERVER_SOFTWARE", ""):
    _start_background_threads()


if __name__ == "__main__":
    _start_background_threads()
    print(f"⚽ KurzAnalytik běží na  http://{_HOST}:{_PORT}")
    if _HOST == "127.0.0.1":   # prohlížeč otvíráme jen při lokálním běhu
        threading.Timer(1.2, _open_browser).start()
    app.run(host=_HOST, port=_PORT, debug=False, threaded=True)
