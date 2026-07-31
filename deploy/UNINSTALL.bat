@echo off
chcp 65001 >nul
net session >nul 2>&1 || (echo Spust jako spravce. & pause & exit /b 1)
echo Odebiram sluzbu a pravidlo firewallu...
schtasks /End /TN "KurzAnalytik" >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":5000 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
schtasks /Delete /TN "KurzAnalytik" /F >nul 2>&1
netsh advfirewall firewall delete rule name="KurzAnalytik" >nul 2>&1
netsh advfirewall firewall delete rule name="KurzAnalytik ping" >nul 2>&1
echo Hotovo. Data a slozka aplikace zustavaji nedotcene.
pause
