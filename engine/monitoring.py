# -*- coding: utf-8 -*-
"""
Real-time Monitoring – Model drift detection, performance tracking, alerts
"""

import json
import numpy as np
from datetime import datetime, timedelta
from . import storage


class PerformanceMonitor:
    """Monitor model performance in real-time."""

    def __init__(self):
        self.metrics = {}
        self.alerts = []
        self.load_metrics()

    def record_prediction(self, bet_id, predicted_prob, actual_outcome, odds):
        """Record a prediction for monitoring."""
        outcome = 1 if actual_outcome in ("won", "won") else 0
        is_correct = (predicted_prob > 0.5) == (outcome == 1)

        record = {
            "timestamp": datetime.now().isoformat(),
            "bet_id": bet_id,
            "predicted_prob": predicted_prob,
            "actual_outcome": outcome,
            "is_correct": is_correct,
            "odds": odds,
            "error": abs(predicted_prob - outcome),
        }

        return record

    def detect_model_drift(self, recent_accuracy, historical_accuracy, threshold=0.15):
        """Detect if model performance is degrading."""
        if recent_accuracy is None or historical_accuracy is None:
            return None

        drift = abs(recent_accuracy - historical_accuracy)
        return {
            "drift_detected": drift > threshold,
            "drift_magnitude": drift,
            "threshold": threshold,
            "recent_accuracy": recent_accuracy,
            "historical_accuracy": historical_accuracy,
        }

    def check_performance_degradation(self, recent_bets, min_bets=20):
        """Check if performance is degrading over time."""
        if len(recent_bets) < min_bets:
            return None

        # Calculate rolling win rate
        first_half = recent_bets[:len(recent_bets)//2]
        second_half = recent_bets[len(recent_bets)//2:]

        wr_first = sum(1 for b in first_half if b.get("status") == "won") / len(first_half)
        wr_second = sum(1 for b in second_half if b.get("status") == "won") / len(second_half)

        degradation = wr_first - wr_second

        return {
            "degradation_detected": degradation > 0.1,
            "degradation_pct": degradation * 100,
            "first_half_wr": wr_first,
            "second_half_wr": wr_second,
        }

    def generate_alert(self, alert_type, severity, message, data=None):
        """Generate an alert."""
        alert = {
            "timestamp": datetime.now().isoformat(),
            "type": alert_type,  # "drift", "degradation", "low_confidence", "poor_odds"
            "severity": severity,  # "low", "medium", "high", "critical"
            "message": message,
            "data": data or {},
        }

        self.alerts.append(alert)

        # Keep only last 100 alerts
        if len(self.alerts) > 100:
            self.alerts = self.alerts[-100:]

        return alert

    def get_active_alerts(self, hours=24):
        """Get recent active alerts."""
        cutoff = datetime.now() - timedelta(hours=hours)
        return [
            a for a in self.alerts
            if datetime.fromisoformat(a["timestamp"]) > cutoff
        ]

    def get_high_priority_alerts(self):
        """Get critical and high severity alerts."""
        return [a for a in self.alerts if a["severity"] in ("critical", "high")]

    def analyze_confidence_distribution(self, predictions, threshold=0.55):
        """Analyze distribution of model confidence."""
        if not predictions:
            return None

        high_conf = sum(1 for p in predictions if p > 0.7 or p < 0.3)
        low_conf = sum(1 for p in predictions if 0.4 < p < 0.6)

        return {
            "total": len(predictions),
            "high_confidence": high_conf,
            "low_confidence": low_conf,
            "high_conf_pct": high_conf / len(predictions) * 100 if predictions else 0,
            "low_conf_pct": low_conf / len(predictions) * 100 if predictions else 0,
            "avg_confidence": np.mean([abs(p - 0.5) * 2 for p in predictions]) if predictions else 0,
        }

    def detect_unfamiliar_patterns(self, features, historical_means, n_stdevs=3):
        """Detect if current features are significantly different from historical."""
        if not features or not historical_means:
            return None

        anomalies = []
        for i, (feat, mean) in enumerate(zip(features, historical_means)):
            # Simplified: flag if >3 std devs from mean
            if abs(feat - mean) > n_stdevs * 0.2:  # 0.2 is rough std dev estimate
                anomalies.append(i)

        return {
            "has_anomalies": len(anomalies) > 0,
            "anomaly_indices": anomalies,
            "anomaly_count": len(anomalies),
        }

    def save_metrics(self):
        """Save monitoring metrics."""
        try:
            data = {
                "timestamp": datetime.now().isoformat(),
                "alerts": self.alerts[-50:],  # Save last 50
                "metrics": self.metrics,
            }
            storage.save("monitoring_metrics.json", data)
        except:
            pass

    def load_metrics(self):
        """Load monitoring metrics."""
        try:
            data = storage.load("monitoring_metrics.json", {})
            self.alerts = data.get("alerts", [])
            self.metrics = data.get("metrics", {})
        except:
            pass

    def get_summary(self):
        """Get monitoring summary."""
        high_alerts = self.get_high_priority_alerts()
        recent_alerts = self.get_active_alerts(hours=24)

        return {
            "total_alerts": len(self.alerts),
            "recent_alerts": len(recent_alerts),
            "high_priority_alerts": len(high_alerts),
            "latest_alert": self.alerts[-1] if self.alerts else None,
            "alert_summary": {
                "high": sum(1 for a in self.alerts if a["severity"] == "high"),
                "critical": sum(1 for a in self.alerts if a["severity"] == "critical"),
                "medium": sum(1 for a in self.alerts if a["severity"] == "medium"),
                "low": sum(1 for a in self.alerts if a["severity"] == "low"),
            },
        }


class ModelHealthCheck:
    """Health check for ML model."""

    def __init__(self):
        self.checks = {}

    def run_health_check(self, model, X_test=None, y_test=None):
        """Run comprehensive health check."""
        health = {
            "timestamp": datetime.now().isoformat(),
            "model_exists": model is not None,
            "is_trained": model is not None,
        }

        if model and X_test is not None and y_test is not None:
            try:
                accuracy = model.score(X_test, y_test)
                health["test_accuracy"] = accuracy
                health["accuracy_status"] = "good" if accuracy > 0.6 else "poor"
            except:
                health["test_accuracy"] = None

        return health

    def get_health_status(self):
        """Get overall health status."""
        if not self.checks:
            return "unknown"

        latest = self.checks.get("latest", {})
        accuracy = latest.get("test_accuracy", 0)

        if accuracy > 0.65:
            return "healthy"
        elif accuracy > 0.55:
            return "degraded"
        else:
            return "critical"
