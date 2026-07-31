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
from concurrent.futures import ThreadPoolExecutor, wait as _futures_wait

# Spustitelné z libovolného adresáře (kvůli importům a šablonám)
_HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(_HERE)
sys.path.insert(0, _HERE)

# --- samoinstalace závislostí (stejný styl jako ostatní appky) -------------
def _ensure():
    import importlib.util, subprocess
    # numpy je potřeba nepodmíněně (backtester ho importuje při startu)
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
from engine import goals_model as pred
from engine import bankroll
from engine import odds_api
from engine import tips_db
from engine import settings as app_settings
from engine import agent
from engine import virtual_bettors
from engine import calibration
from engine import persist
from engine import apifootball
from engine import backtester

# ML Learning (optional)
try:
    from engine import ml_learner
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False

try:
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
_PRED_CACHE = {}          # key -> (uloženo_v, predikce)
PRED_CACHE_TTL = 300      # 5 min – kratší než soft TTL keše zápasů

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
    # Statické soubory (CSS/JS) musí jít i nepřihlášenému uživateli – jinak
    # se přihlašovací stránka sama vykreslí nestylovaná (link na style.css
    # dostane 302 na /login místo CSS, prohlížeč to zahodí jako 0 pravidel).
    if request.path.startswith("/static/"):
        return
    # Cron endpoint má vlastní token-based auth (viz api_cron_settle) – běžná
    # session zde nedává smysl, volá ho externí scheduler (GitHub Actions).
    if request.path == "/api/cron/settle":
        return

    # Check if user is authenticated
    if "user" not in session:
        # API call - return 401
        if request.path.startswith("/api/"):
            return jsonify({"error": "Unauthorized"}), 401
        # HTML page - redirect to login
        else:
            return redirect(url_for("login_page"))


def _persist_push_safe():
    """Okamžitě zazálohuje stav (bankroll, tipy, sázkaři, ratingy) do gistu,
    nečeká na 5min periodickou smyčku (persist.sync_loop). Render při
    KAŽDÉM redeployi resetuje efemérní disk na stav z repa – když appka
    mezitím vsadila/vyhodnotila a nestihla to zazálohovat před dalším
    deployem, data se nenávratně ztratí. Volej po každé mutaci stavu, co
    jde spustit z reálného requestu (cron tick, ruční tlačítko)."""
    try:
        persist.push()
    except Exception:
        pass


def _predictions_for(date_str: str, days: int = 1, sport: str = "soccer", refresh=False):
    days = max(1, min(14, int(days)))
    end = ds.add_days(date_str, days - 1)
    key = f"{sport}~{date_str}~{end}"
    # Predikce se drží jen krátce. Bez expirace by se čerstvá data z pozadí
    # (viz stale-while-revalidate v data_sources) nikdy neprojevila – appka by
    # do restartu servírovala predikce spočítané z prvních stažených zápasů.
    if not refresh:
        hit = _PRED_CACHE.get(key)
        if hit and _time.time() - hit[0] < PRED_CACHE_TTL:
            return hit[1]
    matches = ds.fetch_range(date_str, end, use_cache=not refresh, sport=sport)
    # Volitelné: nahradit ESPN kurzy přesnějšími ze zpoplatněného The Odds API,
    # pokud je nastaven klíč – jinak zůstávají zdarma ESPN (DraftKings) kurzy,
    # co už jsou v matches[i]["real_odds"].
    if odds_api.has_key():
        index = odds_api.fetch_index(sport)
        if index:
            for m in matches:
                rb = odds_api.lookup(index, m["home"], m["away"])
                if rb:
                    m["real_odds"] = {"provider": rb[0]["name"], "odds": rb[0]["odds"]}
    predictions = pred.predict_all(matches)
    _PRED_CACHE[key] = (_time.time(), predictions)

    # CLV: u otevřených sázek si zapsat aktuální kurz trhu. Poslední hodnota
    # před výkopem je "closing line" a porovnání s cenou, za kterou jsme
    # vsadili, řekne dřív než zisk, jestli agent bere lepší cenu než trh.
    try:
        cur_odds = {p["id"]: {k: v.get("odds") for k, v in (p.get("bets") or {}).items()
                              if v.get("real") and v.get("odds")}
                    for p in predictions if p.get("result") is None}
        bankroll.track_closing_odds(cur_odds)
    except Exception:
        pass
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
    def _slim_bet(b):
        if not b:
            return None
        return {"label": b.get("label"), "name": b.get("name"), "prob": b.get("prob"),
                "odds": b.get("odds"), "real": bool(b.get("real")), "is_value": bool(b.get("is_value"))}

    def slim_prediction(p):
        keys = ("home", "away") if p.get("two_way") else ("home", "draw", "away")
        bets = p.get("bets", {})
        odds = {k: bets[k].get("odds") for k in keys if k in bets and bets[k].get("odds")}
        # Další trhy pro kartičku zápasu (víc typů tipů, ne jen jeden "best
        # value" pick) – vítěz, nejjistější góly O/U linie, BTTS.
        best_goal_line = None
        for gl in p.get("goal_lines") or []:
            side = "over" if gl["over"]["prob"] >= gl["under"]["prob"] else "under"
            cand = gl[side]
            if best_goal_line is None or cand.get("prob", 0) > best_goal_line.get("prob", 0):
                best_goal_line = cand
        btts = None
        if not p.get("two_way"):
            by, bn = bets.get("btts_yes"), bets.get("btts_no")
            if by and bn:
                btts = _slim_bet(by if by.get("prob", 0) >= bn.get("prob", 0) else bn)
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
            "confidence": p.get("confidence"),
            "result": p.get("result"),
            "live": p.get("live", False),
            "best_value": p.get("best_value") or {},
            "odds": odds,
            "odds_source": p.get("odds_source", "model"),
            "exp_goals": p.get("exp_goals"),
            "exp_total": p.get("exp_total"),
            "rating_confidence": p.get("rating_confidence"),
            "goal_lines": p.get("goal_lines", [])[:2],
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
    # Tip dne: nejdřív skutečná value (nejvyšší EV). Když žádná není – což u
    # neznámých týmů nastává správně, protože model proti trhu nic neví –
    # ukáže se aspoň nejjistější trh s reálným kurzem, tedy to, co by agent
    # opravdu vsadil. Dřív se tip vázal jen na value a dashboard zůstal prázdný.
    upcoming = [p for p in slim_preds if p["result"] is None and not p["live"]
                and p["best_value"].get("odds")]
    valued = [p for p in upcoming if p["best_value"].get("is_value")]
    if valued:
        tip = max(valued, key=lambda p: p["best_value"].get("ev", 0))
    else:
        tip = max(upcoming, key=lambda p: p["best_value"].get("prob", 0), default=None)
        if tip and (tip["best_value"].get("prob") or 0) < 0.6:
            tip = None      # nic dost jistého – radši nenabízet nic
    return jsonify({
        "date": date_str,
        "days": max(1, min(14, int(days))),
        "total_matches": len(slim_preds),
        "total_leagues": len(league_list),
        "value_count": value_count,
        "tip": tip,
        "leagues": league_list,
    })


