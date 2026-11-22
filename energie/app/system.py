"""Systeemstatus: werkt alles nog? Gateway, omvormers, batterij, meters en de app zelf.

De gateway geeft per firmwareversie net andere velden terug. Alles wordt daarom
voorzichtig gelezen: een ontbrekend veld wordt 'onbekend', nooit een fout.
"""

import base64
import datetime as dt
import json
import logging
import os
import re
import threading
import time

from timeutil import TZ, day_bounds

log = logging.getLogger("status")

OK, LET_OP, FOUT, ONBEKEND = "ok", "let_op", "fout", "onbekend"

ENDPOINTS = {
    "info": "/info",
    "home": "/home.json",
    "inventory": "/inventory.json",
    "inverters": "/api/v1/production/inverters",
    "ensemble": "/ivp/ensemble/inventory",
    "meters": "/ivp/meters",
}


def _dt(epoch):
    if not isinstance(epoch, (int, float)) or epoch <= 0:
        return None
    return dt.datetime.fromtimestamp(epoch, TZ)


def _wanneer(epoch, now):
    d = _dt(epoch)
    if d is None:
        return None
    sec = now - epoch
    if sec < 90:
        return "zojuist"
    if sec < 3600:
        return f"{int(sec // 60)} min geleden"
    if d.date() == dt.datetime.now(TZ).date():
        return "vandaag " + d.strftime("%H:%M")
    if d.date() == dt.datetime.now(TZ).date() - dt.timedelta(days=1):
        return "gisteren " + d.strftime("%H:%M")
    return d.strftime("%d-%m-%Y %H:%M")


