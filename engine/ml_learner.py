# -*- coding: utf-8 -*-
"""
ML Learning System – Agent se učí z vlastních tipů a chyb
Feedback loop: sázka → výsledek → model retraining → lepší tipy
"""

import json
import os
import pickle
import numpy as np
from datetime import datetime, timedelta
from collections import defaultdict

try:
    from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.metrics import accuracy_score, roc_auc_score, precision_score, recall_score
    import xgboost as xgb
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False

from . import storage

MODEL_DIR = "data/ml_models"
FEEDBACK_FILE = "data/agent_feedback.jsonl"
METRICS_FILE = "data/learning_metrics.json"

# Jednotný seznam featur — MUSÍ sedět mezi prepare_features a predict_with_confidence
#
# Přepsáno pro nový predikční engine (engine/goals_model.py). Starý seznam
# featur (elo_*_norm, xg_*_norm, possession_norm, form_*_norm) počítal se
# staženým Elo ratingem (0-3000) a částečně FINGOVANÝMI daty – possession
# ESPN scoreboard nikdy neposkytoval (vždy konstanta 50), recent_form se
# generovala náhodně (seeded random), ne ze skutečných výsledků. Model by
# se tak reálně učil hlavně z konstant a šumu.
#
# Nové featury sedí na to, co goals_model doopravdy počítá: attack/defense
# multiplikátory (ne Elo), očekávané góly, edge (model_prob - implied,
# přímo měří "kolik value" sázka má – tohle ve starém seznamu chybělo
# úplně) a rating_confidence – kolik zápasů rating obou týmů reálně vidělo
# (nový tým se známým ratingem 1.0 je mnohem nejistější než tým po 30
# zápasech, to se předtím nikde nezohledňovalo).
FEATURE_NAMES = [
    "odds", "log_odds", "model_prob", "edge", "is_home",
    "attack_home", "defense_home", "attack_away", "defense_away",
    "exp_goals_home", "exp_goals_away", "rating_confidence",
]


def _is_home_enc(prediction):
    return 1.0 if prediction == "home" else 0.0 if prediction == "away" else 0.5


