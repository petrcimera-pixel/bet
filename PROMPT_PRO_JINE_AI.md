# Zadání: KurzAnalytik — lokální webová aplikace na analýzu sportovních kurzů

Vytvoř kompletní webovou aplikaci podle následující specifikace. Aplikace běží
lokálně na Windows a jako server v domácí síti. **Celé uživatelské rozhraní je
česky.**

---

## 1. Než začneš — tři pravidla, která nesmíš porušit

Tahle tři pravidla vznikla z reálných chyb. Když je porušíš, aplikace bude
vypadat, že funguje, ale bude lhát uživateli o penězích.

1. **Nikdy nevymýšlej kurzy ani zápasy.** Sázet se smí výhradně na kurzy, které
   skutečně přišly z datového zdroje. Když trh kurz nemá, model svou
   pravděpodobnost zobrazit může, ale musí být označený odznakem `MODEL` a
   nesmí vstoupit do žádné sázky. Nikdy negeneruj ukázková ("demo") data jako
   náhradu, když API vrátí prázdno — prázdno je platná odpověď.
2. **Nikdy nekombinuj trhy jednoho zápasu součinem pravděpodobností.** Výsledky
   téhož zápasu spolu korelují (např. „výhra domácích" a „přes 2,5 gólu").
   Součin dá až o 12 procentních bodů jinou hodnotu než správný výpočet ze
   společné mřížky skóre.
3. **Odděl realizovaný zisk od peněz v otevřených sázkách.** Zisk počítej jen
   z vyhodnocených sázek. Když od zůstatku odečteš počáteční vklad, dostaneš
   zápornou hodnotu vedle kladného ROI a uživatel ti přestane věřit.

---

## 2. Technologie

- **Backend:** Python 3.10+, Flask (bez ORM, data v JSON souborech)
- **Frontend:** jedna HTML stránka, vanilla JavaScript (žádný framework, žádný
  build krok), vlastní CSS
- **ML:** scikit-learn + XGBoost, numpy
- **Závislosti:** `Flask>=3.0`, `requests>=2.31`, `numpy`, `scikit-learn`,
  `xgboost`, `gunicorn`

Struktura projektu:

```
app.py                    # Flask server, ~80 endpointů
engine/
  data_sources.py         # stahování zápasů a kurzů, cache
  goals_model.py          # predikční model
  tips_db.py              # databáze tipů modelu a jejich vyhodnocení
  bankroll.py             # sázky a zůstatek
  bankroll_stats.py       # statistiky (denní, měsíční, série, ROI dle kurzu)
  agent.py                # automatický sázecí agent
  virtual_bettors.py      # 41 virtuálních sázkařů
  calibration.py          # izotonická kalibrace pravděpodobností
  ml_learner.py           # XGBoost model učící se z výsledků
  backtester.py           # zpětné testy
  settings.py             # konfigurace
  storage.py, persist.py  # ukládání JSON
  netdiag.py              # diagnostika síťové dostupnosti (Windows)
  footballdata.py         # archiv historických zápasů
  apifootball.py, odds_api.py  # volitelné doplňkové zdroje
templates/index.html      # celá aplikace
templates/login.html
static/app.js             # ~2200 řádků
static/style.css
data/*.json               # veškerá data
deploy/                   # instalace na server
```

---

## 3. Datový zdroj

Primární zdroj je **veřejné ESPN API** (`site.api.espn.com`), které nevyžaduje
registraci ani klíč. To je tvrdý požadavek — žádný povinný zdroj nesmí chtít
registraci.

```
https://site.api.espn.com/apis/site/v2/sports/{sport}/{liga}/scoreboard?dates=YYYYMMDD
```

**Co ESPN dává:** zápasy, čas výkopu, průběžné i konečné skóre, stav zápasu, a
u části zápasů kurzy — přesně čtyři trhy: `moneyline` (1/2), `drawOdds`,
`total` (přes/pod) a `pointSpread` (handicap). Nic víc. **Kurzy na oba týmy
skórují ani na rohy neexistují nikde** — model je počítat může, sázet se na ně
nesmí.

