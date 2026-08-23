# -*- coding: utf-8 -*-
"""Měření kvality predikcí modelu proti zavíracímu kurzu Pinnacle.

Predikce se spočítají JEDNOU a uloží, pak se na nich dá levně zkoušet
libovolná úprava (shrinkage, teplota...). Bez toho by každý pokus
znamenal znovu projet tisíce zápasů.

Referenční body pro 1X2 Brier (součet přes 3 výsledky, menší = lepší):
  0.667 = "nevím nic", rovnoměrný tip 1/3 na každý výsledek
  ~0.60 = zavírací kurz Pinnacle (trh)
Model, který je nad 0.667, je horší než rovnoměrné hádání.

POZOR na výhodu, kterou model v tomhle měření má: ratingy se učily mimo
jiné právě z těchhle odehraných zápasů, takže výsledky už "viděl".
Reálná predikce na neznámý zápas bude horší, ne lepší.
"""
import sys, os, json, math, argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import footballdata, goals_model, storage

CACHE = "experiment_preds.json"
VYSLEDKY = ("home", "draw", "away")


def posbirej(limit):
    """Spočítá predikce modelu pro historické zápasy se zavíracím kurzem."""
    matches = [m for m in footballdata.fetch_all()
               if all(m["closing"].get(k) for k in VYSLEDKY)][-limit:]
    data = []
    for i, m in enumerate(matches):
        if i % 250 == 0:
            print(f"  ... {i}/{len(matches)}", flush=True)
        try:
            p = goals_model.predict_match(m)
        except Exception:
            continue
        pr = p.get("probs") or {}
        if not pr.get("home"):
            continue
        c = m["closing"]
        imp = {k: 1.0 / c[k] for k in VYSLEDKY}
        tot = sum(imp.values())
        hs, as_ = m["home_score"], m["away_score"]
        # Kolik toho model o obou týmech reálně ví – klíč k tomu, jestli
        # se dá důvěřovat víc u známých týmů a míň u neznámých.
        rh, ra = p.get("rating_home") or {}, p.get("rating_away") or {}
        data.append({
            "model": {k: pr.get(k, 0.0) for k in VYSLEDKY},
            "trh": {k: imp[k] / tot for k in VYSLEDKY},      # odmarženo
            "skutecnost": {"home": 1.0 if hs > as_ else 0.0,
                           "draw": 1.0 if hs == as_ else 0.0,
                           "away": 1.0 if as_ > hs else 0.0},
            "conf": p.get("rating_confidence"),
            "n_min": min(rh.get("n", 0) or 0, ra.get("n", 0) or 0),
        })
    return data


def brier(rozdeleni_fn, data):
    s = 0.0
    for d in data:
        p = rozdeleni_fn(d)
        s += sum((p[k] - d["skutecnost"][k]) ** 2 for k in VYSLEDKY)
    return s / len(data)


def normalizuj(p):
    t = sum(p.values()) or 1.0
    return {k: v / t for k, v in p.items()}


def smichej(p, zaklad, w):
    """Přimíchá k predikci základní rozdělení: w=0 čistý model, w=1 základ."""
    return normalizuj({k: (1 - w) * p[k] + w * zaklad[k] for k in VYSLEDKY})


