"""Meldingen op je telefoon, via de notify-diensten van Home Assistant
(de Home Assistant-app op je telefoon heet daar notify.mobile_app_<naam>)."""

import datetime as dt
import http.client
import json
import logging
import os
import threading
import time

import calc
import i18n
from timeutil import TZ, day_bounds

log = logging.getLogger("meldingen")

STANDAARD = {"doel": None, "taal": "nl", "negatief": True, "morgen": False, "nietvol": True, "storing": True, "token": True}
LAGE_PRIJS = 0.05  # all-in per kWh; daaronder (of een negatieve beursprijs) volgt een melding

TEKST = {
    "nl": {
        "negatief_titel": "Morgen negatieve stroomprijs",
        "laag_titel": "Morgen zeer goedkope stroom",
        "laag": "Morgen {van}–{tot}: laagste prijs €{prijs} om {uur}. De batterij kan dan goedkoop laden.",
        "morgen_titel": "Goedkoopste moment morgen",
        "morgen": "Morgen {van}–{tot}, gemiddeld €{prijs} per kWh. Handig voor de wasmachine of vaatwasser.",
        "nietvol_titel": "Batterij vannacht niet vol",
        "nietvol": "De batterij kwam vannacht tot {pct}%.",
        "storing_titel": "Storing in je energiesysteem",
        "token_titel": "Enphase-token verloopt bijna",
        "token": "Je token verloopt over {dagen} dagen. Maak een nieuw token aan op entrez.enphaseenergy.com.",
        "test_titel": "Testmelding",
        "test": "Meldingen van de Enphase energie-app werken.",
    },
    "en": {
        "negatief_titel": "Negative electricity price tomorrow",
        "laag_titel": "Very cheap electricity tomorrow",
        "laag": "Tomorrow {van}–{tot}: lowest price €{prijs} at {uur}. The battery can charge cheaply.",
        "morgen_titel": "Cheapest moment tomorrow",
        "morgen": "Tomorrow {van}–{tot}, average €{prijs} per kWh. Handy for the washing machine or dishwasher.",
        "nietvol_titel": "Battery not full last night",
        "nietvol": "The battery reached {pct}% last night.",
        "storing_titel": "Fault in your energy system",
        "token_titel": "Enphase token expires soon",
        "token": "Your token expires in {dagen} days. Create a new token at entrez.enphaseenergy.com.",
        "test_titel": "Test notification",
        "test": "Notifications from the Enphase energy app work.",
    },
}


def beste_blok(uren, lengte):
    """Goedkoopste aaneengesloten blok van `lengte` uur. uren: lijst (start_ts, allin)."""
    beste = None
    for i in range(len(uren) - lengte + 1):
        blok = uren[i:i + lengte]
        if any(blok[j + 1][0] - blok[j][0] != 3600 for j in range(lengte - 1)):
            continue
        gem = sum(p for _, p in blok) / lengte
        if beste is None or gem < beste[1]:
            beste = (blok[0][0], gem)
    return beste


