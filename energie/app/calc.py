"""Berekeningen: prijsniveaus, blokken, energie per uur en kosten."""

import datetime as dt

from timeutil import TZ, day_bounds, hhmm

GOEDKOOP, NORMAAL, DUUR = "goedkoop", "normaal", "duur"


def levels(prices):
    """Indeling per dag: onderste kwart goedkoop, bovenste kwart duur."""
    values = sorted(prices.values())
    if not values:
        return {}
    n = len(values)
    low = values[int(0.25 * (n - 1))]
    high = values[int(round(0.75 * (n - 1)))]
    out = {}
    for ts, p in prices.items():
        if high - low < 0.005:
            out[ts] = NORMAAL
        elif p <= low:
            out[ts] = GOEDKOOP
        elif p >= high:
            out[ts] = DUUR
        else:
            out[ts] = NORMAAL
    return out


def blocks(hours, start_ts=None, limit=4):
    """Aaneengesloten uren met hetzelfde niveau, vanaf start_ts."""
    out = []
    for h in hours:
        if start_ts is not None and h["t"] + 3600 <= start_ts:
            continue
        if out and out[-1]["level"] == h["level"]:
            b = out[-1]
            b["end"] = h["t"] + 3600
            b["min"] = min(b["min"], h["allin"])
            b["max"] = max(b["max"], h["allin"])
        else:
            out.append({"start": h["t"], "end": h["t"] + 3600, "level": h["level"], "min": h["allin"], "max": h["allin"]})
    for b in out:
        b["van"] = hhmm(b["start"])
        b["tot"] = hhmm(b["end"] - 60)
    return out[:limit]


def price_day(store, tariffs, day):
    start, end = day_bounds(day)
    prices = store.prices(start, end)
    lv = levels(prices)
    hours = []
    for ts in sorted(prices):
        epex = prices[ts]
        hours.append({
            "t": ts,
            "uur": hhmm(ts),
            "epex": round(epex, 5),
            "allin": round(tariffs.import_price(epex), 4),
            "terug": round(tariffs.export_value(epex, day), 4),
            "level": lv[ts],
        })
    return hours


def summary(hours):
    if not hours:
        return None
    low = min(hours, key=lambda h: h["allin"])
    high = max(hours, key=lambda h: h["allin"])
    return {
        "laagste": low["allin"], "laagste_uur": low["uur"],
        "hoogste": high["allin"], "hoogste_uur": high["uur"],
        "gemiddeld": round(sum(h["allin"] for h in hours) / len(hours), 4),
    }


def energy_by_hour(rows):
    """Per uur in kWh, uit gemiddelden per minuut."""
    out = {}
    for r in rows:
        hour = r["ts"] - r["ts"] % 3600
        e = out.setdefault(hour, {"load": 0.0, "pv": 0.0, "import": 0.0, "export": 0.0, "batt_out": 0.0, "batt_in": 0.0})
        k = 1 / 60000  # watt gedurende een minuut naar kWh
        e["load"] += (r["load"] or 0) * k
        e["pv"] += (r["pv"] or 0) * k
        g = r["grid"] or 0
        b = r["batt"] or 0
        e["import" if g > 0 else "export"] += abs(g) * k
        e["batt_out" if b > 0 else "batt_in"] += abs(b) * k
    return out


def day_totals(store, tariffs, day, extra_rows=()):
    start, end = day_bounds(day)
    rows = store.minutes(start, end) + [r for r in extra_rows if start <= r["ts"] < end]
    per_hour = energy_by_hour(rows)
    prices = store.prices(start, end)
    tot = {"load": 0.0, "pv": 0.0, "import": 0.0, "export": 0.0, "batt_out": 0.0, "batt_in": 0.0}
    cost = 0.0
    missing = 0
    for hour, e in per_hour.items():
        for k in tot:
            tot[k] += e[k]
        epex = prices.get(hour)
        if epex is None:
            missing += 1
            continue
        cost += e["import"] * tariffs.import_price(epex) - e["export"] * tariffs.export_value(epex, day)
    return {
        "verbruik_kwh": round(tot["load"], 3),
        "opgewekt_kwh": round(tot["pv"], 3),
        "afname_kwh": round(tot["import"], 3),
        "terug_kwh": round(tot["export"], 3),
        "batterij_uit_kwh": round(tot["batt_out"], 3),
        "batterij_in_kwh": round(tot["batt_in"], 3),
        "kosten": round(cost, 3),
        "vaste_kosten_dag": round(tariffs.fixed_day, 3),
        "uren_zonder_prijs": missing,
    }


def next_moment(price, rest_today, tomorrow):
    """Wat de melding op het scherm Nu moet zeggen.

    - Nu goedkoop: tot wanneer het voordelig blijft.
    - Nu normaal en eerst komt een duur blok: wanneer het duur wordt.
    - Anders: vanaf wanneer het weer voordelig (goedkoop) is, eventueel morgen.
    """
    if not price:
        return None
    upcoming = [dict(h, morgen=False) for h in rest_today] + [dict(h, morgen=True) for h in tomorrow]

    def first(pred):
        return next((h for h in upcoming if pred(h)), None)

    def pack(soort, h):
        return {"soort": soort, "uur": h["uur"], "allin": h["allin"], "morgen": h["morgen"]}

    if price["level"] == GOEDKOOP:
        h = first(lambda x: x["level"] != GOEDKOOP)
        return pack("voordelig_tot", h) if h else None
    goed = first(lambda x: x["level"] == GOEDKOOP)
    if price["level"] == NORMAAL:
        duur = first(lambda x: x["level"] == DUUR)
        if duur and (not goed or upcoming.index(duur) < upcoming.index(goed)):
            return pack("duur_vanaf", duur)
    return pack("voordelig_vanaf", goed) if goed else None


def current_hour(now=None):
    now = now or dt.datetime.now(TZ).timestamp()
    return int(now - now % 3600)
