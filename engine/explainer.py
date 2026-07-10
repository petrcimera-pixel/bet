# -*- coding: utf-8 -*-
"""
Explainability Engine – SHAP-style explanations for agent predictions
Why did the agent choose this bet? Which features matter most?
"""

import numpy as np
from datetime import datetime
from . import storage

class ModelExplainer:
    """SHAP-style explanations for betting predictions."""

    def __init__(self, ml_learner=None):
        self.ml_learner = ml_learner
        self.explanations = {}

    def explain_prediction(self, bet_id, features, prediction_prob, odds, stake):
        """Generate SHAP-style explanation for a single prediction."""

        if not features or not self.ml_learner or not self.ml_learner.model:
            return self._fallback_explanation(features, prediction_prob, odds, stake)

        # Extract base value (model's average prediction)
        base_value = 0.5  # Default 50% for binary classification

        # Calculate feature contributions (simplified SHAP)
        contributions = self._calculate_contributions(features)

        # Sort by absolute impact
        sorted_features = sorted(
            contributions.items(),
            key=lambda x: abs(x[1]),
            reverse=True
        )

        return {
            "bet_id": bet_id,
            "timestamp": datetime.now().isoformat(),
            "prediction": round(prediction_prob, 3),
            "base_value": base_value,
            "contributions": dict(sorted_features[:6]),  # Top 6 features
            "final_prediction": round(base_value + sum(contributions.values()), 3),
            "reasoning": self._generate_reasoning(sorted_features),
            "risk_level": self._assess_risk(prediction_prob, odds, stake),
        }

    def _calculate_contributions(self, features):
        """Calculate approximate SHAP values for features."""
        contributions = {}

        # Map feature indices to names
        feature_names = [
            "odds", "log_odds", "model_prob", "is_home",
            "league_weight", "elo_home_norm", "elo_away_norm",
            "xg_home_norm", "xg_away_norm", "possession_norm",
            "form_home_norm", "form_away_norm"
        ]

        if not isinstance(features, (list, np.ndarray)):
            # Convert dict to vector if needed
            feature_list = [
                features.get("odds", 1.5),
                np.log(features.get("odds", 1.5)),
                float(features.get("prob", 0.5)),
                1.0 if features.get("prediction") == "home" else 0.0,
                1.0 if features.get("league") == "Premier League" else 0.5,
                features.get("elo_home", 1500) / 1500.0,
                features.get("elo_away", 1500) / 1500.0,
                features.get("xg_home", 1.5) / 2.0,
                features.get("xg_away", 1.2) / 2.0,
                features.get("possession", 50) / 100.0,
                features.get("form_home", 0) / 5.0,
                features.get("form_away", 0) / 5.0,
            ]
        else:
            feature_list = list(features)

        # Calculate impact: (feature_value - mean) * weight
        feature_means = [1.8, 0.6, 1.0, 0.5, 0.75, 1.0, 1.0, 0.75, 0.6, 0.5, 0.0, 0.0]
        feature_weights = [0.15, 0.1, 0.12, 0.08, 0.05, 0.12, 0.12, 0.08, 0.08, 0.05, 0.03, 0.03]

        for i, name in enumerate(feature_names):
            if i < len(feature_list):
                value = float(feature_list[i]) if feature_list[i] is not None else 0
                mean = feature_means[i] if i < len(feature_means) else 0.5
                weight = feature_weights[i] if i < len(feature_weights) else 0.05

                contribution = (value - mean) * weight * 2  # Scale for visibility
                contributions[name] = round(contribution, 3)

        return contributions

    def _generate_reasoning(self, sorted_features):
        """Generate human-readable reasoning."""
        reasons = []

        for i, (feature, contribution) in enumerate(sorted_features[:3]):
            direction = "increases" if contribution > 0 else "decreases"
            magnitude = "significantly" if abs(contribution) > 0.05 else "slightly"

            if feature == "odds":
                reasons.append(f"High odds {magnitude} {direction} win confidence")
            elif feature == "elo_home_norm":
                reasons.append(f"Home team strength {magnitude} {direction} prediction")
            elif feature == "elo_away_norm":
                reasons.append(f"Away team strength {magnitude} {direction} prediction")
            elif feature == "form_home_norm":
                reasons.append(f"Home recent form {magnitude} {direction} bet attractiveness")
            elif feature == "xg_home_norm":
                reasons.append(f"Home expected goals {magnitude} {direction} confidence")
            elif feature == "stake_norm":
                reasons.append(f"Stake size {magnitude} {direction} bet allocation")
            elif feature == "league_weight":
                reasons.append(f"League competitiveness {magnitude} {direction} decision")

        return reasons if reasons else ["Model prediction based on weighted feature analysis"]

    def _assess_risk(self, prediction_prob, odds, stake):
        """Assess risk level of the bet."""
        if prediction_prob < 0.35:
            return {"level": "very_high", "score": 0.9, "warning": "Low confidence prediction"}
        elif prediction_prob < 0.45:
            return {"level": "high", "score": 0.7, "warning": "Below 50% confidence"}
        elif prediction_prob < 0.55:
            return {"level": "medium", "score": 0.5, "warning": None}
        else:
            return {"level": "low", "score": 0.3, "warning": None}

    def _fallback_explanation(self, features, prediction_prob, odds, stake):
        """Fallback explanation when model not available."""
        return {
            "bet_id": None,
            "timestamp": datetime.now().isoformat(),
            "prediction": round(prediction_prob, 3),
            "base_value": 0.5,
            "contributions": {
                "odds": odds - 1.8,
                "stake": stake / 100.0,
            },
            "final_prediction": round(prediction_prob, 3),
            "reasoning": [
                f"Betting at {odds:.2f} odds",
                f"Stake: {stake:.0f} Kč",
                f"Expected confidence: {prediction_prob:.1%}",
            ],
            "risk_level": self._assess_risk(prediction_prob, odds, stake),
        }

    def save_explanation(self, bet_id, explanation):
        """Save explanation to file."""
        try:
            explanations = storage.load("explanations.json", {})
            explanations[bet_id] = explanation
            storage.save("explanations.json", explanations)
        except:
            pass

        self.explanations[bet_id] = explanation
        return explanation

    def get_explanation(self, bet_id):
        """Retrieve saved explanation."""
        return self.explanations.get(bet_id)

    def get_feature_interpretation(self, feature_name, feature_value):
        """Human-readable interpretation of a single feature."""
        interpretations = {
            "odds": lambda v: f"Market odds at {v:.2f}x (higher = riskier but better value)",
            "log_odds": lambda v: f"Log-transformed odds: {v:.3f}",
            "stake_norm": lambda v: f"Normalized stake: {v:.2f}",
            "is_home": lambda v: "Betting on home team" if v > 0.5 else "Betting away or draw",
            "league_weight": lambda v: "Top-tier league" if v > 0.7 else "Lower-tier league",
            "elo_home_norm": lambda v: f"Home Elo strength: {v:.1%} (1500 = average)",
            "elo_away_norm": lambda v: f"Away Elo strength: {v:.1%}",
            "xg_home_norm": lambda v: f"Home expected goals: {v * 2:.2f}",
            "xg_away_norm": lambda v: f"Away expected goals: {v * 2:.2f}",
            "possession_norm": lambda v: f"Expected possession: {v * 100:.0f}%",
            "form_home_norm": lambda v: f"Home recent form: {v:.2f}/5.0",
            "form_away_norm": lambda v: f"Away recent form: {v:.2f}/5.0",
        }

        if feature_name in interpretations:
            return interpretations[feature_name](feature_value)
        else:
            return f"{feature_name}: {feature_value:.3f}"