SEARCH_DAYS = 14          # jak daleko dopředu hledat zápasy týmu
ODDS_HORIZON_DAYS = 4     # za tímhle horizontem ESPN kurzy prakticky nedává


def _fold(s: str) -> str:
    """Text bez diakritiky pro porovnávání – bez toho by "karvina" nenašlo
    "Karviná" ani "plzen" tým "Plzeň", což je u českých týmů zásadní."""
    import unicodedata
    s = unicodedata.normalize("NFKD", (s or "").lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def _search_window(sport: str):
    """Zápasy od dneška na SEARCH_DAYS dopředu. Jeden ESPN dotaz na ligu pro
    celý rozsah (ne per den), takže je to stejně drahé jako běžný denní fetch
    a drží se to 12 h v keši."""
    today = ds.today_str()
    return ds.fetch_range(today, ds.add_days(today, SEARCH_DAYS - 1), sport=sport)


@app.route("/api/search")
@login_required
def api_search():
    """Vyhledání budoucích zápasů podle názvu týmu."""
    q = _fold((request.args.get("q") or "").strip())
    sport = request.args.get("sport", "soccer")
    if len(q) < 2:
        return jsonify({"query": q, "teams": [], "matches": [], "error": "Zadej aspoň 2 znaky"})

    try:
        matches = _search_window(sport)
    except Exception as e:
        return jsonify({"query": q, "teams": [], "matches": [], "error": str(e)}), 200

    today = ds.today_str()
    horizon = ds.add_days(today, ODDS_HORIZON_DAYS)
    hits, teams = [], {}
    for m in matches:
        # jen dosud neodehrané – hledáme, na co se dá vsadit
        if m.get("home_score") is not None or m.get("live"):
            continue
        home, away = m.get("home", ""), m.get("away", "")
        side = None
        if q in _fold(home):
            side = home
        elif q in _fold(away):
            side = away
        if not side:
            continue
        teams[side] = teams.get(side, 0) + 1
        # odds_expected: dál než horizont kurzy nečekej – frontend podle toho
        # odliší, jestli půjde o skutečný tip, nebo jen odhad modelu
        hits.append(_slim_search_match(m, sport, horizon))

    hits.sort(key=lambda x: (x["date"], x["time"]))
    team_list = [{"name": k, "matches": v} for k, v in
                 sorted(teams.items(), key=lambda kv: (-kv[1], kv[0]))]
    return jsonify({"query": q, "teams": team_list, "matches": hits[:60],
                    "total": len(hits), "days": SEARCH_DAYS})


@app.route("/api/leagues")
@login_required
def api_leagues():
    """Přehled soutěží, ve kterých appka reálně vidí nadcházející zápasy."""
    sport = request.args.get("sport", "soccer")
    try:
        matches = _search_window(sport)
    except Exception as e:
        return jsonify({"leagues": [], "error": str(e)}), 200

    today = ds.today_str()
    horizon = ds.add_days(today, ODDS_HORIZON_DAYS)
    agg = {}
    for m in matches:
        if m.get("home_score") is not None or m.get("live"):
            continue
        key = (m.get("league", ""), m.get("country", ""))
        a = agg.setdefault(key, {
            "league": key[0], "country": key[1], "flag": ds.flag(key[1]),
            "matches": 0, "with_odds": 0, "next_date": None, "last_date": None,
            # zdroj se pozná podle prefixu slugu – ligy z doplňkového zdroje
            # nemají kurzy, takže se na nich nedá sázet
            "source": "apifootball" if str(m.get("slug", "")).startswith("apif:") else "espn",
        })
        a["matches"] += 1
        if (m.get("real_odds") or {}).get("odds"):
            a["with_odds"] += 1
        d = m.get("date") or ""
        if d:
            if not a["next_date"] or d < a["next_date"]:
                a["next_date"] = d
            if not a["last_date"] or d > a["last_date"]:
                a["last_date"] = d

    out = sorted(agg.values(), key=lambda x: (-x["matches"], x["league"]))
    return jsonify({
        "leagues": out,
        "total_leagues": len(out),
        "total_matches": sum(x["matches"] for x in out),
        "total_with_odds": sum(x["with_odds"] for x in out),
        "days": SEARCH_DAYS,
        "odds_horizon": horizon,
        "apifootball": apifootball.usage_status(),
    })


def _slim_search_match(m: dict, sport: str, horizon: str) -> dict:
    return {
        "id": m["id"], "sport": sport, "slug": m.get("slug", ""),
        "home": m.get("home", ""), "away": m.get("away", ""),
        "date": m.get("date", ""), "time": m.get("time", ""),
        "league": m.get("league", ""), "country": m.get("country", ""),
        "flag": ds.flag(m.get("country", "")),
        "has_odds": bool((m.get("real_odds") or {}).get("odds")),
        "odds_expected": m.get("date", "") <= horizon,
    }


@app.route("/api/league/matches")
@login_required
def api_league_matches():
    """Nadcházející zápasy jedné soutěže – pro rozkliknutí ligy v přehledu."""
    league = (request.args.get("league") or "").strip()
    country = (request.args.get("country") or "").strip()
    sport = request.args.get("sport", "soccer")
    if not league:
        return jsonify({"matches": [], "error": "Chybí soutěž"}), 400

    try:
        matches = _search_window(sport)
    except Exception as e:
        return jsonify({"matches": [], "error": str(e)}), 200

    horizon = ds.add_days(ds.today_str(), ODDS_HORIZON_DAYS)
    hits = [_slim_search_match(m, sport, horizon) for m in matches
            if m.get("league", "") == league
            and (not country or m.get("country", "") == country)
            and m.get("home_score") is None and not m.get("live")]
    hits.sort(key=lambda x: (x["date"], x["time"]))
    return jsonify({"league": league, "country": country,
                    "flag": ds.flag(country), "matches": hits,
                    "total": len(hits)})


@app.route("/api/analysis/<match_id>")
@login_required
def api_analysis(match_id):
    """Kompletní rozbor jednoho zápasu + co by na něj agent vsadil."""
    sport = request.args.get("sport", "soccer")
    try:
        matches = _search_window(sport)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    m = next((x for x in matches if str(x["id"]) == str(match_id)), None)
    if not m:
        return jsonify({"error": "Zápas nenalezen"}), 404

    p = pred.predict_match(m)
    cfg = app_settings.get_settings().get("agent", {})

    # Stejná logika, jakou používá agent – ať se doporučení nerozchází s tím,
    # co by appka reálně vsadila.
    try:
        cands = agent._candidates(p, cfg)
        min_prob = float(cfg.get("min_prob", 0.75))
        min_odds = float(cfg.get("min_odds", 1.20))
        best = agent._best_tutovka(cands, min_prob, min_odds, True)
    except Exception:
        cands, best, min_prob, min_odds = [], None, 0.75, 1.20

    def _tip(c):
        cal = c.get("cal_prob", c.get("prob"))
        return {
            "outcome": c.get("outcome"), "label": c.get("label"), "name": c.get("name"),
            "prob": c.get("prob"), "cal_prob": cal, "odds": c.get("odds"),
            "edge": c.get("edge"), "ev": c.get("ev"),
            "real": bool(c.get("real")), "is_value": bool(c.get("is_value")),
            "passes": cal is not None and cal >= min_prob and (c.get("odds") or 0) >= min_odds,
        }

    ranked = sorted(cands, key=lambda c: -(c.get("cal_prob") or c.get("prob") or 0))

    return jsonify({
        "match": {
            "id": p["id"], "home": p["home"], "away": p["away"],
            "date": p.get("date"), "time": p.get("time"),
            "league": p.get("league"), "country": p.get("country"),
            "flag": ds.flag(p.get("country", "")), "sport": sport,
        },
        "probs": p.get("probs"), "pick": p.get("pick"),
        "confidence": p.get("confidence"),
        "exp_goals": p.get("exp_goals"), "exp_total": p.get("exp_total"),
        "rating_confidence": p.get("rating_confidence"),
        "rating_home": p.get("rating_home"), "rating_away": p.get("rating_away"),
        "top_scores": p.get("top_scores", [])[:5],
        "goal_lines": p.get("goal_lines", []),
        "has_odds": p.get("odds_source") == "real",
        "best_value": p.get("best_value"),
        "recommendation": _tip(best) if best else None,
        "candidates": [_tip(c) for c in ranked[:8]],
        "thresholds": {"min_prob": min_prob, "min_odds": min_odds},
    })




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
        bv = p.get("best_value")   # None, když zápas nemá reálné kurzy sázkovky
        if bv and bv.get("is_value"):
            r = bankroll.eval_outcome(bv["outcome"], hs, as_)
            if r:
                val_bets += 1
                val_profit += (bv["odds"] - 1) if r == "won" else -1

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
        "rating": pred.rating_of(name),
        "form": last,
        "upcoming": upcoming,
        "played": len(past),
        "win_rate": round(wins / len(past) * 100) if past else 0,
        "avg_for": round(sum(gf) / len(gf), 2) if gf else None,
        "avg_against": round(sum(ga) / len(ga), 2) if ga else None,
    })


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


