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
CREATE TABLE IF NOT EXISTS hour_import (
    ts       INTEGER PRIMARY KEY,  -- begin van het uur (UTC), uit Home Assistant
    pv       REAL,                 -- kWh in dat uur
    load     REAL,
    import   REAL,
    export   REAL,
    batt_in  REAL,
    batt_out REAL,
    soc      REAL                  -- gemiddelde laadtoestand in procent
);
CREATE TABLE IF NOT EXISTS price (
    ts      INTEGER PRIMARY KEY,  -- begin van het uur, epoch-seconden (UTC)
    epex    REAL,                 -- beursprijs in euro per kWh, excl. btw
    source  TEXT,
    fetched INTEGER
);
"""


WM = 60000  # kWh naar wattminuut (de eenheid van hourly())


def hour_from_kwh(pv, load, imp, exp, b_in, b_out):
    """Een uur uit Home Assistant in dezelfde vorm als een uur uit eigen metingen.
    Binnen het uur is niet te zien wat gelijktijdig liep; we nemen aan dat zon eerst
    naar het huis gaat, dan de batterij het huis aanvult, en zonoverschot de batterij laadt."""
    pv, load, imp, exp, b_in, b_out = (x or 0.0 for x in (pv, load, imp, exp, b_in, b_out))
    pv_house = min(pv, load)
    batt_house = min(b_out, max(load - pv_house, 0.0))
    batt_in_pv = min(b_in, max(pv - pv_house, 0.0))
    return {
        "load": load * WM, "pv": pv * WM, "import": imp * WM, "export": exp * WM,
        "batt_out": b_out * WM, "batt_in": b_in * WM,
        "pv_house": pv_house * WM, "batt_house": batt_house * WM, "batt_in_pv": batt_in_pv * WM,
        "minutes": 60,
    }


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
            imp = self._db.execute(
                "SELECT ts, pv, load, import, export, batt_in, batt_out FROM hour_import WHERE ts >= ? AND ts < ?",
                (start, end),
            ).fetchall()
        out = {r[0]: dict(zip(keys, r[1:])) for r in rows}
        # Uren uit Home Assistant gebruiken waar de app zelf (bijna) niets mat
        for ts, pv, load, imp_, exp, b_in, b_out in imp:
            eigen = out.get(ts)
            if eigen and (eigen["minutes"] or 0) >= 55:
                continue
            out[ts] = hour_from_kwh(pv, load, imp_, exp, b_in, b_out)
        return dict(sorted(out.items()))

    def quarterly(self, start, end):
        """Energie per kwartier in kWh: wat binnenkwam (zon, batterij, net) en waar het heen ging.
        Uren waarvoor alleen Home Assistant-gegevens zijn, worden gelijk over vier kwartieren verdeeld."""
        sql = """
            SELECT ts - (ts % 900) AS q,
                   SUM(pv), SUM(load), SUM(MAX(grid, 0)), SUM(MAX(-grid, 0)),
                   SUM(MAX(batt, 0)), SUM(MAX(-batt, 0)), COUNT(*)
            FROM minute WHERE ts >= ? AND ts < ?
            GROUP BY q ORDER BY q
        """
        with self._lock:
            rows = self._db.execute(sql, (start, end)).fetchall()
            imp = self._db.execute(
                "SELECT ts, pv, load, import, export, batt_in, batt_out FROM hour_import WHERE ts >= ? AND ts < ?",
                (start, end),
            ).fetchall()
        out, per_uur = {}, {}
        for q, pv, load, imp_, exp, b_out, b_in, n in rows:
            out[q] = {"zon": (pv or 0) / WM, "huis": (load or 0) / WM, "net": (imp_ or 0) / WM, "terug": (exp or 0) / WM,
                      "bat_uit": (b_out or 0) / WM, "bat_in": (b_in or 0) / WM, "uur": False}
            per_uur[q - q % 3600] = per_uur.get(q - q % 3600, 0) + n
        for ts, pv, load, imp_, exp, b_in, b_out in imp:
            if per_uur.get(ts, 0) >= 55:
                continue
            for i in range(4):
                out[ts + i * 900] = {"zon": (pv or 0) / 4, "huis": (load or 0) / 4, "net": (imp_ or 0) / 4, "terug": (exp or 0) / 4,
                                     "bat_uit": (b_out or 0) / 4, "bat_in": (b_in or 0) / 4, "uur": True}
        return out

    def write_import(self, rows):
        with self._lock:
            self._db.executemany(
                "INSERT OR REPLACE INTO hour_import (ts, pv, load, import, export, batt_in, batt_out, soc) VALUES (?,?,?,?,?,?,?,?)",
                rows,
            )
            self._db.commit()

    def import_range(self):
        with self._lock:
            r = self._db.execute("SELECT MIN(ts), MAX(ts), COUNT(*) FROM hour_import").fetchone()
        return (r[0], r[1], r[2] or 0) if r else (None, None, 0)

    def soc_series(self, start, end, step=600):
        with self._lock:
            cur = self._db.execute(
                "SELECT ts - (ts % ?) AS t, AVG(soc) FROM minute WHERE ts >= ? AND ts < ? AND soc IS NOT NULL GROUP BY t ORDER BY t",
                (step, start, end),
            )
            eigen = [(r[0], r[1]) for r in cur.fetchall()]
            uren = self._db.execute(
                "SELECT ts, soc FROM hour_import WHERE ts >= ? AND ts < ? AND soc IS NOT NULL ORDER BY ts", (start, end)
            ).fetchall()
        gemeten = {t - t % 3600 for t, _ in eigen}
        extra = [(ts + 1800, v) for ts, v in uren if ts not in gemeten]  # midden van het uur
        return sorted(eigen + extra)

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
            if a is None:
                a = self._db.execute(
                    "SELECT soc FROM hour_import WHERE ts >= ? AND ts < ? AND soc IS NOT NULL ORDER BY ts LIMIT 1", (start, end)
                ).fetchone()
                b = self._db.execute(
                    "SELECT soc FROM hour_import WHERE ts >= ? AND ts < ? AND soc IS NOT NULL ORDER BY ts DESC LIMIT 1", (start, end)
                ).fetchone()
        return (a[0] if a else None), (b[0] if b else None)

    def first_ts(self):
        with self._lock:
            r = self._db.execute("SELECT MIN(ts) FROM minute").fetchone()
            h = self._db.execute("SELECT MIN(ts) FROM hour_import").fetchone()
        firsts = [x[0] for x in (r, h) if x and x[0] is not None]
        return min(firsts) if firsts else None
