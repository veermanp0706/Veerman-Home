"""Enphase energie-app: backend en webserver."""

import datetime as dt
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import calc
import ha_import
import history
import i18n
import system
from gateway import DemoGateway, Gateway
from prices import PriceService
from storage import Storage
from tariffs import Tariffs
from timeutil import TZ, hhmm, parse_day

VERSION = "0.5.1"
DATA_DIR = os.environ.get("DATA_DIR", "/data")
OPTIONS_PATH = os.environ.get("OPTIONS_PATH", os.path.join(DATA_DIR, "options.json"))
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
PORT = int(os.environ.get("PORT", "8099"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/i18n.js": ("i18n.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/manifest.json": ("manifest.json", "application/manifest+json"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
}


def load_options():
    try:
        with open(OPTIONS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        log.warning("geen instellingen gevonden op %s", OPTIONS_PATH)
        return {}


class Collector(threading.Thread):
    """Leest de gateway elke paar seconden en bewaart gemiddelden per minuut."""

    def __init__(self, gateway, store, interval):
        super().__init__(daemon=True, name="collector")
        self.gw = gateway
        self.store = store
        self.interval = max(2, int(interval))
        self.latest = None
        self.last_ok = 0.0
        self.last_error = None
        self._acc = None
        self._lock = threading.Lock()

    def run(self):
        while True:
            t0 = time.time()
            try:
                v = self.gw.read()
                v["ts"] = t0
                with self._lock:
                    self.latest = v
                    self.last_ok = t0
                    self.last_error = None
                    self._accumulate(v)
            except Exception as e:
                self.last_error = str(e)
                log.warning("gateway uitlezen mislukt: %s", e)
            time.sleep(max(0.5, self.interval - (time.time() - t0)))

    def _accumulate(self, v):
        minute = int(v["ts"] - v["ts"] % 60)
        if self._acc and self._acc["ts"] != minute:
            self._flush()
        if self._acc is None:
            self._acc = {"ts": minute, "n": 0, "pv": 0.0, "load": 0.0, "grid": 0.0, "batt": 0.0, "soc": None}
        a = self._acc
        a["n"] += 1
        for k in ("pv", "load", "grid", "batt"):
            a[k] += float(v.get(k) or 0)
        if v.get("soc") is not None:
            a["soc"] = v["soc"]

    def _flush(self):
        a, self._acc = self._acc, None
        n = a["n"]
        try:
            self.store.write_minute(a["ts"], a["pv"] / n, a["load"] / n, a["grid"] / n, a["batt"] / n, a["soc"], n)
        except Exception as e:
            log.error("minuut niet opgeslagen: %s", e)

    def partial(self):
        """De lopende minuut, als die nog niet is opgeslagen."""
        with self._lock:
            a = self._acc
            if not a or not a["n"]:
                return []
            n = a["n"]
            return [{"ts": a["ts"], "pv": a["pv"] / n, "load": a["load"] / n, "grid": a["grid"] / n, "batt": a["batt"] / n, "soc": a["soc"]}]


class App:
    def __init__(self):
        self.opts = load_options()
        self.demo = os.environ.get("DEMO") == "1" or bool(self.opts.get("demo"))
        self.tariffs = Tariffs(self.opts)
        self.capacity = float(self.opts.get("accu_kwh", 5.0)) or 5.0
        self.store_path = os.path.join(DATA_DIR, "energie.db")
        self.store = Storage(self.store_path)
        self.version = VERSION
        host = (self.opts.get("gateway_host") or "").strip()
        token = (self.opts.get("gateway_token") or "").strip()
        if self.demo:
            gw = DemoGateway()
            log.info("demomodus: geen echte gateway")
        elif host and token:
            gw = Gateway(host, token)
        else:
            gw = None
            log.error("vul gateway_host en gateway_token in bij de instellingen van de add-on")
        self.gateway = gw
        self.token = token
        self.collector = Collector(gw, self.store, self.opts.get("poll_interval", 5)) if gw else None
        self.prices = PriceService(self.store, demo=self.demo)
        self.system = system.SystemStatus(self)
        ha_token = os.environ.get("SUPERVISOR_TOKEN")
        self.importer = None
        if ha_token and not self.demo and self.opts.get("historie_uit_ha", True):
            self.importer = ha_import.Importer(self.store, self.prices, ha_token)

    def start(self):
        if self.collector:
            self.collector.start()
        self.prices.start()
        if self.importer:
            self.importer.start()

    # --- API ---------------------------------------------------------------

    def api_now(self):
        now = time.time()
        today = dt.datetime.now(TZ).date()
        hours = calc.price_day(self.store, self.tariffs, today)
        cur = calc.current_hour(now)
        price = next((h for h in hours if h["t"] == cur), None)
        tomorrow = calc.price_day(self.store, self.tariffs, today + dt.timedelta(days=1))
        nxt = calc.next_moment(price, [h for h in hours if h["t"] > cur], tomorrow)
        latest = self.collector.latest if self.collector else None
        last_ok = self.collector.last_ok if self.collector else 0
        partial = self.collector.partial() if self.collector else []
        return {
            "ok": latest is not None and now - last_ok < 60,
            "tijd": hhmm(last_ok) if last_ok else None,
            "fout": self.collector.last_error if self.collector else "gateway niet ingesteld",
            "vermogen": None if latest is None else {
                "zon": round(latest["pv"]), "huis": round(latest["load"]), "net": round(latest["grid"]),
                "batterij": round(latest["batt"]), "laadtoestand": latest.get("soc"), "bron": latest.get("source"),
            },
            "prijs": price,
            "volgende": nxt,
            "strip": [{"uur": h["uur"], "allin": h["allin"], "level": h["level"], "voorbij": h["t"] < cur, "nu": h["t"] == cur} for h in hours],
            "vandaag": calc.day_totals(self.store, self.tariffs, today, partial),
            "saldering": self.tariffs.saldering_actief(today),
            "interval": self.collector.interval if self.collector else 5,
        }

    def api_prices(self, day_value):
        day = parse_day(day_value)
        today = dt.datetime.now(TZ).date()
        hours = calc.price_day(self.store, self.tariffs, day)
        cur = calc.current_hour()
        now_hour = next((h for h in hours if h["t"] == cur), None)
        return {
            "dag": day.isoformat(),
            "is_vandaag": day == today,
            "uren": hours,
            "samenvatting": calc.summary(hours),
            "blokken": calc.blocks(hours, start_ts=cur if day == today else None),
            "nu": None if not now_hour else {
                "uur": now_hour["uur"], "tot": hhmm(now_hour["t"] + 3600),
                "opbouw": self.tariffs.breakdown(now_hour["epex"]), "terug": now_hour["terug"],
            },
            "saldering": self.tariffs.saldering_actief(day),
            "verwacht_rond": "13:00" if not hours and day > today else None,
        }

    def api_history(self, periode, day_value):
        return history.period(self.store, self.tariffs, periode or "dag", parse_day(day_value), self.capacity)

    def api_battery(self, day_value):
        return history.battery(self.store, self.tariffs, parse_day(day_value), self.capacity)

    def api_status(self):
        return {
            "versie": VERSION,
            "demo": self.demo,
            "gateway_ingesteld": self.collector is not None,
            "laatste_meting": self.collector.last_ok if self.collector else None,
            "gateway_fout": self.collector.last_error if self.collector else None,
            "prijzen_fout": self.prices.last_error,
        }


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "VeermanEnphase/" + VERSION

        def log_message(self, fmt, *args):
            pass

        def _send(self, status, body, ctype, cache="no-store"):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.end_headers()
            self.wfile.write(body)

        def _json(self, data, status=200):
            self._send(status, json.dumps(data, ensure_ascii=False).encode(), "application/json; charset=utf-8")

        def do_GET(self):
            url = urlparse(self.path)
            path = url.path
            q = parse_qs(url.query)
            taal = (q.get("taal") or ["nl"])[0]
            try:
                if path == "/api/now":
                    return self._json(app.api_now())
                if path == "/api/prices":
                    return self._json(app.api_prices((q.get("dag") or [None])[0]))
                if path == "/api/history":
                    return self._json(i18n.translate(app.api_history((q.get("periode") or ["dag"])[0], (q.get("datum") or [None])[0]), taal))
                if path == "/api/battery":
                    return self._json(i18n.translate(app.api_battery((q.get("datum") or [None])[0]), taal))
                if path == "/api/system":
                    return self._json(i18n.translate(app.system.get(force=(q.get("vernieuw") or ["0"])[0] == "1"), taal))
                if path == "/api/system/raw":
                    return self._json(app.system.raw())
                if path == "/api/status":
                    return self._json(app.api_status())
            except ValueError as e:
                return self._json({"fout": str(e)}, 400)
            except Exception as e:
                log.exception("fout bij %s", path)
                return self._json({"fout": str(e)}, 500)
            if path in STATIC:
                name, ctype = STATIC[path]
                with open(os.path.join(STATIC_DIR, name), "rb") as f:
                    return self._send(200, f.read(), ctype, cache="no-cache")
            self._json({"fout": "niet gevonden"}, 404)

    return Handler


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    app = App()
    app.start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), make_handler(app))
    log.info("Enphase energie-app %s luistert op poort %d", VERSION, PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
