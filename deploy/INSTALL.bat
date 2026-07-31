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
  echo [!] Instalace potrebuje prava spravce.
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
  echo [!] Python nenalezen.
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
    echo [!] Nepodarilo se vytvorit virtualni prostredi.
    pause
    exit /b 1
  )
)
set "PY=%APPDIR%\.venv\Scripts\python.exe"

echo [2/5] Instaluji zavislosti (muze trvat par minut)...
"%PY%" -m pip install --upgrade pip -q
"%PY%" -m pip install -r "%APPDIR%\requirements.txt" -q
if errorlevel 1 (
  echo [!] Instalace zavislosti selhala.
  pause
  exit /b 1
)

REM ---- firewall: pustit port 5000 v domaci siti ----
echo [3/5] Otviram port 5000 pro domaci sit...
netsh advfirewall firewall delete rule name="KurzAnalytik" >nul 2>&1
netsh advfirewall firewall add rule name="KurzAnalytik" dir=in action=allow ^
  protocol=TCP localport=5000 profile=private,domain >nul
if errorlevel 1 (
  echo     [!] Pravidlo firewallu se nepodarilo pridat - server pujde
  echo         jen z tohoto pocitace. Muzes ho pridat rucne pozdeji.
) else (
  echo     Hotovo (jen privatni/domenova sit, ne verejna).
)

REM ---- sluzba pres Planovac uloh: nabehne po restartu i bez prihlaseni ----
echo [4/5] Registruji sluzbu (nabehne po restartu PC)...
schtasks /Delete /TN "KurzAnalytik" /F >nul 2>&1
schtasks /Create /TN "KurzAnalytik" /SC ONSTART /RU "SYSTEM" /RL HIGHEST /F ^
  /TR "\"%APPDIR%\deploy\run_server.bat\"" >nul
if errorlevel 1 (
  echo     [!] Registrace ulohy selhala.
  pause
  exit /b 1
)
echo     Hotovo - uloha "KurzAnalytik" spusti server pri startu Windows.

REM ---- prvni spusteni ----
echo [5/5] Spoustim server...
schtasks /Run /TN "KurzAnalytik" >nul 2>&1
timeout /t 6 /nobreak >nul

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
