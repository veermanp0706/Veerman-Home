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

    def hourly(self, start, end):
        """Energie per uur in wattminuut, uitgesplitst naar herkomst en bestemming."""
        sql = """
            SELECT ts - (ts % 3600) AS h,
                   SUM(load), SUM(pv),
                   SUM(MAX(grid, 0)), SUM(MAX(-grid, 0)),
                   SUM(MAX(batt, 0)), SUM(MAX(-batt, 0)),
                   SUM(MIN(pv, load)),
                   SUM(MIN(MAX(batt, 0), MAX(load - MIN(pv, load), 0))),
                   SUM(MIN(MAX(-batt, 0), MAX(pv - load, 0))),
                   COUNT(*)
            FROM minute WHERE ts >= ? AND ts < ?
            GROUP BY h ORDER BY h
        """
        keys = ("load", "pv", "import", "export", "batt_out", "batt_in", "pv_house", "batt_house", "batt_in_pv", "minutes")
        with self._lock:
            rows = self._db.execute(sql, (start, end)).fetchall()
        return {r[0]: dict(zip(keys, r[1:])) for r in rows}

    def soc_series(self, start, end, step=600):
        with self._lock:
            cur = self._db.execute(
                "SELECT ts - (ts % ?) AS t, AVG(soc) FROM minute WHERE ts >= ? AND ts < ? AND soc IS NOT NULL GROUP BY t ORDER BY t",
                (step, start, end),
            )
            return [(r[0], r[1]) for r in cur.fetchall()]

    def first_soc_at_least(self, start, end, level):
        with self._lock:
            r = self._db.execute(
                "SELECT MIN(ts) FROM minute WHERE ts >= ? AND ts < ? AND soc >= ?", (start, end, level)
            ).fetchone()
            m = self._db.execute("SELECT MAX(soc) FROM minute WHERE ts >= ? AND ts < ?", (start, end)).fetchone()
        return (r[0] if r else None), (m[0] if m else None)

    def soc_edges(self, start, end):
        with self._lock:
            a = self._db.execute(
                "SELECT soc FROM minute WHERE ts >= ? AND ts < ? AND soc IS NOT NULL ORDER BY ts LIMIT 1", (start, end)
            ).fetchone()
            b = self._db.execute(
                "SELECT soc FROM minute WHERE ts >= ? AND ts < ? AND soc IS NOT NULL ORDER BY ts DESC LIMIT 1", (start, end)
            ).fetchone()
        return (a[0] if a else None), (b[0] if b else None)

    def first_ts(self):
        with self._lock:
            r = self._db.execute("SELECT MIN(ts) FROM minute").fetchone()
        return r[0] if r else None
