"""Historie aanvullen uit Home Assistant.

Home Assistant bewaart van energiesensoren (zoals de Enphase-integratie) voor
altijd uurtotalen ('lange-termijnstatistieken'). Deze module haalt die op via de
websocket-API van Home Assistant en bewaart ze per uur, voor de uren waarvan de
app zelf geen metingen heeft.

Welke sensoren? Eerst wat er in het Energie-dashboard van Home Assistant is
ingesteld (zon, net, batterij); anders de sensoren van de Enphase-integratie.
"""

import base64
import datetime as dt
import json
import logging
import os
import socket
import struct
import threading
import time

from timeutil import TZ

log = logging.getLogger("ha-import")

HOST = os.environ.get("HA_WS_HOST", "supervisor")
PATH = os.environ.get("HA_WS_PATH", "/core/websocket")


class WebSocket:
    """Minimale websocket-client (alleen wat nodig is voor Home Assistant)."""

    def __init__(self, host, path, port=80, timeout=60):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("verbinding met Home Assistant verbroken")
            head += chunk
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status:
            raise ConnectionError("Home Assistant weigert de verbinding: " + status.decode(errors="replace"))
        self.buf = head.split(b"\r\n\r\n", 1)[1]

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("verbinding met Home Assistant verbroken")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(head + mask + masked)

    def send(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def recv(self):
        data = b""
        while True:
            b1, b2 = self._read(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n)
            if opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0x8:
                raise ConnectionError("Home Assistant sloot de verbinding")
            if opcode in (0x1, 0x2, 0x0):
                data += payload
                if fin:
                    return json.loads(data)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class HomeAssistant:
    def __init__(self, token):
        self.ws = WebSocket(HOST, PATH)
        self.n = 0
        msg = self.ws.recv()
        if msg.get("type") == "auth_required":
            self.ws.send({"type": "auth", "access_token": token})
            msg = self.ws.recv()
        if msg.get("type") != "auth_ok":
            raise PermissionError("Home Assistant accepteert de toegang niet")

    def call(self, msg):
        self.n += 1
        msg = dict(msg, id=self.n)
        self.ws.send(msg)
        while True:
            r = self.ws.recv()
            if r.get("id") == self.n and r.get("type") == "result":
                if not r.get("success"):
                    raise RuntimeError((r.get("error") or {}).get("message") or "onbekende fout")
                return r.get("result")

    def close(self):
        self.ws.close()


def _start_epoch(v):
    if isinstance(v, (int, float)):
        return int(v / 1000) if v > 1e11 else int(v)
    return int(dt.datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp())


def _iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat()


def find_sources(ha):
    """Zoekt de statistieken: eerst het Energie-dashboard, dan de Enphase-sensoren."""
    src = {"pv": [], "import": [], "export": [], "batt_in": [], "batt_out": [], "load": [], "soc": None}
    try:
        prefs = ha.call({"type": "energy/get_prefs"}) or {}
    except Exception as e:
        log.info("energie-instellingen niet gelezen: %s", e)
        prefs = {}
    for s in prefs.get("energy_sources", []) or []:
        kind = s.get("type")
        if kind == "solar" and s.get("stat_energy_from"):
            src["pv"].append(s["stat_energy_from"])
        elif kind == "battery":
            if s.get("stat_energy_from"):
                src["batt_out"].append(s["stat_energy_from"])
            if s.get("stat_energy_to"):
                src["batt_in"].append(s["stat_energy_to"])
        elif kind == "grid":
            for f in s.get("flow_from", []) or []:
                if f.get("stat_energy_from"):
                    src["import"].append(f["stat_energy_from"])
            for f in s.get("flow_to", []) or []:
                if f.get("stat_energy_to"):
                    src["export"].append(f["stat_energy_to"])
            # nieuwere opzet: één netbron met in- en uitvoer
            if s.get("stat_energy_from"):
                src["import"].append(s["stat_energy_from"])
            if s.get("stat_energy_to"):
                src["export"].append(s["stat_energy_to"])

    ids = ha.call({"type": "recorder/list_statistic_ids", "statistic_type": "sum"}) or []
    envoy = [x["statistic_id"] for x in ids if "envoy" in x.get("statistic_id", "") or "enphase" in x.get("statistic_id", "")]

    def zoek(*must, niet=()):
        for sid in envoy:
            if all(m in sid for m in must) and not any(n in sid for n in niet):
                return sid
        return None

    fallback = {
        "pv": zoek("lifetime_energy_production", niet=("net_", "battery")),
        "import": zoek("lifetime_net_energy_consumption"),
        "export": zoek("lifetime_net_energy_production"),
        "batt_in": zoek("lifetime_battery_energy_charged"),
        "batt_out": zoek("lifetime_battery_energy_discharged"),
        "load": zoek("lifetime_energy_consumption", niet=("net_",)),
    }
    for k, sid in fallback.items():
        if not src[k] and sid:
            src[k] = [sid]

    means = ha.call({"type": "recorder/list_statistic_ids", "statistic_type": "mean"}) or []
    for x in means:
        sid = x.get("statistic_id", "")
        unit = x.get("statistics_unit_of_measurement") or x.get("display_unit_of_measurement")
        if unit == "%" and ("envoy" in sid or "encharge" in sid) and sid.endswith("_battery"):
            src["soc"] = sid
            if "envoy" in sid:
                break
    return src


def hour_rows(series, soc):
    """Zet de uurwaarden (kWh per bron) om naar rijen voor de opslag."""
    hours = set()
    for per in series.values():
        hours.update(per)
    rows = []
    for h in sorted(hours):
        g = {k: series[k].get(h) for k in series}
        pv, imp, exp = g.get("pv") or 0.0, g.get("import"), g.get("export")
        if imp is None and exp is None:
            continue  # zonder netgegevens is het uur niet te reconstrueren
        imp, exp = imp or 0.0, exp or 0.0
        b_in, b_out, load = g.get("batt_in"), g.get("batt_out"), g.get("load")
        if b_in is None and b_out is None:
            if load is not None:
                netto = load - pv - imp + exp  # wat de batterij netto leverde
                b_out, b_in = max(netto, 0.0), max(-netto, 0.0)
            else:
                b_out = b_in = 0.0
        b_in, b_out = b_in or 0.0, b_out or 0.0
        if load is None:
            load = pv + imp - exp + b_out - b_in
        rows.append((h, max(pv, 0.0), max(load, 0.0), max(imp, 0.0), max(exp, 0.0),
                     max(b_in, 0.0), max(b_out, 0.0), soc.get(h)))
    return rows


class Importer(threading.Thread):
    def __init__(self, store, prices, token):
        super().__init__(daemon=True, name="ha-import")
        self.store = store
        self.prices = prices
        self.token = token
        self.status = "wachten"
        self.fout = None
        self.bronnen = None
        self.laatst = None

    def info(self):
        first, last, n = self.store.import_range()
        return {
            "status": self.status,
            "fout": self.fout,
            "sinds": dt.datetime.fromtimestamp(first, TZ).strftime("%d-%m-%Y") if first else None,
            "tot": dt.datetime.fromtimestamp(last, TZ).strftime("%d-%m-%Y %H:%M") if last else None,
            "uren": n,
            "bronnen": self.bronnen,
        }

    def run(self):
        time.sleep(20)
        while True:
            try:
                self.status = "bezig"
                self.once()
                self.status = "klaar"
                self.fout = None
            except Exception as e:
                self.status = "fout"
                self.fout = str(e)
                log.warning("historie uit Home Assistant niet opgehaald: %s", e)
            self.laatst = time.time()
            time.sleep(6 * 3600)

    def once(self):
        ha = HomeAssistant(self.token)
        try:
            src = find_sources(ha)
            self.bronnen = src
            if not (src["import"] or src["export"]):
                raise RuntimeError("geen energiesensoren voor het net gevonden in Home Assistant")
            now = int(time.time())
            end = now - now % 3600  # alleen volledige uren
            _, last, _ = self.store.import_range()
            if last:
                start = last - 2 * 86400
            else:
                start = self._first_month(ha, src)
                if start is None:
                    return
            log.info("historie ophalen vanaf %s", dt.datetime.fromtimestamp(start, TZ).date())
            alle = [sid for k in ("pv", "import", "export", "batt_in", "batt_out", "load") for sid in src[k]]
            t = start
            totaal = 0
            while t < end:
                t2 = min(t + 14 * 86400, end)
                r = ha.call({"type": "recorder/statistics_during_period", "start_time": _iso(t), "end_time": _iso(t2),
                             "statistic_ids": alle, "period": "hour", "types": ["change"],
                             "units": {"energy": "kWh"}}) or {}
                series = {k: {} for k in ("pv", "import", "export", "batt_in", "batt_out", "load")}
                for k in series:
                    for sid in src[k]:
                        for p in r.get(sid, []) or []:
                            if p.get("change") is None:
                                continue
                            h = _start_epoch(p["start"])
                            series[k][h] = series[k].get(h, 0.0) + float(p["change"])
                series = {k: v for k, v in series.items() if src[k]}
                soc = {}
                if src["soc"]:
                    rs = ha.call({"type": "recorder/statistics_during_period", "start_time": _iso(t), "end_time": _iso(t2),
                                  "statistic_ids": [src["soc"]], "period": "hour", "types": ["mean"]}) or {}
                    for p in rs.get(src["soc"], []) or []:
                        if p.get("mean") is not None:
                            soc[_start_epoch(p["start"])] = float(p["mean"])
                rows = hour_rows(series, soc)
                if rows:
                    self.store.write_import(rows)
                    totaal += len(rows)
                t = t2
            log.info("historie: %d uren uit Home Assistant opgeslagen", totaal)
        finally:
            ha.close()
        self._prices()

    def _first_month(self, ha, src):
        sid = (src["import"] or src["export"])[0]
        r = ha.call({"type": "recorder/statistics_during_period", "start_time": _iso(946684800),
                     "statistic_ids": [sid], "period": "month", "types": ["change"]}) or {}
        punten = r.get(sid) or []
        return _start_epoch(punten[0]["start"]) if punten else None

    def _prices(self):
        """Prijzen ophalen voor de geïmporteerde dagen, zodat de kosten kloppen."""
        first, last, _ = self.store.import_range()
        if not first:
            return
        day = dt.datetime.fromtimestamp(first, TZ).date()
        stop = dt.datetime.fromtimestamp(last, TZ).date()
        missend = 0
        while day <= stop:
            if not self.prices.complete(day):
                if not self.prices.ensure(day, log_level=logging.DEBUG):
                    missend += 1
                time.sleep(0.5)
            day += dt.timedelta(days=1)
        if missend:
            log.info("voor %d dagen konden geen prijzen worden opgehaald", missend)
