# 📦 KurzAnalytik Pro – Version History

## v1.2 - 2026-07-09 [CURRENT - LIVE]
**Status**: 🟢 PRODUCTION — reálné kurzy: poctivý režim + šetření kvóty

### Novinky:
- ✅ **Nastavení „Jen reálné kurzy sázkovek"** – agent vsadí pouze na zápasy,
  kde jsou k dispozici skutečné kurzy z The Odds API (jediný poctivý test
  ziskovosti proti reálnému trhu). Výchozí: vypnuto.
- ✅ **Priorita reálných kurzů a velkých lig** – denní rozpočet agenta se
  utrácí nejdřív za zápasy s reálnými kurzy a top ligy, až pak za malé
  kvalifikace se simulovanými kurzy.
- ✅ **Šetření kvóty The Odds API** – keš kurzů prodloužena z 10 min na 1 h
  a přidána disková keš, která přežije restart serveru (dřív každý restart
  pálil kvótu znovu). Při vyčerpané kvótě se použije poslední známá keš.
- ✅ Každá sázka nově ukládá `odds_source` („real" / „sim") – v analytice
  půjde rozlišit výkon proti reálnému trhu od simulace.

### Poznámka ke kvótě:
Free tarif The Odds API = 500 dotazů/měsíc; aktuální klíč je vyčerpaný,
reset začátkem měsíce. Do té doby jedou kurzy simulované modelem.

---

## v1.1 - 2026-07-08
**Status**: 🟢 PRODUCTION — kompletní audit + oprava ~20 chyb

### Opravené chyby (kompletní multi-agent audit):
**Matematika sázek:**
- ✅ Backtester: void sázky se počítaly jako čistý zisk (nafukovaly equity curve)
- ✅ Backtester: max drawdown se počítal proti globálnímu maximu → rostoucí křivka hlásila fantomový propad
- ✅ Backtester: řazení podle času vyhodnocení (ne vsazení), win rate bez voidů, start z reálného banku
- ✅ Měsíční/týdenní ROI: dělilo se počtem sázek místo prosázenou částkou (−7400 % → korektní %)
- ✅ ROI po ligách: stejná chyba, opraveno + přidáno pole staked
- ✅ Peak/trough: hardcoded 1000 → skutečný počáteční bank
- ✅ Denní breakdown: parametr days se ignoroval

**ML učení (agent se konečně učí správně):**
- ✅ Model trénoval na "open" záznamech jako na prohrách + každou sázku počítal 2× (dedupe podle bet_id)
- ✅ PnL vzorec ve feedbacku: výhra = stake×(kurz−1), ne stake×kurz
- ✅ Featury: přidán model_prob (nejcennější vstup!), odstraněn stake (cirkulární)
- ✅ Sjednoceno kódování featur mezi tréninkem a predikcí (dřív se lišilo)
- ✅ AUC crash na jednotřídním test setu
- ✅ **ML smyčka UZAVŘENA**: naučený model nyní vetuje tipy s nízkou šancí (dřív se predikce nikdy nepoužila!)
- ✅ Learning curve jen z rozhodnutých sázek

**API a bezpečnost:**
- ✅ /api/explain vracel 500 (modul místo instance MLLearner)
- ✅ Credentials a SECRET_KEY přes env proměnné (APP_USERNAME, APP_PASSWORD, SECRET_KEY)
- ✅ Self-installer doplněn o numpy (crash na čistém stroji)
- ✅ storage.load: utf-8-sig (BOM od PowerShellu)

**Frontend:**
- ✅ Duplicitní id="monthlyTable" → měsíční tabulka v Bankroll byla trvale prázdná
- ✅ Konflikt tabů mezi Analytics a Advanced (klik na jedné stránce rozbil druhou) + duplicitní listenery
- ✅ Historie sázek (#betsTable) se nikdy nenaplnila (četla neexistující s.bets)
- ✅ Equity curve graf v Bankroll se nikdy nevykreslil
- ✅ Filtr statusu tipů (Otevřené/Vyhrané/Prohry) byl mrtvý
- ✅ Monitoring se načítal až po 30 s (teď hned při otevření stránky)
- ✅ Auto-save togglu resetoval kelly_fraction a další uložené hodnoty
- ✅ Nastavení modelu (domácí výhoda, rating→góly) se tvářilo uložené, ale zahazovalo se

**Data:**
- ✅ Odstraněna syntetická test data (20 fake sázek Team A/B) z banku i ML feedbacku
- ✅ Reálný výkon agenta: 7/10 výher, ROI +23,9 %

---

## v1.0 - 2026-07-07
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
