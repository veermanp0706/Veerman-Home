"""De rest van het huis, via Home Assistant: klimaat (Tado X via Matter), lampen en
scènes (Hue) en de zonwering (eigen PowerView-koppeling plus de zonwering-scripts).

De app praat alleen met Home Assistant, nooit rechtstreeks met de apparaten."""

import http.client
import json
import logging
import os
import re
import threading
import time

log = logging.getLogger("thuis")

RAIL = re.compile(r"^cover\.(.+)_(top|bottom)_rail$")
ZONWERING_SCRIPT = re.compile(r"^script\.zonwering_(?!zet$)\w+$")
SCENE_HELPER = "input_text.zonwering_scene"
# Volgorde van de zonwering-scènes zoals in de PowerView-app; onbekende namen komen erachter
SCENE_VOLGORDE = ["overdag 1", "overdag 2", "avond 1", "avond 2", "iemand naar binnen of buiten", "alles open", "alles dicht"]

AREA_TEMPLATE = (
    "{%- set ns = namespace(d=[]) -%}"
    "{%- for s in states.climate | list + states.light | list + states.cover | list + states.sensor | list -%}"
    "{%- set a = area_name(s.entity_id) -%}"
    "{%- if a -%}{%- set ns.d = ns.d + [[s.entity_id, a]] -%}{%- endif -%}"
    "{%- endfor -%}{{ ns.d | tojson }}"
)


FLOOR_TEMPLATE = (
    "{%- set ns = namespace(d=[]) -%}"
    "{%- for f in floors() -%}"
    "{%- set ns.d = ns.d + [[floor_name(f), floor_areas(f) | map('area_name') | list]] -%}"
    "{%- endfor -%}{{ ns.d | tojson }}"
)

# Weertoestanden van Home Assistant -> icoon in de app
WEER = {"sunny": "zon", "clear-night": "nacht", "partlycloudy": "halfbewolkt", "cloudy": "bewolkt", "fog": "mist",
        "rainy": "regen", "pouring": "regen", "lightning": "onweer", "lightning-rainy": "onweer", "hail": "regen",
        "snowy": "sneeuw", "snowy-rainy": "sneeuw", "windy": "wind", "windy-variant": "wind", "exceptional": "bewolkt"}
BFT = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118]  # bovengrenzen in km/u
RICHTING = ["N", "NO", "O", "ZO", "Z", "ZW", "W", "NW"]
MARGE = 3  # procent: binnen deze marge telt een stand als gelijk aan een scène
STAND_VAR = re.compile(r"(links|rechts)_(product|midden)")


class HAFout(Exception):
    pass


def _stappen(seq):
    """Alle losse stappen in een script, ook binnen parallel/sequence/choose."""
    if isinstance(seq, dict):
        seq = [seq]
    for stap in seq or []:
        if not isinstance(stap, dict):
            continue
        yield stap
        for sleutel in ("parallel", "sequence", "then", "else", "default"):
            if sleutel in stap:
                yield from _stappen(stap[sleutel])
        for keuze in stap.get("choose") or []:
            yield from _stappen((keuze or {}).get("sequence"))


def _cover_stap(stap):
    if (stap.get("action") or stap.get("service")) != "cover.set_cover_position":
        return None, None
    doel = stap.get("target") or {}
    eid = doel.get("entity_id") or stap.get("entity_id") or (stap.get("data") or {}).get("entity_id")
    if isinstance(eid, list):
        eid = eid[0] if len(eid) == 1 else None
    pos = (stap.get("data") or {}).get("position")
    if isinstance(pos, str) and pos.strip().isdigit():
        pos = int(pos)
    return eid, pos


