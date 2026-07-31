@echo off
chcp 65001 >nul
title KurzAnalytik - vyroba instalacniho balicku

REM ==========================================================
REM  Vyrobi samorozbalovaci EXE pomoci IExpress, ktery je
REM  soucasti Windows - neni potreba nic instalovat navic.
REM  Vysledek: KurzAnalytik-Setup.exe
REM
REM  Dve vlastnosti IExpressu, ktere nas stalo cas najit:
REM   1) prijme jen RELATIVNI cestu k .sed souboru; s absolutni
REM      skonci s errorlevel 1 a nic nevyrobi
REM   2) neumi zapsat vysledek do cesty s diakritikou, proto se
REM      EXE tvori v TEMP a teprve pak kopiruje k aplikaci
REM ==========================================================

set "APPDIR=%~dp0.."
pushd "%APPDIR%"
set "APPDIR=%CD%"
popd

set "OUT=%APPDIR%\KurzAnalytik-Setup.exe"
set "BUILD=%TEMP%\ka_build"
set "STAGE=%TEMP%\ka_stage"
set "TMPOUT=%BUILD%\KurzAnalytik-Setup.exe"

if exist "%BUILD%" rmdir /s /q "%BUILD%"
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%BUILD%"
mkdir "%STAGE%"

echo [1/4] Pripravuji obsah balicku...
robocopy "%APPDIR%" "%STAGE%" /E /XD ".venv" ".git" "__pycache__" /XF "*.pyc" "server.log" "KurzAnalytik-Setup.exe" "*.tmp" >nul
REM kese jsou zbytecne velke a stejne se stahnou znovu
del /q "%STAGE%\data\cache_*.json" 2>nul
del /q "%STAGE%\data\apif_*.json" 2>nul
del /q "%STAGE%\data\fd_*.json" 2>nul
REM klic k API-Football je osobni - do balicku nepatri
del /q "%STAGE%\data\config.json" 2>nul

echo [2/4] Balim...
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%BUILD%\kurzanalytik_pkg.zip' -Force"
if not exist "%BUILD%\kurzanalytik_pkg.zip" goto :err

echo [3/4] Pripravuji rozbalovaci skript...
> "%BUILD%\setup.bat" (
  echo @echo off
  echo chcp 65001 ^>nul
  echo title KurzAnalytik - rozbaleni
  echo set "DEST=%%ProgramData%%\KurzAnalytik"
  echo echo.
  echo echo Rozbaluji do %%DEST%% ...
  echo if not exist "%%DEST%%" mkdir "%%DEST%%"
  echo powershell -NoProfile -Command "Expand-Archive -Path '%%~dp0kurzanalytik_pkg.zip' -DestinationPath '%%DEST%%' -Force"
  echo if errorlevel 1 ^( echo [!] Rozbaleni selhalo. ^& pause ^& exit /b 1 ^)
  echo call "%%DEST%%\deploy\INSTALL.bat"
)

echo [4/4] Vytvarim SFX...
> "%BUILD%\ka.sed" (
  echo [Version]
  echo Class=IEXPRESS
  echo SEDVersion=3
  echo [Options]
  echo PackagePurpose=InstallApp
  echo ShowInstallProgramWindow=0
  echo HideExtractAnimation=1
  echo UseLongFileName=1
  echo InsideCompressed=0
  echo CAB_FixedSize=0
  echo CAB_ResvCodeSigning=0
  echo RebootMode=N
  echo InstallPrompt=%%InstallPrompt%%
  echo DisplayLicense=%%DisplayLicense%%
  echo FinishMessage=%%FinishMessage%%
  echo TargetName=%%TargetName%%
  echo FriendlyName=%%FriendlyName%%
  echo AppLaunched=%%AppLaunched%%
  echo PostInstallCmd=%%PostInstallCmd%%
  echo AdminQuietInstCmd=%%AdminQuietInstCmd%%
  echo UserQuietInstCmd=%%UserQuietInstCmd%%
  echo SourceFiles=SourceFiles
  echo [Strings]
  echo InstallPrompt=
  echo DisplayLicense=
  echo FinishMessage=
  echo TargetName=%TMPOUT%
  echo FriendlyName=KurzAnalytik - instalace serveru
  echo AppLaunched=cmd /c setup.bat
  echo PostInstallCmd=^<None^>
  echo AdminQuietInstCmd=
  echo UserQuietInstCmd=
  echo FILE0="kurzanalytik_pkg.zip"
  echo FILE1="setup.bat"
  echo [SourceFiles]
  echo SourceFiles0=%BUILD%\
  echo [SourceFiles0]
  echo %%FILE0%%=
  echo %%FILE1%%=
)

if exist "%OUT%" del /q "%OUT%"
cd /d "%BUILD%"
iexpress /N /Q ka.sed
cd /d "%APPDIR%"
if not exist "%TMPOUT%" goto :err
move /y "%TMPOUT%" "%OUT%" >nul
if not exist "%OUT%" goto :err

rmdir /s /q "%STAGE%" 2>nul
rmdir /s /q "%BUILD%" 2>nul

for %%f in ("%OUT%") do set SZ=%%~zf
set /a SZMB=%SZ%/1048576
cls
echo ==========================================================
echo   HOTOVO
echo ==========================================================
echo.
echo   Vytvoreno: KurzAnalytik-Setup.exe  (%SZMB% MB^)
echo   ve slozce: %APPDIR%
echo.
echo   Prenes tenhle jediny soubor na server, spust ho PRAVYM
echo   tlacitkem jako spravce - rozbali se do
echo   C:\ProgramData\KurzAnalytik a sam se nainstaluje.
echo.
echo ==========================================================
pause
exit /b 0

:err
echo.
echo [!] Vyroba balicku selhala.
echo     Zkontroluj obsah "%BUILD%" a ze mas prava zapisovat do "%APPDIR%".
pause
exit /b 1