@app.route("/api/apifootball/status")
@login_required
def api_apifootball_status():
    return jsonify(apifootball.usage_status())


@app.route("/api/apifootball/key", methods=["POST"])
@login_required
def api_apifootball_key():
    d = request.get_json(force=True)
    apifootball.set_key(d.get("key", ""))
    _PRED_CACHE.clear()
    # Keše zápasů drží starý (jen ESPN) obsah – bez pročištění by se doplněné
    # ligy objevily až za 12 h.
    try:
        storage.clear_match_caches()
    except Exception:
        pass
    return jsonify(apifootball.usage_status())


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
    "last_error": None,     # text poslední výjimky ze settle smyčky (diagnostika bez logů)
    "error_count": 0,
    "pass_started_at": None,       # unix ts začátku PRÁVĚ BĚŽÍCÍHO průchodu
    "last_pass_duration_s": None,  # jak dlouho trval poslední DOKONČENÝ průchod
}
_settle_lock = threading.Lock()
_last_slugless_fallback = 0.0   # throttle: plný sken 244 lig, ne každý průchod
_SETTLE_STATE_FILE = "settle_status.json"


def _load_settle_status():
    """Stav poslední kontroly přežije restart – jinak appka po každém startu
    tvrdí, že ještě nikdy nic nekontrolovala, i když kontrola proběhla."""
    try:
        saved = storage.load(_SETTLE_STATE_FILE, None) or {}
        for k in ("last_check", "last_pass_duration_s", "results_found",
                  "more_pending", "total_targets", "batch_size"):
            if k in saved:
                _settle_status[k] = saved[k]
    except Exception:
        pass


def _save_settle_status():
    try:
        with _settle_lock:
            snap = {k: _settle_status.get(k) for k in
                    ("last_check", "last_pass_duration_s", "results_found",
                     "more_pending", "total_targets", "batch_size")}
        storage.save(_SETTLE_STATE_FILE, snap)
    except Exception:
        pass


_load_settle_status()

# Diagnostika bootu – kdy se který background thread reálně spustil (nebo
# vůbec ne). Nastaveno jako VŮBEC PRVNÍ řádek v každé thread funkci, ať jde
# rozlišit "thread se nespustil" od "thread běží, ale visí/spí".
_boot_diag = {
    "module_import_at": None,
    "start_bg_threads_called_at": None,
    "prewarm_thread_entered_at": None,
    "settle_thread_entered_at": None,
    "agent_thread_entered_at": None,
    "persist_thread_entered_at": None,
    "canary_started_at": None,
    "canary_last_tick_at": None,
    "canary_ticks": 0,
}


_last_settle_debug = {}
_settle_batch_cursor = 0   # rotuje napříč voláními, ať se dávka nezasekne na stejné pomalé podmnožině


def _run_bounded(fn, items, max_workers, deadline_s, collect):
    """Spustí fn(item) pro každý item přes max_workers vláken, ale NIKDY nečeká
    déle než deadline_s celkem – na rozdíl od ThreadPoolExecutor().map() uvnitř
    `with` bloku, který při shutdown() vždy počká na VŠECHNA zadaná vlákna,
    i když jsme se je už vzdali čekat (na Renderu se jednotlivé ESPN requesty
    i s timeout=8s na požadavek chovaly, jako by visely podstatně déle –
    shutdown(wait=False) tohle omezení obchází, ať se appka nikdy nezasekne
    na jednom pomalém/mrtvém síťovém spojení)."""
    ex = ThreadPoolExecutor(max_workers=max_workers)
    futures = [ex.submit(fn, item) for item in items]
    done, not_done = _futures_wait(futures, timeout=deadline_s)
    for fut in done:
        try:
            collect(fut.result())
        except Exception:
            pass
    # Nedokončené necháme běžet na pozadí, ale request na ně dál nečeká.
    ex.shutdown(wait=False, cancel_futures=True)
    return len(not_done)