def teplota(p, t):
    """Zploští/zostří rozdělení mocninou (t>1 = mírnější, t<1 = jistější)."""
    q = {k: max(p[k], 1e-9) ** (1.0 / t) for k in VYSLEDKY}
    return normalizuj(q)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1500)
    ap.add_argument("--refresh", action="store_true", help="přepočítat predikce")
    args = ap.parse_args()

    data = storage.load(CACHE, None)
    if data is None or args.refresh or len(data) < args.limit * 0.5:
        print(f"Počítám predikce pro až {args.limit} zápasů…")
        data = posbirej(args.limit)
        storage.save(CACHE, data)
    print(f"Zápasů v měření: {len(data)}\n")

    # základní rozdělení podle skutečnosti (jak často padá 1/X/2)
    zaklad = normalizuj({k: sum(d["skutecnost"][k] for d in data) for k in VYSLEDKY})
    rovnomerne = {k: 1 / 3 for k in VYSLEDKY}

    print("REFERENCE")
    print(f"  rovnoměrné hádání (1/3)     {brier(lambda d: rovnomerne, data):.4f}")
    print(f"  základní četnost výsledků   {brier(lambda d: zaklad, data):.4f}"
          f"   (1 {zaklad['home']:.0%} / X {zaklad['draw']:.0%} / 2 {zaklad['away']:.0%})")
    print(f"  TRH (Pinnacle zavírací)     {brier(lambda d: d['trh'], data):.4f}")
    zaklad_model = brier(lambda d: d["model"], data)
    print(f"  MODEL teď                   {zaklad_model:.4f}")

    print("\nA) PŘIMÍCHÁNÍ ZÁKLADNÍ ČETNOSTI (krocení přehnané jistoty)")
    nej = (None, 9e9)
    for w in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8):
        b = brier(lambda d, w=w: smichej(d["model"], zaklad, w), data)
        znak = "  <-- nejlepší" if b < nej[1] else ""
        if b < nej[1]:
            nej = (w, b)
        print(f"  w={w:.1f}  {b:.4f}   ({b - zaklad_model:+.4f} proti dnešku)")
    print(f"  nejlepší w={nej[0]} -> {nej[1]:.4f}")

    print("\nB) TEPLOTA (zploštění rozdělení)")
    nejT = (None, 9e9)
    for t in (1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0):
        b = brier(lambda d, t=t: teplota(d["model"], t), data)
        if b < nejT[1]:
            nejT = (t, b)
        print(f"  t={t:.2f}  {b:.4f}   ({b - zaklad_model:+.4f})")
    print(f"  nejlepší t={nejT[0]} -> {nejT[1]:.4f}")

    print("\nC) KOMBINACE nejlepší teploty + přimíchání")
    nejK = (None, None, 9e9)
    for t in (1.5, 2.0, 2.5, 3.0):
        for w in (0.0, 0.1, 0.2, 0.3, 0.4):
            b = brier(lambda d, t=t, w=w: smichej(teplota(d["model"], t), zaklad, w), data)
            if b < nejK[2]:
                nejK = (t, w, b)
    print(f"  nejlepší t={nejK[0]}, w={nejK[1]} -> {nejK[2]:.4f}"
          f"   ({nejK[2] - zaklad_model:+.4f} proti dnešku)")

    print("\nD) ZÁVISÍ KVALITA NA TOM, KOLIK MODEL O TÝMECH VÍ?")
    print("   (n = počet odehraných zápasů slabšího z obou týmů)")
    for lo, hi in ((0, 5), (5, 15), (15, 40), (40, 10**9)):
        g = [d for d in data if lo <= (d.get("n_min") or 0) < hi]
        if len(g) < 30:
            continue
        bm = brier(lambda d: d["model"], g)
        bt = brier(lambda d: d["trh"], g)
        bz = brier(lambda d: zaklad, g)
        print(f"  n {lo}-{hi if hi < 10**8 else '∞'}: {len(g):4d} zápasů | "
              f"model {bm:.4f} | základ {bz:.4f} | trh {bt:.4f} | "
              f"model {'JE lepší' if bm < bz else 'je horší'} než základ")

    print("\nE) ADAPTIVNÍ KROCENÍ – míra důvěry podle znalosti týmů")
    # w = kolik základní četnosti přimíchat. U neznámých týmů skoro všechno,
    # u dobře známých míň. n0 říká, při kolika zápasech se váhy vyrovnají.
    def adaptivni(d, n0, strop):
        n = d.get("n_min") or 0
        w = strop * (n0 / (n0 + n))
        return smichej(d["model"], zaklad, w)
    nejA = (None, None, 9e9)
    for n0 in (5, 10, 20, 40):
        for strop in (0.6, 0.8, 1.0):
            b = brier(lambda d, a=n0, s=strop: adaptivni(d, a, s), data)
            if b < nejA[2]:
                nejA = (n0, strop, b)
    print(f"  nejlepší n0={nejA[0]}, strop={nejA[1]} -> {nejA[2]:.4f}"
          f"   ({nejA[2] - zaklad_model:+.4f} proti dnešku)")
    print(f"  pro srovnání ploché krocení w=0.6 -> {nej[1]:.4f}")

    print("\nF) OPRAVA SYSTEMATICKÉHO POSUNU domácí/hosté + krocení")
    # Model soustavně podceňuje domácí a přeceňuje hosty. Posun se opraví
    # vynásobením a znovunormalizováním; pak se teprve krotí jistota.
    def oprav(p, h, a):
        return normalizuj({"home": p["home"] * h, "draw": p["draw"], "away": p["away"] * a})
    nejF = (None, None, None, 9e9)
    for h in (1.0, 1.1, 1.2, 1.3, 1.4):
        for a in (0.7, 0.8, 0.9, 1.0):
            for w in (0.0, 0.2, 0.4, 0.5, 0.6):
                b = brier(lambda d, h=h, a=a, w=w: smichej(oprav(d["model"], h, a), zaklad, w), data)
                if b < nejF[3]:
                    nejF = (h, a, w, b)
    print(f"  nejlepší: domácí ×{nejF[0]}, hosté ×{nejF[1]}, krocení w={nejF[2]}"
          f"  ->  {nejF[3]:.4f}   ({nejF[3] - zaklad_model:+.4f})")

    # Poctivější test: parametry naladit na první polovině, změřit na druhé.
    p1, p2 = data[:len(data) // 2], data[len(data) // 2:]
    zaklad1 = normalizuj({k: sum(d["skutecnost"][k] for d in p1) for k in VYSLEDKY})
    nejT1 = (None, None, None, 9e9)
    for h in (1.0, 1.1, 1.2, 1.3, 1.4):
        for a in (0.7, 0.8, 0.9, 1.0):
            for w in (0.0, 0.2, 0.4, 0.5, 0.6):
                b = brier(lambda d, h=h, a=a, w=w: smichej(oprav(d["model"], h, a), zaklad1, w), p1)
                if b < nejT1[3]:
                    nejT1 = (h, a, w, b)
    h, a, w = nejT1[0], nejT1[1], nejT1[2]
    mimo = brier(lambda d: smichej(oprav(d["model"], h, a), zaklad1, w), p2)
    puvodni2 = brier(lambda d: d["model"], p2)
    trh2 = brier(lambda d: d["trh"], p2)
    print(f"\n  KONTROLA na datech, na kterých se neladilo:")
    print(f"    naladěno na 1. půlce (domácí ×{h}, hosté ×{a}, w={w})")
    print(f"    2. půlka: model dnes {puvodni2:.4f} -> po opravě {mimo:.4f} | trh {trh2:.4f}")

    trh = brier(lambda d: d["trh"], data)
    print("\nZÁVĚR")
    print(f"  dnešek {zaklad_model:.4f} -> nejlépe {nejK[2]:.4f} | trh {trh:.4f}")
    print("  " + ("Ani po úpravě model trh neporáží." if nejK[2] >= trh
                  else "Po úpravě model trh poráží!"))


if __name__ == "__main__":
    main()