class Home:
    def __init__(self, token, data_dir=None):
        self.token = token
        self._pad = os.path.join(data_dir, "thuis.json") if data_dir else None
        self.cfg = {"adres": ""}
        try:
            with open(self._pad) as f:
                self.cfg.update(json.load(f))
        except Exception:
            pass
        self._locatie = None
        self._standen = {}
        self._standen_t = 0.0
        self._states = None
        self._states_t = 0.0
        self._areas = {}
        self._areas_t = 0.0
        self._floors = []
        self._lock = threading.Lock()

    # --- Home Assistant ----------------------------------------------------------

    def _http(self, method, path, body=None):
        c = http.client.HTTPConnection(os.environ.get("HA_API_HOST", "supervisor"), timeout=15)
        try:
            c.request(method, "/core/api" + path, body=json.dumps(body) if body is not None else None,
                      headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
            r = c.getresponse()
            data = r.read()
            if r.status >= 300:
                raise HAFout(f"Home Assistant gaf {r.status}: {data[:200].decode('utf-8', 'replace')}")
            return data
        finally:
            c.close()

    def states(self):
        with self._lock:
            if self._states is not None and time.time() - self._states_t < 1.5:
                return self._states
        data = json.loads(self._http("GET", "/states") or b"[]")
        with self._lock:
            self._states = {s["entity_id"]: s for s in data}
            self._states_t = time.time()
            return self._states

    def areas(self):
        if time.time() - self._areas_t < 600:
            return self._areas
        try:
            tekst = self._http("POST", "/template", {"template": AREA_TEMPLATE}).decode("utf-8")
            self._areas = dict(json.loads(tekst or "[]"))
        except Exception as e:
            log.warning("ruimtes niet opgehaald: %s", e)
        try:
            tekst = self._http("POST", "/template", {"template": FLOOR_TEMPLATE}).decode("utf-8")
            self._floors = [{"naam": f, "ruimtes": [r for r in rs if r]} for f, rs in json.loads(tekst or "[]")]
        except Exception as e:
            log.warning("verdiepingen niet opgehaald: %s", e)
        self._areas_t = time.time()
        return self._areas

    def floors(self):
        self.areas()
        return self._floors

    def _volgorde(self):
        """Ruimtenaam -> (verdieping-index, ruimte-index, verdiepingnaam), zoals ingericht in Home Assistant."""
        uit = {}
        for fi, f in enumerate(self.floors()):
            for ri, r in enumerate(f["ruimtes"]):
                uit[r] = (fi, ri, f["naam"])
        return uit

    def call(self, domain, service, data):
        log.info("%s.%s %s", domain, service, data)
        self._http("POST", f"/services/{domain}/{service}", data)
        with self._lock:
            self._states_t = 0  # volgende keer vers ophalen

    # --- instellingen --------------------------------------------------------------

    def bewaar(self, nieuw):
        if "adres" in nieuw:
            self.cfg["adres"] = str(nieuw.get("adres") or "").strip()[:80]
        if self._pad:
            with open(self._pad, "w") as f:
                json.dump(self.cfg, f)
        return {"adres": self.cfg["adres"], "locatie": self._locatienaam()}

    def _locatienaam(self):
        """Naam van het huis uit Home Assistant, als er geen adres is ingevuld."""
        if self._locatie is None:
            try:
                self._locatie = json.loads(self._http("GET", "/config")).get("location_name") or ""
            except Exception:
                self._locatie = ""
        return self._locatie

    # --- overzicht ---------------------------------------------------------------

    def overzicht(self):
        st = self.states()
        ar = self.areas()
        return {
            "ok": True,
            "adres": self.cfg.get("adres") or self._locatienaam(),
            "adres_eigen": self.cfg.get("adres", ""),
            "zon": self._zon(st),
            "buiten": self._buiten(st),
            "weer": self._weer(st),
            "klimaat": self._klimaat(st, ar),
            "licht": self._licht(st, ar),
            "zonwering": self._zonwering(st),
        }

    def _weer(self, st):
        for eid, s in sorted(st.items()):
            if not eid.startswith("weather.") or s.get("state") in ("unavailable", "unknown"):
                continue
            a = s.get("attributes") or {}
            wind = self._getal(a.get("wind_speed"))
            eenheid = (a.get("wind_speed_unit") or "km/h").lower()
            if wind is not None and eenheid in ("m/s", "ms"):
                wind *= 3.6
            elif wind is not None and eenheid in ("mph",):
                wind *= 1.609
            elif wind is not None and eenheid in ("kn", "knots"):
                wind *= 1.852
            bft = None if wind is None else next((i for i, g in enumerate(BFT) if wind < g), 12)
            graden = self._getal(a.get("wind_bearing"))
            return {
                "toestand": s.get("state"),
                "icoon": WEER.get(s.get("state"), "bewolkt"),
                "temp": self._getal(a.get("temperature")),
                "vocht": self._getal(a.get("humidity")),
                "wind_bft": bft,
                "wind_kmh": None if wind is None else round(wind),
                "wind_graden": graden,
                "wind_richting": None if graden is None else RICHTING[int((graden % 360) / 45 + 0.5) % 8],
            }
        return None

    @staticmethod
    def _zon(st):
        """Zon op en zon onder uit sun.sun (tijdstippen in UTC, de app zet ze om naar de eigen tijd)."""
        a = (st.get("sun.sun") or {}).get("attributes") or {}
        return {"op": a.get("next_rising"), "onder": a.get("next_setting")} if a.get("next_rising") else None

    @staticmethod
    def _getal(v):
        try:
            return None if v in (None, "unknown", "unavailable") else float(v)
        except (TypeError, ValueError):
            return None

    def _buiten(self, st):
        for eid, s in st.items():
            if eid.startswith("weather.") and s.get("state") not in ("unavailable", "unknown"):
                return self._getal((s.get("attributes") or {}).get("temperature"))
        return None

    def _klimaat(self, st, ar):
        vocht_per_ruimte = {}
        for eid, s in st.items():
            a = s.get("attributes") or {}
            if eid.startswith("sensor.") and a.get("device_class") == "humidity" and ar.get(eid):
                v = self._getal(s.get("state"))
                if v is not None:
                    vocht_per_ruimte.setdefault(ar[eid], v)
        out = []
        for eid, s in st.items():
            if not eid.startswith("climate."):
                continue
            a = s.get("attributes") or {}
            ruimte = ar.get(eid)
            vocht = self._getal(a.get("current_humidity"))
            if vocht is None and ruimte:
                vocht = vocht_per_ruimte.get(ruimte)
            out.append({
                "id": eid,
                "naam": ruimte or a.get("friendly_name") or eid,
                "ruimte": ruimte,
                "temp": self._getal(a.get("current_temperature")),
                "doel": self._getal(a.get("temperature")),
                "min": self._getal(a.get("min_temp")) or 5.0,
                "max": self._getal(a.get("max_temp")) or 25.0,
                "stap": self._getal(a.get("target_temp_step")) or 0.5,
                "modus": s.get("state"),
                "actie": a.get("hvac_action"),
                "vocht": vocht,
                "bereikbaar": s.get("state") not in ("unavailable", "unknown"),
            })
        volg = self._volgorde()
        for k in out:
            v = volg.get(k["ruimte"])
            k["verdieping"] = v[2] if v else None
            k["_v"] = (v[0], v[1]) if v else (99, 0)
        out.sort(key=lambda k: (k["_v"], (k["naam"] or "").lower()))
        for k in out:
            del k["_v"]
        return out

    def _licht(self, st, ar):
        lampen = []
        for eid, s in st.items():
            if not eid.startswith("light."):
                continue
            a = s.get("attributes") or {}
            if a.get("is_hue_group") or isinstance(a.get("entity_id"), list):
                continue  # Hue-ruimtes en -zones zijn groepen; we tonen de losse lampen
            ruimte = ar.get(eid)
            naam = a.get("friendly_name") or eid
            if ruimte and naam.lower().startswith(ruimte.lower() + " ") and len(naam) > len(ruimte) + 1:
                naam = naam[len(ruimte) + 1:]
                naam = naam[:1].upper() + naam[1:]
            aan = s.get("state") == "on"
            bri = a.get("brightness")
            modi = a.get("supported_color_modes") or []
            lampen.append({
                "id": eid, "naam": naam, "ruimte": ruimte, "aan": aan,
                "helderheid": round(bri / 255 * 100) if aan and isinstance(bri, (int, float)) else None,
                "dimbaar": bool(modi) and modi != ["onoff"],
                "bereikbaar": s.get("state") not in ("unavailable", "unknown"),
            })
        lampen.sort(key=lambda l: ((l["ruimte"] or "~").lower(), l["naam"].lower()))
        scenes = []
        for eid, s in st.items():
            if not eid.startswith("scene."):
                continue
            a = s.get("attributes") or {}
            scenes.append({
                "id": eid,
                "naam": a.get("name") or a.get("friendly_name") or eid,
                "groep": a.get("group_name"),
                "laatst": s.get("state") if s.get("state") not in ("unknown", "unavailable") else None,
            })
        # Per groep de laatst gekozen scène markeren
        nieuwste = {}
        for sc in scenes:
            if sc["laatst"] and (sc["groep"] not in nieuwste or sc["laatst"] > nieuwste[sc["groep"]]["laatst"]):
                nieuwste[sc["groep"]] = sc
        for sc in scenes:
            sc["actief"] = nieuwste.get(sc["groep"]) is sc
        scenes.sort(key=lambda x: ((x["groep"] or "~").lower(), x["naam"].lower()))
        groepen = self._groepen(st, lampen, scenes)
        return {"lampen": lampen, "scenes": scenes, "groepen": groepen,
                "aan": sum(1 for l in lampen if l["aan"]), "totaal": len(lampen),
                "groepen_aan": sum(1 for g in groepen if g["aan"])}

    def _groepen(self, st, lampen, scenes):
        """Hue-ruimtes en -zones als groepen; een zone binnen één ruimte komt eronder te staan."""
        naam_aan = {}
        for eid, s in st.items():
            if eid.startswith("light."):
                a = s.get("attributes") or {}
                if not a.get("is_hue_group"):
                    naam_aan[a.get("friendly_name") or eid] = s.get("state") == "on"
        groepen = []
        for eid, s in st.items():
            a = s.get("attributes") or {}
            if not (eid.startswith("light.") and a.get("is_hue_group")):
                continue
            naam = a.get("friendly_name") or eid
            leden = [l for l in (a.get("lights") or []) if isinstance(l, str)]
            aan = s.get("state") == "on"
            bri = a.get("brightness")
            modi = a.get("supported_color_modes") or []
            groepen.append({
                "id": eid, "naam": naam, "soort": a.get("hue_type") or "room", "leden": leden,
                "lampen": len(leden), "lampen_aan": sum(1 for l in leden if naam_aan.get(l)),
                "aan": aan, "helderheid": round(bri / 255 * 100) if aan and isinstance(bri, (int, float)) else None,
                "dimbaar": bool(modi) and modi != ["onoff"],
                "bereikbaar": s.get("state") not in ("unavailable", "unknown"),
                "scenes": [{"id": sc["id"], "naam": sc["naam"], "actief": sc["actief"]} for sc in scenes if sc["groep"] == naam],
                "ouder": None,
            })
        kamers = [g for g in groepen if g["soort"] == "room"]
        for z in groepen:
            if z["soort"] == "zone" and z["leden"]:
                for k in kamers:
                    if set(z["leden"]) <= set(k["leden"]):
                        z["ouder"] = k["id"]
                        break
        volg = self._volgorde()
        sleutel = lambda g: (volg.get(g["naam"], (99, 0))[:2], g["naam"].lower())
        uit = []
        for g in sorted([g for g in groepen if not g["ouder"]], key=sleutel):
            uit.append(g)
            uit.extend(sorted([z for z in groepen if z["ouder"] == g["id"]], key=lambda z: z["naam"].lower()))
        for g in uit:
            del g["leden"]
        return uit

    def _zonwering(self, st):
        scenes = []
        for eid, s in st.items():
            if ZONWERING_SCRIPT.match(eid):
                naam = (s.get("attributes") or {}).get("friendly_name") or eid
                naam = re.sub(r"^Zonwering\s*[–-]\s*", "", naam)
                scenes.append({"id": eid, "naam": naam, "bezig": s.get("state") == "on"})
        def volgorde(sc):
            n = sc["naam"].lower()
            return (SCENE_VOLGORDE.index(n) if n in SCENE_VOLGORDE else len(SCENE_VOLGORDE), n)
        scenes.sort(key=volgorde)
        helper = st.get(SCENE_HELPER)
        actief = helper.get("state") if helper and helper.get("state") not in ("unknown", "unavailable", "") else None
        herkend = False
        bezig = next((sc for sc in scenes if sc["bezig"]), None)
        standen = self._scene_standen([sc["id"] for sc in scenes])
        if bezig:
            actief = bezig["naam"]
        elif standen:
            # welke scène past bij de stand van de gordijnen nu? (iemand kan ze met de hand of de PowerView-app hebben verzet)
            pos = {eid: self._getal((s.get("attributes") or {}).get("current_position")) for eid, s in st.items() if RAIL.match(eid)}
            beste = None
            for sc in scenes:
                doel = standen.get(sc["id"])
                if not doel:
                    continue
                if all(pos.get(eid) is not None and abs(pos[eid] - p) <= MARGE for eid, p in doel.items()):
                    if beste is None or len(doel) > len(standen[beste["id"]]):
                        beste = sc
            actief = beste["naam"] if beste else None
            herkend = beste is not None

        paren = {}
        for eid, s in st.items():
            m = RAIL.match(eid)
            if m:
                paren.setdefault(m.group(1), {})[m.group(2)] = s
        gordijnen = []
        for sleutel, p in sorted(paren.items()):
            onder, boven = p.get("bottom"), p.get("top")
            naam_bron = onder or boven
            naam = (naam_bron.get("attributes") or {}).get("friendly_name") or sleutel
            naam = re.sub(r"\s*(bottom|top)\s*rail$", "", naam, flags=re.I).strip() or sleutel
            pos = lambda s: self._getal((s.get("attributes") or {}).get("current_position")) if s else None
            p_onder, p_boven = pos(onder), pos(boven)
            gordijnen.append({
                "sleutel": sleutel,
                "naam": naam,
                "onder_id": onder["entity_id"] if onder else None,
                "boven_id": boven["entity_id"] if boven else None,
                # Zoals in de PowerView-app: product (onderste rail) vanaf onder, middelste rail vanaf boven
                "product": None if p_onder is None else round(p_onder),
                "rail": None if p_boven is None else round(100 - p_boven),
                "bereikbaar": all(s and s.get("state") not in ("unavailable", "unknown") for s in (onder, boven)),
            })
        return {"scenes": scenes, "actief": actief, "herkend": herkend, "kan_herkennen": bool(standen),
                "gordijnen": gordijnen, "helper": helper is not None}

    def _script_config(self, obj):
        return json.loads(self._http("GET", f"/config/script/config/{obj}") or b"{}")

    def _scene_standen(self, ids):
        """Per zonwering-script de stand die het instelt: {script: {cover-entiteit: positie in Home Assistant}}.
        Gelezen uit de scripts zelf, zodat een gewijzigde scène vanzelf meekomt. Eens per 10 minuten."""
        if time.time() - self._standen_t < 600:
            return self._standen
        self._standen_t = time.time()
        try:
            zet = self._script_config("zonwering_zet")
        except Exception as e:
            log.info("scènes niet herkenbaar (script-config niet leesbaar): %s", e)
            self._standen = {}
            return self._standen
        var = {}  # links_product -> cover.x_bottom_rail
        for stap in _stappen(zet.get("sequence")):
            eid, pos = _cover_stap(stap)
            if eid and isinstance(pos, str):
                m = STAND_VAR.search(pos)
                if m:
                    var[m.group(0)] = eid
        uit = {}
        for sid in ids:
            try:
                cfg = self._script_config(sid.split(".", 1)[1])
            except Exception:
                continue
            doel = {}
            for stap in _stappen(cfg.get("sequence")):
                actie = stap.get("action") or stap.get("service")
                if actie == "script.zonwering_zet":
                    for k, v in (stap.get("data") or {}).items():
                        if k in var and isinstance(v, (int, float)):
                            # product telt vanaf onder (zoals HA); de middelste rail telt PowerView vanaf boven
                            doel[var[k]] = v if k.endswith("product") else 100 - v
                eid, pos = _cover_stap(stap)
                if eid and isinstance(pos, (int, float)):
                    doel[eid] = pos
            if doel:
                uit[sid] = doel
        self._standen = uit
        return uit

    # --- acties ------------------------------------------------------------------

    def actie(self, body):
        soort = body.get("soort")
        eid = str(body.get("id") or "")
        st = self.states()

        def moet(prefix):
            if not eid.startswith(prefix) or eid not in st:
                raise ValueError("onbekend apparaat: " + eid)

        if soort == "temperatuur":
            moet("climate.")
            a = st[eid].get("attributes") or {}
            lo, hi = self._getal(a.get("min_temp")) or 5.0, self._getal(a.get("max_temp")) or 25.0
            temp = min(max(float(body["waarde"]), lo), hi)
            self.call("climate", "set_temperature", {"entity_id": eid, "temperature": temp})
        elif soort == "licht":
            moet("light.")
            self.call("light", "turn_on" if body.get("aan") else "turn_off", {"entity_id": eid})
        elif soort == "helderheid":
            moet("light.")
            pct = int(min(max(float(body["waarde"]), 1), 100))
            self.call("light", "turn_on", {"entity_id": eid, "brightness_pct": pct})
        elif soort == "groep":
            moet("light.")
            self.call("light", "turn_on" if body.get("aan") else "turn_off", {"entity_id": eid})
        elif soort == "alles_uit":
            aan = [l["id"] for l in self._licht(st, self.areas())["lampen"] if l["aan"]]
            if aan:
                self.call("light", "turn_off", {"entity_id": aan})
        elif soort == "scene":
            moet("scene.")
            self.call("scene", "turn_on", {"entity_id": eid})
        elif soort == "zonwering_scene":
            if not ZONWERING_SCRIPT.match(eid) or eid not in st:
                raise ValueError("onbekende scène: " + eid)
            self.call("script", "turn_on", {"entity_id": eid})
        elif soort == "rail":
            m = RAIL.match(eid)
            if not m or eid not in st:
                raise ValueError("onbekende rail: " + eid)
            pct = int(min(max(float(body["waarde"]), 0), 100))
            ha_pos = pct if m.group(2) == "bottom" else 100 - pct
            self.call("cover", "set_cover_position", {"entity_id": eid, "position": ha_pos})
        else:
            raise ValueError("onbekende actie: " + str(soort))
        return {"ok": True}


class DemoHome(Home):
    """Een nep-huis om de app zonder Home Assistant te kunnen bekijken."""

    def __init__(self):
        super().__init__(token=None)
        self._locatie = "Thuis"
        self._areas = {}
        self._areas_t = time.time() + 10 ** 9
        st = {}

        def zet(eid, state, area=None, **attrs):
            st[eid] = {"entity_id": eid, "state": state, "attributes": attrs}
            if area:
                self._areas[eid] = area

        zet("sun.sun", "above_horizon", next_rising="2026-11-27T07:24:00+00:00", next_setting="2026-11-26T15:37:00+00:00")
        zet("weather.forecast_home", "partlycloudy", temperature=7.8, humidity=86, wind_speed=24.1, wind_speed_unit="km/h", wind_bearing=225)
        self._floors = [
            {"naam": "Begane grond", "ruimtes": ["Schuur", "Meterkast", "Keuken", "Eettafel", "Woonkamer", "Achtertuin"]},
            {"naam": "Eerste verdieping", "ruimtes": ["Badkamer", "Slaapkamer Lotte", "Slaapkamer Sander", "Logeerkamer"]},
            {"naam": "Tweede verdieping", "ruimtes": ["Waskamer", "Berging", "Slaapkamer Peter & Monique"]},
            {"naam": "Derde verdieping", "ruimtes": ["Dak"]},
        ]
        for i, (kamer, temp, doel, vocht, actie) in enumerate([
                ("Woonkamer", 21.0, 21.5, 49, "heating"), ("Badkamer", 22.6, 22.0, 63, "idle"),
                ("Slaapkamer Lotte", 18.2, 18.0, 51, "idle"), ("Slaapkamer Sander", 17.4, 18.0, 52, "heating"),
                ("Logeerkamer", 14.6, 15.0, 55, "heating"), ("Waskamer", 19.9, 19.0, 58, "idle"),
                ("Berging", 12.4, 12.0, 61, "idle"), ("Slaapkamer Peter & Monique", 17.8, 18.0, 50, "idle")]):
            zet(f"climate.thermostaat_{i}", "heat", kamer, friendly_name=f"{kamer} thermostaat", current_temperature=temp,
                temperature=doel, min_temp=5, max_temp=25, target_temp_step=0.5, hvac_action=actie)
            zet(f"sensor.vocht_{i}", str(vocht), kamer, device_class="humidity", unit_of_measurement="%")
        lampen = {"Keuken": [("Spot 1", True, 70), ("Spot 2", True, 70), ("Spot 3", True, 70), ("Keukenraam links", True, 55), ("Keukenraam rechts", True, 55)],
                  "Eettafel": [("Hanglamp 1", True, 45), ("Hanglamp 2", True, 45), ("Hanglamp 3", True, 45)],
                  "Woonkamer": [("Plafond", True, 60), ("Leeslamp", True, 60), ("Kast", True, 60), ("Staande lamp", False, 0)],
                  "Achtertuin": [("Tuinlamp 1", False, 0), ("Tuinlamp 2", False, 0)]}
        for kamer, ls in lampen.items():
            namen = []
            for naam, aan, pct in ls:
                eid = f"light.{kamer.lower()}_{naam.lower().replace(' ', '_')}"
                volledig = f"{kamer} {naam}"
                namen.append(volledig)
                kleur = ["onoff"] if kamer == "Achtertuin" else ["color_temp", "xy"]
                zet(eid, "on" if aan else "off", kamer, friendly_name=volledig, brightness=round(pct * 2.55) if aan else None, supported_color_modes=kleur)
            groep_aan = any(a for _, a, _ in ls)
            pct = max(p for _, _, p in ls)
            zet(f"light.{kamer.lower()}", "on" if groep_aan else "off", kamer, friendly_name=kamer, is_hue_group=True, hue_type="room",
                lights=namen, brightness=round(pct * 2.55) if groep_aan else None,
                supported_color_modes=["onoff"] if kamer == "Achtertuin" else ["color_temp", "xy"])
        zet("light.keukenraam", "on", "Keuken", friendly_name="Keukenraam", is_hue_group=True, hue_type="zone",
            lights=["Keuken Keukenraam links", "Keuken Keukenraam rechts"], brightness=round(55 * 2.55), supported_color_modes=["color_temp", "xy"])
        for groep, namen in [("Woonkamer", ["Ontspannen", "Helder", "Avond", "Film", "Gedimd", "Concentreren"]),
                             ("Keuken", ["Koken", "Helder", "Gedimd"]), ("Eettafel", ["Diner", "Gezellig", "Helder"]),
                             ("Keukenraam", ["Sfeer", "Helder"])]:
            for i, naam in enumerate(namen):
                actief = (groep, naam) in (("Woonkamer", "Ontspannen"), ("Eettafel", "Diner"))
                zet(f"scene.{groep.lower()}_{naam.lower()}", "2026-11-24T18:0%d:00+00:00" % i if actief else "unknown",
                    friendly_name=f"{groep} {naam}", name=naam, group_name=groep)
        for sleutel, naam in [("overdag_1", "Overdag 1"), ("overdag_2", "Overdag 2"), ("avond_1", "Avond 1"), ("avond_2", "Avond 2"),
                              ("iemand_binnen_buiten", "Iemand naar binnen of buiten"), ("alles_open", "Alles open"), ("alles_dicht", "Alles dicht")]:
            zet(f"script.zonwering_{sleutel}", "off", friendly_name=f"Zonwering – {naam}")
        zet("script.zonwering_zet", "off", friendly_name="Zonwering – stand zetten (hulpscript)")
        zet(SCENE_HELPER, "Overdag 1", friendly_name="Zonwering scène")
        for code, naam, product, rail in [("du1_b95e", "Links", 40, 50), ("du1_beb4", "Rechts", 37, 53)]:
            zet(f"cover.{code}_bottom_rail", "open", "Woonkamer", friendly_name=f"{naam} Bottom rail", current_position=product)
            zet(f"cover.{code}_top_rail", "open", "Woonkamer", friendly_name=f"{naam} Top rail", current_position=100 - rail)
        self._demo = st
        self._scenes = {
            "overdag_1": (40, 50, 37, 53), "overdag_2": (37, 53, 40, 50), "avond_1": (15, 47, 10, 50), "avond_2": (15, 15, 10, 10),
            "alles_open": (100, 0, 100, 0), "alles_dicht": (0, 0, 0, 0), "iemand_binnen_buiten": (80, 15, None, None),
        }

    def states(self):
        return self._demo

    def _script_config(self, obj):
        if obj == "zonwering_zet":
            return {"sequence": [{"parallel": [
                {"action": "cover.set_cover_position", "target": {"entity_id": f"cover.{code}_{rail}_rail"},
                 "data": {"position": ("{{ %s_product }}" if rail == "bottom" else "{{ 100 - (%s_midden | int) }}") % kant}}
                for rail in ("bottom", "top")]} for code, kant in (("du1_b95e", "links"), ("du1_beb4", "rechts"))]}
        lp, lr, rp, rr = self._scenes[obj[len("zonwering_"):]]
        if rp is None:
            return {"sequence": [{"parallel": [{"action": "cover.set_cover_position", "target": {"entity_id": "cover.du1_b95e_top_rail"}, "data": {"position": 100 - lr}},
                                               {"action": "cover.set_cover_position", "target": {"entity_id": "cover.du1_b95e_bottom_rail"}, "data": {"position": lp}}]}]}
        return {"sequence": [{"action": "script.zonwering_zet", "data": {"links_product": lp, "links_midden": lr, "rechts_product": rp, "rechts_midden": rr}}]}

    def floors(self):
        return self._floors

    def call(self, domain, service, data):
        st = self._demo
        ids = data.get("entity_id")
        ids = ids if isinstance(ids, list) else [ids]
        for eid in ids:
            s = st[eid]
            a = s["attributes"]
            if domain == "climate":
                a["temperature"] = data["temperature"]
            elif domain == "light":
                s["state"] = "on" if service == "turn_on" else "off"
                if service == "turn_on":
                    a["brightness"] = round(data.get("brightness_pct", round((a.get("brightness") or 200) / 2.55)) * 2.55)
                if a.get("is_hue_group"):  # de lampen van de groep gaan mee
                    for leid, ls in st.items():
                        if leid.startswith("light.") and ls["attributes"].get("friendly_name") in (a.get("lights") or []):
                            ls["state"] = s["state"]
                            ls["attributes"]["brightness"] = a.get("brightness")
            elif domain == "scene":
                s["state"] = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
            elif domain == "cover":
                a["current_position"] = data["position"]
            elif domain == "script":
                sleutel = eid[len("script.zonwering_"):]
                lp, lr, rp, rr = self._scenes.get(sleutel, (None,) * 4)
                for code, p, r in [("du1_b95e", lp, lr), ("du1_beb4", rp, rr)]:
                    if p is not None:
                        st[f"cover.{code}_bottom_rail"]["attributes"]["current_position"] = p
                        st[f"cover.{code}_top_rail"]["attributes"]["current_position"] = 100 - r
                st[SCENE_HELPER]["state"] = s["attributes"]["friendly_name"].replace("Zonwering – ", "")
