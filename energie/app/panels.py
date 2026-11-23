"""Opbrengst per zonnepaneel (per micro-omvormer) en records.

Bron 1: /ivp/pdm/device_data van de gateway. Die kent per omvormer de opbrengst van
vandaag, de totale opbrengst en de temperatuur.
Bron 2 (als bron 1 niet werkt): de app telt zelf op uit het vermogen dat elke
omvormer ongeveer elke 5 minuten meldt (/api/v1/production/inverters).
"""

import datetime as dt
import logging
import math
import threading
import time

from timeutil import TZ

log = logging.getLogger("panelen")

INTERVAL = 300  # elke 5 minuten
MAX_GAT = 900   # langer dan een kwartier geen melding: niet doortellen


def parse_device_data(data):
    """Haalt per omvormer de gegevens uit /ivp/pdm/device_data."""
    out = {}
    if not isinstance(data, dict):
        return out
    for v in data.values():
        if not isinstance(v, dict) or str(v.get("devName", "")).lower() != "pcu":
            continue
        sn = str(v.get("sn") or v.get("serialNumber") or "")
        ch = (v.get("channels") or [{}])[0] or {}
        wh = (ch.get("wattHours") or {}).get("today")
        joules = (ch.get("lifetime") or {}).get("joulesProduced")
        last = ch.get("lastReading") or {}
        if sn:
            out[sn] = {
                "vandaag_wh": float(wh) if isinstance(wh, (int, float)) else None,
                "totaal_wh": float(joules) / 3600 if isinstance(joules, (int, float)) else None,
                "temp": last.get("channelTemp") if isinstance(last.get("channelTemp"), (int, float)) else None,
            }
    return out


