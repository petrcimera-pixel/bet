@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title KurzAnalytik - instalace serveru

echo ==========================================================
echo   KurzAnalytik - instalace na server
echo ==========================================================
echo.

REM ---- musi bezet jako spravce (firewall + naplanovana uloha) ----
net session >nul 2>&1
if errorlevel 1 (
  echo [^!] Instalace potrebuje prava spravce.
  echo     Klikni na INSTALL.bat pravym tlacitkem - "Spustit jako spravce".
  echo.
  pause
  exit /b 1
)

set "APPDIR=%~dp0.."
pushd "%APPDIR%"
set "APPDIR=%CD%"
popd
echo Slozka aplikace: %APPDIR%
echo.

REM ---- Python ----
where python >nul 2>&1
if errorlevel 1 (
  echo [^!] Python nenalezen.
  echo     Nainstaluj Python 3.10+ z https://www.python.org/downloads/
  echo     DULEZITE: pri instalaci zaskrtni "Add Python to PATH".
  echo.
  pause
  exit /b 1
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PYVER=%%v
echo Python %PYVER% nalezen.
echo.

REM ---- virtualni prostredi (at se nemichaji balicky se systemem) ----
echo [1/5] Pripravuji virtualni prostredi...
if not exist "%APPDIR%\.venv" (
  python -m venv "%APPDIR%\.venv"
  if errorlevel 1 (
    echo [^!] Nepodarilo se vytvorit virtualni prostredi.
    pause
    exit /b 1
  )
)
set "PY=%APPDIR%\.venv\Scripts\python.exe"

echo [2/5] Instaluji zavislosti (muze trvat par minut)...
"%PY%" -m pip install --upgrade pip -q
"%PY%" -m pip install -r "%APPDIR%\requirements.txt" -q
if errorlevel 1 (
  echo [^!] Instalace zavislosti selhala.
  pause
  exit /b 1
)

REM ---- sit + firewall (vytazeno do netsetup.ps1) ----
REM Slozitejsi PowerShell primo v batchi (zvlast uvnitr for /f) se musi
REM escapovat a rozbije se na cizim stroji - proto samostatny skript.
echo [3/5] Kontroluji profil site a otviram port 5000...
powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\deploy\netsetup.ps1" -Port 5000

REM ---- sluzba pres Planovac uloh: nabehne po restartu i bez prihlaseni ----
echo [4/5] Registruji sluzbu (nabehne po restartu PC)...
schtasks /Delete /TN "KurzAnalytik" /F >nul 2>&1
schtasks /Create /TN "KurzAnalytik" /SC ONSTART /RU "SYSTEM" /RL HIGHEST /F ^
  /TR "\"%APPDIR%\deploy\run_server.bat\"" >nul
if errorlevel 1 (
  echo     [^!] Registrace ulohy selhala.
  pause
  exit /b 1
)
echo     Hotovo - uloha "KurzAnalytik" spusti server pri startu Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\deploy\netsetup.ps1" -HardenTask

REM ---- prvni spusteni ----
echo [5/5] Spoustim server...
schtasks /Run /TN "KurzAnalytik" >nul 2>&1
REM timeout selze, kdyz je presmerovany vstup (vzdalene spusteni) - ping ne
ping -n 11 127.0.0.1 >nul

REM ---- overit, ze server opravdu bezi a naslouchá vsem adresam ----
REM Bez tohodle by instalator hlasil "hotovo" i kdyz server spadl na
REM chybejici zavislosti - a clovek pak hleda chybu v siti.
for /f %%l in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%APPDIR%\deploy\netsetup.ps1" -Check') do set "SRVSTAV=%%l"
if "%SRVSTAV%"=="OK" (
  echo     Server bezi a naslouchá na vsech sitovych adresach.
) else (
  echo.
  echo     [^!] Server nenaslouchá jak ma ^(stav: %SRVSTAV%^).
  echo         Duvod najdes v "%APPDIR%\server.log".
  echo.
)

REM ---- zjistit IP adresu v domaci siti ----
REM Preferujeme 192.168.x.x - to ma domaci router skoro vzdy. Adresy jako
REM 172.x patri casto virtualnim adapterum (WSL, Hyper-V, Docker), na ktere
REM se z jineho pocitace nepripojis, takze je bereme az jako nahradu.
set "LANIP="
set "LANALT="
set "ALLIPS="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "CAND=%%a"
  set "CAND=!CAND: =!"
  echo !CAND! | findstr /r "^192\.168\." >nul
  if not errorlevel 1 (
    if not defined LANIP set "LANIP=!CAND!"
    set "ALLIPS=!ALLIPS! !CAND!"
  ) else (
    echo !CAND! | findstr /r "^10\. ^172\.1[6-9]\. ^172\.2[0-9]\. ^172\.3[0-1]\." >nul
    if not errorlevel 1 (
      if not defined LANALT set "LANALT=!CAND!"
      set "ALLIPS=!ALLIPS! !CAND!"
    )
  )
)
if not defined LANIP set "LANIP=%LANALT%"
if not defined LANIP set "LANIP=<IP tohoto pocitace>"

