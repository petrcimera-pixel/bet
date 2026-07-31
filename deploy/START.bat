@echo off
chcp 65001 >nul
net session >nul 2>&1 || (echo Spust jako spravce. & pause & exit /b 1)
schtasks /Run /TN "KurzAnalytik" >nul 2>&1
if errorlevel 1 (echo [!] Sluzba nenalezena - spust nejdriv INSTALL.bat) else (echo Server spusten.)
timeout /t 3 /nobreak >nul
pause
