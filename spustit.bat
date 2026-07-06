@echo off
chcp 65001 >nul
echo ============================================
echo   KurzAnalytik - predikce fotbalovych zapasu
echo ============================================
echo.
echo Instaluji zavislosti (pri prvnim spusteni)...
python -m pip install --upgrade pip -q
python -m pip install Flask requests -q
echo.
echo Spoustim aplikaci... Otevre se v prohlizeci.
echo Pro ukonceni zavri toto okno nebo stiskni Ctrl+C.
echo.
python app.py
pause
