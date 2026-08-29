#!/usr/bin/env python3
"""
Analyzer Mac e Windows — backend locale per il journal/backtest manuale.
Server Flask minimale: API REST su SQLite + file statici in public/.
Porta di default: 8078 (diversa dal vecchio Analyzer NinjaTrader, porta 8077).
"""
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "analyzer.db"
PUBLIC_DIR = BASE_DIR / "public"
PORT = int(os.environ.get("ANALYZER_PORT", "8078"))

DATA_DIR.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=None)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(str(DB_PATH))
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        # Difensivo: se il file .db è stato cancellato/svuotato mentre il
        # server era acceso, ricrea subito lo schema invece di rompersi.
        g.db.executescript(SCHEMA)
        run_migrations(g.db)
        seed_default_instruments(g.db)
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS backtests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    market_type TEXT NOT NULL DEFAULT 'futures',
    account_size REAL NOT NULL DEFAULT 0,
    instrument TEXT DEFAULT '',
    instrument_mode TEXT NOT NULL DEFAULT 'fixed',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schemas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#3987e5',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    commission_per_lot REAL DEFAULT 0,
    pip_value_per_lot REAL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backtest_id INTEGER NOT NULL REFERENCES backtests(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'long',
    schema_id INTEGER REFERENCES schemas(id) ON DELETE SET NULL,
    instrument_id INTEGER REFERENCES instruments(id) ON DELETE SET NULL,
    risk_percent REAL DEFAULT 0,
    risk_amount REAL DEFAULT 0,
    r_multiple REAL DEFAULT 0,
    sample_type TEXT NOT NULL DEFAULT 'is',
    pips_sl REAL DEFAULT 0,
    pips_tp REAL DEFAULT 0,
    lots REAL DEFAULT 0,
    pnl_gross REAL DEFAULT 0,
    pnl REAL NOT NULL DEFAULT 0,
    commission REAL DEFAULT 0,
    use_partials INTEGER NOT NULL DEFAULT 0,
    partials TEXT NOT NULL DEFAULT '[]',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

# Migrazioni leggere per DB creati con uno schema precedente (ALTER TABLE
# ADD COLUMN non è coperto da CREATE TABLE IF NOT EXISTS).
MIGRATIONS = [
    ("backtests", "instrument_mode", "ALTER TABLE backtests ADD COLUMN instrument_mode TEXT NOT NULL DEFAULT 'fixed'"),
    ("trades", "instrument_id", "ALTER TABLE trades ADD COLUMN instrument_id INTEGER REFERENCES instruments(id) ON DELETE SET NULL"),
    ("instruments", "commission_per_lot", "ALTER TABLE instruments ADD COLUMN commission_per_lot REAL DEFAULT 0"),
    ("instruments", "pip_value_per_lot", "ALTER TABLE instruments ADD COLUMN pip_value_per_lot REAL DEFAULT 0"),
    ("trades", "pips_sl", "ALTER TABLE trades ADD COLUMN pips_sl REAL DEFAULT 0"),
    ("trades", "pips_tp", "ALTER TABLE trades ADD COLUMN pips_tp REAL DEFAULT 0"),
    ("trades", "lots", "ALTER TABLE trades ADD COLUMN lots REAL DEFAULT 0"),
    ("trades", "pnl_gross", "ALTER TABLE trades ADD COLUMN pnl_gross REAL DEFAULT 0"),
    ("trades", "sample_type", "ALTER TABLE trades ADD COLUMN sample_type TEXT NOT NULL DEFAULT 'is'"),
    ("trades", "use_partials", "ALTER TABLE trades ADD COLUMN use_partials INTEGER NOT NULL DEFAULT 0"),
    ("trades", "partials", "ALTER TABLE trades ADD COLUMN partials TEXT NOT NULL DEFAULT '[]'"),
]

# Strumenti CFD pre-configurati al primo avvio (valore pip indicativo —
# l'utente lo corregge in Impostazioni per farlo combaciare col proprio
# broker; le commissioni non sono gestite qui, l'utente le tratta a parte).
DEFAULT_INSTRUMENTS = [
    {"name": "EURUSD", "pip_value_per_lot": 10},
    {"name": "GBPUSD", "pip_value_per_lot": 10},
    {"name": "USDCAD", "pip_value_per_lot": 7.5},
    {"name": "EURGBP", "pip_value_per_lot": 12.5},
    {"name": "GBPCAD", "pip_value_per_lot": 7.5},
    {"name": "EURCAD", "pip_value_per_lot": 7.5},
    {"name": "XAUUSD", "pip_value_per_lot": 1},
    {"name": "US500", "pip_value_per_lot": 1},
    {"name": "UK100", "pip_value_per_lot": 1},
]


def seed_default_instruments(db):
    n = db.execute("SELECT COUNT(*) AS n FROM instruments").fetchone()["n"]
    if n > 0:
        return
    for ins in DEFAULT_INSTRUMENTS:
        db.execute(
            "INSERT INTO instruments (name, pip_value_per_lot, created_at) VALUES (?,?,?)",
            (ins["name"], ins["pip_value_per_lot"], now_iso()),
        )
    db.commit()


def run_migrations(db):
    for table, column, ddl in MIGRATIONS:
        cols = [r["name"] for r in db.execute(f"PRAGMA table_info({table})").fetchall()]
        if column not in cols:
            db.execute(ddl)
    db.commit()


def init_db():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    run_migrations(db)
    seed_default_instruments(db)
    db.commit()
    db.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def trade_row_to_dict(row):
    d = row_to_dict(row)
    try:
        d["partials"] = json.loads(d.get("partials") or "[]")
    except (TypeError, ValueError):
        d["partials"] = []
    d["use_partials"] = bool(d.get("use_partials"))
    return d


# ---------------------------------------------------------------------------
# Backtests
# ---------------------------------------------------------------------------

@app.get("/api/backtests")
def list_backtests():
    db = get_db()
    rows = db.execute(
        """SELECT b.*,
                  (SELECT COUNT(*) FROM trades t WHERE t.backtest_id = b.id) AS trade_count,
                  (SELECT COALESCE(SUM(pnl),0) FROM trades t WHERE t.backtest_id = b.id) AS net_pnl
           FROM backtests b ORDER BY b.created_at DESC"""
    ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/backtests")
def create_backtest():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name richiesto"}), 400
    db = get_db()
    try:
        cur = db.execute(
            """INSERT INTO backtests (name, market_type, account_size, instrument, instrument_mode, notes, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (
                name,
                data.get("market_type", "futures"),
                float(data.get("account_size") or 0),
                data.get("instrument", ""),
                data.get("instrument_mode", "fixed"),
                data.get("notes", ""),
                now_iso(),
            ),
        )
        db.commit()
    except sqlite3.Error as e:
        return jsonify({"error": str(e)}), 500
    row = db.execute("SELECT * FROM backtests WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.put("/api/backtests/<int:bid>")
def update_backtest(bid):
    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM backtests WHERE id=?", (bid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    fields = ["name", "market_type", "account_size", "instrument", "instrument_mode", "notes"]
    updated = {f: data.get(f, row[f]) for f in fields}
    db.execute(
        """UPDATE backtests SET name=?, market_type=?, account_size=?, instrument=?,
                                 instrument_mode=?, notes=? WHERE id=?""",
        (updated["name"], updated["market_type"], float(updated["account_size"] or 0),
         updated["instrument"], updated["instrument_mode"], updated["notes"], bid),
    )
    db.commit()
    row = db.execute("SELECT * FROM backtests WHERE id=?", (bid,)).fetchone()
    return jsonify(row_to_dict(row))


@app.delete("/api/backtests/<int:bid>")
def delete_backtest(bid):
    db = get_db()
    db.execute("DELETE FROM backtests WHERE id=?", (bid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Trades
# ---------------------------------------------------------------------------

@app.get("/api/backtests/<int:bid>/trades")
def list_trades(bid):
    db = get_db()
    rows = db.execute(
        "SELECT * FROM trades WHERE backtest_id=? ORDER BY date ASC, id ASC", (bid,)
    ).fetchall()
    return jsonify([trade_row_to_dict(r) for r in rows])


class TradeValidationError(ValueError):
    pass


def _compute_partials_r(partials_in):
    """Valida i parziali e calcola l'R multiplo complessivo come media
    pesata sulla % di posizione chiusa in ciascuno step, es.:
    50% a +1R, 25% a +2R, 25% a breakeven (0R) -> 0.5*1 + 0.25*2 + 0.25*0 = +1R.
    Questo è corretto perché il P&L totale è proporzionale alla somma di
    (dimensione_i * R_i), e l'R complessivo è quel totale diviso per la
    dimensione piena (100%), cioè esattamente la media pesata sulle %."""
    if not isinstance(partials_in, list) or not partials_in:
        raise TradeValidationError("Aggiungi almeno un parziale")
    cleaned = []
    total_pct = 0.0
    for i, p in enumerate(partials_in):
        if not isinstance(p, dict):
            raise TradeValidationError(f"Parziale {i+1} non valido")
        try:
            pct = float(p.get("pct"))
            r = float(p.get("r"))
        except (TypeError, ValueError):
            raise TradeValidationError(f"Parziale {i+1}: % e R devono essere numeri")
        if pct <= 0:
            raise TradeValidationError(f"Parziale {i+1}: la % deve essere maggiore di 0")
        total_pct += pct
        cleaned.append({"pct": pct, "r": r})
    if abs(total_pct - 100.0) > 0.01:
        raise TradeValidationError(
            f"La somma delle % dei parziali deve essere 100 (attuale: {total_pct:.2f})"
        )
    r_multiple = sum(p["pct"] / 100.0 * p["r"] for p in cleaned)
    return cleaned, r_multiple


def _trade_payload(data):
    use_partials = bool(data.get("use_partials"))
    partials = data.get("partials") or []
    if use_partials:
        partials, r_multiple = _compute_partials_r(partials)
    else:
        partials = []
        r_multiple = float(data.get("r_multiple") or 0)
    risk_amount = data.get("risk_amount")
    if risk_amount is None:
        risk_amount = 0
    risk_amount = float(risk_amount)
    commission = float(data.get("commission") or 0)
    pnl_gross = data.get("pnl_gross")
    if pnl_gross is None or pnl_gross == "" or use_partials:
        pnl_gross = risk_amount * r_multiple
    pnl_gross = float(pnl_gross)
    pnl = data.get("pnl")
    if pnl is None or pnl == "" or use_partials:
        pnl = pnl_gross - commission
    sample_type = data.get("sample_type") or "is"
    if sample_type not in ("is", "oos"):
        sample_type = "is"
    return {
        "date": data.get("date") or datetime.now().strftime("%Y-%m-%d"),
        "direction": data.get("direction", "long"),
        "schema_id": data.get("schema_id") or None,
        "instrument_id": data.get("instrument_id") or None,
        "risk_percent": float(data.get("risk_percent") or 0),
        "risk_amount": risk_amount,
        "r_multiple": r_multiple,
        "sample_type": sample_type,
        "pips_sl": float(data.get("pips_sl") or 0),
        "pips_tp": float(data.get("pips_tp") or 0),
        "lots": float(data.get("lots") or 0),
        "pnl_gross": pnl_gross,
        "pnl": float(pnl),
        "commission": commission,
        "use_partials": use_partials,
        "partials": partials,
        "notes": data.get("notes", ""),
    }


@app.post("/api/backtests/<int:bid>/trades")
def create_trade(bid):
    data = request.get_json(force=True) or {}
    try:
        p = _trade_payload(data)
    except TradeValidationError as e:
        return jsonify({"error": str(e)}), 400
    db = get_db()
    bt = db.execute("SELECT id FROM backtests WHERE id=?", (bid,)).fetchone()
    if not bt:
        return jsonify({"error": "backtest non trovato"}), 404
    cur = db.execute(
        """INSERT INTO trades (backtest_id, date, direction, schema_id, instrument_id,
                                risk_percent, risk_amount, r_multiple, sample_type, pips_sl, pips_tp, lots,
                                pnl_gross, pnl, commission, use_partials, partials, notes, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (bid, p["date"], p["direction"], p["schema_id"], p["instrument_id"], p["risk_percent"],
         p["risk_amount"], p["r_multiple"], p["sample_type"], p["pips_sl"], p["pips_tp"], p["lots"],
         p["pnl_gross"], p["pnl"], p["commission"], int(p["use_partials"]), json.dumps(p["partials"]),
         p["notes"], now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM trades WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(trade_row_to_dict(row)), 201


@app.put("/api/trades/<int:tid>")
def update_trade(tid):
    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM trades WHERE id=?", (tid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    merged = trade_row_to_dict(row)
    merged.update(data)
    try:
        p = _trade_payload(merged)
    except TradeValidationError as e:
        return jsonify({"error": str(e)}), 400
    db.execute(
        """UPDATE trades SET date=?, direction=?, schema_id=?, instrument_id=?, risk_percent=?,
                              risk_amount=?, r_multiple=?, sample_type=?, pips_sl=?, pips_tp=?, lots=?,
                              pnl_gross=?, pnl=?, commission=?, use_partials=?, partials=?, notes=? WHERE id=?""",
        (p["date"], p["direction"], p["schema_id"], p["instrument_id"], p["risk_percent"],
         p["risk_amount"], p["r_multiple"], p["sample_type"], p["pips_sl"], p["pips_tp"], p["lots"],
         p["pnl_gross"], p["pnl"], p["commission"], int(p["use_partials"]), json.dumps(p["partials"]),
         p["notes"], tid),
    )
    db.commit()
    row = db.execute("SELECT * FROM trades WHERE id=?", (tid,)).fetchone()
    return jsonify(trade_row_to_dict(row))


@app.delete("/api/trades/<int:tid>")
def delete_trade(tid):
    db = get_db()
    db.execute("DELETE FROM trades WHERE id=?", (tid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Schemi / Setup
# ---------------------------------------------------------------------------

@app.get("/api/schemas")
def list_schemas():
    db = get_db()
    rows = db.execute("SELECT * FROM schemas ORDER BY name ASC").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/schemas")
def create_schema():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name richiesto"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO schemas (name, color, created_at) VALUES (?,?,?)",
        (name, data.get("color", "#3987e5"), now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM schemas WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.put("/api/schemas/<int:sid>")
def update_schema(sid):
    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM schemas WHERE id=?", (sid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    db.execute(
        "UPDATE schemas SET name=?, color=? WHERE id=?",
        (data.get("name", row["name"]), data.get("color", row["color"]), sid),
    )
    db.commit()
    row = db.execute("SELECT * FROM schemas WHERE id=?", (sid,)).fetchone()
    return jsonify(row_to_dict(row))


@app.delete("/api/schemas/<int:sid>")
def delete_schema(sid):
    db = get_db()
    db.execute("DELETE FROM schemas WHERE id=?", (sid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Strumenti (per backtest multi-strumento)
# ---------------------------------------------------------------------------

@app.get("/api/instruments")
def list_instruments():
    db = get_db()
    rows = db.execute("SELECT * FROM instruments ORDER BY name ASC").fetchall()
    return jsonify([row_to_dict(r) for r in rows])


@app.post("/api/instruments")
def create_instrument():
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name richiesto"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO instruments (name, pip_value_per_lot, created_at) VALUES (?,?,?)",
        (name, float(data.get("pip_value_per_lot") or 0), now_iso()),
    )
    db.commit()
    row = db.execute("SELECT * FROM instruments WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.put("/api/instruments/<int:iid>")
def update_instrument(iid):
    data = request.get_json(force=True) or {}
    db = get_db()
    row = db.execute("SELECT * FROM instruments WHERE id=?", (iid,)).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    name = data.get("name", row["name"])
    pip_value = float(data.get("pip_value_per_lot", row["pip_value_per_lot"]) or 0)
    db.execute(
        "UPDATE instruments SET name=?, pip_value_per_lot=? WHERE id=?",
        (name, pip_value, iid),
    )
    db.commit()
    row = db.execute("SELECT * FROM instruments WHERE id=?", (iid,)).fetchone()
    return jsonify(row_to_dict(row))


@app.delete("/api/instruments/<int:iid>")
def delete_instrument(iid):
    db = get_db()
    db.execute("DELETE FROM instruments WHERE id=?", (iid,))
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Settings (key/value)
# ---------------------------------------------------------------------------

@app.get("/api/settings")
def get_settings():
    db = get_db()
    rows = db.execute("SELECT key, value FROM settings").fetchall()
    out = {}
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value"])
        except (TypeError, ValueError):
            out[r["key"]] = r["value"]
    return jsonify(out)


@app.post("/api/settings")
def set_settings():
    data = request.get_json(force=True) or {}
    db = get_db()
    for k, v in data.items():
        db.execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (k, json.dumps(v)),
        )
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Preset Prop Simulator (Futures + CFD) — valori indicativi, da verificare
# sempre con le regole ufficiali della prop scelta.
# ---------------------------------------------------------------------------

FUTURES_PRESETS = [
    {"id": "apex50", "name": "Apex 50K", "unit": "usd", "propType": "1phase", "account": 50000, "target": 3000,
     "dd": 2500, "ddMode": "trailing_intraday", "dll": 0, "ddStop": 100, "minDays": 1, "maxDays": 0,
     "consistency": 0, "fee": 167},
    {"id": "apex100", "name": "Apex 100K", "unit": "usd", "propType": "1phase", "account": 100000, "target": 6000,
     "dd": 3000, "ddMode": "trailing_intraday", "dll": 0, "ddStop": 100, "minDays": 1, "maxDays": 0,
     "consistency": 0, "fee": 207},
    {"id": "apex150", "name": "Apex 150K", "unit": "usd", "propType": "1phase", "account": 150000, "target": 9000,
     "dd": 5000, "ddMode": "trailing_intraday", "dll": 0, "ddStop": 100, "minDays": 1, "maxDays": 0,
     "consistency": 0, "fee": 297},
    {"id": "topstep50", "name": "Topstep 50K", "unit": "usd", "propType": "1phase", "account": 50000, "target": 3000,
     "dd": 2000, "ddMode": "trailing_eod", "dll": 1000, "ddStop": 0, "minDays": 2, "maxDays": 0,
     "consistency": 50, "fee": 49},
    {"id": "topstep100", "name": "Topstep 100K", "unit": "usd", "propType": "1phase", "account": 100000, "target": 6000,
     "dd": 3000, "ddMode": "trailing_eod", "dll": 2000, "ddStop": 0, "minDays": 2, "maxDays": 0,
     "consistency": 50, "fee": 99},
    {"id": "topstep150", "name": "Topstep 150K", "unit": "usd", "propType": "1phase", "account": 150000, "target": 9000,
     "dd": 4500, "ddMode": "trailing_eod", "dll": 3000, "ddStop": 0, "minDays": 2, "maxDays": 0,
     "consistency": 50, "fee": 149},
    {"id": "mfu50", "name": "MyFundedFutures 50K", "unit": "usd", "propType": "1phase", "account": 50000, "target": 4000,
     "dd": 2500, "ddMode": "trailing_eod", "dll": 0, "ddStop": 0, "minDays": 1, "maxDays": 0,
     "consistency": 40, "fee": 80},
]

# preset CFD: valori % sull'account_size del backtest, risolti a runtime nel
# frontend. Struttura a 2 fasi -> phase2* alimenta il blocco "Conto Funded".
CFD_PRESETS = [
    {"id": "ftmo", "name": "FTMO Challenge", "unit": "pct", "propType": "2phase", "targetPct": 10, "ddPct": 10,
     "ddMode": "static", "dllPct": 5, "minDays": 4, "maxDays": 30, "consistency": 0,
     "feePct": 1.0,
     "phase2": {"targetPct": 5, "ddPct": 10, "dllPct": 5, "minDays": 4, "maxDays": 60}},
    {"id": "the5ers", "name": "The5ers Bootcamp", "unit": "pct", "propType": "2phase", "targetPct": 8, "ddPct": 8,
     "ddMode": "static", "dllPct": 5, "minDays": 0, "maxDays": 0, "consistency": 0,
     "feePct": 0.6,
     "phase2": {"targetPct": 5, "ddPct": 8, "dllPct": 5, "minDays": 0, "maxDays": 0}},
    {"id": "fundednext", "name": "FundedNext Evaluation", "unit": "pct", "propType": "2phase", "targetPct": 8,
     "ddPct": 10, "ddMode": "static", "dllPct": 5, "minDays": 5, "maxDays": 0,
     "consistency": 0, "feePct": 0.5,
     "phase2": {"targetPct": 5, "ddPct": 10, "dllPct": 5, "minDays": 5, "maxDays": 0}},
    {"id": "myfundedfx", "name": "MyFundedFX", "unit": "pct", "propType": "2phase", "targetPct": 8, "ddPct": 12,
     "ddMode": "trailing_eod", "dllPct": 4, "minDays": 5, "maxDays": 0, "consistency": 0,
     "feePct": 0.5,
     "phase2": {"targetPct": 5, "ddPct": 12, "dllPct": 4, "minDays": 5, "maxDays": 0}},
    {"id": "ftplus", "name": "Funded Trading Plus", "unit": "pct", "propType": "2phase", "targetPct": 8, "ddPct": 10,
     "ddMode": "static", "dllPct": 5, "minDays": 3, "maxDays": 0, "consistency": 0,
     "feePct": 0.5,
     "phase2": {"targetPct": 5, "ddPct": 10, "dllPct": 5, "minDays": 3, "maxDays": 0}},
    {"id": "instant", "name": "Instant Funding (generico)", "unit": "pct", "propType": "instant",
     "targetPct": 0, "ddPct": 6, "ddMode": "trailing_eod", "dllPct": 3, "minDays": 0, "maxDays": 0,
     "consistency": 20, "feePct": 3.0, "phase2": None},
]


@app.get("/api/presets")
def get_presets():
    return jsonify({"futures": FUTURES_PRESETS, "cfd": CFD_PRESETS})


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(str(PUBLIC_DIR), "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(str(PUBLIC_DIR), path)


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "time": now_iso()})


if __name__ == "__main__":
    init_db()
    print(f"Analyzer Mac e Windows in ascolto su http://localhost:{PORT}")
    app.run(host="127.0.0.1", port=PORT, debug=False)