Podporované sporty a jejich parametry:

| Sport | Dvoucestný | Průměr | Směr. odch. | Linie |
|---|---|---|---|---|
| Fotbal | ne (je remíza) | 2,7 gólu | 1,7 | 0,5 / 1,5 / 2,5 / 3,5 / 4,5 |
| Basketbal | ano | 224 bodů | 19 | 210,5 / 220,5 / 230,5 |
| Hokej | ano | 6,1 gólu | 2,2 | 4,5 / 5,5 / 6,5 / 7,5 |
| Am. fotbal | ano | 45 bodů | 13,5 | 41,5 / 45,5 / 49,5 |

U fotbalu načítej ligy dynamicky (je jich přes 240), u ostatních sportů měj
kurátorovaný seznam (NBA, WNBA, NHL, NFL, EuroLeague, univerzitní soutěže).

**Průměry musí být per soutěž, ne per sport.** NBA má 228 bodů, WNBA 163 —
kdybys WNBA ocenil průměrem NBA, každý zápas vyjde jako extrémní „pod".

### Dvě pasti při stahování

1. **Půlnoc UTC.** ESPN indexuje zápasy podle amerického data, ty filtruješ
   podle UTC. Zápas začínající těsně po půlnoci UTC je pak neviditelný pro
   jakýkoliv jednodenní dotaz. Řešení: ptej se na okno ±1 den a teprve výsledek
   filtruj na přesný den.
2. **Cache.** Používej „stale-while-revalidate": měkká platnost 30 minut, tvrdá
   12 hodin, po měkkém vypršení vrať uložená data hned a čerstvá dotáhni na
   pozadí. Prázdné odpovědi a data z náhradních zdrojů **necachuj**.

---

## 4. Predikční model

### Ratingy týmů

Každý tým má útok a obranu jako **poměr vůči ligovému průměru** (1,0 = průměr),
oříznuté do rozsahu 0,4–2,6.

Po zápase aktualizuj s **bayesovským vyhlazením** — bez něj tým po jediném
zápase vyskočí na krajní hodnotu:

```
novy_utok = (vstrelene_soucet + prior) / (ocekavane_soucet + prior)
```

kde `prior` je gama předpoklad se střední hodnotou 1 (funguje např. 4). Každý
zápas smí ovlivnit ratingy **právě jednou** — veď si seznam už zpracovaných ID.

**Pozor na sport.** Funkce pro aktualizaci ratingů musí dostat, o jaký sport
jde. Když basketbalové skóre (110 bodů) vydělíš fotbalovým průměrem (1,35),
vyjde poměr přes 50 a tým se natrvalo zasekne na horní mezi — po jediném zápase.

### Očekávané skóre

Musí existovat **jediná funkce**, která z ratingů spočítá očekávané skóre, a
používá ji jak predikce, tak učení. Když to spočítáš na dvou místech zvlášť,
rozejdou se.

Vliv ratingů tlum podle variability sportu (poměr směrodatné odchylky k průměru
vůči fotbalu) — v basketbalu znamená rozdíl v síle mnohem menší relativní
rozdíl ve skóre než ve fotbale.

### Mřížka skóre

Dixon-Colesův model: Poissonova mřížka 0–8 gólů pro každý tým, s korekcí nízkých
skóre (`rho = -0,13`) a výhodou domácího prostředí (násobek 1,12 pro domácí).
Z mřížky odvoď **všechny** trhy — nikdy je nepočítej samostatnými vzorci:

- 1X2 (výhra domácích / remíza / výhra hostů)
- Přes/pod pro každou linii sportu
- Oba týmy skórují ano/ne
- Asijský/evropský handicap
- Dvojtip: 1X, 12, X2
- Remíza neplatí (draw no bet)

Dvojtipy a remíza neplatí se **odvozují z kurzů 1X2**, aby zůstala zachovaná
marže sázkovky:

