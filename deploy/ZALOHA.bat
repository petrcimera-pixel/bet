@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title KurzAnalytik - kompletni zaloha

echo ==========================================================
echo   KurzAnalytik - kompletni zaloha (kod + vsechna data)
echo ==========================================================
echo.
echo Zabali cely kod appky, historii v gitu i uplne vsechna data
echo (sazky, ratingy, kalibraci, natrenovany ML model, nastaveni...)
echo do jednoho ZIP souboru, ktery jde presunout na jiny pocitac.
echo.
echo Vynechava se jen ".venv" (nainstalovane knihovny - na novem
echo pocitaci se znovu vytvori pres INSTALL.bat) a docasna mezipamet
echo (__pycache__), ktera se sama dopocita.
echo.

set "APPDIR=%~dp0.."
pushd "%APPDIR%"
set "APPDIR=%CD%"
popd

REM ---- cilova slozka: 1. argument, jinak plocha uzivatele ----
set "CILOVA_SLOZKA=%~1"
if "%CILOVA_SLOZKA%"=="" set "CILOVA_SLOZKA=%USERPROFILE%\Desktop"
if not exist "%CILOVA_SLOZKA%" (
  echo [^!] Slozka "%CILOVA_SLOZKA%" neexistuje.
  pause
  exit /b 1
)

REM ---- casova znacka pres PowerShell, at nezavisi na lokalizaci "date /t" ----
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%i"
set "STAGING=%TEMP%\KurzAnalytik-zaloha-staging"
set "DEST=%CILOVA_SLOZKA%\KurzAnalytik-zaloha-%STAMP%.zip"

echo Slozka aplikace: %APPDIR%
echo Cil zalohy:      %DEST%
echo.

echo [1/3] Pripravuji docasnou kopii (bez .venv a mezipameti)...
if exist "%STAGING%" rmdir /s /q "%STAGING%"
robocopy "%APPDIR%" "%STAGING%" /E ^
  /XD ".venv" "__pycache__" ".claude" ^
  /XF "*.pyc" "KurzAnalytik-Setup.exe" ^
  /NFL /NDL /NJH /NJS /NP >nul

echo [2/3] Balim do ZIP (muze chvili trvat, data jsou v radu desitek MB)...
if exist "%DEST%" del /q "%DEST%"
REM POZOR: Compress-Archive -Path 'slozka\*' potichu preskoci skryte
REM polozky (.git ma atribut Hidden) - Get-ChildItem -Force pred rourou
REM je jediny spolehlivy zpusob, jak dostat .git (a tedy celou historii
REM zmen) do zalohy.
powershell -NoProfile -Command "Get-ChildItem -Path '%STAGING%' -Force | Compress-Archive -DestinationPath '%DEST%' -CompressionLevel Optimal -Force"
if errorlevel 1 (
  echo [^!] Balani selhalo.
  rmdir /s /q "%STAGING%" >nul 2>&1
  pause
  exit /b 1
)

echo [3/3] Uklizim docasnou kopii...
rmdir /s /q "%STAGING%"

for %%f in ("%DEST%") do set "VELIKOST=%%~zf"
set /a VELIKOST_MB=%VELIKOST%/1048576

echo.
echo ==========================================================
echo   Hotovo ^(~%VELIKOST_MB% MB^):
echo   %DEST%
echo ==========================================================
echo.
echo Presun ten ZIP soubor na novy pocitac (USB, cloud, sit...).
echo.
echo NA NOVEM POCITACI:
echo   1. Rozbal ZIP kamkoli (napr. C:\KurzAnalytik).
echo   2. Nainstaluj Python 3.10+ (zaskrtni "Add Python to PATH"),
echo      pokud tam jeste neni.
echo   3. Spust deploy\INSTALL.bat PRAVYM tlacitkem - "Spustit jako
echo      spravce". Vytvori si vlastni .venv, nastavi sit a naplanuje
echo      spusteni pri startu Windows. Vsechna data (sazky, ratingy,
echo      natrenovany model...) uz budou na miste, appka pojede presne
echo      tam, kde skoncila.
echo.
pause
