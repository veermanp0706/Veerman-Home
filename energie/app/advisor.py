"""Adviseur voor het nachtladen van de batterij.

De app stuurt niets aan. Elke middag, zodra de prijzen van morgen bekend zijn,
rekent hij uit hoe je de batterij die nacht het beste laadt:
  - zonverwachting per uur (Open-Meteo, bijgesteld aan je werkelijke opbrengst)
  - verwacht verbruik per uur (je eigen metingen van de afgelopen weken)
  - een simulatie van de batterij in zelfverbruik, voor elke mogelijke laadlimiet
Het advies is de laagste laadlimiet die (vrijwel) het meeste oplevert: niet voller
laden dan nodig, want elke kWh door de batterij kost slijtage en laadverlies.
"""

import datetime as dt
import json
import logging
import math
import os
import threading
import time
import urllib.request

import calc
import notify
from timeutil import TZ, day_bounds, hhmm

log = logging.getLogger("advies")

LAADVERMOGEN = 3.84      # kW, IQ Battery 5P
RENDEMENT = 0.95         # per richting (laden en ontladen), samen ongeveer 90%
PR = 0.85                # verhouding opbrengst / instraling x vermogen, voor bijstellen
MARGE = 0.02             # euro per kWh: zoveel moet laden van het net minstens opleveren
NACHT = (0, 7)           # laadschema valt tussen 00:00 en 07:00

STANDAARD = {
    "schema_start": 2, "schema_eind": 4, "schema_limiet": 100,
    "azimut": 205, "helling": 30, "kwp": 3.33, "reserve": 5,
}