```
dvojtip:        kurz = 1 / (implikovana_A + implikovana_B)
remiza neplati: kurz = 1 + (implikovana_soupere / implikovana_moje)
```

Pro kombinace trhů v jednom zápase napiš funkci, která projde mřížku skóre a
sečte pravděpodobnost polí, kde platí **všechny** podmínky současně.

### Kdy je sázka „value"

```
edge = model_pravdepodobnost - implikovana_pravdepodobnost
potrebna_edge = 0,03 + (1 - jistota_ratingu) * 0,20
```

`jistota_ratingu = min(1, pocet_zapasu_obou_tymu / 40)`. Pod hodnotou 0,25 se
value neoznačuje vůbec.

**Proč to tam musí být:** bez téhle podmínky model u týmů bez historie vrátí
ploché pravděpodobnosti (~45/29/26 %) a proti kurzu 18,0 to vypadá jako výhodná
sázka s očekávaným ziskem +371 %. Skoro všechny „nejlepší příležitosti" pak
budou obrovští outsideři a bankroll to vysaje.

### Kalibrace

Z vyhodnocených tipů se izotonickou regresí (algoritmus PAV) nauč korekční
křivku a novější vzorky važ víc. **Křivku veď zvlášť pro každý typ trhu** —
u vítěze zápasu odpovídá deklarovaným 75 % skutečných 78,9 %, ale u počtu gólů
jen 55,6 %. Jedna společná křivka tenhle rozdíl rozmaže.

---

## 5. Funkce aplikace

### Automatický agent

Sází ploché nebo Kellyho sázky na tipy s dostatečnou jistotou. Konfigurace:
zapnuto, výše sázky, způsob vkladu (Kelly / pevná částka), minimální
pravděpodobnost (0,65), minimální kurz (1,2), denní strop z banku (40 %),
povolené trhy a sporty, automatický běh v daných hodinách, jen skutečné kurzy.

Pravidla: jedna sázka na zápas, kontrola duplicit přes ID zápasu, při
nedostatku banku končí.

### Virtuálních 41 sázkařů ve třech skupinách

Každý má vlastní strategii a vlastní zůstatek — slouží ke srovnání přístupů.

- **Jednotlivé sázky (21):** Kelly, čtvrtinový Kelly, konzervativní, lovec
  value, favorité, outsideři, martingale, náhodný, disciplinovaný, opatrný,
  domácí, přes, pod, Fibonacci, D'Alembert, Paroli, nízké kurzy, vysoké kurzy,
  kalibrovaný, handicapy, + vlastní
- **Více sázek na tiketu (10):** akumulátory ze **dvou a více zápasů** —
  dvojice, trojice, pětice, jackpot, value, handicapové, přes, favorité,
  dvojtipy, progresivní. Kurzy se násobí.
- **Kombinované zápasy (10):** několik trhů **jednoho zápasu** na tiketu —
  výhra+přes, výhra+pod, oba skórují+přes, handicap+přes, jistá, riziková,
  value, trojitá, domácí+oba skórují, kalibrovaná. **Zde platí pravidlo č. 2 —
  společná pravděpodobnost z mřížky, ne součin.**

Dále: vkládání peněz s historií, mazání, přidání nového průvodcem, generátor
jmen (s ohledem na rod), srovnání skupin.

**Pozor:** když má víc nohou tiketu stejné filtry, výběr vrátí tutéž nohu
vícekrát a tiket se zahodí. Už vybrané nohy vylučuj.

### Databáze tipů

Ke každému nadcházejícímu zápasu ulož tip (1X2 + nejjistější linie gólů). Zpětně
vyhodnoť podle výsledku. Rozliš „ostré" tipy (jistota nad 0,55 nebo value) od
mincí — ostré mají výrazně vyšší úspěšnost a bez toho rozdělení vypadá model
špatně. Odložené a zrušené zápasy označ jako neplatné, aby neblokovaly frontu.

