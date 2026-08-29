#!/bin/bash
cd "$(dirname "$0")"
if [ -f .server.pid ]; then
  PID=$(cat .server.pid)
  if kill "$PID" 2>/dev/null; then
    echo "Server (PID $PID) fermato."
  else
    echo "Il processo non era attivo."
  fi
  rm -f .server.pid
else
  echo "Nessun PID salvato, provo a chiudere per porta 8078..."
  PID=$(lsof -ti tcp:8078 || true)
  if [ -n "$PID" ]; then kill $PID && echo "Fermato (PID $PID)."; else echo "Nessun server in ascolto su 8078."; fi
fi
read -p "Premi Invio per chiudere..."
