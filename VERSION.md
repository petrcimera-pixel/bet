# 📦 KurzAnalytik Pro – Version History

## v1.0 - 2026-07-07 [CURRENT - LIVE]
**Status**: 🟢 PRODUCTION - Live na https://kurzanalytik.onrender.com/

### Features:
- ✅ Complete ML Learning System (XGBoost + Feedback Loop)
- ✅ Backtesting Engine (League, Odds, Time Period analysis)
- ✅ Explainability (SHAP-style explanations)
- ✅ Model Ensembling (3 models: XGBoost, RF, AdaBoost)
- ✅ Real-time Monitoring (Drift detection, Alerts)
- ✅ Advanced Analytics (6 backtesting API endpoints)
- ✅ Bankroll Analytics Dashboard (Daily/Monthly/Hourly breakdown)
- ✅ 11 Open Agent Bets (Live)
- ✅ Equity Curve Visualization
- ✅ Feature Importance Charts
- ✅ Agent vs Manual Comparison
- ✅ Streak Analysis
- ✅ Best/Worst Days Tracking

### Pages (7 total):
1. Dashboard - Overview + Agent tips
2. Tipy agenta - Detailed agent bets
3. Analytics - Monthly/League/Distribution
4. Bankroll - Equity curve + bet history
5. ML Learning - Model status + learning curve
6. Advanced - Backtesting + analysis
7. Nastavení - Agent configuration

### API Endpoints (25+ total):
- Learning: /api/learning/stats, /api/learning/train, /api/feedback/record
- Backtest: /api/backtest/league, /api/backtest/agent-vs-manual, /api/backtest/best-leagues, /api/backtest/odds-ranges
- Explainability: /api/explain/<bet_id>, /api/feature-importance
- Analytics: /api/analytics/summary, /api/monitoring/summary, /api/monitoring/alerts
- Bankroll: /api/bankroll/summary, /api/bankroll/daily, /api/bankroll/monthly, /api/bankroll/best-worst, /api/bankroll/streaks, /api/bankroll/hourly
- Agent: /api/agent

### Bug Fixes:
- Fixed dashboard agent tips loading (renderDashboardTips)
- Fixed scheduled matches filtering
- Fixed agent duplicate detection

### Data:
- 38 Agent bets (11 open, 27 settled)
- 44.4% Accuracy
- -30.1% ROI (test data)
- ML Model trained and saved

---

## v0.9 - Pre-release (Not Public)
- Initial ML Learning System
- Basic Analytics
- Monitoring Foundation

---

**Current**: v1.0 ✅