def ensure_dirs():
    """Create ML directories if they don't exist."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs("data", exist_ok=True)


class MLLearner:
    """Machine Learning model that learns from agent decisions and outcomes."""

    def __init__(self):
        ensure_dirs()
        self.model = None
        self.scaler = None
        self.feature_names = list(FEATURE_NAMES)
        self.metrics = self.load_metrics()
        self.feedback_log = []
        self.load_model()

    def record_feedback(self, bet_id, match_id, prediction, odds, stake,
                       outcome, home_team, away_team, league, match_date,
                       features=None):
        """Record a bet outcome for learning."""
        record = {
            "ts": datetime.now().isoformat(),
            "bet_id": bet_id,
            "match_id": match_id,
            "prediction": prediction,
            "odds": odds,
            "stake": stake,
            "outcome": outcome,  # "won" / "lost" / "void"
            "home_team": home_team,
            "away_team": away_team,
            "league": league,
            "match_date": match_date,
            "features": features or {},
            # čistý zisk: výhra = stake*(kurz-1); open/void = 0 (žádný výsledek)
            "pnl": round(stake * (odds - 1), 2) if outcome == "won"
                   else (-stake if outcome == "lost" else 0.0)
        }

        # Append to JSONL feedback file
        try:
            with open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except Exception:
            pass

        self.feedback_log.append(record)
        return record

    # Alias for compatibility with bankroll.py
    def record_bet_outcome(self, *args, **kwargs):
        """Alias for record_feedback() - called from bankroll.py"""
        return self.record_feedback(*args, **kwargs)

    def load_feedback_log(self, days=30):
        """Load recent feedback for training.

        Každá sázka může mít v JSONL víc záznamů (open při vsazení, won/lost
        při vyhodnocení) – dedupujeme podle bet_id a bereme POSLEDNÍ záznam,
        jinak by se sázky počítaly dvakrát a 'open' by model bral jako prohry.
        """
        if not os.path.exists(FEEDBACK_FILE):
            return []

        cutoff = datetime.now() - timedelta(days=days)
        by_bet = {}

        try:
            with open(FEEDBACK_FILE, "r", encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    if datetime.fromisoformat(record["ts"]) > cutoff:
                        by_bet[record.get("bet_id") or id(record)] = record
        except Exception:
            pass

        return list(by_bet.values())

    def prepare_features(self, feedback_records):
        """Extract features from feedback records for training."""
        X = []
        y = []

        for record in feedback_records:
            # Trénujeme JEN na rozhodnutých sázkách – open/void nemají label
            if record["outcome"] not in ("won", "lost"):
                continue

            features = record.get("features", {})
            odds = record.get("odds", 1.5)
            prob = float(features.get("prob", 1.0 / odds if odds > 1 else 0.5))
            implied = 1.0 / odds if odds > 1 else 0.5

            feature_vector = [
                odds,
                np.log(odds),
                prob,
                features.get("edge", prob - implied),
                _is_home_enc(record.get("prediction")),
                features.get("attack_home", 1.0),
                features.get("defense_home", 1.0),
                features.get("attack_away", 1.0),
                features.get("defense_away", 1.0),
                (features.get("exp_goals_home") or 1.3) / 2.0,
                (features.get("exp_goals_away") or 1.1) / 2.0,
                features.get("rating_confidence", 0.0),
            ]

            X.append(feature_vector)
            y.append(1 if record["outcome"] == "won" else 0)

        self.feature_names = list(FEATURE_NAMES)

        return np.array(X) if X else None, np.array(y) if y else None

    def train(self, days=30):
        """Train model on recent feedback."""
        if not ML_AVAILABLE:
            self.metrics["status"] = "ML libraries not available"
            return False

        feedback = self.load_feedback_log(days=days)
        # 10 záznamů dřív dovolilo 80/20 split s testovacím vzorkem o
        # velikosti 1-2 – roc_auc_score na tak malém (často jednotřídním)
        # vzorku občas tiše vrátí NaN místo vyhození výjimky (na rozdíl od
        # očekávání), což pak rozbilo i JSON odpověď API. 30 záznamů dá
        # test set alespoň ~6 vzorků.
        if len(feedback) < 30:
            self.metrics["status"] = f"Not enough data ({len(feedback)} records)"
            return False

        X, y = self.prepare_features(feedback)
        if X is None or len(X) < 15:
            return False

        # Split: 80/20
        split_idx = int(0.8 * len(X))
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y[:split_idx], y[split_idx:]

        # Scale features
        if self.scaler is None:
            self.scaler = StandardScaler()

        X_train_scaled = self.scaler.fit_transform(X_train)
        X_test_scaled = self.scaler.transform(X_test)

        # Train XGBoost
        try:
            self.model = xgb.XGBClassifier(
                n_estimators=100,
                max_depth=6,
                learning_rate=0.1,
                subsample=0.8,
                colsample_bytree=0.8,
                random_state=42,
                use_label_encoder=False,
                eval_metric='logloss'
            )
        except Exception:
            # Fallback to Gradient Boosting
            self.model = GradientBoostingClassifier(
                n_estimators=100,
                max_depth=5,
                learning_rate=0.1,
                random_state=42
            )

        self.model.fit(X_train_scaled, y_train)

        # Evaluate
        y_pred = self.model.predict(X_test_scaled)
        y_proba = self.model.predict_proba(X_test_scaled)[:, 1]

        accuracy = accuracy_score(y_test, y_pred)
        try:
            auc = roc_auc_score(y_test, y_proba)
        except ValueError:
            auc = 0.5   # test set má jen 1 třídu – AUC nedefinované, spadlo by
        if auc != auc:   # NaN check (roc_auc_score na hraničních vstupech NaN
            auc = 0.5     # tiše VRACÍ, nevyhazuje – ValueError výše to nechytí)
        precision = precision_score(y_test, y_pred, zero_division=0)
        recall = recall_score(y_test, y_pred, zero_division=0)

        self.metrics.update({
            "status": "trained",
            "last_trained": datetime.now().isoformat(),
            "total_feedback": len(feedback),
            "training_samples": len(X_train),
            "test_samples": len(X_test),
            "accuracy": float(accuracy),
            "auc": float(auc),
            "precision": float(precision),
            "recall": float(recall),
            "win_rate": float(np.mean(y_train)),
            "model_version": 2
        })

        self.save_model()
        self.save_metrics()

        return True

    def predict_with_confidence(self, features_dict):
        """Predict outcome probability with confidence."""
        if self.model is None:
            return {"win_prob": 0.5, "confidence": 0.0, "model_status": "not_trained"}

        try:
            odds = features_dict.get("odds", 1.5)
            prob = float(features_dict.get("prob", 1.0 / odds if odds > 1 else 0.5))
            implied = 1.0 / odds if odds > 1 else 0.5
            # STEJNÉ kódování jako prepare_features – jinak model dostává
            # při predikci jiné vstupy, než na jakých se učil
            feature_vector = np.array([[
                odds,
                np.log(odds),
                prob,
                features_dict.get("edge", prob - implied),
                _is_home_enc(features_dict.get("prediction")),
                features_dict.get("attack_home", 1.0),
                features_dict.get("defense_home", 1.0),
                features_dict.get("attack_away", 1.0),
                features_dict.get("defense_away", 1.0),
                (features_dict.get("exp_goals_home") or 1.3) / 2.0,
                (features_dict.get("exp_goals_away") or 1.1) / 2.0,
                features_dict.get("rating_confidence", 0.0),
            ]])

            X_scaled = self.scaler.transform(feature_vector)
            proba = self.model.predict_proba(X_scaled)[0]

            return {
                "win_prob": float(proba[1]),
                "confidence": float(max(proba)),
                "model_status": "ready"
            }
        except Exception:
            return {"win_prob": 0.5, "confidence": 0.0, "model_status": "error"}

    def predict_batch(self, features_dicts):
        """Stejné jako predict_with_confidence, ale pro VÍC kandidátů
        najednou jedním maticovým voláním modelu místo smyčky s jedním
        řádkem na volání.

        Virtuální sázkaři (AI Adam/Karel/Klára) skórují celý fond
        kandidátů - klidně tisíce najednou. Volat predict_with_confidence()
        v Python smyčce pro každého zvlášť znamenalo tisíce jednotlivých
        scaler.transform()/predict_proba() volání na jeden kolo sázení,
        což na omezeném CPU (Render free tier) dokázalo zaměstnat jediný
        gunicorn worker natolik dlouho, že appka přestala odpovídat na
        cokoliv jiného. Jedna dávková matice je řádově rychlejší."""
        if self.model is None or not features_dicts:
            return [{"win_prob": 0.5, "confidence": 0.0, "model_status": "not_trained"} for _ in features_dicts]
        try:
            rows = []
            for fd in features_dicts:
                odds = fd.get("odds", 1.5)
                prob = float(fd.get("prob", 1.0 / odds if odds > 1 else 0.5))
                implied = 1.0 / odds if odds > 1 else 0.5
                rows.append([
                    odds, np.log(odds), prob,
                    fd.get("edge", prob - implied),
                    _is_home_enc(fd.get("prediction")),
                    fd.get("attack_home", 1.0), fd.get("defense_home", 1.0),
                    fd.get("attack_away", 1.0), fd.get("defense_away", 1.0),
                    (fd.get("exp_goals_home") or 1.3) / 2.0,
                    (fd.get("exp_goals_away") or 1.1) / 2.0,
                    fd.get("rating_confidence", 0.0),
                ])
            X_scaled = self.scaler.transform(np.array(rows))
            proba = self.model.predict_proba(X_scaled)
            return [{"win_prob": float(p[1]), "confidence": float(max(p)), "model_status": "ready"}
                    for p in proba]
        except Exception:
            return [{"win_prob": 0.5, "confidence": 0.0, "model_status": "error"} for _ in features_dicts]

    def get_feature_importance(self):
        """Get feature importance for explainability."""
        if self.model is None or self.feature_names is None:
            return {}

        try:
            importances = self.model.feature_importances_
            return dict(zip(self.feature_names, [float(i) for i in importances]))
        except Exception:
            return {}

    def save_model(self):
        """Persist model to disk."""
        if self.model is None:
            return

        try:
            with open(os.path.join(MODEL_DIR, "model.pkl"), "wb") as f:
                pickle.dump(self.model, f)
            with open(os.path.join(MODEL_DIR, "scaler.pkl"), "wb") as f:
                pickle.dump(self.scaler, f)
        except Exception:
            pass

    def load_model(self):
        """Load model from disk."""
        try:
            model_path = os.path.join(MODEL_DIR, "model.pkl")
            scaler_path = os.path.join(MODEL_DIR, "scaler.pkl")

            if os.path.exists(model_path):
                with open(model_path, "rb") as f:
                    self.model = pickle.load(f)

            if os.path.exists(scaler_path):
                with open(scaler_path, "rb") as f:
                    self.scaler = pickle.load(f)
        except Exception:
            pass

    def save_metrics(self):
        """Save learning metrics."""
        try:
            with open(METRICS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.metrics, f, indent=2, ensure_ascii=False)
        except Exception:
            pass

    def load_metrics(self):
        """Load learning metrics."""
        if not os.path.exists(METRICS_FILE):
            return {"status": "not_trained", "accuracy": 0.0}

        try:
            with open(METRICS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            return {"status": "not_trained"}
        # Obrana i proti starým souborům z doby, kdy train() mohlo uložit
        # NaN (viz oprava výše) – NaN v odpovědi rozbíjí JSON.parse na
        # frontendu úplně (na rozdíl od Pythonu to JS bere jako chybu).
        for k, v in list(data.items()):
            if isinstance(v, float) and v != v:
                data[k] = 0.0
        return data

    def get_learning_stats(self):
        """Get comprehensive learning statistics."""
        # jen rozhodnuté sázky – open/void do win-rate nepatří
        feedback = [r for r in self.load_feedback_log(days=90)
                    if r.get("outcome") in ("won", "lost")]

        won = sum(1 for r in feedback if r["outcome"] == "won")
        lost = sum(1 for r in feedback if r["outcome"] == "lost")
        total = won + lost

        if total == 0:
            return {
                "total_bets": 0,
                "win_rate": 0,
                "model_status": "no_data",
                "learning_curve": []
            }

        # Learning curve: win rate over time (7-day windows)
        learning_curve = []
        for days_back in range(90, 0, -7):
            start = datetime.now() - timedelta(days=days_back)
            end = datetime.now() - timedelta(days=days_back-7)
            period_bets = [r for r in feedback
                          if start <= datetime.fromisoformat(r["ts"]) <= end]
            if period_bets:
                period_won = sum(1 for r in period_bets if r["outcome"] == "won")
                learning_curve.append({
                    "date": end.isoformat(),
                    "win_rate": period_won / len(period_bets)
                })

        return {
            "total_bets": total,
            "wins": won,
            "losses": lost,
            "win_rate": won / total,
            "model_status": self.metrics.get("status", "unknown"),
            "model_accuracy": self.metrics.get("accuracy", 0),
            "model_auc": self.metrics.get("auc", 0),
            "feature_importance": self.get_feature_importance(),
            "learning_curve": learning_curve,
            "last_trained": self.metrics.get("last_trained")
        }


# Global instance
_learner = None

def get_learner():
    global _learner
    if _learner is None:
        _learner = MLLearner()
    return _learner

def record_bet_outcome(bet_id, match_id, prediction, odds, stake,
                      outcome, home_team, away_team, league, match_date, features=None):
    """Public API to record a bet outcome."""
    learner = get_learner()
    return learner.record_feedback(bet_id, match_id, prediction, odds, stake,
                                  outcome, home_team, away_team, league, match_date, features)

def train_model(days=30):
    """Public API to train the model."""
    learner = get_learner()
    return learner.train(days=days)

def get_learning_stats():
    """Public API to get learning statistics."""
    learner = get_learner()
    return learner.get_learning_stats()

def predict_with_model(features_dict):
    """Public API to get model prediction."""
    learner = get_learner()
    return learner.predict_with_confidence(features_dict)

def predict_batch(features_dicts):
    """Public API - dávková predikce pro víc kandidátů jedním voláním."""
    learner = get_learner()
    return learner.predict_batch(features_dicts)
