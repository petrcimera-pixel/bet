@echo off
chcp 65001 >nul
REM Spousti server tak, aby byl videt i z jinych pocitacu v domaci siti.
REM HOST=0.0.0.0 = naslouchej na vsech sitovych rozhranich (ne jen localhost).
set "APPDIR=%~dp0.."
pushd "%APPDIR%"
set HOST=0.0.0.0
set PORT=5000
set PYTHONUNBUFFERED=1
REM Volitelne prepnuti na produkcni WSGI server waitress. Vyzaduje, aby
REM byl waitress nainstalovany ve .venv (requirements.txt uz ho ma).
REM Zapina se rozkomentovanim radku:
REM set USE_WAITRESS=1
if exist "%CD%\.venv\Scripts\python.exe" (
  "%CD%\.venv\Scripts\python.exe" -X utf8 app.py >> server.log 2>&1
) else (
  python -X utf8 app.py >> server.log 2>&1
)
popd
