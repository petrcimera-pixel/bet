@echo off
chcp 65001 >nul
net session >nul 2>&1 || (echo Spust jako spravce. & pause & exit /b 1)
schtasks /End /TN "KurzAnalytik" >nul 2>&1
REM Naplanovana uloha nemusi potomka ukoncit - dorazime python drzici port 5000.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":5000 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo Server zastaven.
pause