def _get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "Veerman-home"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class Advisor(threading.Thread):
    def __init__(self, app, token, data_dir):
        super().__init__(daemon=True, name="advies")
        self.app = app
        self.store = app.store
        self.token = token
        self.path = os.path.join(data_dir, "advies.json")
        self.lock = threading.Lock()
        self.cfg, self.dagen = self._laad()
        self.locatie = None
        self.zon = {}            # uur (epoch) -> instraling op het paneel (W/m2)
        self.zon_t = 0
        self.factor = 1.0        # bijstelling aan werkelijke opbrengst
        self.plan = None
        self.plan_t = 0
        self.fout = None

    # --- opslag -----------------------------------------------------------------

    def _laad(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
            return {**STANDAARD, **(d.get("instellingen") or {})}, d.get("dagen") or {}
        except (OSError, ValueError):
            return dict(STANDAARD), {}

    def _bewaar(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"instellingen": self.cfg, "dagen": self.dagen}, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def bewaar_instellingen(self, nieuw):
        with self.lock:
            for k, v in nieuw.items():
                if k in STANDAARD and isinstance(v, (int, float, bool)):
                    self.cfg[k] = v
            self.cfg["schema_start"] = int(self.cfg["schema_start"]) % 24
            self.cfg["schema_eind"] = int(self.cfg["schema_eind"]) % 24
            self.cfg["schema_limiet"] = max(0, min(100, int(self.cfg["schema_limiet"])))
            self._bewaar()
        self.zon_t = 0  # dak gewijzigd: verwachting opnieuw ophalen
        self.ververs()
        return self.api()

    def ingesteld(self, dag, gedaan):
        """De gebruiker heeft het advies overgenomen (of niet)."""
        with self.lock:
            p = self.plan
            d = self.dagen.setdefault(dag, {})
            d["ingesteld"] = bool(gedaan)
            if gedaan and p and p["dag"] == dag and p["advies"]:
                a = p["advies"]
                self.cfg.update({"schema_start": a["start"], "schema_eind": a["eind"], "schema_limiet": a["limiet"]})
            self._bewaar()
        self.ververs()
        return self.api()

    # --- achtergrond --------------------------------------------------------------

    def run(self):
        time.sleep(30)
        while True:
            try:
                self.ververs()
                self._evalueer()
                self._melding()
            except Exception as e:
                self.fout = str(e)
                log.warning("advies niet berekend: %s", e)
            # zolang de prijzen voor vannacht nog niet binnen zijn, vaker kijken
            time.sleep(300 if (self.plan or {}).get("status") == "wacht_op_prijzen" else 900)

    def ververs(self):
        if time.time() - self.zon_t > 3600:
            self._haal_zon()
        self.plan = self.bereken()
        self.plan_t = time.time()
        self.fout = None

    # --- zonverwachting -------------------------------------------------------------

    def _haal_locatie(self):
        if self.locatie:
            return self.locatie
        o = self.app.opts
        if o.get("latitude") and o.get("longitude"):
            self.locatie = (float(o["latitude"]), float(o["longitude"]))
        elif self.token:
            c = notify.ha_request(self.token, "GET", "/config")
            self.locatie = (float(c["latitude"]), float(c["longitude"]))
        return self.locatie

    def _haal_zon(self):
        if self.app.demo:
            self.zon = demo_instraling()
        else:
            lat, lon = self._haal_locatie() or (None, None)
            if lat is None:
                raise RuntimeError("geen locatie: de app weet niet waar je woont")
            # Open-Meteo: azimut 0 = zuid, -90 = oost, 90 = west
            az = ((self.cfg["azimut"] - 180 + 180) % 360) - 180
            url = (f"https://api.open-meteo.com/v1/forecast?latitude={lat:.3f}&longitude={lon:.3f}"
                   f"&hourly=global_tilted_irradiance&tilt={self.cfg['helling']}&azimuth={az}"
                   f"&timezone=UTC&timeformat=unixtime&past_days=14&forecast_days=3")
            d = _get_json(url)
            uren, waarden = d["hourly"]["time"], d["hourly"]["global_tilted_irradiance"]
            # Open-Meteo geeft het gemiddelde over het uur ervóór; wij gebruiken het begin van het uur
            self.zon = {int(t) - 3600: float(v) for t, v in zip(uren, waarden) if v is not None}
        self.zon_t = time.time()
        self._stel_bij()

    def _stel_bij(self):
        """Vergelijkt de verwachting van de afgelopen 14 dagen met wat de panelen echt opwekten."""
        nu = int(time.time())
        start = nu - nu % 86400 - 14 * 86400
        echt = self.store.hourly(start, nu - nu % 3600)
        som_echt = som_model = 0.0
        for h, v in echt.items():
            if h in self.zon and v["minutes"] >= 50:
                som_echt += v["pv"] / 60000
                som_model += self.zon[h] / 1000 * self.cfg["kwp"] * PR
        if som_model > 5:  # pas bijstellen met genoeg zon in de vergelijking
            self.factor = max(0.4, min(1.3, som_echt / som_model))

    def zon_kwh(self, h):
        g = self.zon.get(h)
        return None if g is None else g / 1000 * self.cfg["kwp"] * PR * self.factor

    # --- verbruiksprofiel -----------------------------------------------------------

    def _profiel(self):
        """Verwacht verbruik per (weekdag, uur) en per uur, uit de afgelopen 4 weken."""
        nu = int(time.time())
        rows = self.store.hourly(nu - 28 * 86400, nu - nu % 3600)
        per_wd, per_uur = {}, {}
        for h, v in rows.items():
            if v["minutes"] < 50:
                continue
            t = dt.datetime.fromtimestamp(h, TZ)
            kwh = v["load"] / 60000
            per_wd.setdefault((t.weekday(), t.hour), []).append(kwh)
            per_uur.setdefault(t.hour, []).append(kwh)
        return per_wd, per_uur

    @staticmethod
    def _verwacht(per_wd, per_uur, ts):
        t = dt.datetime.fromtimestamp(ts, TZ)
        a = per_wd.get((t.weekday(), t.hour), [])
        if len(a) >= 2:
            return sum(a) / len(a)
        b = per_uur.get(t.hour, [])
        return sum(b) / len(b) if b else 0.35

    # --- simulatie ---------------------------------------------------------------------

    def _simuleer(self, uren, soc0, laad_uren, limiet_kwh):
        """Zelfverbruik met (optioneel) laden van het net in laad_uren tot limiet_kwh.
        Geeft de kosten in euro, de eindlading en de energie uit het net voor de batterij."""
        cap = self.app.capacity
        res = cap * self.cfg["reserve"] / 100
        soc, kosten, net_laden, ontladen_waarde, ontladen = soc0, 0.0, 0.0, 0.0, 0.0
        for u in uren:
            netto = u["verbruik"] - u["zon"]
            if u["t"] in laad_uren and soc < limiet_kwh:
                bij = min(LAADVERMOGEN * RENDEMENT, limiet_kwh - soc)
                van_net = bij / RENDEMENT
                soc += bij
                net_laden += van_net
                kosten += (max(netto, 0) + van_net) * u["allin"] - max(-netto, 0) * u["terug"]
                continue
            if netto > 0:
                uit = min(netto, max(soc - res, 0) * RENDEMENT, LAADVERMOGEN)
                soc -= uit / RENDEMENT
                ontladen += uit
                ontladen_waarde += uit * u["allin"]
                kosten += (netto - uit) * u["allin"]
            else:
                bij = min(-netto * RENDEMENT, cap - soc, LAADVERMOGEN * RENDEMENT)
                soc += bij
                kosten -= (-netto - bij / RENDEMENT) * u["terug"]
        return kosten, soc, net_laden, ontladen, ontladen_waarde

    def bereken(self):
        nu = dt.datetime.now(TZ)
        # de komende nacht: vóór 07:00 is dat de lopende nacht, anders de nacht van morgen
        dag = nu.date() if nu.hour < NACHT[1] else nu.date() + dt.timedelta(days=1)
        if not self.app.prices.complete(dag):
            return {"dag": dag.isoformat(), "advies": None, "status": "wacht_op_prijzen"}

        prijzen = {h["t"]: h for h in calc.price_day(self.store, self.app.tariffs, nu.date())}
        prijzen.update({h["t"]: h for h in calc.price_day(self.store, self.app.tariffs, dag)})
        per_wd, per_uur = self._profiel()
        start_uur = int(time.time()) - int(time.time()) % 3600
        _, eind = day_bounds(dag)
        uren = []
        for t in range(start_uur, eind, 3600):
            if t not in prijzen:
                continue
            z = self.zon_kwh(t)
            uren.append({"t": t, "zon": z or 0.0, "verbruik": self._verwacht(per_wd, per_uur, t),
                         "allin": prijzen[t]["allin"], "terug": prijzen[t]["terug"], "zon_bekend": z is not None})
        if not uren:
            return {"dag": dag.isoformat(), "advies": None, "status": "geen_gegevens"}

        cap = self.app.capacity
        latest = self.app.collector.latest if self.app.collector else None
        soc_nu = (latest.get("soc") if latest else None)
        soc0 = cap * (soc_nu if soc_nu is not None else 30) / 100

        nacht_start, _ = day_bounds(dag)
        nacht = [u for u in uren if nacht_start + NACHT[0] * 3600 <= u["t"] < nacht_start + NACHT[1] * 3600]

        def blok(n):
            """Goedkoopste aaneengesloten n uur in de nacht."""
            beste = None
            for i in range(len(nacht) - n + 1):
                b = nacht[i:i + n]
                if b[-1]["t"] - b[0]["t"] != (n - 1) * 3600:
                    continue
                gem = sum(u["allin"] for u in b) / n
                if beste is None or gem < beste[1]:
                    beste = (b, gem)
            return beste

        # 1. niet laden van het net
        k_niets, _, _, _, _ = self._simuleer(uren, soc0, set(), 0)
        # 2. je huidige schema
        s, e = self.cfg["schema_start"], self.cfg["schema_eind"]
        schema_uren = {nacht_start + h * 3600 for h in range(s, e if e > s else e + 24)}
        k_schema, _, net_schema, _, _ = self._simuleer(uren, soc0, schema_uren, cap * self.cfg["schema_limiet"] / 100)

        # 3. elke laadlimiet in stappen van 5%, steeds in het goedkoopste blok dat lang genoeg is
        opties = []
        # lading bij het begin van de nacht (zelfverbruik tot dan)
        _, soc_nacht, _, _, _ = self._simuleer([u for u in uren if u["t"] < nacht_start], soc0, set(), 0)
        for limiet in range(0, 101, 5):
            lk = cap * limiet / 100
            nodig = max(lk - soc_nacht, 0) / RENDEMENT
            if nodig < 0.05:
                k, _, net, ontl, w = self._simuleer(uren, soc0, set(), 0)
                opties.append({"limiet": limiet, "kosten": k, "net": 0.0, "uren": [], "gem": None})
                continue
            n = max(1, math.ceil(nodig / LAADVERMOGEN))
            b = blok(min(n, len(nacht)))
            if not b:
                continue
            laad = {u["t"] for u in b[0]}
            k, _, net, ontl, w = self._simuleer(uren, soc0, laad, lk)
            opties.append({"limiet": limiet, "kosten": k, "net": net, "uren": sorted(laad), "gem": b[1]})

        # Kies de limiet met de laagste kosten, waarbij elke kWh van het net minstens
        # MARGE moet opleveren (slijtage, onzekerheid in de verwachting). Gelijk: de laagste.
        keuze = min(opties, key=lambda o: (round(o["kosten"] + MARGE * o["net"], 3), o["limiet"]))

        dag_uren = [u for u in uren if u["t"] >= nacht_start]
        advies = None
        if keuze["uren"]:
            advies = {
                "start": dt.datetime.fromtimestamp(keuze["uren"][0], TZ).hour,
                "eind": (dt.datetime.fromtimestamp(keuze["uren"][-1], TZ).hour + 1) % 24,
                "limiet": keuze["limiet"],
                "laden_kwh": round(keuze["net"], 2),
                "gem_prijs": round(keuze["gem"], 4),
            }
        gelijk = (advies is not None and advies["start"] == s and advies["eind"] == e
                  and abs(advies["limiet"] - self.cfg["schema_limiet"]) <= 5) or \
                 (advies is None and self.cfg["schema_limiet"] == 0)
        dure = [u for u in dag_uren if u["verbruik"] > u["zon"] and u["t"] >= nacht_start + NACHT[1] * 3600]
        gebruik_prijs = (sum(u["allin"] * (u["verbruik"] - u["zon"]) for u in dure) /
                         max(sum(u["verbruik"] - u["zon"] for u in dure), 0.001)) if dure else None
        plan = {
            "dag": dag.isoformat(),
            "status": "ok",
            "advies": advies,
            "laden": advies is not None,
            "gelijk_aan_schema": gelijk,
            "schema": {"start": s, "eind": e, "limiet": self.cfg["schema_limiet"]},
            "besparing_vs_schema": round(k_schema - keuze["kosten"], 2),
            "besparing_vs_niets": round(k_niets - keuze["kosten"], 2),
            "soc_begin_nacht": round(soc_nacht / cap * 100),
            "zon_kwh": round(sum(u["zon"] for u in dag_uren), 2),
            "zon_bekend": all(u["zon_bekend"] for u in dag_uren),
            "verbruik_kwh": round(sum(u["verbruik"] for u in dag_uren), 2),
            "gebruik_prijs": round(gebruik_prijs, 4) if gebruik_prijs else None,
            "factor": round(self.factor, 2),
            "uren": [{"uur": hhmm(u["t"]), "zon": round(u["zon"], 3), "verbruik": round(u["verbruik"], 3),
                      "allin": u["allin"], "laden": u["t"] in set(keuze["uren"])} for u in dag_uren],
            "ingesteld": self.dagen.get(dag.isoformat(), {}).get("ingesteld"),
            "prijzen_sinds": self._sinds(dag),
        }
        with self.lock:
            d = self.dagen.setdefault(dag.isoformat(), {})
            d.update({"advies": advies, "schema": plan["schema"], "zon_verwacht": plan["zon_kwh"],
                      "verwacht_vs_schema": plan["besparing_vs_schema"]})
            grens = (nu.date() - dt.timedelta(days=60)).isoformat()
            self.dagen = {k: v for k, v in self.dagen.items() if k >= grens}
            self._bewaar()
        return plan

    def _sinds(self, dag):
        t = getattr(self.app.prices, "binnen", {}).get(dag.isoformat())
        return dt.datetime.fromtimestamp(t, TZ).strftime("%H:%M") if t else None

    # --- achteraf ------------------------------------------------------------------------

    def _evalueer(self):
        """Rekent afgelopen dagen opnieuw door met wat er echt gebeurde (verbruik, zon, prijzen)."""
        vandaag = dt.datetime.now(TZ).date()
        gewijzigd = False
        for dag_s, d in list(self.dagen.items()):
            dag = dt.date.fromisoformat(dag_s)
            if dag >= vandaag or "achteraf" in d or "schema" not in d:
                continue
            s, e = day_bounds(dag)
            echt = self.store.hourly(s, e)
            prijzen = {h["t"]: h for h in calc.price_day(self.store, self.app.tariffs, dag)}
            if len(echt) < 20 or len(prijzen) < 20:
                d["achteraf"] = None
                gewijzigd = True
                continue
            uren = [{"t": t, "zon": echt[t]["pv"] / 60000, "verbruik": echt[t]["load"] / 60000,
                     "allin": prijzen[t]["allin"], "terug": prijzen[t]["terug"]} for t in sorted(echt) if t in prijzen]
            soc_a, _ = self.store.soc_edges(s, s + 3600)
            soc0 = self.app.capacity * (soc_a if soc_a is not None else 30) / 100
            cap = self.app.capacity

            def kosten(st):
                if not st:
                    return self._simuleer(uren, soc0, set(), 0)[0]
                a, b = st["start"], st["eind"]
                laad = {s + h * 3600 for h in range(a, b if b > a else b + 24)}
                return self._simuleer(uren, soc0, laad, cap * st["limiet"] / 100)[0]

            d["achteraf"] = round(kosten(d["schema"]) - kosten(d.get("advies")), 2)
            d["zon_echt"] = round(sum(u["zon"] for u in uren), 2)
            gewijzigd = True
        if gewijzigd:
            with self.lock:
                self._bewaar()

    def evaluatie(self):
        maand = dt.datetime.now(TZ).date().replace(day=1).isoformat()
        dagen = [d for k, d in self.dagen.items() if k >= maand and d.get("achteraf") is not None]
        afw = [abs(d["zon_verwacht"] - d["zon_echt"]) / d["zon_echt"]
               for d in self.dagen.values() if d.get("zon_echt") and d["zon_echt"] > 0.5 and d.get("zon_verwacht") is not None]
        return {
            "besparing_maand": round(sum(d["achteraf"] for d in dagen), 2) if dagen else None,
            "dagen": len(dagen),
            "zon_afwijking": round(sum(afw) / len(afw) * 100) if afw else None,
        }

    # --- melding ------------------------------------------------------------------------

    def _melding(self):
        n = getattr(self.app, "notifier", None)
        p = self.plan
        nu = dt.datetime.now(TZ)
        if not (n and p and p.get("status") == "ok" and 12 <= nu.hour < 23):
            return
        if p["gelijk_aan_schema"]:
            return
        n.advies(p)

    def api(self):
        return {
            "plan": self.plan,
            "evaluatie": self.evaluatie(),
            "instellingen": dict(self.cfg),
            "fout": self.fout,
        }


def demo_instraling():
    """Een bewolkte novemberdag als voorbeeld."""
    out = {}
    nu = int(time.time())
    start = nu - nu % 86400 - 14 * 86400
    for t in range(start, start + 18 * 86400, 3600):
        u = dt.datetime.fromtimestamp(t, TZ).hour + 0.5
        out[t] = max(0.0, math.sin((u - 8.5) / 8 * math.pi)) * 260 if 8.5 < u < 16.5 else 0.0
    return out
