"""Ophalen van EPEX day-ahead-prijzen per uur via EnergyZero."""

import datetime as dt
import json
import logging
import math
import threading
import time
import urllib.request

from timeutil import TZ, day_bounds

log = logging.getLogger("prijzen")

URL = (
    "https://api.energyzero.nl/v1/energyprices"
    "?fromDate={start}&tillDate={end}&interval=4&usageType=1&inclBtw=false"
)


def _iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def fetch_energyzero(day):
    """Geeft [(uur-epoch, prijs excl. btw)] voor een lokale dag."""
    start, end = day_bounds(day)
    url = URL.format(start=_iso(start), end=_iso(end - 1))
    req = urllib.request.Request(url, headers={"User-Agent": "veerman-enphase/0.1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        js = json.loads(r.read())
    out = []
    for p in js.get("Prices", []):
        when = p.get("readingDate")
        price = p.get("price")
        if when is None or price is None:
            continue
        ts = int(dt.datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp())
        if start <= ts < end:
            out.append((ts, float(price)))
    return out


def demo_prices(day):
    start, end = day_bounds(day)
    out = []
    for ts in range(start, end, 3600):
        h = dt.datetime.fromtimestamp(ts, TZ).hour
        p = 0.19 + 0.05 * math.sin((h - 11) / 24 * 2 * math.pi) ** 2 + (0.06 if 17 <= h < 20 else 0) - (0.04 if 2 <= h < 5 else 0)
        out.append((ts, round(p, 4)))
    return out


class PriceService(threading.Thread):
    """Houdt de prijzen van vandaag en (vanaf 13:00) morgen bij."""

    def __init__(self, store, demo=False):
        super().__init__(daemon=True, name="prijzen")
        self.store = store
        self.demo = demo
        self.last_error = None
        self.last_fetch = None

    def complete(self, day):
        start, end = day_bounds(day)
        return len(self.store.prices(start, end)) >= (end - start) // 3600

    def ensure(self, day):
        if self.complete(day):
            return True
        try:
            items = fetch_energyzero(day)
            source = "EnergyZero"
        except Exception as e:
            if not self.demo:
                self.last_error = f"{day}: {e}"
                log.warning("prijzen voor %s niet opgehaald: %s", day, e)
                return False
            items, source = demo_prices(day), "demo"
        if items:
            self.store.set_prices(items, source, int(time.time()))
            self.last_fetch = time.time()
            self.last_error = None
            log.info("%d prijzen opgeslagen voor %s (%s)", len(items), day, source)
        return self.complete(day)

    def run(self):
        while True:
            now = dt.datetime.now(TZ)
            ok = self.ensure(now.date())
            if now.hour >= 13:
                ok = self.ensure(now.date() + dt.timedelta(days=1)) and ok
            time.sleep(900 if ok else 300)
