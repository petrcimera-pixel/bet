# -*- coding: utf-8 -*-
"""
Model Ensembling – Kombinace více modelů pro robustnější predikce
Ensemble = Voting + Stacking pro lepší accuracy
"""

import numpy as np
try:
    from sklearn.ensemble import RandomForestClassifier, AdaBoostClassifier
    import xgboost as xgb
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False


class ModelEnsemble:
    """Combine multiple models for robust predictions."""

    def __init__(self):
        self.models = {}
        self.weights = {
            "xgboost": 0.5,
            "random_forest": 0.3,
            "adaboost": 0.2,
        }
        self.predictions = {}

    def train_ensemble(self, X, y, test_size=0.2):
        """Train multiple models on the same data."""
        if not ML_AVAILABLE or X is None or len(X) < 10:
            return False

        # Split data
        split_idx = int(len(X) * (1 - test_size))
        X_train, X_test = X[:split_idx], X[split_idx:]
        y_train, y_test = y[:split_idx], y[split_idx:]

        results = {}

        # XGBoost
        try:
            model_xgb = xgb.XGBClassifier(
                n_estimators=100,
                max_depth=6,
                learning_rate=0.1,
                subsample=0.8,
                colsample_bytree=0.8,
                random_state=42,
                verbosity=0
            )
            model_xgb.fit(X_train, y_train)
            score_xgb = model_xgb.score(X_test, y_test)
            self.models["xgboost"] = model_xgb
            results["xgboost"] = {"accuracy": score_xgb}
        except Exception as e:
            print(f"XGBoost training failed: {e}")

        # Random Forest
        try:
            model_rf = RandomForestClassifier(
                n_estimators=100,
                max_depth=10,
                min_samples_split=5,
                random_state=42,
                n_jobs=-1
            )
            model_rf.fit(X_train, y_train)
            score_rf = model_rf.score(X_test, y_test)
            self.models["random_forest"] = model_rf
            results["random_forest"] = {"accuracy": score_rf}
        except Exception as e:
            print(f"Random Forest training failed: {e}")

        # AdaBoost
        try:
            model_ada = AdaBoostClassifier(
                n_estimators=100,
                learning_rate=0.1,
                random_state=42
            )
            model_ada.fit(X_train, y_train)
            score_ada = model_ada.score(X_test, y_test)
            self.models["adaboost"] = model_ada
            results["adaboost"] = {"accuracy": score_ada}
        except Exception as e:
            print(f"AdaBoost training failed: {e}")

        # Normalize weights based on accuracy
        if results:
            total_acc = sum(r.get("accuracy", 0) for r in results.values())
            if total_acc > 0:
                for model_name, res in results.items():
                    self.weights[model_name] = res.get("accuracy", 0) / total_acc

        return len(self.models) > 0

    def predict_ensemble(self, features):
        """Get ensemble prediction by weighted voting."""
        if not self.models or not features:
            return {"prediction": 0.5, "confidence": 0.0, "models": {}}

        features_arr = np.array(features).reshape(1, -1)
        predictions = {}
        total_weight = 0

        for model_name, model in self.models.items():
            try:
                if hasattr(model, 'predict_proba'):
                    pred = model.predict_proba(features_arr)[0][1]
                else:
                    pred = float(model.predict(features_arr)[0])

                weight = self.weights.get(model_name, 0.3)
                predictions[model_name] = {"prediction": pred, "weight": weight}
                total_weight += weight
            except Exception as e:
                print(f"Prediction error in {model_name}: {e}")

        # Weighted average
        if not predictions:
            return {"prediction": 0.5, "confidence": 0.0, "models": {}}

        ensemble_pred = sum(p["prediction"] * p["weight"] for p in predictions.values()) / total_weight

        # Confidence = agreement between models
        if len(predictions) > 1:
            std_dev = np.std([p["prediction"] for p in predictions.values()])
            confidence = 1.0 - min(std_dev, 1.0)
        else:
            confidence = abs(ensemble_pred - 0.5) * 2

        return {
            "prediction": ensemble_pred,
            "confidence": confidence,
            "models": predictions,
            "weights": self.weights,
        }

    def get_model_agreement(self, features):
        """Shoda modelů na predikci pro dané featury (0 = plná shoda)."""
        if len(self.models) < 2 or not features:
            return 0.0

        preds = []
        for model in self.models.values():
            try:
                arr = np.array(features).reshape(1, -1)
                preds.append(model.predict_proba(arr)[0][1] if hasattr(model, 'predict_proba')
                             else float(model.predict(arr)[0]))
            except Exception:
                pass

        if len(preds) < 2:
            return 0.0
        return sum(abs(p1 - p2) for p1 in preds for p2 in preds) / (len(preds) ** 2)

    def save_ensemble(self, path="data/ml_models/ensemble"):
        """Save all models to disk."""
        try:
            import pickle
            import os
            os.makedirs(path, exist_ok=True)

            for model_name, model in self.models.items():
                model_path = f"{path}/{model_name}.pkl"
                with open(model_path, 'wb') as f:
                    pickle.dump(model, f)

            # Save weights
            weights_path = f"{path}/weights.pkl"
            with open(weights_path, 'wb') as f:
                pickle.dump(self.weights, f)

            return True
        except Exception as e:
            print(f"Save error: {e}")
            return False

    def load_ensemble(self, path="data/ml_models/ensemble"):
        """Load ensemble from disk."""
        try:
            import pickle
            import os

            if not os.path.exists(path):
                return False

            self.models = {}
            for filename in os.listdir(path):
                if filename.endswith(".pkl") and filename != "weights.pkl":
                    model_name = filename.replace(".pkl", "")
                    model_path = os.path.join(path, filename)
                    with open(model_path, 'rb') as f:
                        self.models[model_name] = pickle.load(f)

            # Load weights
            weights_path = os.path.join(path, "weights.pkl")
            if os.path.exists(weights_path):
                with open(weights_path, 'rb') as f:
                    self.weights = pickle.load(f)

            return len(self.models) > 0
        except Exception as e:
            print(f"Load error: {e}")
            return False

    def get_ensemble_stats(self):
        """Get statistics about the ensemble."""
        return {
            "model_count": len(self.models),
            "models": list(self.models.keys()),
            "weights": self.weights,
            "is_trained": len(self.models) > 0,
        }