REM ---- zapsat pripojovaci info ----
> "%APPDIR%\PRIPOJENI.txt" (
  echo ==========================================================
  echo   KurzAnalytik - jak se pripojit
  echo ==========================================================
  echo.
  echo Z TOHOTO pocitace:      http://localhost:5000
  echo Z jineho v domaci siti: http://%LANIP%:5000
  echo.
  echo Prihlaseni: admin / 8312172165
  echo.
  echo Vsechny sitove adresy tohoto pocitace:%ALLIPS%
  echo ^(pokud prvni nefunguje, zkus dalsi - nektere patri
  echo  virtualnim adapterum jako WSL nebo Hyper-V^)
  echo.
  echo TIP: aby se adresa nemenila, nastav serveru pevnou IP
  echo      v routeru ^(rezervace podle MAC adresy^).
  echo.
  echo ----------------------------------------------------------
  echo KDYZ SE Z JINEHO POCITACE NEPRIPOJIS:
  echo.
  echo 1^) V aplikaci otevri Nastaveni - sama napise, co brani
  echo    pripojeni, a nabidne automatickou opravu.
  echo 2^) Kdyz appka nejde ani zde, spust v prikazovem radku:
  echo       netstat -ano ^| findstr :5000
  echo    - nic nevypise ....... server nebezi, koukni do server.log
  echo    - 127.0.0.1:5000 ..... spoustej ho pres deploy\run_server.bat
  echo    - 0.0.0.0:5000 ....... server je OK, vina je firewall/profil site
  echo 3^) Sit musi byt SOUKROMA. Na Verejne Windows zahodi i ping
  echo    a pravidlo firewallu neplati. Nastaveni - Sit a internet -
  echo    vlastnosti site - Soukroma.
  echo 4^) Oba pocitace musi byt na stejne siti. Pozor na hostovskou
  echo    sit - ta mezi zarizenimi spojeni obvykle nepusti vubec.
  echo.
  echo Podrobneji v deploy\README.md
  echo ----------------------------------------------------------
  echo Sprava sluzby ^(spustit jako spravce^):
  echo   Zastavit:  deploy\STOP.bat
  echo   Spustit:   deploy\START.bat
  echo   Odebrat:   deploy\UNINSTALL.bat
  echo.
  echo Server nabehne sam po restartu pocitace.
  echo Log najdes v souboru server.log ve slozce aplikace.
  echo ----------------------------------------------------------
)

cls
echo ==========================================================
echo   HOTOVO - server bezi
echo ==========================================================
echo.
echo   Z TOHOTO pocitace:      http://localhost:5000
echo   Z jineho v domaci siti: http://%LANIP%:5000
echo.
echo   Vsechny adresy:%ALLIPS%
echo   ^(nefunguje-li prvni, zkus dalsi^)
echo.
echo   Prihlaseni: admin / 8312172165
echo.
echo   Server se sam spusti i po restartu pocitace.
echo   Tyhle udaje jsou i v souboru PRIPOJENI.txt
echo.
echo ==========================================================
echo.
pause
