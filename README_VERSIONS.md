# 📦 KurzAnalytik Pro – Version Guide

## Jak poznat verzi?

### V aplikaci:
- V **levém horním rohu** (logo) vidíš číslo verze **v1.0** ✅

### Na webu:
Pokud jsi na https://kurzanalytik.onrender.com/:
- Refreshni F5 nebo Ctrl+Shift+R (hard refresh)
- Počkej 2-3 minuty na deployment
- Podívej se na logo v levém horním rohu → měl by zobrazit **v1.0**

### V terminálu:
```bash
cat VERSION.md
```

---

## Aktuální verze

### 🟢 v1.0 (LIVE - 2026-07-07)
**Status**: PRODUCTION ✅

#### Co je nového:
- ✅ **Dashboard agent tips FIX** - Tlačítko "Dnešní + Zítřejší tipy" už FUNGUJE
- ✅ **11 otevřených sázek** viditelných na dashboardu
- ✅ Complete Bankroll Analytics
- ✅ ML Learning System s feedback loop
- ✅ Backtesting engine
- ✅ Explainability (SHAP-style)
- ✅ Model Ensembling

#### Jak funguje:
1. **Dashboard** → vidíš "Běh agenta" s 11 otevřenými sázkami
2. **Tipy agenta** → kompletní seznam všech 38 sázek agenta
3. **Vývoj Banku** → equity curve + metriky
4. **ML Learning** → jak se agent učí
5. **Advanced** → backtesting
6. **Bankroll** → úplná historia

#### API:
- 25+ endpointů
- Všechny fungují
- JSON responses

#### Data:
- 38 Agent bets (11 open, 27 settled)
- 11 aktuálních otevřených sázek
- Equity curve tracking
- Daily/monthly analytics

---

## Jak se verze updatují?

1. Nová verze se commituje do `main` branch
2. Render.com automaticky builduje a deployuje
3. Deploy trvá **2-3 minuty**
4. Zkontroluj verzi číslo v aplikaci

---

## Verze timeline

| Verze | Datum | Status | Deploy |
|-------|-------|--------|--------|
| v1.0 | 2026-07-07 | ✅ LIVE | https://kurzanalytik.onrender.com/ |
| v0.9 | (neveřejné) | Archived | - |

---

## Troubleshooting

**Vidím starou verzi?**
→ Hard refresh: `Ctrl+Shift+R` nebo `Cmd+Shift+R` (Mac)
→ Počkej 2-3 minuty na Render deployment

**Nejsou vidět agent tipy?**
→ Zkontroluj že vidíš "v1.0" v levém horním rohu
→ Zkontroluj že se agent enablel v Nastavení
→ Refresh stránku

**Není vidět verze?**
→ Máš starou verzi (< v1.0)
→ Refresh a počkej na deployment

---

## Budoucí verze

### Plánovaná: v1.1
- [ ] Advanced UI optimizations
- [ ] Real-time WebSocket updates
- [ ] Mobile app
- [ ] Dark mode toggle

### Plánovaná: v2.0
- [ ] Live betting integration
- [ ] Advanced prediction models
- [ ] Multi-user support
- [ ] Cloud sync

---

**Current**: v1.0 ✅

Sleduj GitHub releases: https://github.com/petrcimera-pixel/bet/releases
