"""Opslag in SQLite: gemiddelden per minuut en prijzen per uur."""

import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS minute (
    ts   INTEGER PRIMARY KEY,  -- begin van de minuut, epoch-seconden (UTC)
    pv   REAL,                 -- gemiddeld vermogen in watt
    load REAL,
    grid REAL,                 -- positief = afname
    batt REAL,                 -- positief = ontladen
    soc  REAL,
    n    INTEGER               -- aantal metingen in de minuut
);
CREATE TABLE IF NOT EXISTS price (
    ts      INTEGER PRIMARY KEY,  -- begin van het uur, epoch-seconden (UTC)
    epex    REAL,                 -- beursprijs in euro per kWh, excl. btw
    source  TEXT,
    fetched INTEGER
);
"""


class Storage:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def write_minute(self, ts, pv, load, grid, batt, soc, n):
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO minute (ts, pv, load, grid, batt, soc, n) VALUES (?,?,?,?,?,?,?)",
                (ts, pv, load, grid, batt, soc, n),
            )
            self._db.commit()

    def minutes(self, start, end):
        with self._lock:
            cur = self._db.execute(
                "SELECT ts, pv, load, grid, batt, soc FROM minute WHERE ts >= ? AND ts < ? ORDER BY ts",
                (start, end),
            )
            return [
                {"ts": r[0], "pv": r[1], "load": r[2], "grid": r[3], "batt": r[4], "soc": r[5]}
                for r in cur.fetchall()
            ]

    def set_prices(self, items, source, fetched):
        with self._lock:
            self._db.executemany(
                "INSERT OR REPLACE INTO price (ts, epex, source, fetched) VALUES (?,?,?,?)",
                [(ts, epex, source, fetched) for ts, epex in items],
            )
            self._db.commit()

    def prices(self, start, end):
        with self._lock:
            cur = self._db.execute("SELECT ts, epex FROM price WHERE ts >= ? AND ts < ? ORDER BY ts", (start, end))
            return {r[0]: r[1] for r in cur.fetchall()}
