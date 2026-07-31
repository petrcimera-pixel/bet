# Nasazení KurzAnalytiku na domácí server

## Rychle

1. Na tomhle počítači spusť **`deploy\BUILD_INSTALLER.bat`** → vznikne `KurzAnalytik-Setup.exe`
2. Přenes ten jediný soubor na server (flash disk, síť, cokoliv)
3. Na serveru ho spusť **pravým tlačítkem → Spustit jako správce**
4. Hotovo. Adresa, na kterou se připojíš, se vypíše na konci a uloží do `PRIPOJENI.txt`

Instalátor se rozbalí do `C:\ProgramData\KurzAnalytik` a sám:

- vytvoří virtuální prostředí a nainstaluje závislosti
- otevře port 5000 ve firewallu (jen pro privátní/doménovou síť, ne veřejnou)
- zaregistruje úlohu, která server spustí **při startu Windows i bez přihlášení**
- server rovnou nastartuje

## Předpoklad

Na serveru musí být **Python 3.10+** s volbou *„Add Python to PATH"*.
Instalátor to zkontroluje a když chybí, řekne, kde ho vzít.

## Připojení

| Odkud | Adresa |
|---|---|
| Ze serveru | `http://localhost:5000` |
| Z jiného počítače / mobilu v domácí síti | `http://<IP serveru>:5000` |

Přihlášení: `admin` / `8312172165`

Instalátor IP adresu zjistí sám a vypíše i všechny ostatní, kdyby ta první
nefungovala — počítače s WSL, Hyper-V nebo Dockerem mají virtuální adaptéry,
na které se zvenčí nepřipojíš.

**Doporučení:** v routeru serveru nastav rezervaci IP podle MAC adresy, aby se
adresa po restartu nezměnila.

## Správa (vždy jako správce)

| Akce | Soubor |
|---|---|
| Spustit | `deploy\START.bat` |
| Zastavit | `deploy\STOP.bat` |
| Odinstalovat | `deploy\UNINSTALL.bat` |

Odinstalace odebere úlohu a pravidlo firewallu, ale **data i složku nechá** —
sázky, ratingy a nastavení zůstanou.

Log běhu je v `server.log` ve složce aplikace.

## Jak to běží

Server pouští **Plánovač úloh** (úloha `KurzAnalytik`, spouštěč *Při spuštění
počítače*, účet `SYSTEM`). Není to klasická služba Windows, ale chová se stejně:
naběhne po restartu, běží bez přihlášeného uživatele a nepotřebuje otevřené okno.

Proti klasické službě má tohle výhodu, že nepotřebuje nic doinstalovat (NSSM
apod.) — vystačí si s tím, co ve Windows už je.

## Bezpečnost

Aplikace je určená **do domácí sítě**, ne na internet:

- pravidlo firewallu se přidává jen pro privátní a doménový profil
- přihlášení je jediné, heslo je v kódu
- běží na vývojovém Flask serveru

Pokud bys ji chtěl vystavit z internetu, chtělo by to napřed HTTPS, silnější
přihlášení a produkční WSGI server (waitress/gunicorn). Neotvírej port 5000
na routeru směrem ven.

## Když se něco pokazí

**Nejde se připojit z jiného počítače**

Nejdřív si v aplikaci otevři **Nastavení** — když něco brání připojení, appka to
sama pozná a napíše co (naslouchání jen lokálně, chybějící pravidlo firewallu,
veřejný profil sítě) i s tlačítkem na automatickou opravu.

Když k aplikaci nemáš přístup ani ze serveru, jdi na server a spusť tohle
v příkazovém řádku — dvě odpovědi rozhodnou, kde chyba je:

```
ipconfig | findstr IPv4
netstat -ano | findstr :5000
```

| Co uvidíš | Co to znamená | Co s tím |
|---|---|---|
| `netstat` nevypíše nic | Server neběží — chyba není v síti | Podívej se do `server.log`, ručně zkus `deploy\START.bat` jako správce |
| `netstat` vypíše `127.0.0.1:5000` | Server běží, ale poslouchá jen sám sobě | Spouštěj ho přes `deploy\run_server.bat` (nastaví `HOST=0.0.0.0`), ne přímo `python app.py` |
| `netstat` vypíše `0.0.0.0:5000` | Server je v pořádku, brání firewall nebo profil sítě | Přeinstaluj novým EXE — profil sítě přepne na Soukromou sám |
| `ipconfig` ukáže jinou IP než čekáš | Router adresu změnil | Použij tu novou; ať se to neopakuje, nastav v routeru rezervaci podle MAC |

Nejčastější příčina je **síť označená jako Veřejná**. Windows na ní zahodí
příchozí spojení i ping a pravidlo firewallu pro soukromý profil se vůbec
neuplatní — server je nedostupný a nic to nedá najevo. Instalátor to od téhle
verze přepíná sám; ručně: *Nastavení → Síť a internet → Wi-Fi → vlastnosti
sítě → Soukromá*.

Zbylé možnosti, když sedí všechno výše:

- Ověř ze svého počítače, že server vůbec odpovídá: `Test-NetConnection 192.168.50.47 -Port 5000` v PowerShellu. `TcpTestSucceeded : True` znamená, že chyba je jinde než v síti.
- Oba počítače musí být na **stejné síti** — pozor na oddělené SSID pro 2,4 a 5 GHz a hlavně na **hostovskou síť**, která má obvykle zapnutou izolaci klientů a spojení mezi zařízeními nepustí vůbec.
- Zkus další adresu z `PRIPOJENI.txt` — adresy `172.x` patří většinou virtuálním adaptérům (WSL, Hyper-V, Docker) a zvenčí na ně nedosáhneš.

**Server po restartu nenaběhl**
- Plánovač úloh → úloha `KurzAnalytik` → zkontroluj poslední výsledek
- ruční start: `deploy\START.bat` jako správce

**Výroba instalátoru selže**
- IExpress (nástroj Windows, kterým se balíček dělá) si neporadí s diakritikou
  v cílové cestě a přijme jen relativní cestu ke svému `.sed` souboru —
  proto skript tvoří EXE v `%TEMP%` a teprve pak ho kopíruje. Když si ho budeš
  upravovat, tohle nech být.
