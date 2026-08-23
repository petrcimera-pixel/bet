# -*- coding: utf-8 -*-
"""Jednorázový úklid: odstraní duplicitní sázky sázkařů na týž zápas.

Proč: pravidlo "nikdy dvakrát na stejný zápas" v _run_one_bettor bylo
děravé pro tikety (match_id prázdné, zápasy schované v legs), takže
sázkaři skládající AKO/kombi měli týž zápas klidně ve čtyřech tiketech
za den. Pravidlo je opravené, tenhle skript dorovná historii.

Pravidlo úklidu (stejné jako to nové v enginu):
  - sázky se procházejí od NEJSTARŠÍ, první výskyt zápasu se nechá
  - každá pozdější sázka, která sahá na už obsazený zápas, se smaže
  - kombi tiket = víc trhů JEDNOHO zápasu, jeho nohy se berou jako
    množina, takže se nepočítá sám proti sobě

Zůstatek se dorovná tak, aby to vypadalo, že smazaná sázka nikdy
neproběhla:
  - otevřená sázka: vklad se vrátí   (balance += stake)
  - vyhodnocená:    odečte se její P&L (balance -= pnl)
    (u prohry je pnl = -stake, takže se vklad taky vrátí; u void je 0)

Spouštět jen se ZASTAVENOU aplikací. Zápis jde přes storage.save (atomicky).
"""
import sys, os, json, argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from engine import storage, virtual_bettors as vb


def zapasy_sazky(bet: dict) -> set:
    """Zápasy, kterých se sázka týká. Kombi tiket má víc noh z jednoho
    zápasu – množina to srovná na jeden."""
    legs = bet.get("legs")
    if legs:
        return {l["match_id"] for l in legs if l.get("match_id")}
    return {bet["match_id"]} if bet.get("match_id") else set()


def dopad_na_zustatek(bet: dict) -> float:
    """O kolik se musí změnit zůstatek, aby sázka „nikdy neproběhla“."""
    if bet.get("status") == "open":
        return float(bet.get("stake") or 0.0)
    return -float(bet.get("pnl") or 0.0)


def uklid(st: dict):
    zmeny = []
    for bid, b in st.items():
        # od nejstarší: v souboru je nejnovější první (insert(0, ...))
        od_nejstarsi = sorted(b.get("bets", []), key=lambda x: x.get("ts", 0))
        obsazene, k_smazani = set(), []
        for bet in od_nejstarsi:
            ids = zapasy_sazky(bet)
            if ids and ids & obsazene:
                k_smazani.append(bet)
            else:
                obsazene |= ids
        if not k_smazani:
            continue
        smazat_id = {x["id"] for x in k_smazani}
        oprava = round(sum(dopad_na_zustatek(x) for x in k_smazani), 2)
        zmeny.append({
            "id": bid, "jmeno": b.get("name"), "smazano": len(k_smazani),
            "zustatek_pred": b.get("balance"),
            "zustatek_po": round(float(b.get("balance", 0)) + oprava, 2),
            "oprava": oprava,
            "otevrenych": sum(1 for x in k_smazani if x.get("status") == "open"),
            "_smazat_id": smazat_id,
        })
    return zmeny


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zapsat", action="store_true", help="skutečně uložit (jinak jen výpis)")
    args = ap.parse_args()

    st = storage.load(vb.FILE, None)
    if st is None:
        raise SystemExit("virtual_bettors.json se nepodařilo načíst – končím.")

    pred = sum(len(b.get("bets", [])) for b in st.values())
    zmeny = uklid(st)
    celkem = sum(z["smazano"] for z in zmeny)

    print(f"Sázkařů s duplicitou: {len(zmeny)} z {len(st)}")
    print(f"Sázek ke smazání:     {celkem} (z {pred})")
    print()
    for z in sorted(zmeny, key=lambda x: -x["smazano"])[:12]:
        print(f"  {z['jmeno']:<28} -{z['smazano']:>3} sázek "
              f"({z['otevrenych']} otevřených) | zůstatek "
              f"{z['zustatek_pred']:>7} -> {z['zustatek_po']:>7} ({z['oprava']:+})")
    if len(zmeny) > 12:
        print(f"  … a dalších {len(zmeny) - 12} sázkařů")

    if not args.zapsat:
        print("\n(nanečisto – nic se neuložilo; pro zápis přidej --zapsat)")
        return

    for z in zmeny:
        b = st[z["id"]]
        b["bets"] = [x for x in b["bets"] if x["id"] not in z["_smazat_id"]]
        b["balance"] = z["zustatek_po"]
    storage.save(vb.FILE, st)
    po = sum(len(b.get("bets", [])) for b in st.values())
    print(f"\nULOŽENO. Sázek: {pred} -> {po} (smazáno {pred - po})")


if __name__ == "__main__":
    main()
