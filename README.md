# Analyzer — Trading Manuale (Mac & Windows)

Journal/backtest manuale locale, pensato per chi fa trading a mano (non NinjaTrader).
Gira su Mac e Windows con Python (in un virtualenv dentro questa cartella) — nessun
account cloud, nessuna dipendenza esterna nel browser.

> Questo è un progetto **separato** dal vecchio Analyzer per NinjaTrader
> (`Desktop\Analyzer`), che resta invariato. Qui i dati si inseriscono a mano.

## Avvio

- **Mac**: doppio click su `Avvia Analyzer (Mac).command` (la prima volta macOS potrebbe
  chiedere conferma in Impostazioni → Privacy e sicurezza — è normale per script scaricati).
- **Windows**: doppio click su `Avvia Analyzer (Windows).bat`.

Al primo avvio viene creato un ambiente virtuale Python nella cartella `venv/` e vengono
installate le uniche dipendenze necessarie (Flask), **tutte dentro il progetto** — non
tocca l'installazione Python di sistema. Poi si apre il browser su `http://localhost:8078`.

Per fermare il server: `Ferma Analyzer (Mac).command` / `Ferma Analyzer (Windows).bat`.

## Come si usa

### 1 · Backtest
Crea un **Nuovo Backtest** (nome, tipo mercato CFD/Futures, size del conto). La size del
conto è quello che permette di convertire il **rischio %** che inserisci per ogni trade nel
suo equivalente in **dollari**, così puoi ragionare in percentuale ma vedere subito quanto
rischi in $.

L'inserimento trade è ottimizzato per la velocità: data, Long/Short a bottoni, schema
(chip, configurabili in Impostazioni), rischio %, risultato in **R multiplo** → il P&L in $
si calcola da solo. **Invio** salva e tiene il focus pronto per il trade successivo, i campi
data/direzione/schema restano com'erano per inserire più operazioni di fila senza mouse.

### 2 · Analisi Dati
KPI (net profit, profit factor, win rate, Sharpe/Sortino, drawdown, streak...), equity
curve, drawdown, distribuzione P&L, per giorno della settimana/mese, long vs short, il
grafico **Esito dei trade** (profitto, loss e breakeven) e un **breakdown per schema**
(win rate, profit factor, R medio per ogni setup che usi).

### 3 · Monte Carlo
Reshuffle (stessi trade, ordine diverso — rischio di sequenza) e Bootstrap con reimmissione
(varia anche il risultato finale — intervalli di confidenza). Per trade o per giornata,
grafico a ventaglio, tabella percentili di drawdown/P&L, pannello Expected Value.

### 4 · Prop Simulator
Preset divisi in due sezioni:
- **Futures** (target/drawdown in $ fissi): Apex, Topstep, MyFundedFutures.
- **CFD** (target/drawdown in % sul conto, risolti automaticamente sulla size scelta):
  FTMO, The5ers, FundedNext, MyFundedFX, Funded Trading Plus.

I preset sono **indicativi** — verifica sempre le regole ufficiali aggiornate della prop
che usi prima di fare scelte reali. C'è anche una **Fase 2 — Conto Funded** per simulare
la fase di payout dopo la challenge, e uno sweep automatico della dimensione di posizione.

Sia in Monte Carlo che in Prop Simulator puoi selezionare più backtest insieme
(portafoglio), ognuno con il proprio moltiplicatore di rischio.

### 5 · Impostazioni
Gestisci i tuoi **schemi/setup** (nome + colore): li usi nell'inserimento rapido e ti
danno automaticamente il win rate/profit factor per schema in Analisi Dati.

## Note

- Le commissioni non sono ancora gestite nei calcoli (funzionalità rimandata).
- I dati sono salvati in `data/analyzer.db` (SQLite) — fai un backup di questo file se vuoi
  conservare uno storico.
- Il database e tutti i dati personali sono esclusi dal repository GitHub tramite `.gitignore`.
  Chi scarica il progetto crea automaticamente il proprio `data/analyzer.db` al primo avvio:
  nessun backtest altrui viene distribuito o condiviso.
- Porta di default 8078 (diversa da quella del vecchio Analyzer, 8077): puoi tenerli aperti
  insieme. Per cambiarla, imposta la variabile d'ambiente `ANALYZER_PORT` prima di avviare.