### Bankroll a statistiky

Zůstatek, otevřené sázky, realizovaný zisk, ROI, denní/hodinové/měsíční
přehledy, série výher a proher, ROI podle pásma kurzu, nejlepší a nejhorší
sázky, Kellyho kalkulačka.

### ML

XGBoost učící se z výsledků agenta. Příznaky: `odds`, `log_odds`, `model_prob`,
`edge`, `is_home`, útok a obrana obou týmů, očekávané skóre obou týmů,
`rating_confidence`. Zobraz důležitost příznaků a přesnost.

### Ostatní

Vyhledávání týmů (nezávislé na diakritice), detail zápasu s rozborem, přehled
lig, zpětné testy (nejlepší/nejhorší ligy, pásma kurzů, agent vs. ruční sázky),
export a import dat, srovnání modelu s uzavíracím kurzem sázkovky přes Brierovo
skóre.

---

## 6. Vzhled

Střídmá „trading desk" estetika. Tmavý motiv je výchozí, světlý přepínatelný.

```css
:root {
  --bg: #0b0e14;      --bg-alt: #10141d;
  --panel: #151a25;   --panel-2: #1b2130;
  --border: #262d3d;
  --txt: #e8ecf4;     --txt2: #8892a6;  --txt3: #5c6580;
  --accent: #3ddc97;  --accent-dim: #2a9d6f;
  --accent-glow: rgba(61, 220, 151, 0.15);
  --pos: #3ddc97;     --bad: #ff5d7a;
  --warn: #ffb547;    --blue: #5b8cff;
  --radius: 14px;     --radius-sm: 9px;
  --shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
```

**Zásady:** ploché grafitové plochy, vlasové linky, žádné neonové záře, žádné
přechody. Akcentové odstíny přes `color-mix`. V rámu aplikace (postranní panel,
stavová lišta) žádné emoji — čárové SVG ikony.

**Rozvržení:** mřížka 240 px postranní panel + obsah. Osm stránek: Dashboard,
Zápasy, Hledat, Sázkaři, Bankroll, ML Learning, Nastavení, Návod. Zápasy jsou
**řádky tabulky uvnitř karty ligy**, ne plovoucí kartičky. Pod každým kurzem
zobraz implikovanou pravděpodobnost modelu. V hlavičce ukazuj volný bank
i částku v riziku.

### Světlý motiv

Musí jít vynutit nezávisle na systému:

```css
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }
:root[data-theme="light"] { … }
```

Barvy **musí být tmavší** než v tmavém motivu. Zelená `#3ddc97` má na bílém
pozadí kontrast 1,4:1 — nečitelné. Použij `#066343` a ověř, že všechny texty
mají aspoň 4,5:1 (u průhledných pozadí počítej kontrast až po prolnutí).

Volbu ulož do `localStorage` a aplikuj **inline skriptem v `<head>` obou
šablon**, jinak při každém načtení problikne tmavá.

---

## 7. Detaily UI, na kterých záleží

- **Časy převáděj z UTC na místní.** ESPN vrací UTC; bez převodu je každý zápas
  o dvě hodiny vedle.
- **Živé zápasy** označ odznakem a průběžným skóre, obnovuj automaticky.
  Zápas je odehraný jen tehdy, když má výsledek **a zároveň neběží** — živý
  zápas už skóre má a jinak se bude tvářit jako ukončený.
- **U vyhodnocených sázek ukaž výsledek zápasu**, ne jen výhru/prohru.
- **Souhrnné dlaždice, na které jde klikat, musí filtrovat.** Ty, které
  filtrovat nejdou, odliš vzhledem (přerušovaný rámeček, bez efektu při
  najetí) — jinak uživatel klika a nic se neděje.
- **Tipy piš česky se správným skloňováním:** „více než 4,5 gólu", „3 góly",
  „1 gól", „5 gólů". Desetinná čárka, ne tečka.
- **Dolní stavová lišta** s časem poslední kontroly výsledků.

