# -*- coding: utf-8 -*-
"""Totéž co experiment_model.py, ale pro gólové linie (Over/Under 2.5).

Proč zvlášť: oprava 1X2 se totálů vůbec netýká, a přitom agent sází
hlavně je ("Méně než 3,5 gólu" apod.). Archiv football-data.co.uk má
u zápasů i zavírací kurzy Bet365 na O/U 2.5, takže se dá měřit stejně
poctivě jako 1X2 – proti trhu.

Brier se tu počítá jako dvouvýsledkový (over/under), takže referenční
hodnoty jsou jiné než u 1X2:
  0.5  = hádání 50/50
"""
import sys, os, argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import footballdata, goals_model, storage

CACHE = "experiment_totals.json"


def posbirej(limit):
    matches = [m for m in footballdata.fetch_all()
               if m["closing"].get("over25") and m["closing"].get("under25")][-limit:]
    data = []
    for i, m in enumerate(matches):
        if i % 250 == 0:
            print(f"  ... {i}/{len(matches)}", flush=True)
        try:
            p = goals_model.predict_match(m)
        except Exception:
            continue
        # model: pravděpodobnost Over 2.5
        p_over = None
        for gl in p.get("goal_lines") or []:
            if abs(float(gl.get("line", 0)) - 2.5) < 1e-6:
                p_over = (gl.get("over") or {}).get("prob")
                break
        if not p_over:
            continue
        c = m["closing"]
        io, iu = 1.0 / c["over25"], 1.0 / c["under25"]
        tot = io + iu
        data.append({
            "model_over": float(p_over),
            "trh_over": io / tot,                     # odmarženo
            "over": 1.0 if (m["home_score"] + m["away_score"]) > 2.5 else 0.0,
        })
    return data


def brier(fn, data):
    return sum((fn(d) - d["over"]) ** 2 + ((1 - fn(d)) - (1 - d["over"])) ** 2
               for d in data) / len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1500)
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    data = storage.load(CACHE, None)
    if data is None or args.refresh:
        print(f"Počítám predikce O/U 2.5 pro až {args.limit} zápasů…")
        data = posbirej(args.limit)
        storage.save(CACHE, data)
    print(f"Zápasů v měření: {len(data)}\n")

    zaklad = sum(d["over"] for d in data) / len(data)
    print("REFERENCE")
    print(f"  hádání 50/50                {brier(lambda d: 0.5, data):.4f}")
    print(f"  základní četnost            {brier(lambda d: zaklad, data):.4f}   (Over 2.5 padá v {zaklad:.1%})")
    print(f"  TRH (Bet365 zavírací)       {brier(lambda d: d['trh_over'], data):.4f}")
    zm = brier(lambda d: d["model_over"], data)
    print(f"  MODEL teď                   {zm:.4f}")

    prum_model = sum(d["model_over"] for d in data) / len(data)
    prum_trh = sum(d["trh_over"] for d in data) / len(data)
    print(f"\n  průměrná predikce Over: model {prum_model:.3f} | trh {prum_trh:.3f} | realita {zaklad:.3f}")
    jistota_m = sum(max(d["model_over"], 1 - d["model_over"]) for d in data) / len(data)
    jistota_t = sum(max(d["trh_over"], 1 - d["trh_over"]) for d in data) / len(data)
    print(f"  průměrná jistota:       model {jistota_m:.3f} | trh {jistota_t:.3f}")

    print("\nKROCENÍ (přimíchání základní četnosti)")
    nej = (None, 9e9)
    for w in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7):
        b = brier(lambda d, w=w: (1 - w) * d["model_over"] + w * zaklad, data)
        if b < nej[1]:
            nej = (w, b)
        mx = max(max((1 - w) * d["model_over"] + w * zaklad,
                     1 - ((1 - w) * d["model_over"] + w * zaklad)) for d in data)
        print(f"  w={w:.1f}  Brier {b:.4f}  ({b - zm:+.4f})  nejvyšší jistota {mx:.3f}")
    print(f"  nejlepší w={nej[0]} -> {nej[1]:.4f}")

    # poctivá kontrola mimo trénovací data
    p1, p2 = data[:len(data) // 2], data[len(data) // 2:]
    z1 = sum(d["over"] for d in p1) / len(p1)
    best = min(((w, brier(lambda d, w=w: (1 - w) * d["model_over"] + w * z1, p1))
                for w in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7)), key=lambda t: t[1])[0]
    print(f"\nKONTROLA mimo trénovací data (naladěno w={best} na 1. půlce):")
    print(f"  2. půlka: dnes {brier(lambda d: d['model_over'], p2):.4f}"
          f" -> po zkrocení {brier(lambda d: (1 - best) * d['model_over'] + best * z1, p2):.4f}"
          f" | trh {brier(lambda d: d['trh_over'], p2):.4f}")


if __name__ == "__main__":
    main()
