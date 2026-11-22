"""Lokaal uitlezen van de Enphase IQ Gateway (alleen lezen)."""

import http.client
import json
import logging
import math
import ssl
import threading
import time

log = logging.getLogger("gateway")


class GatewayError(Exception):
    pass


class Gateway:
    """Leest live waarden via de lokale API van de gateway.

    Eerst /ivp/livedata/status (zon, huis, net, batterij en laadtoestand in een keer).
    Lukt dat niet, dan /ivp/meters/readings met /ivp/ensemble/inventory voor de laadtoestand.
    Waarden in watt; net positief = afname, batterij positief = ontladen.
    """

    def __init__(self, host, token, timeout=15):
        self.host = host
        self.token = token
        self.timeout = timeout
        self._ctx = ssl.create_default_context()
        # De gateway gebruikt een eigen certificaat in het thuisnetwerk.
        self._ctx.check_hostname = False
        self._ctx.verify_mode = ssl.CERT_NONE
        self._conn = None
        self._lock = threading.Lock()
        self._last_stream_enable = 0.0
        self._meter_types = None
        self._last_soc_check = 0.0
        self._soc = None

    # --- verbinding -------------------------------------------------------

    def _connection(self):
        if self._conn is None:
            self._conn = http.client.HTTPSConnection(self.host, context=self._ctx, timeout=self.timeout)
        return self._conn

    def _request(self, method, path, body=None, raw_text=False):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        with self._lock:
            for attempt in (1, 2):
                try:
                    conn = self._connection()
                    conn.request(method, path, body=data, headers=headers)
                    resp = conn.getresponse()
                    raw = resp.read()
                    if resp.status == 401:
                        raise GatewayError("token geweigerd (401): maak een nieuw token aan")
                    if resp.status != 200:
                        raise GatewayError(f"{path} gaf status {resp.status}")
                    if raw_text:
                        return raw.decode("utf-8", "replace")
                    return json.loads(raw) if raw else None
                except GatewayError:
                    raise
                except Exception as e:  # verbroken verbinding: een keer opnieuw
                    self._close()
                    if attempt == 2:
                        raise GatewayError(f"{path}: {e}") from e
        return None

    def get_json(self, path):
        """Alleen lezen: een JSON-endpoint van de gateway."""
        return self._request("GET", path)

    def get_text(self, path):
        return self._request("GET", path, raw_text=True)

    def _close(self):
        try:
            if self._conn is not None:
                self._conn.close()
        finally:
            self._conn = None

    # --- uitlezen -----------------------------------------------------------

    def read(self):
        try:
            return self._read_livedata()
        except GatewayError as e:
            log.debug("livedata niet bruikbaar (%s), terugvallen op meters", e)
            return self._read_meters()

    def _read_livedata(self):
        js = self._request("GET", "/ivp/livedata/status")
        meters = (js or {}).get("meters")
        if not isinstance(meters, dict):
            raise GatewayError("livedata zonder meters")

        now = time.time()
        last_update = meters.get("last_update")
        if isinstance(last_update, (int, float)) and now - last_update > 60:
            # De live-stroom staat uit; de Enphase-app zet hem ook aan bij het live-scherm.
            if now - self._last_stream_enable > 120:
                self._last_stream_enable = now
                try:
                    self._request("POST", "/ivp/livedata/stream", {"enable": 1})
                    log.info("live-stroom van de gateway aangezet")
                except GatewayError as e:
                    log.warning("live-stroom aanzetten mislukt: %s", e)
            raise GatewayError("livedata verouderd")

        def watts(key):
            v = meters.get(key)
            if isinstance(v, dict) and isinstance(v.get("agg_p_mw"), (int, float)):
                return v["agg_p_mw"] / 1000.0
            return None

        pv, grid, batt, load = watts("pv"), watts("grid"), watts("storage"), watts("load")
        if pv is None and grid is None:
            raise GatewayError("livedata zonder waarden")
        if load is None:
            load = (pv or 0) + (grid or 0) + (batt or 0)
        return {
            "pv": max(pv or 0.0, 0.0),
            "load": max(load, 0.0),
            "grid": grid or 0.0,
            "batt": batt or 0.0,
            "soc": meters.get("soc"),
            "source": "livedata",
        }

    def _read_meters(self):
        if self._meter_types is None:
            meters = self._request("GET", "/ivp/meters") or []
            self._meter_types = {m.get("eid"): m.get("measurementType") for m in meters if m.get("state") == "enabled"}
        readings = self._request("GET", "/ivp/meters/readings") or []
        out = {"pv": 0.0, "grid": 0.0, "batt": 0.0}
        for r in readings:
            kind = self._meter_types.get(r.get("eid"))
            p = r.get("activePower")
            if p is None:
                continue
            if kind == "production":
                out["pv"] = max(float(p), 0.0)
            elif kind == "net-consumption":
                out["grid"] = float(p)
            elif kind == "storage":
                out["batt"] = float(p)
        out["load"] = max(out["pv"] + out["grid"] + out["batt"], 0.0)
        now = time.time()
        if now - self._last_soc_check > 60:
            self._last_soc_check = now
            try:
                levels = []
                for group in self._request("GET", "/ivp/ensemble/inventory") or []:
                    for dev in group.get("devices", []):
                        if "percentFull" in dev:
                            levels.append(dev["percentFull"])
                if levels:
                    self._soc = round(sum(levels) / len(levels))
            except GatewayError as e:
                log.debug("laadtoestand niet gelezen: %s", e)
        out["soc"] = self._soc
        out["source"] = "meters"
        return out


class DemoGateway:
    """Nepgateway voor testen zonder echte installatie."""

    def __init__(self):
        self.soc = 60.0
        self._t = time.time()

    def read(self):
        now = time.time()
        dt = now - self._t
        self._t = now
        lt = time.localtime(now)
        hour = lt.tm_hour + lt.tm_min / 60
        pv = max(0.0, math.sin((hour - 8.5) / 8 * math.pi)) * 900 if 8.5 < hour < 16.5 else 0.0
        load = 180 + 220 * math.sin(now / 900) ** 2 + (500 if 17 <= hour < 20 else 0)
        batt = 0.0
        if 2 <= hour < 4 and self.soc < 100:
            batt = -3840.0
        elif self.soc > 5:
            batt = max(0.0, load - pv)
        self.soc = min(100.0, max(5.0, self.soc - batt * dt / 3600 / 5000 * 100))
        grid = load - pv - batt
        return {"pv": pv, "load": load, "grid": grid, "batt": batt, "soc": round(self.soc), "source": "demo"}
