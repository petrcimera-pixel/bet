# ⚽ KurzAnalytik

Lokální webová aplikace na **kurzové sázení a predikci fotbalu**. Načítá fotbalové
zápasy z celého světa rozdělené podle lig, analyzuje je vlastním predikčním
enginem, simuluje kurzy sázkových kanceláří a hledá **value sázky**.

## Spuštění

Dvojklik na **`spustit.bat`** (nainstaluje závislosti a otevře appku v prohlížeči).

Nebo ručně:
```
pip install -r requirements.txt
python app.py
```
Aplikace běží na <http://127.0.0.1:5000>.

## Co umí

- **📅 Zápasy** – všechny fotbalové zápasy, seskupené podle lig a zemí.
  **Časové okno** 1 / 3 / 7 / 14 dní (defaultně 7 dní, ať je vidět hodně zápasů
  i mimo víkend). Filtrování podle ligy, hledání týmu, řazení podle data / jistoty
  / value. Datum a okno lze libovolně přepínat.
- **Predikce** každého zápasu – pravděpodobnosti 1 / X / 2, Over/Under 2.5,
  „oba dají gól", očekávané góly a nejpravděpodobnější skóre.
- **💎 Value bets + EV** – porovnání nejlepšího kurzu na trhu s férovou cenou,
  výpočet očekávané hodnoty (EV) a hrany proti sázkovce.
- **🎯 Confidence + forma** – skóre jistoty predikce, forma týmů (posledních 5),
  Elo ratingy.
- **💰 Bankroll + Kelly** – správa banku, doporučená výše sázky podle (frakčního)
  Kelly kritéria, historie tipů, vyhodnocení a sledování ROI / úspěšnosti.
- **🎟️ Tikety dne** – automatické akumulátory: *Jistota*, *Value* a *Odvážný* tiket.
- **🔔 Alerty** – silné value příležitosti, velký rozkol kurzů mezi sázkovkami,
  zápasy s vysokou jistotou.
- **🏀 Více sportů** – kromě fotbalu i **basketbal, hokej a americký fotbal**
  (přepínač sportu nahoře). U dvoucestných sportů predikce 1/2 a trh více/méně
  bodů; engine se použije znovu.
- **🧾 Tiket builder (košík)** – klikáním napříč zápasy si složíš vlastní
  akumulátor; živě se počítá kombinovaný kurz, pravděpodobnost a EV, pak vsadíš
  jedním tlačítkem.
- **🔥 Skutečná forma + H2H** – v detailu zápasu se on-demand stáhne posledních
  ~6 reálných zápasů obou týmů a vzájemné duely z ESPN.
- **⚡ Auto-vyhodnocení + CLV** – tlačítkem se otevřené tipy samy označí
  výhra/prohra podle reálných výsledků; sleduje se **CLV** (náskok tvého kurzu
  nad tržním konsenzem).
- **👤 Detail týmu** – klik na jméno týmu v detailu zápasu: Elo rating, úspěšnost,
  průměr vstřelených/obdržených, skutečná forma (10 zápasů) a příští zápasy.
- **📐 Kalibrace / backtest** – záložka, která přehraje predikce na odehraných
  zápasech a spočítá přesnost, **Brier score**, náskok nad náhodou, ROI value
  sázek a graf „predikováno vs. realita".
- **🔴 Reálné kurzy (volitelné)** – v Nastavení banku lze vložit bezplatný klíč
  z *the-odds-api.com*; pak se u zápasů použijí skutečné kurzy sázkovek místo
  modelovaných (value se počítá proti reálnému trhu). Bez klíče jede model.
- **❓ Nápověda a vysvětlivky** – integrovaný průvodce (tlačítko ❓): co appka dělá,
  4 kroky „jak na to" a **slovníček pojmů**. U odborných výrazů jsou **ⓘ bublinky**
  s vysvětlením a každá záložka má krátký popisek. Při prvním spuštění se průvodce
  ukáže automaticky.
- **💎 Tip dne** – banner s nejvyšší value příležitostí dne, klikem rovnou do detailu.
- **📈 Graf vývoje banku** – křivka zůstatku v čase + statistiky (ROI, úspěšnost).
- **Velké ligy nahoře**, sbalovací sekce lig, zapamatování nastavení (okno, řazení,
  filtry, sbalené ligy) mezi spuštěními. Moderní tmavý vzhled, skeleton načítání.
- **Samoučící engine** – po zadání reálného výsledku zápasu se aktualizují Elo
  ratingy, takže predikce se časem zpřesňují.

## Jak to funguje

1. **Zápasy** se načítají z veřejného **ESPN API** – **bez jakékoliv registrace**.
   Seznam **všech ~244 fotbalových lig světa** se stahuje dynamicky a kešuje
   (`data/leagues.json`, obnova 1× týdně); rozpis na daný den se pak stáhne pro
   každou ligu paralelně. Fallback: TheSportsDB (klíč `3`) a nakonec vestavěný
   demo dataset, takže appka funguje vždy. Výsledky dne se kešují do
   `data/cache_<datum>.json` (první načtení dne trvá ~25 s, pak je okamžité).
2. **Predikce**: každý tým má sílu (Elo) podle úrovně ligy; z rozdílu sil se
   Poissonovým modelem spočítají očekávané góly a z nich pravděpodobnosti všech
   trhů.
3. **Kurzy**: z férových pravděpodobností se nasimuluje panel 10 sázkových
   kanceláří (každá s vlastní marží a šumem, včetně „sharp" knih jako Pinnacle).
   Z nich se počítá tržní konsenzus a hledají se value sázky (nejlepší dostupný
   kurz vs. naše pravděpodobnost).

> ⚠️ Reálné agregované kurzy více sázkovek nejsou dostupné zdarma bez registrace,
> proto je engine **modeluje** (metodicky odpovídají sharp konsenzu). Architektura
> v `engine/prediction.py` je připravená napojit reálný kurzový feed – stačí
> nahradit funkci `_book_odds()`.

## Struktura

```
app.py                  Flask server + API
engine/
  data_sources.py       načítání zápasů (TheSportsDB + demo)
  prediction.py         Elo + Poisson predikční engine, simulace kurzů
  bankroll.py           bank, Kelly kritérium, historie tipů, ROI
  accumulator.py        generátor tiketů a alertů
  storage.py            ukládání stavu do data/*.json
templates/index.html    dashboard
static/                 style.css, app.js
data/                   keš a uložený stav (vznikne za běhu)
```

## Upozornění

Aplikace slouží ke **vzdělávacím a analytickým účelům**. Žádná predikce nezaručuje
výhru. Sázej zodpovědně. **18+**