def _settle_recent(allow_slugless_fallback=False):
    """Sdílená logika vyhodnocení: CÍLENÉ dotazy jen na ligy, kde něco čeká.
    Každý otevřený tip/sázka nese slug ligy → místo skenu všech 244 lig na den
    se ptáme jen konkrétních lig (1 request na ligu a den, paralelně).
    Staré záznamy bez slugu se dořeší celoplošným skenem, až je cílená fronta
    prázdná – POKUD allow_slugless_fallback (automatická smyčka ho vypíná:
    v nejhorším případě, kdy hodně požadavků timeoutuje, může sken 244 lig
    trvat i desítky minut a blokovat celý průchod bez chyby k odchycení;
    ruční "Zkontrolovat výsledky" ho pořád smí použít). Vrací (results,
    corner_results, more_pending)."""
    today = ds.today_str()
    # Dávno odehrané a přesto nevyhodnocené tipy (odložené/zrušené zápasy) už
    # výsledek nedostanou – odklidit je, ať nezabírají místo ve frontě.
    try:
        tips_db.prune_stale(today)
    except Exception:
        pass
    open_tips = tips_db.open_tips_until(today)   # od nejstarších, jen vyhodnotitelné
    open_bets = [b for b in bankroll.state()["bets"] if b["status"] == "open" and b.get("match_id")]
    # Otevřené sázky sázkařů (engine/virtual_bettors.py) – BEZ tohohle by se
    # jejich zápas nikdy nedostal do cílů, jakmile by odpovídající tip/sázka
    # z reálného banku byly už vyhodnocené jinde (jiný match_id nemá jinam se
    # připojit) – sázkařova sázka by tak zůstala navždy OPEN.
    vb_state = virtual_bettors.load_state()
    open_vb_bets = [b for bettor in vb_state.values() for b in bettor["bets"] if b["status"] == "open"]

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
    for b in open_vb_bets:
        if not b.get("match_date") or b["match_date"] > today:
            continue
        sport = b.get("sport", "soccer")
        if b.get("slug"):
            k = (sport, b["slug"], b["match_date"])
            targets[k] = targets.get(k, 0) + 2
        else:
            k = (sport, b["match_date"])
            slugless_days[k] = slugless_days.get(k, 0) + 2

    # Nejstarší dny první, pak dle váhy; dávka = max N liga-dnů (N requestů).
    # ROTACE: debug ukázal, že ~15/24 cílů v dávce pravidelně nestihne 25s
    # deadline (pomalá ESPN liga/síť) – protože výběr byl VŽDY stejných
    # nejstarších 24, appka donekonečna zkoušela tu samou rychlou polovinu
    # a pomalá polovina (s hledanými tipy) se nikdy nedostala ke zpracování.
    # Kurzor rotuje napříč voláními, ať se postupně dostane na všechny.
    global _settle_batch_cursor
    ordered = sorted(targets, key=lambda t: (t[2], -targets[t]))
    if ordered:
        start_i = _settle_batch_cursor % len(ordered)
        batch = (ordered[start_i:] + ordered[:start_i])[:_SETTLE_BATCH_TARGETS]
        _settle_batch_cursor = (start_i + _SETTLE_BATCH_TARGETS) % len(ordered)
    else:
        batch = []
    remaining = len(ordered) - len(batch)

    results = {}
    voided = set()
    _pass_t0 = _time.time()
    with _settle_lock:
        _settle_status["in_progress"] = True
        _settle_status["pass_started_at"] = int(_pass_t0)
        _settle_status["batch_size"] = len(batch)
        _settle_status["total_targets"] = len(ordered)

    # Odložené/zrušené zápasy: výsledek nikdy nepřijde, ale ESPN je dál vrací.
    # Bez rozpoznání se fronta na nich zasekne a každý průchod je stahuje znovu
    # (typicky "matched_count: 0" i když se výsledky našly – jen patří jiným
    # zápasům toho dne).
    _VOID_MARKS = ("postpon", "cancel", "abandon", "suspend", "await",
                   "technical", "walkover", "forfeit")

    def _collect(matches):
        for m in matches:
            status = (m.get("status") or "").lower()
            if any(k in status for k in _VOID_MARKS):
                voided.add(m["id"])
                continue
            if m.get("home_score") is None or m.get("away_score") is None:
                continue
            if m.get("live"):
                continue   # neukončené, skóre se ještě může změnit
            results[m["id"]] = {"home": m["home_score"], "away": m["away_score"]}

    n_stuck = 0
    if batch:
        def _grab_league(t):
            sport, slug, date_str = t
            return ds.fetch_league_scores(sport, slug, date_str)
        # nízká paralelizace záměrně – víc vláken = víc paměti na síťová
        # spojení, na Render free tieru (512 MB) vyšší počty appku shazovaly.
        # Tvrdý deadline 25s – jednotlivé ESPN requesty se na Renderu chovaly,
        # jako by visely déle než jejich vlastní timeout=8s naznačuje.
        n_stuck = _run_bounded(_grab_league, batch, min(4, len(batch)), 25, _collect)
        if n_stuck:
            remaining += n_stuck   # nedokončené cíle → další průchod je zkusí znovu

        # Diagnostika: proč fronta neklesá i když results != {}? Porovná ID
        # zápasů, které ESPN vrátil, s ID, která čekají otevřené tipy z
        # PRÁVĚ zpracované dávky – nulový průnik = neshoda formátu/zdroje ID.
        batch_set = set(batch)
        batch_tip_ids = [t["id"] for t in open_tips
                         if t.get("slug") and (t.get("sport", "soccer"), t["slug"], t["date"]) in batch_set]
        _last_settle_debug.clear()
        _last_settle_debug.update({
            "batch_sample": [list(x) for x in batch[:5]],
            "results_count": len(results),
            "results_id_sample": list(results.keys())[:8],
            "batch_tip_ids_count": len(batch_tip_ids),
            "batch_tip_ids_sample": batch_tip_ids[:8],
            "matched_count": len(set(batch_tip_ids) & set(results.keys())),
            "n_stuck": n_stuck,
        })

    # Fallback pro záznamy bez slugu: celoplošný sken (všech 244 lig – drahé),
    # max 1 den za průchod, jen když cílená fronta je hotová, a navíc throttle
    # na 1× za 2 minuty – jinak by jakmile fronta klesne, běžel skoro pořád
    # a byl by to dominantní zdroj zátěže na paměť/síť.
    global _last_slugless_fallback
    if (allow_slugless_fallback and not remaining and slugless_days
            and _time.time() - _last_slugless_fallback > 120):
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

    # Model se učí přímo z každého potvrzeného výsledku – attack/defense
    # rating obou týmů se posune podle skutečného skóre vs. očekávání.
    # Dřív se rating aktualizoval JEN přes ruční /api/result endpoint, takže
    # se model ve skutečnosti z automatického vyhodnocování nikdy neučil.
    id_to_teams = {t["id"]: (t.get("home"), t.get("away"), t.get("league", ""),
                             t.get("sport", "soccer"), t.get("slug", ""))
                   for t in open_tips if t.get("home") and t.get("away")}
    for mid, r in results.items():
        info = id_to_teams.get(mid)
        if not info:
            continue
        home, away, league, sport, slug = info
        try:
            # sport+slug jsou nutné – bez nich se nefotbalové skóre poměřuje
            # s fotbalovou baseline (resp. WNBA s průměrem NBA) a rating se
            # učí proti úplně jinému očekávání, než jaké model předpovídá
            pred.update_from_result(home, away, league, r["home"], r["away"], sport, slug)
        except Exception:
            pass

    # Odložené/zrušené zápasy uzavřít, ať se fronta pohne: sázky se vrací jako
    # void (vklad zpět, žádný zisk ani ztráta), tipy se označí za propadlé.
    n_voided = 0
    if voided:
        try:
            for b in bankroll.state()["bets"]:
                if b.get("status") == "open" and b.get("match_id") in voided:
                    bankroll.settle_bet(b["id"], "void")
                    n_voided += 1
        except Exception:
            pass
        try:
            virtual_bettors.void_matches(voided)
        except Exception:
            pass
        try:
            tips_db.void_tips(voided)
        except Exception:
            pass

    corner_results = {}

    with _settle_lock:
        _settle_status["in_progress"] = False
        _settle_status["voided"] = len(voided)
        _settle_status["last_check"] = int(_time.time())
        _settle_status["last_pass_duration_s"] = round(_time.time() - _pass_t0, 1)
        _settle_status["results_found"] = len(results)
        _settle_status["n_stuck"] = n_stuck
        _settle_status["more_pending"] = remaining > 0
        _settle_status["last_error"] = None
    _save_settle_status()

    return results, corner_results, remaining > 0


