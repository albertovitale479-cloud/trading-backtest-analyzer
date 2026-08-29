#!/bin/bash
# Avvia l'Analyzer (trading manuale) su Mac: crea/usa un venv locale,
# installa le dipendenze Python al suo interno e apre il browser.
set -e
cd "$(dirname "$0")"

PORT=8078
VENV_DIR="venv"
PY=python3

if [ ! -d "$VENV_DIR" ]; then
  echo "Creo l'ambiente virtuale Python in ./$VENV_DIR ..."
  "$PY" -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install --quiet --disable-pip-version-check -r requirements.txt

echo "Avvio server su http://localhost:$PORT ..."
python server.py &
SERVER_PID=$!
echo $SERVER_PID > .server.pid

sleep 1.2
open "http://localhost:$PORT"

echo "Server avviato (PID $SERVER_PID). Per fermarlo: doppio click su 'Ferma Analyzer (Mac).command'"
echo "Questa finestra puoi ridurla a icona; chiudendola il server resta attivo."
wait $SERVER_PID