def token_expiry(token):
    """Vervaldatum uit het JWT-token (het middelste deel bevat 'exp')."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return int(data["exp"]) if "exp" in data else None
    except Exception:
        return None


def _status_ok(dev):
    st = dev.get("device_status")
    if isinstance(st, list) and st:
        return all(str(x).endswith(".ok") or x in ("prop.done",) for x in st), [str(x) for x in st]
    return None, []


def _devices(inventory, kind):
    out = []
    if isinstance(inventory, list):
        for group in inventory:
            if isinstance(group, dict) and str(group.get("type", "")).upper() == kind:
                out.extend(d for d in group.get("devices", []) if isinstance(d, dict))
    return out


def _kort(serial):
    s = str(serial or "")
    return "…" + s[-4:] if len(s) > 4 else s


class SystemStatus:
    def __init__(self, app):
        self.app = app
        self._cache = None
        self._cache_t = 0.0
        self._lock = threading.Lock()

    # --- ophalen ------------------------------------------------------------

    def _fetch_raw(self):
        gw = self.app.gateway
        raw, errors = {}, {}
        if gw is None:
            return raw, {"alles": "gateway niet ingesteld"}
        if self.app.demo:
            return demo_raw(), {}
        for key, path in ENDPOINTS.items():
            try:
                raw[key] = gw.get_text(path) if key == "info" else gw.get_json(path)
            except Exception as e:
                errors[key] = str(e)
        return raw, errors

    def raw(self):
        raw, errors = self._fetch_raw()
        return {"gegevens": raw, "fouten": errors}

    def get(self, force=False):
        with self._lock:
            if not force and self._cache and time.time() - self._cache_t < 60:
                return self._cache
            raw, errors = self._fetch_raw()
            self._cache = self._build(raw, errors)
            self._cache_t = time.time()
            return self._cache

    # --- samenstellen ---------------------------------------------------------

    def _build(self, raw, errors):
        now = time.time()
        meldingen = []

        def melding(niveau, onderdeel, tekst):
            meldingen.append({"niveau": niveau, "onderdeel": onderdeel, "tekst": tekst})

        gateway = self._gateway(raw, errors, now, melding)
        omvormers = self._inverters(raw, errors, now, melding)
        batterij = self._battery(raw, errors, now, melding)
        meters = self._meters(raw, errors, melding)
        app = self._app(now, melding)

        niveau = FOUT if any(m["niveau"] == FOUT for m in meldingen) else LET_OP if meldingen else OK
        return {
            "gecontroleerd": dt.datetime.fromtimestamp(now, TZ).strftime("%H:%M"),
            "niveau": niveau,
            "meldingen": meldingen,
            "gateway": gateway,
            "omvormers": omvormers,
            "batterij": batterij,
            "meters": meters,
            "app": app,
            "ophaalfouten": errors,
        }

    def _gateway(self, raw, errors, now, melding):
        info = raw.get("info") or ""
        home = raw.get("home") if isinstance(raw.get("home"), dict) else {}
        collector = self.app.collector
        bereikbaar = bool(collector and collector.last_ok and now - collector.last_ok < 60)
        if not bereikbaar:
            melding(FOUT, "Gateway", "De gateway antwoordt niet. Controleer of hij aan staat en verbonden is met je netwerk.")

        def tag(name):
            m = re.search(rf"<{name}>([^<]+)</{name}>", info) if isinstance(info, str) else None
            return m.group(1) if m else None

        net = home.get("network") if isinstance(home.get("network"), dict) else {}
        verbinding, signaal = None, None
        primary = net.get("primary_interface")
        for itf in net.get("interfaces", []) or []:
            if not isinstance(itf, dict):
                continue
            if primary and itf.get("interface") != primary:
                continue
            soort = str(itf.get("type", "")).lower()
            verbinding = {"wifi": "Wifi", "ethernet": "Ethernet", "cellular": "Mobiel"}.get(soort, soort or None)
            if itf.get("signal_strength") is not None and itf.get("signal_strength_max"):
                signaal = f"{itf['signal_strength']} van {itf['signal_strength_max']}"
                if soort == "wifi" and itf["signal_strength"] <= 1:
                    melding(LET_OP, "Gateway", "Het wifisignaal van de gateway is zwak.")
            break

        cloud = net.get("web_comm")
        if cloud is False:
            melding(LET_OP, "Gateway", "De gateway heeft geen verbinding met de Enphase-cloud. Lokaal werkt alles, maar de Enphase-app krijgt geen gegevens.")
        laatste_cloud = net.get("last_enlighten_report_time")

        db = home.get("db_percent_full")
        if isinstance(db, (int, float)) and db >= 90:
            melding(LET_OP, "Gateway", f"De opslag van de gateway is voor {db}% vol.")
        alerts = home.get("alerts") or []
        for a in alerts if isinstance(alerts, list) else []:
            tekst = a.get("msg_key") if isinstance(a, dict) else str(a)
            melding(LET_OP, "Gateway", f"Melding van de gateway: {tekst}")

        token_exp = token_expiry(self.app.token) if self.app.token else None
        return {
            "status": OK if bereikbaar else FOUT,
            "bereikbaar": bereikbaar,
            "firmware": tag("software"),
            "serienummer": _kort(tag("sn")),
            "verbinding": verbinding,
            "signaal": signaal,
            "cloud": None if cloud is None else bool(cloud),
            "laatste_cloud": _wanneer(laatste_cloud, now),
            "opslag_procent": db if isinstance(db, (int, float)) else None,
            "update_status": home.get("update_status"),
            "laatste_meting": _wanneer(collector.last_ok, now) if collector and collector.last_ok else None,
            "token_verloopt": _dt(token_exp).strftime("%d-%m-%Y") if token_exp else None,
            "token_dagen": int((token_exp - now) // 86400) if token_exp else None,
            "ophaalfout": errors.get("home") or errors.get("info"),
        }

    def _inverters(self, raw, errors, now, melding):
        prod = {}
        for r in raw.get("inverters") or []:
            if isinstance(r, dict) and r.get("serialNumber"):
                prod[str(r["serialNumber"])] = r
        devs = _devices(raw.get("inventory"), "PCU")
        serials = [str(d.get("serial_num")) for d in devs if d.get("serial_num")] or list(prod)
        by_serial = {str(d.get("serial_num")): d for d in devs}
        lijst = []
        for i, sn in enumerate(sorted(serials), start=1):
            d = by_serial.get(sn, {})
            p = prod.get(sn, {})
            ok, codes = _status_ok(d)
            last = p.get("lastReportDate") or (int(d["last_rpt_date"]) if str(d.get("last_rpt_date", "")).isdigit() else None)
            status = OK
            reden = None
            if d.get("communicating") is False:
                status, reden = FOUT, "communiceert niet"
            elif ok is False:
                status, reden = FOUT, ", ".join(c.replace("envoy.", "") for c in codes)
            elif isinstance(last, (int, float)) and now - last > 26 * 3600:
                status, reden = LET_OP, "al meer dan een dag geen melding"
            if status != OK:
                melding(status, "Omvormers", f"Omvormer {i} ({_kort(sn)}): {reden}.")
            lijst.append({
                "nr": i,
                "serie": _kort(sn),
                "watt": p.get("lastReportWatts"),
                "max_watt": p.get("maxReportWatts"),
                "laatste": _wanneer(last, now),
                "produceert": d.get("producing"),
                "status": status,
                "reden": reden,
            })
        if not lijst and "inverters" in errors and "inventory" in errors:
            melding(LET_OP, "Omvormers", "De status van de omvormers kon niet worden opgehaald.")
        actief = sum(1 for x in lijst if x["status"] == OK)
        totaal_w = sum(x["watt"] or 0 for x in lijst)
        return {
            "aantal": len(lijst),
            "actief": actief,
            "totaal_watt": totaal_w,
            "lijst": lijst,
            "status": FOUT if any(x["status"] == FOUT for x in lijst) else LET_OP if any(x["status"] == LET_OP for x in lijst) else (OK if lijst else ONBEKEND),
            "ophaalfout": errors.get("inverters") or errors.get("inventory"),
        }

    def _battery(self, raw, errors, now, melding):
        devs = _devices(raw.get("ensemble"), "ENCHARGE")
        lijst = []
        for i, d in enumerate(devs, start=1):
            ok, codes = _status_ok(d)
            temp = d.get("temperature")
            status, reden = OK, None
            if d.get("communicating") is False:
                status, reden = FOUT, "communiceert niet"
            elif d.get("operating") is False:
                status, reden = FOUT, "is niet actief"
            elif ok is False:
                status, reden = FOUT, ", ".join(codes)
            elif d.get("dc_switch_off") is True:
                status, reden = FOUT, "de DC-schakelaar staat uit"
            elif isinstance(temp, (int, float)) and temp >= 45:
                status, reden = LET_OP, f"temperatuur is hoog ({temp} °C)"
            if status != OK:
                melding(status, "Batterij", f"Batterij{'' if len(devs) == 1 else ' ' + str(i)}: {reden}.")
            cap = d.get("encharge_capacity")
            lijst.append({
                "serie": _kort(d.get("serial_num")),
                "laadtoestand": d.get("percentFull"),
                "temperatuur": temp,
                "capaciteit_kwh": round(cap / 1000, 1) if isinstance(cap, (int, float)) and cap > 100 else None,
                "communiceert": d.get("communicating"),
                "actief": d.get("operating"),
                "slaapstand": d.get("sleep_enabled"),
                "signaal": d.get("comm_level_sub_ghz") if d.get("comm_level_sub_ghz") is not None else d.get("comm_level_2_4_ghz"),
                "laatste": _wanneer(int(d["last_rpt_date"]) if str(d.get("last_rpt_date", "")).isdigit() else None, now),
                "status": status,
                "reden": reden,
            })
        if not lijst and "ensemble" in errors:
            melding(LET_OP, "Batterij", "De status van de batterij kon niet worden opgehaald.")
        return {
            "lijst": lijst,
            "status": FOUT if any(x["status"] == FOUT for x in lijst) else LET_OP if any(x["status"] == LET_OP for x in lijst) else (OK if lijst else ONBEKEND),
            "ophaalfout": errors.get("ensemble"),
        }

    def _meters(self, raw, errors, melding):
        namen = {"production": "Productie (zon)", "net-consumption": "Verbruik (net)", "total-consumption": "Totaal verbruik", "storage": "Batterij"}
        lijst = []
        for m in raw.get("meters") or []:
            if not isinstance(m, dict):
                continue
            soort = m.get("measurementType")
            aan = m.get("state") == "enabled"
            lijst.append({"naam": namen.get(soort, soort or "Meter"), "aan": aan, "status": OK if aan else LET_OP})
            if not aan and soort in ("production", "net-consumption"):
                melding(LET_OP, "Meters", f"De meter '{namen.get(soort, soort)}' staat uit.")
        return {
            "lijst": lijst,
            "status": LET_OP if any(x["status"] == LET_OP for x in lijst) else (OK if lijst else ONBEKEND),
            "ophaalfout": errors.get("meters"),
        }

    def _app(self, now, melding):
        app = self.app
        today = dt.datetime.now(TZ).date()
        prijzen_vandaag = app.prices.complete(today)
        prijzen_morgen = app.prices.complete(today + dt.timedelta(days=1))
        if not prijzen_vandaag:
            melding(LET_OP, "App", "De prijzen van vandaag ontbreken; de kosten zijn daardoor niet compleet.")
        if dt.datetime.now(TZ).hour >= 15 and not prijzen_morgen:
            melding(LET_OP, "App", "De prijzen van morgen zijn nog niet binnen.")
        exp = token_expiry(app.token) if app.token else None
        if exp:
            dagen = (exp - now) / 86400
            if dagen < 0:
                melding(FOUT, "App", "Je token is verlopen. Maak een nieuw token aan op entrez.enphaseenergy.com.")
            elif dagen < 30:
                melding(LET_OP, "App", f"Je token verloopt over {int(dagen)} dagen. Maak op tijd een nieuw token aan.")
        try:
            db_mb = round(os.path.getsize(app.store_path) / 1024 / 1024, 1)
        except OSError:
            db_mb = None
        first = app.store.first_ts()
        return {
            "versie": app.version,
            "prijzen_vandaag": prijzen_vandaag,
            "prijzen_morgen": prijzen_morgen,
            "prijzen_fout": app.prices.last_error,
            "database_mb": db_mb,
            "metingen_sinds": _dt(first).strftime("%d-%m-%Y") if first else None,
        }


def demo_raw():
    now = int(time.time())
    hour = dt.datetime.now(TZ).hour
    dag = 8 <= hour < 17
    inverters = [{"serialNumber": f"12210{i:07d}", "lastReportDate": now - 300 if dag else now - 3600 * 9,
                  "devType": 1, "lastReportWatts": (180 + i * 7) if dag else 0, "maxReportWatts": 290 + i * 3}
                 for i in range(1, 10)]
    inventory = [{"type": "PCU", "devices": [
        {"serial_num": f"12210{i:07d}", "device_status": ["envoy.global.ok"], "communicating": True,
         "producing": dag, "operating": True, "last_rpt_date": str(now - 300)} for i in range(1, 10)]}]
    inventory[0]["devices"][6]["communicating"] = False  # een storing om de weergave te testen
    return {
        "info": "<envoy_info><device><sn>122312345678</sn><pn>800-00654-r09</pn><software>D8.3.5289</software></device></envoy_info>",
        "home": {"db_percent_full": 12, "update_status": "satisfied", "alerts": [],
                 "network": {"web_comm": True, "last_enlighten_report_time": now - 400, "primary_interface": "wlan0",
                             "interfaces": [{"type": "wifi", "interface": "wlan0", "signal_strength": 4, "signal_strength_max": 5}]}},
        "inventory": inventory,
        "inverters": inverters,
        "ensemble": [{"type": "ENCHARGE", "devices": [{"serial_num": "482300001234", "device_status": ["envoy.global.ok", "prop.done"],
                                                         "communicating": True, "operating": True, "sleep_enabled": False,
                                                         "percentFull": 68, "temperature": 21, "encharge_capacity": 5000,
                                                         "comm_level_sub_ghz": 5, "dc_switch_off": False, "last_rpt_date": str(now - 120)}]}],
        "meters": [{"eid": 1, "state": "enabled", "measurementType": "production"},
                   {"eid": 2, "state": "enabled", "measurementType": "net-consumption"},
                   {"eid": 3, "state": "enabled", "measurementType": "storage"}],
    }
