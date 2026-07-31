@echo off
chcp 65001 >nul
title KurzAnalytik - povoleni vzdalene spravy (SSH)

REM ==========================================================
REM  Zapne na tomhle pocitaci OpenSSH server, aby se na nej
REM  dalo pripojit z vyvojoveho PC a upravovat aplikaci na
REM  dalku - bez chozeni k serveru.
REM
REM  Prihlaseni je JEN pres klic, heslem se prihlasit neda.
REM  Pravidlo firewallu plati jen pro soukromou sit, ne verejnou
REM  a uz vubec ne z internetu.
REM ==========================================================

net session >nul 2>&1
if errorlevel 1 (
  echo [!] Potrebuje prava spravce.
  echo     Klikni pravym tlacitkem - "Spustit jako spravce".
  pause
  exit /b 1
)

REM Verejny klic vyvojoveho PC. Privatni protejsek zustava tam,
REM po siti se nikdy neposila.
set "PUBKEY=ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPYvukEtdShe68t0hla4rwv9MGP3Q9+WWaqlHJIPnVUX kurzanalytik-dev-pc"

echo [1/4] Instaluji OpenSSH Server...
powershell -NoProfile -Command "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null"
if errorlevel 1 (
  echo     [!] Instalace selhala. Zkus rucne: Nastaveni - Aplikace -
  echo         Volitelne funkce - Pridat funkci - OpenSSH Server.
  pause
  exit /b 1
)

echo [2/4] Spoustim sluzbu a nastavuji automaticky start...
powershell -NoProfile -Command "Set-Service -Name sshd -StartupType Automatic; Start-Service sshd" >nul 2>&1

echo [3/4] Ukladam verejny klic...
set "AK=%ProgramData%\ssh\administrators_authorized_keys"
findstr /c:"kurzanalytik-dev-pc" "%AK%" >nul 2>&1
if errorlevel 1 (
  echo %PUBKEY%>> "%AK%"
)
REM Windows klic ignoruje, kdyz k souboru muze kdokoliv
icacls "%AK%" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" >nul

echo     Vypinam prihlaseni heslem (jen klic)...
powershell -NoProfile -Command ^
  "$f = \"$env:ProgramData\ssh\sshd_config\"; $t = Get-Content $f; $t = $t -replace '^#?\s*PasswordAuthentication.*', 'PasswordAuthentication no'; if ($t -notmatch '^PasswordAuthentication no') { $t += 'PasswordAuthentication no' }; Set-Content $f $t" >nul 2>&1

echo [4/4] Otviram port 22 jen pro domaci sit...
netsh advfirewall firewall delete rule name="KurzAnalytik SSH" >nul 2>&1
netsh advfirewall firewall add rule name="KurzAnalytik SSH" dir=in action=allow ^
  protocol=TCP localport=22 profile=private,domain >nul

powershell -NoProfile -Command "Restart-Service sshd" >nul 2>&1

for /f %%i in ('powershell -NoProfile -Command ^
  "(Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -like '192.168.*' } ^| Select-Object -First 1).IPAddress"') do set "LANIP=%%i"

cls
echo ==========================================================
echo   HOTOVO - vzdalena sprava je povolena
echo ==========================================================
echo.
echo   Adresa serveru: %LANIP%
echo   Uzivatel:       %USERNAME%
echo.
echo   Prihlasit se lze jen klicem z vyvojoveho PC.
echo   Heslem se prihlasit NEJDE a z internetu se sem nikdo
echo   nedostane - pravidlo plati jen pro domaci sit.
echo.
echo   Vypnout zpet:  services.msc - sluzba "OpenSSH SSH Server"
echo                  - Zastavit + typ spusteni Zakazano
echo.
echo ==========================================================
pause