class PanelService(threading.Thread):
    def __init__(self, app):
        super().__init__(daemon=True, name="panelen")
        self.app = app
        self.store = app.store
        self.detail = {}        # serie -> gegevens uit device_data
        self.bron = None        # "gateway" of "eigen telling"
        self._vorige = {}       # serie -> (tijd van melding, watt)
        self._records = None
        self._records_t = 0
        self._lock = threading.Lock()

    def run(self):
        time.sleep(5)
        while True:
            try:
                self.once()
            except Exception as e:
                log.warning("paneelgegevens niet opgehaald: %s", e)
            time.sleep(INTERVAL)

    def once(self):
        gw = self.app.gateway
        if gw is None:
            return
        today = dt.datetime.now(TZ).date().isoformat()
        if self.app.demo:
            detail = demo_device_data()
        else:
            try:
                detail = parse_device_data(gw.get_json("/ivp/pdm/device_data"))
            except Exception as e:
                detail = {}
                if self.bron != "eigen telling":
                    log.info("per-paneelgegevens van de gateway niet beschikbaar (%s); de app telt zelf", e)
        rows = []
        if detail and any(d["vandaag_wh"] is not None for d in detail.values()):
            self.bron = "gateway"
            with self._lock:
                self.detail = detail
            rows = [(today, sn, d["vandaag_wh"], "gateway") for sn, d in detail.items() if d["vandaag_wh"] is not None]
        else:
            self.bron = "eigen telling"
            with self._lock:
                self.detail = detail
            rows = self._zelf_tellen(today)
        if rows:
            self.store.write_panel_days(rows)

    def _zelf_tellen(self, today):
        """Telt de opbrengst op uit de vermogens die de omvormers melden."""
        gw = self.app.gateway
        data = gw.get_json("/api/v1/production/inverters")
        rows = []
        bestaand = {sn: wh for sn, wh in self.store.panel_day(today)}
        for r in data or []:
            sn = str(r.get("serialNumber") or "")
            t, w = r.get("lastReportDate"), r.get("lastReportWatts")
            if not sn or not isinstance(t, (int, float)) or not isinstance(w, (int, float)):
                continue
            prev = self._vorige.get(sn)
            self._vorige[sn] = (t, w)
            if not prev or t <= prev[0]:
                continue
            if dt.datetime.fromtimestamp(t, TZ).date().isoformat() != today:
                continue
            gat = min(t - prev[0], MAX_GAT)
            wh = bestaand.get(sn, 0.0) + (prev[1] + w) / 2 * gat / 3600
            rows.append((today, sn, wh, "eigen"))
        return rows

    # --- voor de API ----------------------------------------------------------

    def vandaag(self, inverters):
        """Combineert de status van de omvormers met de opbrengst van vandaag."""
        today = dt.datetime.now(TZ).date().isoformat()
        wh = dict(self.store.panel_day(today))
        with self._lock:
            detail = dict(self.detail)
        lijst = []
        for p in inverters:
            sn = p.get("serie_lang")
            d = detail.get(sn, {})
            lijst.append({
                "nr": p["nr"],
                "serie": p["serie"],
                "watt": p.get("watt") if not p.get("slaapt") else 0,
                "vandaag_kwh": round(wh[sn] / 1000, 3) if sn in wh and wh[sn] is not None else None,
                "temp": d.get("temp"),
                "status": p.get("status"),
                "slaapt": p.get("slaapt"),
            })
        waarden = sorted(x["vandaag_kwh"] for x in lijst if x["vandaag_kwh"] is not None)
        zwak = []
        if len(waarden) >= 3:
            mediaan = waarden[len(waarden) // 2]
            gem = sum(waarden) / len(waarden)
            if mediaan >= 0.15:  # pas vergelijken als er genoeg licht was
                for x in lijst:
                    v = x["vandaag_kwh"]
                    if v is not None and v < mediaan * 0.85:
                        zwak.append({"nr": x["nr"], "procent": round((1 - v / gem) * 100)})
        return {
            "lijst": lijst,
            "totaal_kwh": round(sum(waarden), 3) if waarden else None,
            "beste_kwh": waarden[-1] if waarden else None,
            "zwak": zwak,
            "bron": self.bron,
        }

    def records(self, inverters):
        """Totalen en records; een uur bewaard omdat het rekenwerk kost."""
        if self._records and time.time() - self._records_t < 3600:
            rec = dict(self._records)
        else:
            rec = self._bereken_records(inverters)
            self._records, self._records_t = dict(rec), time.time()
        with self._lock:
            detail = dict(self.detail)
        totaal = [d["totaal_wh"] for d in detail.values() if d.get("totaal_wh")]
        temps = [d["temp"] for d in detail.values() if d.get("temp") is not None]
        rec["sinds_installatie_kwh"] = round(sum(totaal) / 1000, 1) if totaal else None
        rec["temp_min"] = min(temps) if temps else None
        rec["temp_max"] = max(temps) if temps else None
        return rec

    def _bereken_records(self, inverters):
        first = self.store.first_ts()
        now = time.time()
        per_dag = {}
        if first:
            for h, v in self.store.hourly(int(first), int(now)).items():
                d = dt.datetime.fromtimestamp(h, TZ).date()
                per_dag[d] = per_dag.get(d, 0.0) + v["pv"] / 60000
        jaar = dt.datetime.now(TZ).year
        beste = max(per_dag.items(), key=lambda kv: kv[1]) if per_dag else None
        nr = {p.get("serie_lang"): p["nr"] for p in inverters}
        beste_paneel = None
        for sn, wh in self.store.panel_totals():
            if sn in nr and (beste_paneel is None or wh > beste_paneel[1]):
                beste_paneel = (nr[sn], wh)
        return {
            "dit_jaar_kwh": round(sum(v for d, v in per_dag.items() if d.year == jaar), 1) if per_dag else None,
            "gemeten_kwh": round(sum(per_dag.values()), 1) if per_dag else None,
            "beste_dag_kwh": round(beste[1], 3) if beste else None,
            "beste_dag": beste[0].isoformat() if beste else None,
            "beste_paneel": beste_paneel[0] if beste_paneel else None,
            "sinds": dt.datetime.fromtimestamp(first, TZ).date().isoformat() if first else None,
        }


def demo_device_data():
    now = time.time()
    lt = time.localtime(now)
    uur = lt.tm_hour + lt.tm_min / 60
    # opbrengst tot nu toe volgens een zonneboog van 8:30 tot 16:30
    frac = 0.0 if uur < 8.5 else 1.0 if uur > 16.5 else (1 - math.cos((uur - 8.5) / 8 * math.pi)) / 2
    out = {}
    for i in range(1, 10):
        factor = 0.7 if i == 7 else 1.0 + (i % 3) * 0.02
        out[f"12210{i:07d}"] = {"vandaag_wh": 420 * factor * frac, "totaal_wh": 530000 * factor, "temp": 9 + i % 5}
    return out
