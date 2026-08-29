# Analyzer — Manual Trading Backtest Journal (Mac & Windows)

Applicazione web locale per il journaling e l'analisi statistica di backtest di trading
manuale/discrezionale: KPI quantitativi, simulazione Monte Carlo bootstrap, simulazione
parametrica di regole di prop firm, separazione In-Sample / Out-of-Sample. Gira su Mac e
Windows con Python — nessun account cloud, nessuna dipendenza esterna nel browser.

> ⚠️ **Nota**: questo repository non contiene dati di trading reali. Il database si crea
> vuoto al primo avvio; qualsiasi dato mostrato in screenshot o demo è fittizio.

## Stack tecnico

- **Backend**: Python 3 + [Flask](https://flask.palletsprojects.com/), API REST
- **Database**: SQLite (file locale, nessun server esterno)
- **Frontend**: HTML/CSS/JavaScript vanilla — nessun framework, grafici disegnati a mano
  su `<canvas>` (equity curve, drawdown, istogrammi, ventaglio Monte Carlo)

## Avvio

### Da riga di comando (sviluppo)

```bash
git clone <repo-url>
cd analyzer-trading-manuale
python3 -m venv venv
source venv/bin/activate      # su Windows: venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

Apri il browser su `http://localhost:8078`.

### Doppio click (Mac/Windows, senza terminale)

- **Mac**: `Avvia Analyzer (Mac).command` (la prima volta macOS potrebbe chiedere conferma
  in Impostazioni → Privacy e sicurezza — è normale per script scaricati).
- **Windows**: `Avvia Analyzer (Windows).bat`.

Al primo avvio lo script crea da solo un virtualenv nella cartella `venv/` e installa
l'unica dipendenza necessaria (Flask), **tutta dentro il progetto**. Per fermare il
server: `Ferma Analyzer (Mac).command` / `Ferma Analyzer (Windows).bat`.

## Come si usa

### 1 · Backtest
Crea un **Nuovo Backtest** (nome, tipo mercato CFD/Futures, size del conto). La size del
conto è quello che permette di convertire il **rischio %** che inserisci per ogni trade nel
suo equivalente in **dollari**, così puoi ragionare in percentuale ma vedere subito quanto
rischi in $.

L'inserimento trade è ottimizzato per la velocità: data, Long/Short a bottoni, fase
**In-Sample / Out-of-Sample**, schema (chip, configurabili in Impostazioni), rischio %,
risultato in **R multiplo** → il P&L in $ si calcola da solo. **Invio** salva e tiene il
focus pronto per il trade successivo, i campi restano com'erano per inserire più
operazioni di fila senza mouse.

### 2 · Analisi Dati
KPI quantitativi (net profit, profit factor, win rate, Sharpe/Sortino annualizzati, payoff
ratio, max drawdown, streak, concentrazione top percentile...), equity curve, drawdown,
distribuzione P&L, per giorno della settimana/mese, long vs short, breakdown per
schema/strumento.

Vista filtrabile **Tutti / Solo In-Sample / Solo Out-of-Sample**: con "Tutti" selezionato
l'equity curve resta un'unica linea continua (non riparte mai da zero), colorata a
segmenti — blu per l'In-Sample, arancione per l'Out-of-Sample dal punto esatto del
passaggio — con una linea verticale a marcare la separazione.

### 3 · Monte Carlo
Reshuffle (stessi trade, ordine diverso — rischio di sequenza) e Bootstrap con reimmissione
(varia anche il risultato finale — intervalli di confidenza). Per trade o per giornata,
grafico a ventaglio con bande di percentili (10°/25°/50°/75°/90°), tabella percentili di
drawdown/P&L, pannello Expected Value con intervallo di confidenza al 95% e probabilità di
risultato negativo.

### 4 · Prop Simulator
Simulazione parametrica configurabile (soglie di drawdown, giorni minimi di operatività,
daily loss limit, consistency rule) per stimare la probabilità di superare le regole di una
prop firm. Preset divisi in due sezioni:
- **Futures** (target/drawdown in $ fissi): Apex, Topstep, MyFundedFutures.
- **CFD** (target/drawdown in % sul conto, risolti automaticamente sulla size scelta):
  FTMO, The5ers, FundedNext, MyFundedFX, Funded Trading Plus.

I preset sono **indicativi** — vanno verificati con le regole ufficiali aggiornate della
prop. C'è anche una **Fase 2 — Conto Funded** per simulare la fase di payout dopo la
challenge, e uno sweep automatico della dimensione di posizione.

Sia in Monte Carlo che in Prop Simulator puoi selezionare più backtest insieme
(portafoglio), ognuno con il proprio moltiplicatore di rischio.

### 5 · Impostazioni
Gestisci i tuoi **schemi/setup** (nome + colore) e gli **strumenti** usati in modalità
multi-strumento: li usi nell'inserimento rapido e ti danno automaticamente il win
rate/profit factor per schema/strumento in Analisi Dati.

## Note

- I dati sono salvati in `data/analyzer.db` (SQLite), creato vuoto al primo avvio e
  ignorato da Git — fai un backup di questo file se vuoi conservare uno storico.
- Porta di default 8078, configurabile con la variabile d'ambiente `ANALYZER_PORT`.