class Notifier(threading.Thread):
    def __init__(self, app, token, data_dir):
        super().__init__(daemon=True, name="meldingen")
        self.app = app
        self.token = token
        self.path = os.path.join(data_dir, "meldingen.json")
        self.lock = threading.Lock()
        self.cfg, self.verstuurd = self._laad()
        self._storing_gezien = {}
        self._diensten = None
        self._diensten_t = 0

    # --- instellingen -----------------------------------------------------------

    def _laad(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
            return {**STANDAARD, **(d.get("instellingen") or {})}, d.get("verstuurd") or {}
        except (OSError, ValueError):
            return dict(STANDAARD), {}

    def _bewaar(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"instellingen": self.cfg, "verstuurd": self.verstuurd}, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def instellingen(self):
        return {"instellingen": dict(self.cfg), "doelen": self.doelen(), "beschikbaar": bool(self.token)}

    def bewaar(self, nieuw):
        with self.lock:
            for k in STANDAARD:
                if k in nieuw:
                    self.cfg[k] = nieuw[k]
            if self.cfg.get("taal") not in TEKST:
                self.cfg["taal"] = "nl"
            self._bewaar()
        return self.instellingen()

    # --- Home Assistant -------------------------------------------------------

    def _ha(self, method, path, body=None):
        c = http.client.HTTPConnection(os.environ.get("HA_API_HOST", "supervisor"), timeout=15)
        try:
            c.request(method, "/core/api" + path, body=json.dumps(body) if body is not None else None,
                      headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
            r = c.getresponse()
            data = r.read()
            if r.status >= 300:
                raise RuntimeError(f"Home Assistant gaf {r.status}")
            return json.loads(data) if data else None
        finally:
            c.close()

    def doelen(self):
        """De telefoons waar Home Assistant meldingen naartoe kan sturen."""
        if not self.token:
            return []
        if self._diensten is not None and time.time() - self._diensten_t < 600:
            return self._diensten
        try:
            out = []
            for d in self._ha("GET", "/services") or []:
                if d.get("domain") == "notify":
                    for naam in (d.get("services") or {}):
                        if naam.startswith("mobile_app_"):
                            out.append({"id": naam, "naam": naam[len("mobile_app_"):].replace("_", " ").title()})
            self._diensten, self._diensten_t = out, time.time()
        except Exception as e:
            log.warning("telefoons voor meldingen niet opgehaald: %s", e)
            self._diensten = self._diensten or []
        return self._diensten

    def stuur(self, titel, tekst):
        doel = self.cfg.get("doel")
        if not (self.token and doel):
            return False
        try:
            self._ha("POST", "/services/notify/" + doel, {"title": titel, "message": tekst})
            log.info("melding verstuurd: %s", titel)
            return True
        except Exception as e:
            log.warning("melding niet verstuurd: %s", e)
            return False

    def test(self):
        t = TEKST[self.cfg.get("taal", "nl")]
        return self.stuur(t["test_titel"], t["test"])

    # --- controles ---------------------------------------------------------------

    def run(self):
        time.sleep(60)
        while True:
            try:
                self.controleer()
            except Exception as e:
                log.warning("controle voor meldingen mislukt: %s", e)
            time.sleep(300)

    def _eenmalig(self, sleutel, titel, tekst):
        if sleutel in self.verstuurd:
            return
        if self.stuur(titel, tekst):
            with self.lock:
                self.verstuurd[sleutel] = int(time.time())
                grens = time.time() - 60 * 86400
                self.verstuurd = {k: v for k, v in self.verstuurd.items() if v > grens}
                self._bewaar()

    def controleer(self):
        if not self.cfg.get("doel"):
            return
        t = TEKST[self.cfg.get("taal", "nl")]
        nu = dt.datetime.now(TZ)
        morgen = nu.date() + dt.timedelta(days=1)
        geld = lambda v: f"{v:.3f}".replace(".", ",") if self.cfg.get("taal") == "nl" else f"{v:.3f}"

        # Prijzen van morgen
        if nu.hour >= 13 and self.app.prices.complete(morgen):
            dag = calc.price_day(self.app.store, self.app.tariffs, morgen)
            uren = [(h["t"], h["allin"]) for h in dag]
            beurs = {h["t"]: h["epex"] for h in dag}
            if self.cfg.get("negatief") and uren:
                laag = [(ts, p) for ts, p in uren if p <= LAGE_PRIJS or beurs[ts] < 0]
                if laag:
                    ts_min, p_min = min(uren, key=lambda x: x[1])
                    negatief = any(beurs[ts] < 0 for ts, _ in laag)
                    self._eenmalig("laag:" + morgen.isoformat(), t["negatief_titel" if negatief else "laag_titel"],
                                   t["laag"].format(van=_hhmm(laag[0][0]), tot=_hhmm(laag[-1][0] + 3600), prijs=geld(p_min), uur=_hhmm(ts_min)))
            if self.cfg.get("morgen") and nu.hour >= 14 and uren:
                b = beste_blok(uren, 2)
                if b:
                    self._eenmalig("morgen:" + morgen.isoformat(), t["morgen_titel"],
                                   t["morgen"].format(van=_hhmm(b[0]), tot=_hhmm(b[0] + 7200), prijs=geld(b[1])))

        # Batterij niet vol na het nachtladen
        if self.cfg.get("nietvol") and 8 <= nu.hour < 12:
            s, _ = day_bounds(nu.date())
            vol_ts, max_soc = self.app.store.first_soc_at_least(s, s + 9 * 3600, 99)
            if vol_ts is None and max_soc is not None:
                self._eenmalig("nietvol:" + nu.date().isoformat(), t["nietvol_titel"], t["nietvol"].format(pct=round(max_soc)))

        # Storingen en token: uit de systeemstatus
        status = self.app.system.get()
        if self.cfg.get("storing"):
            huidige = {m["tekst"] for m in status.get("meldingen", []) if m.get("niveau") == "fout"}
            for tekst in huidige:
                gezien = self._storing_gezien.setdefault(tekst, time.time())
                if time.time() - gezien >= 600:  # pas na 10 minuten: geen melding bij een kort haperen
                    self._eenmalig("storing:" + tekst + ":" + nu.date().isoformat(), t["storing_titel"],
                                   i18n.text(tekst) if self.cfg.get("taal") == "en" else tekst)
            for oud in list(self._storing_gezien):
                if oud not in huidige:
                    del self._storing_gezien[oud]
        if self.cfg.get("token"):
            dagen = (status.get("gateway") or {}).get("token_dagen")
            if isinstance(dagen, int):
                for grens in (30, 7):
                    if dagen <= grens:
                        self._eenmalig(f"token:{grens}:{(status.get('gateway') or {}).get('token_verloopt')}", t["token_titel"], t["token"].format(dagen=dagen))
                        break


def _hhmm(ts):
    return dt.datetime.fromtimestamp(ts, TZ).strftime("%H:%M")
