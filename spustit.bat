@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
echo ============================================
echo   KurzAnalytik - predikce fotbalovych zapasu
echo ============================================
echo.
echo Instaluji zavislosti (pri prvnim spusteni)...
python -m pip install --upgrade pip -q
python -m pip install -r "%~dp0requirements.txt" -q
echo.

REM Naslouchame na vsech rozhranich, ne jen na localhostu - jinak by
REM aplikace bezela jen pro tenhle pocitac a z jineho by se na ni
REM nikdo nedostal, aniz by bylo z ceho poznat proc.
set HOST=0.0.0.0
set PORT=5000

REM adresa pro ostatni zarizeni v domaci siti
set "LANIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "CAND=%%a"
  set "CAND=!CAND: =!"
  echo !CAND! | findstr /r "^192\.168\." >nul
  if not errorlevel 1 if not defined LANIP set "LANIP=!CAND!"
)

echo Spoustim aplikaci... Otevre se v prohlizeci.
echo.
echo   Zde:            http://localhost:5000
if defined LANIP echo   Z jineho PC:    http://!LANIP!:5000
echo.
echo Pro ukonceni zavri toto okno nebo stiskni Ctrl+C.
echo.
echo POZOR: takhle bezi server jen dokud je otevrene tohle okno.
echo Aby nabihal sam po restartu PC, spust deploy\INSTALL.bat jako spravce.
echo.
set PYTHONUTF8=1
python -X utf8 "%~dp0app.py"
pause
