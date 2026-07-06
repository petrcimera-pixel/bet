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
        self.feature_names = None
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
            "pnl": stake * odds if outcome == "won" else -stake
        }

        # Append to JSONL feedback file
        try:
            with open(FEEDBACK_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")
        except:
            pass

        self.feedback_log.append(record)
        return record

    def load_feedback_log(self, days=30):
        """Load recent feedback for training."""
        if not os.path.exists(FEEDBACK_FILE):
            return []

        cutoff = datetime.now() - timedelta(days=days)
        feedback = []

        try:
            with open(FEEDBACK_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    record = json.loads(line)
                    if datetime.fromisoformat(record["ts"]) > cutoff:
                        feedback.append(record)
        except:
            pass

        return feedback

    def prepare_features(self, feedback_records):
        """Extract features from feedback records for training."""
        X = []
        y = []

        for record in feedback_records:
            if record["outcome"] == "void":
                continue

            features = record.get("features", {})
            odds = record.get("odds", 1.5)

            # Feature engineering
            feature_vector = [
                odds,
                np.log(odds),
                record["stake"] / 100.0,
                1.0 if record["prediction"] == "home" else 0.0 if record["prediction"] == "away" else 0.5,
                1.0 if record["league"] == "Premier League" else 0.5,  # league weight
                features.get("home_rating", 1500) / 1500.0,  # normalized Elo
                features.get("away_rating", 1500) / 1500.0,
                features.get("expected_goals_home", 1.5) / 2.0,
                features.get("expected_goals_away", 1.2) / 2.0,
                features.get("possession_home", 50) / 100.0,
                features.get("recent_form_home", 0) / 5.0,
                features.get("recent_form_away", 0) / 5.0,
            ]

            X.append(feature_vector)
            y.append(1 if record["outcome"] == "won" else 0)

        self.feature_names = [
            "odds", "log_odds", "stake_norm", "is_home",
            "league_weight", "elo_home_norm", "elo_away_norm",
            "xg_home_norm", "xg_away_norm", "possession_norm",
            "form_home_norm", "form_away_norm"
        ]

        return np.array(X) if X else None, np.array(y) if y else None

    def train(self, days=30):
        """Train model on recent feedback."""
        if not ML_AVAILABLE:
            self.metrics["status"] = "ML libraries not available"
            return False

        feedback = self.load_feedback_log(days=days)
        if len(feedback) < 10:
            self.metrics["status"] = f"Not enough data ({len(feedback)} records)"
            return False

        X, y = self.prepare_features(feedback)
        if X is None or len(X) < 5:
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
        except:
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
        auc = roc_auc_score(y_test, y_proba)
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
            feature_vector = np.array([[
                odds,
                np.log(odds),
                features_dict.get("stake", 100) / 100.0,
                1.0 if features_dict.get("prediction") == "home" else 0.0,
                0.5,  # league default
                features_dict.get("home_rating", 1500) / 1500.0,
                features_dict.get("away_rating", 1500) / 1500.0,
                features_dict.get("xg_home", 1.5) / 2.0,
                features_dict.get("xg_away", 1.2) / 2.0,
                features_dict.get("possession", 50) / 100.0,
                features_dict.get("form_home", 0) / 5.0,
                features_dict.get("form_away", 0) / 5.0,
            ]])

            X_scaled = self.scaler.transform(feature_vector)
            proba = self.model.predict_proba(X_scaled)[0]

            return {
                "win_prob": float(proba[1]),
                "confidence": float(max(proba)),
                "model_status": "ready"
            }
        except:
            return {"win_prob": 0.5, "confidence": 0.0, "model_status": "error"}

    def get_feature_importance(self):
        """Get feature importance for explainability."""
        if self.model is None or self.feature_names is None:
            return {}

        try:
            importances = self.model.feature_importances_
            return dict(zip(self.feature_names, [float(i) for i in importances]))
        except:
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
        except:
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
        except:
            pass

    def save_metrics(self):
        """Save learning metrics."""
        try:
            with open(METRICS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.metrics, f, indent=2, ensure_ascii=False)
        except:
            pass

    def load_metrics(self):
        """Load learning metrics."""
        if not os.path.exists(METRICS_FILE):
            return {"status": "not_trained", "accuracy": 0.0}

        try:
            with open(METRICS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return {"status": "not_trained"}

    def get_learning_stats(self):
        """Get comprehensive learning statistics."""
        feedback = self.load_feedback_log(days=90)

        # Calculate metrics
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