@app.route("/api/bet/autosettle", methods=["POST"])
def api_autosettle():
    """Vyhodnotí otevřené SÁZKY (bank) – natáhne čerstvé výsledky z ESPN (stejná
    robustní logika jako /api/tips/settle), takže funguje i po restartu appky
    nebo když zápas mezitím doběhl a nebyl v paměťové keši predikcí."""
    results, corner_results, more_pending = _settle_recent()
    tips_db.settle_tips(results, corner_results)   # ať zůstane synchronní s tipy
    n = bankroll.auto_settle(results, corner_results)
    virtual_bettors.settle_all(results)
    _persist_push_safe()
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


@app.route("/api/cron/settle", methods=["GET", "POST"])
def api_cron_settle():
    """Vyhodnocení tipů/sázek spouštěné EXTERNĚ (GitHub Actions cron), ne
    interním background threadem. Zjištěno: na Render free tieru se proces
    mezi requesty zřejmě zcela pozastaví (i nejjednodušší canary thread bez
    sítě, jen s time.sleep(2), tikne přesně jednou a pak už nikdy) – interní
    background smyčky se sleep() tak strukturálně nemohou spolehlivě
    dokončit. Řešení: vyhodnocování žene SKUTEČNÝ příchozí HTTP request,
    ne vlákno čekající na wall-clock čas mezi requesty.

    Auth: token v query/header, ne session – volá to externí scheduler.
    Nastav env CRON_TOKEN na Renderu a stejný token v GitHub Actions secret.
    """
    expected = os.environ.get("CRON_TOKEN", "")
    got = request.args.get("token") or request.headers.get("X-Cron-Token", "")
    if not expected or got != expected:
        return jsonify({"error": "Unauthorized"}), 401

    results, corner_results, more_pending = _settle_recent()
    n_tips = tips_db.settle_tips(results, corner_results)
    n_bets = bankroll.auto_settle(results, corner_results)
    n_vb_settled = virtual_bettors.settle_all(results)
    _PRED_CACHE.clear()
    if n_tips:
        try:
            calibration.rebuild()
        except Exception:
            pass

    agent_info = _run_auto_agent_if_due()
    vb_info = _run_virtual_bettors_if_due()

    _persist_push_safe()

    return jsonify({"settled_tips": n_tips, "settled_bets": n_bets,
                    "settled_virtual": n_vb_settled,
                    "more_pending": more_pending, "ts": int(_time.time()),
                    "auto_agent": agent_info, "virtual_bettors": vb_info})


@app.route("/api/tips/settle", methods=["POST"])
def api_tips_settle():
    """Vyhodnotí otevřené tipy i sázky (bank) – čerstvá data z ESPN, viz _settle_recent()."""
    results, corner_results, more_pending = _settle_recent()
    n = tips_db.settle_tips(results, corner_results)
    n_bets = bankroll.auto_settle(results, corner_results)   # sázky vč. agenta a AKO tiketů
    n_vb = virtual_bettors.settle_all(results)
    _PRED_CACHE.clear()   # ať se i v UI hned zobrazí čerstvě stažené výsledky
    _persist_push_safe()
    return jsonify({"settled": n, "settled_bets": n_bets, "settled_virtual": n_vb,
                    "stats": tips_db.stats(), "more_pending": more_pending})


def _rss_mb():
    """Aktuální paměť procesu v MB (diagnostika OOM na Render free tieru bez
    přístupu k dashboardu). resource je jen na Unixu (Render ano, Windows ne)."""
    try:
        import resource
        kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux: ru_maxrss v KB. macOS: v bajtech (zde nerelevantní – Render = Linux)
        return round(kb / 1024, 1)
    except Exception:
        pass
    # Windows (lokální provoz) modul resource nemá – zkus psutil, a když není
    # ani ten, vrať None a diagnostika ten řádek prostě neukáže.
    try:
        import psutil
        return round(psutil.Process().memory_info().rss / (1024 * 1024), 1)
    except Exception:
        return None


@app.route("/api/settle/debug")
def api_settle_debug():
    """Detail POSLEDNÍHO volání _settle_recent(): vzorek ID zápasů, které ESPN
    vrátil, vs. ID, na která čekají tipy z právě zpracované dávky. Nulový
    'matched_count' i přes results_count > 0 = neshoda ve formátu/zdroji ID."""
    return jsonify(_last_settle_debug)


