@echo off
setlocal
cd /d "%~dp0"

set PORT=8078
set VENV_DIR=venv

where python >nul 2>nul
if errorlevel 1 (
  echo Python non trovato. Installa Python 3 da https://www.python.org/downloads/ e riprova.
  pause
  exit /b 1
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo Creo l'ambiente virtuale Python in .\%VENV_DIR% ...
  python -m venv "%VENV_DIR%"
)

call "%VENV_DIR%\Scripts\activate.bat"
pip install --quiet --disable-pip-version-check -r requirements.txt

echo Avvio server su http://localhost:%PORT% ...
start "Analyzer Server" /min cmd /c "call "%VENV_DIR%\Scripts\activate.bat" && python server.py"

timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"

echo Server avviato in una finestra ridotta a icona chiamata "Analyzer Server".
echo Per fermarlo: doppio click su "Ferma Analyzer (Windows).bat"
pause