---

## 8. Nasazení na domácí server (Windows)

Instalátor: samorozbalovací EXE, které se rozbalí do `C:\ProgramData\<app>` a
samo vytvoří virtuální prostředí, nainstaluje závislosti, nastaví firewall
a zaregistruje spouštění po startu.

Jako službu použij **úlohu v Plánovači** (spouštěč *Při spuštění počítače*,
účet `SYSTEM`) — chová se stejně jako služba, ale nepotřebuje nic doinstalovat.

### Co znemožňuje připojení z jiného počítače

Tohle jsou tři nezávislé příčiny, které vypadají navenek úplně stejně — spojení
mlčky nefunguje. Aplikace by měla umět všechny tři rozpoznat a nabídnout opravu:

1. Server naslouchá na `127.0.0.1` místo `0.0.0.0`.
2. Ve firewallu chybí pravidlo pro port.
3. **Síť je označená jako Veřejná.** Windows na ní zahodí i ping a pravidlo pro
   soukromý profil se vůbec neuplatní. Instalátor by měl profil přepnout sám.

### Jedna instance

Na Windows si druhá instance dokáže port **ukrást** té první (Werkzeug nastavuje
`SO_REUSEADDR`). Původní proces pak běží dál, nikomu neodpovídá, ale **pořád
zapisuje do stejných datových souborů**. Při startu proto ověř, jestli na portu
už někdo neposlouchá, a pokud ano, skonči s vysvětlením.

### Notifikace

Prohlížeče pouštějí systémové notifikace jen na HTTPS nebo `localhost`. Na
`http://` se síťovou IP je zablokují a **povolit je nejde** — neposílej proto
uživatele do nastavení prohlížeče. Zobrazuj upozornění přímo v okně aplikace
a počet nepřečtených piš do titulku karty.

---

## 9. Pasti, na kterých se dá ztratit hodně času

- **`slovnik.get(klic, vychozi)` vrátí `None`**, když klíč existuje s hodnotou
  `None` — výchozí hodnota se nepoužije. Piš `slovnik.get(klic) or vychozi`.
  Tahle jediná věc způsobila tři různé pády, mimo jiné HTTP 500 při řazení
  podle času vyhodnocení.
- **Emoji v konzoli.** `print("⚽ …")` shodí start serveru na `UnicodeEncodeError`,
  když je konzole v cp1250. Ošetři výjimku.
- **Ve Windows batch souborech** neskládej složitější PowerShell uvnitř
  `for /f ('…')` — escapování rour se rozbije. Dej ho do samostatného `.ps1`.
  `timeout /t` navíc selže při přesměrovaném vstupu (použij `ping -n`) a
  vykřičník mizí kvůli `EnableDelayedExpansion`.
- **Rozhodnutí o velikosti sázky** nikdy neopírej o zůstatek včetně peněz
  v otevřených sázkách.

---

## 10. Přihlášení

Jednoduché přihlášení jménem a heslem ze serverové konfigurace, session cookie,
všechny API endpointy chráněné. Aplikace je určená **do domácí sítě, ne na
internet** — pravidlo firewallu jen pro soukromý profil. Pro veřejný provoz by
bylo potřeba HTTPS, silnější přihlášení a produkční WSGI server.

---

## 11. Postup

Stav po každém kroku ověř v prohlížeči, ne odhadem:

1. Flask kostra, přihlášení, rozvržení a design
2. Stahování zápasů z ESPN, cache, výpis zápasů podle lig
3. Ratingy a Dixon-Colesova mřížka, predikce trhů
4. Databáze tipů a jejich vyhodnocení z výsledků
5. Bankroll, sázky, statistiky
6. Automatický agent
7. Virtuální sázkaři (nejdřív jednotlivé sázky, pak akumulátory a kombinace)
8. Kalibrace, ML, zpětné testy
9. Světlý motiv, notifikace, drobnosti v UI
10. Instalátor a nasazení na server