@app.route("/api/settle/diag")
def api_settle_diag():
    """Proč fronta klesá tak pomalu i po úspěšných /api/cron/settle voláních?
    Rozpad otevřených tipů: kolik jich má/nemá uložený slug ligy (bez slugu
    = nikdy se automaticky nevyhodnotí, fallback je vypnutý), kolik
    unikátních (sport, slug, datum) cílů čeká, a vzorek nejstarších."""
    today = ds.today_str()
    open_tips = tips_db.open_tips_until(today, limit=100000)
    with_slug = [t for t in open_tips if t.get("slug")]
    without_slug = [t for t in open_tips if not t.get("slug")]
    targets = {}
    for t in with_slug:
        k = (t.get("sport", "soccer"), t["slug"], t["date"])
        targets[k] = targets.get(k, 0) + 1
    oldest_targets = sorted(targets, key=lambda k: k[2])[:15]
    oldest_slugless_dates = sorted({t["date"] for t in without_slug})[:10]
    return jsonify({
        "open_total": len(open_tips),
        "with_slug": len(with_slug),
        "without_slug": len(without_slug),
        "unique_targets": len(targets),
        "batch_size_per_call": _SETTLE_BATCH_TARGETS,
        "passes_needed_estimate": max(1, -(-len(targets) // _SETTLE_BATCH_TARGETS)),
        "oldest_targets_sample": [
            {"sport": s, "slug": sl, "date": d, "count": targets[(s, sl, d)]}
            for (s, sl, d) in oldest_targets
        ],
        "oldest_slugless_dates_sample": oldest_slugless_dates,
    })


@app.route("/api/boot-diag")
def api_boot_diag():
    """Diagnostika bootu bez nutnosti Render logů: kdy se který background
    thread reálně spustil (nebo vůbec ne), navíc přidá čas 'teď' aby šlo
    přímo vypočítat stáří (kolik s uplynulo od boot)."""
    out = dict(_boot_diag)
    out["now"] = int(_time.time())
    return jsonify(out)


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
    out["rss_mb"] = _rss_mb()
    if out.get("in_progress") and out.get("pass_started_at"):
        out["current_pass_elapsed_s"] = int(_time.time()) - out["pass_started_at"]
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
    # Dřív se při chybějící cache spouštěl fetch na background threadu a
    # vracelo se "warming: true" – na Render free tieru se ale takový thread
    # mezi requesty prakticky nikdy nedokončí (viz canary-thread zjištění),
    # takže "Tip dne" zůstával navždy v načítání. Řešení: fetch proveď
    # SYNCHRONNĚ v rámci tohoto skutečného requestu (jednou za ~12 h, kdy
    # cache vyprší, bude odpověď pomalejší – to je lepší než nekonečný spinner).
    tip = None
    warming = False
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
    # Širší okno (4 dny) – s víc naplánovanými hodinami za den (8,12,16,20)
    # by úzké okno (dřív 1-2 dny) po prvním běhu vyčerpalo dedup a další
    # běhy ten den by neměly na co sázet, dokud nepřibudou nové zápasy.
    days = 4 if cfg.get("bet_today") else 3
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
    _persist_push_safe()
    return jsonify(result)


# ---------------------------------------------------------------------------
# API – Aréna 10 virtuálních sázkařů (engine/virtual_bettors.py)
# ---------------------------------------------------------------------------
@app.route("/api/bettors")
def api_bettors():
    """Žebříček virtuálních sázkařů seřazený podle zisku, s definicí skupin."""
    return jsonify({"bettors": virtual_bettors.leaderboard(),
                    "groups": virtual_bettors.GROUPS})


@app.route("/api/bettors/<bid>")
def api_bettor_detail(bid):
    detail = virtual_bettors.bettor_detail(bid)
    if not detail:
        return jsonify({"error": "not found"}), 404
    return jsonify(detail)


@app.route("/api/ratings/backfill", methods=["POST"])
@login_required
def api_ratings_backfill():
    """Dávkové natažení ratingů z odehrané historie."""
    d = request.get_json(force=True) or {}
    try:
        days = int(d.get("days") or 60)
    except (TypeError, ValueError):
        days = 60
    days = max(7, min(180, days))
    sport = d.get("sport") or "soccer"
    try:
        res = pred.backfill_ratings(days_back=days, sport=sport)
        _PRED_CACHE.clear()      # staré predikce vznikly z plochých ratingů
        _persist_push_safe()
        return jsonify(res)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ratings/status")
@login_required
def api_ratings_status():
    r = pred._ratings()
    played = [v for v in r.values() if v.get("n", 0) > 0]
    ns = sorted(v["n"] for v in played)
    return jsonify({
        "teams": len(r), "teams_with_history": len(played),
        "median_games": ns[len(ns) // 2] if ns else 0,
        "avg_games": round(sum(ns) / len(ns), 1) if ns else 0,
        "max_games": ns[-1] if ns else 0,
        "well_known": sum(1 for n in ns if n >= 10),
    })


@app.route("/api/bettors/options")
@login_required
def api_bettor_options():
    """Číselníky pro průvodce vytvořením sázkaře."""
    return jsonify({
        "markets": [{"key": k, "label": v[0]} for k, v in virtual_bettors.MARKETS.items()],
        "progressions": [{"key": k, "label": v} for k, v in virtual_bettors.PROGRESSIONS.items()],
        "stake_modes": [{"key": k, "label": v} for k, v in virtual_bettors.STAKE_MODES.items()],
        "defaults": virtual_bettors.default_params(),
    })


@app.route("/api/bettors/preview", methods=["POST"])
@login_required
def api_bettor_preview():
    """Náhled jména a popisu pro zadané parametry – průvodce ho ukazuje živě."""
    d = request.get_json(force=True) or {}
    params = d.get("params") or {}
    try:
        taken = [b.get("name") for b in virtual_bettors.load_state().values()]
        name, emoji = virtual_bettors.generate_name(params, taken=taken)
        return jsonify({"name": name, "emoji": emoji,
                        "tagline": virtual_bettors.describe_params(params)})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/bettors", methods=["POST"])
@login_required
def api_bettor_create():
    d = request.get_json(force=True) or {}
    try:
        b = virtual_bettors.add_bettor(
            d.get("params") or {},
            name=(d.get("name") or "").strip() or None,
            emoji=(d.get("emoji") or "").strip() or None,
            start_balance=float(d.get("start_balance") or 1000.0))
        _persist_push_safe()
        return jsonify(b)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/bettors/<bid>", methods=["DELETE"])
@login_required
def api_bettor_delete(bid):
    if not virtual_bettors.delete_bettor(bid):
        return jsonify({"error": "not found"}), 404
    _persist_push_safe()
    return jsonify({"ok": True, "deleted": bid})


@app.route("/api/bettors/<bid>/deposit", methods=["POST"])
@login_required
def api_bettor_deposit(bid):
    d = request.get_json(force=True) or {}
    try:
        amount = float(d.get("amount"))
    except (TypeError, ValueError):
        return jsonify({"error": "Neplatná částka"}), 400
    res = virtual_bettors.deposit(bid, amount, (d.get("note") or "").strip())
    if not res:
        return jsonify({"error": "Sázkař nenalezen nebo nulová částka"}), 404
    _persist_push_safe()
    return jsonify(res)


@app.route("/api/bettors/run", methods=["POST"])
def api_bettors_run():
    """Ruční spuštění kola sázení – obchází hodinový rozvrh (force=True),
    ale sázkaři pořád nikdy nevsadí dvakrát na stejný zápas."""
    today = ds.today_str()
    predictions = _predictions_for(today, days=4, sport="soccer")
    t0 = _time.time()
    placed = virtual_bettors.run_all(predictions, today, force=True)
    _persist_push_safe()
    board = virtual_bettors.leaderboard()
    # Detail kola, ať uživatel z UI pozná, co se stalo, a nemusí to dohledávat
    # v datech – kolik kdo vsadil a za kolik.
    names = {b["id"]: f'{b.get("emoji", "")} {b["name"]}'.strip() for b in board}
    detail = sorted(
        [{"id": bid, "name": names.get(bid, bid), "count": n,
          "staked": virtual_bettors.staked_since(bid, int(t0))}
         for bid, n in (placed or {}).items() if n],
        key=lambda x: -x["count"])
    return jsonify({
        "placed": placed, "bettors": board,
        "detail": detail,
        "total_placed": sum((placed or {}).values()),
        "total_staked": round(sum(d["staked"] for d in detail), 2),
        "eligible": len(board),
    })


@app.route("/api/bettors/groups")
@login_required
def api_bettor_groups():
    """Srovnání kategorií sázkařů – vyplácí se skládat tikety?"""
    return jsonify(virtual_bettors.group_comparison())


@app.route("/api/bettors/calibration")
def api_bettors_calibration():
    """Kalibrace modelu napříč settled sázkami všech 10 sázkařů – dává-li
    model 'X% jistotu', vyhrává reálně ~X % případů?"""
    return jsonify({"buckets": virtual_bettors.calibration_data()})


@app.route("/api/bettors/insight")
def api_bettors_insight():
    """Která strategie v aréně aktuálně vede + srovnání s výkonem agenta,
    případně konkrétní doporučené nastavení agenta (jen pro strategie
    s čistým 1:1 překladem, viz AGENT_SETTING_MAP)."""
    insight = virtual_bettors.leading_strategy_insight()
    insight["agent_stats"] = agent.agent_stats()
    return jsonify(insight)


@app.route("/api/bettors/insight/apply", methods=["POST"])
def api_bettors_insight_apply():
    """Aplikuje doporučené nastavení vedoucí strategie na agenta – jen na
    explicitní kliknutí uživatele, appka nastavení sama od sebe nemění."""
    insight = virtual_bettors.leading_strategy_insight()
    settings_to_apply = insight.get("agent_settings")
    if not settings_to_apply:
        return jsonify({"error": "Tuhle strategii nejde na agenta přímo aplikovat."}), 400
    app_settings.update_settings("agent", settings_to_apply)
    return jsonify({"applied": settings_to_apply, "agent": app_settings.get_settings()["agent"]})


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
                            int(d["home_score"]), int(d["away_score"]),
                            d.get("sport", "soccer"), d.get("slug", ""))
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


def _canary_loop():
    """Nejjednodušší možný background thread – žádná síť, žádný sleep(45),
    jen tikající čítač co 2s. Test: může na Render+gunicornu VŮBEC nějaký
    background thread běžet nepřetržitě? Pokud ani tohle netiká, problém
    není v settle logice, ale ve schopnosti threadů běžet na pozadí vůbec."""
    _boot_diag["canary_started_at"] = int(_time.time())
    n = 0
    while True:
        n += 1
        _boot_diag["canary_ticks"] = n
        _boot_diag["canary_last_tick_at"] = int(_time.time())
        _time.sleep(2)


def _prewarm():
    """Na pozadí předehřeje predikce na dnešek (3denní okno), ať je první
    zobrazení svižné. Zkráceno ze 7 na 3 dny a zúženo na 244→top ligy by
    fetch_range udělal stejně, ale hlavně: nespouští se hned při startu,
    ať nekoliduje s ostatními background thready (settle, persist) v
    kritickém prvním minutě po bootu, kdy appka na Render free tieru
    (512 MB) opakovaně padala."""
    _boot_diag["prewarm_thread_entered_at"] = int(_time.time())
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
    _boot_diag["settle_thread_entered_at"] = int(_time.time())

    # Rozestup od _prewarm (start +10s, běh desítky s) a persist (první push
    # v +60s) – ať v kritické první minutě po bootu neběží víc síťově těžkých
    # operací najednou (appka na Render free tieru na to opakovaně padala).
    time.sleep(45)
    _boot_diag["settle_loop_reached_at"] = int(_time.time())
    _loop_n = 0

    while True:
        _loop_n += 1
        _boot_diag["settle_loop_iteration"] = _loop_n
        _boot_diag["settle_loop_iter_at"] = int(_time.time())
        try:
            with _settle_lock:
                # Počet VYHODNOTITELNÝCH položek (zápas do dneška) na začátku běhu
                today = ds.today_str()
                open_bets = [b for b in bankroll.state()["bets"]
                            if b["status"] == "open" and b.get("match_id")
                            and (b.get("match_date") or "") <= today]
                open_tips = tips_db.open_tips_until(today)
                total = len(open_bets) + len(open_tips)
                _boot_diag["settle_loop_last_total"] = total
                _boot_diag["settle_loop_last_open_bets"] = len(open_bets)
                _boot_diag["settle_loop_last_open_tips"] = len(open_tips)

                if total == 0:
                    # Nic k vyřešení – dále v cyklu
                    _settle_status["in_progress"] = False
                    _settle_status["settled_so_far"] = 0
                else:
                    _settle_status["in_progress"] = True
                    _settle_status["current_batch"] = []
                    _settle_status["total_pending"] = total
                    _settle_status["settled_so_far"] = 0  # reset na začátku běhu
                    _settle_status["pass_started_at"] = int(_time.time())

            if total == 0:
                # Nic k vyřešení – delší čekání (snížení CPU)
                time.sleep(30)
                continue

            # Natáhni a vyřeš jednu dávku – bez drahého fallbacku (viz docstring
            # _settle_recent); ten dostanou jen ruční/API požadavky.
            _pass_t0 = _time.time()
            results, corner_results, more_pending = _settle_recent(allow_slugless_fallback=False)
            with _settle_lock:
                _settle_status["last_pass_duration_s"] = round(_time.time() - _pass_t0, 1)
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
                _settle_status["last_error"] = None   # úspěšný průchod smaže starou chybu
                if not more_pending:
                    _settle_status["in_progress"] = False

            if n_tips + n_bets == 0:
                time.sleep(300)
            elif more_pending:
                time.sleep(3)
            else:
                time.sleep(60)

        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"[settle_bg] Chyba: {e}")
            print(tb)
            with _settle_lock:
                _settle_status["in_progress"] = False
                _settle_status["last_error"] = f"{type(e).__name__}: {e}\n{tb[-800:]}"
                _settle_status["error_count"] = _settle_status.get("error_count", 0) + 1
            time.sleep(10)  # více čekat při chybě


# ============================================================================
# AUTO-RUN AGENT (pozadí)
# ============================================================================

_auto_agent_last_run_date = {}  # {hour: "YYYY-MM-DD"} – aby se agent nespouštěl 2× za hodinu


def _run_auto_agent_if_due():
    """Zkontroluje, zda je čas na automatický běh agenta (dle Nastavení) a
    pokud ano, spustí ho. Voláno SYNCHRONNĚ ze skutečného HTTP requestu
    (/api/cron/settle) – ne z background threadu, viz _auto_agent_loop níže.
    Na Render free tieru se totiž background thready mezi requesty prakticky
    nikdy neprobudí (ověřeno canary threadem), takže spoléhat jen na
    _auto_agent_loop by znamenalo, že agent nikdy automaticky nezasází.
    Vrací info dict, hlavně pro diagnostiku přes /api/cron/settle odpověď."""
    import datetime as _dt
    try:
        cfg = app_settings.get_settings()["agent"]
        if not (cfg.get("enabled") and cfg.get("auto_run")):
            return {"ran": False, "reason": "disabled"}

        now = _dt.datetime.now()
        today_str = now.strftime("%Y-%m-%d")
        hours_raw = str(cfg.get("auto_run_hours", "8,12,16,20"))
        try:
            run_hours = [int(h.strip()) for h in hours_raw.split(",") if h.strip()]
        except ValueError:
            run_hours = [8, 12, 16, 20]

        if now.hour not in run_hours:
            return {"ran": False, "reason": "not_due"}
        if _auto_agent_last_run_date.get(now.hour) == today_str:
            return {"ran": False, "reason": "already_ran"}

        print(f"[auto-agent] Automatický běh agenta v {now.hour}:00")
        _auto_agent_last_run_date[now.hour] = today_str
        try:
            start_date = ds.today_str() if cfg.get("bet_today") else ds.add_days(ds.today_str(), 1)
            days = 4 if cfg.get("bet_today") else 3
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
            return {"ran": True, "placed": result.get("placed", 0)}
        except Exception as e:
            print(f"[auto-agent] Chyba při běhu agenta: {e}")
            return {"ran": False, "reason": "error", "error": str(e)}
    except Exception as e:
        print(f"[auto-agent] Chyba: {e}")
        return {"ran": False, "reason": "error", "error": str(e)}


def _auto_agent_loop():
    """Ponecháno pro LOKÁLNÍ běh (python app.py) – na Renderu se na tento
    background thread nelze spolehnout (viz _run_auto_agent_if_due výše),
    produkce používá /api/cron/settle, který _run_auto_agent_if_due volá
    synchronně při každém externím cron ticku."""
    import time
    _boot_diag["agent_thread_entered_at"] = int(_time.time())
    time.sleep(90)   # rozestup od ostatních background threadů, viz _settle_in_background
    while True:
        _run_auto_agent_if_due()
        time.sleep(60)


def _run_virtual_bettors_if_due():
    """10 virtuálních sázkařů (engine/virtual_bettors.py) sází podle STEJNÉHO
    hodinového rozvrhu jako auto-run agenta (Nastavení → Auto-run podle
    rozvrhu), takže víckrát denně, ne jen jednou – synchronně z reálného
    HTTP requestu (/api/cron/settle), ne z nespolehlivého background threadu."""
    import datetime as _dt
    today = ds.today_str()
    now = _dt.datetime.now()
    try:
        cfg = app_settings.get_settings()["agent"]
        hours_raw = str(cfg.get("auto_run_hours", "8,12,16,20"))
        try:
            allowed_hours = [int(h.strip()) for h in hours_raw.split(",") if h.strip()]
        except ValueError:
            allowed_hours = [8, 12, 16, 20]

        st = virtual_bettors.load_state()
        if now.hour not in allowed_hours:
            return {"ran": False, "reason": "not_due"}
        if all(now.hour in b.get("ran_hours", []) and b.get("last_run_date") == today for b in st.values()):
            return {"ran": False, "reason": "already_ran"}

        predictions = _predictions_for(today, days=4, sport="soccer")
        placed = virtual_bettors.run_all(predictions, today, current_hour=now.hour, allowed_hours=allowed_hours)
        return {"ran": True, "placed": placed}
    except Exception as e:
        return {"ran": False, "reason": "error", "error": str(e)}


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


@app.route("/api/backtest/worst-leagues", methods=["GET"])
@login_required
def api_worst_leagues():
    """Get worst performing leagues (get_worst_leagues existoval v backtester.py,
    ale nikdy nebyl vystavený přes žádný endpoint – tabulka 'Worst Performing
    Leagues' ve frontendu tak byla natrvalo prázdná)."""
    try:
        bt = backtester.Backtester()
        bets = bankroll.state()["bets"]
        top_n = int(request.args.get("top", 5))
        results = bt.get_worst_leagues(bets, top_n)
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
    _boot_diag["start_bg_threads_called_at"] = int(_time.time())
    if _BG_STARTED:
        return
    _BG_STARTED = True
    try:
        n_cleaned = storage.cleanup_old_caches(max_age_days=14)
        if n_cleaned:
            print(f"[cleanup] Smazáno {n_cleaned} starých cache souborů")
        persist.start()   # obnova dat z gistu (Render) + zálohovací smyčka
        threading.Thread(target=_canary_loop, daemon=True).start()
        threading.Thread(target=_prewarm, daemon=True).start()
        threading.Thread(target=_settle_in_background, daemon=True).start()
        threading.Thread(target=_auto_agent_loop, daemon=True).start()
        _boot_diag["start_bg_threads_completed_ok"] = True
    except Exception as e:
        # Nikdy nesmí shodit import modulu – ale ať je vidět CO selhalo
        import traceback
        _boot_diag["start_bg_threads_error"] = f"{type(e).__name__}: {e}\n{traceback.format_exc()[-800:]}"
        print(f"[boot] _start_background_threads selhalo: {e}")
        traceback.print_exc()


# Pod gunicornem (Render) se modul jen importuje, __main__ blok se nespustí –
# proto se background thready startují VŽDY při importu modulu, ne podmíněně.
# (Dřívější podmínka `RENDER env / "gunicorn" in SERVER_SOFTWARE` byla křehká:
# SERVER_SOFTWARE je WSGI environ klíč dostupný per-request, ne v os.environ
# při importu – ta část podmínky nikdy nebyla pravda; spoléhalo se čistě na
# RENDER env proměnnou, a pokud by chyběla, thready by se NIKDY nespustily.
# _BG_STARTED guard zajistí, že se nespustí dvakrát, když __main__ blok
# zavolá totéž znovu při lokálním běhu.)
_boot_diag["module_import_at"] = int(_time.time())
_start_background_threads()


if __name__ == "__main__":
    _start_background_threads()
    print(f"⚽ KurzAnalytik běží na  http://{_HOST}:{_PORT}")
    if _HOST == "127.0.0.1":   # prohlížeč otvíráme jen při lokálním běhu
        threading.Timer(1.2, _open_browser).start()
    app.run(host=_HOST, port=_PORT, debug=False, threaded=True)
