@echo off
echo Chiudo il processo "Analyzer Server"...
taskkill /FI "WINDOWTITLE eq Analyzer Server*" /T /F >nul 2>nul
if errorlevel 1 (
  echo Nessuna finestra "Analyzer Server" trovata. Provo a liberare la porta 8078...
  for /f "tokens=5" %%p in ('netstat -aon ^| findstr :8078 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>nul
)
echo Fatto.
pause
