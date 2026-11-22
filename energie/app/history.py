"""Historie en batterij: energie, kosten en opbrengst over een periode."""

import datetime as dt

from timeutil import TZ, hhmm

K = 1 / 60000  # wattminuut naar kWh
MAANDEN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]
DAGEN = ["ma", "di", "wo", "do", "vr", "za", "zo"]
PERIODES = ("dag", "week", "maand", "jaar")


def epoch(day):
    return int(dt.datetime.combine(day, dt.time(0), TZ).timestamp())


def add_months(day, n):
    m = day.month - 1 + n
    return dt.date(day.year + m // 12, m % 12 + 1, 1)


def period_bounds(periode, day):
    if periode == "dag":
        return day, day + dt.timedelta(days=1)
    if periode == "week":
        start = day - dt.timedelta(days=day.weekday())
        return start, start + dt.timedelta(days=7)
    if periode == "maand":
        start = day.replace(day=1)
        return start, add_months(start, 1)
    if periode == "jaar":
        return dt.date(day.year, 1, 1), dt.date(day.year + 1, 1, 1)
    raise ValueError(f"onbekende periode: {periode}")


def shift(periode, day, n):
    if periode == "dag":
        return day + dt.timedelta(days=n)
    if periode == "week":
        return day + dt.timedelta(days=7 * n)
    if periode == "maand":
        return add_months(day.replace(day=1), n)
    return dt.date(day.year + n, 1, 1)


def label(periode, start, end):
    if periode == "dag":
        return f"{DAGEN_LANG[start.weekday()].capitalize()} {start.day} {MAANDEN_LANG[start.month - 1]}"
    if periode == "week":
        last = end - dt.timedelta(days=1)
        return f"Week {start.isocalendar()[1]} · {start.day} {MAANDEN[start.month - 1]} – {last.day} {MAANDEN[last.month - 1]}"
    if periode == "maand":
        return f"{MAANDEN_LANG[start.month - 1].capitalize()} {start.year}"
    return str(start.year)


MAANDEN_LANG = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus",
                "september", "oktober", "november", "december"]


def hour_detail(h, price, tariffs, day):
    """Eén uur: kWh per stroom, en (als de prijs bekend is) kosten en batterijwaarde."""
    e = {k: (v or 0) * K for k, v in h.items() if k != "minutes"}
    e["net_house"] = max(e["load"] - e["pv_house"] - e["batt_house"], 0.0)
    e["batt_in_grid"] = max(e["batt_in"] - e["batt_in_pv"], 0.0)
    e["batt_out_grid"] = max(e["batt_out"] - e["batt_house"], 0.0)
    e["minutes"] = h.get("minutes") or 0
    if price is None:
        e["has_price"] = False
        return e
    p = tariffs.import_price(price)
    t = tariffs.export_value(price, day)
    e["has_price"] = True
    e["cost"] = e["import"] * p - e["export"] * t
    e["batt_value_out"] = e["batt_house"] * p + e["batt_out_grid"] * t
    e["batt_cost_in"] = e["batt_in_pv"] * t + e["batt_in_grid"] * p
    return e


def collect(store, tariffs, start_day, end_day):
    """Alle uren tussen twee lokale datums, met details."""
    start, end = epoch(start_day), epoch(end_day)
    hours = store.hourly(start, end)
    prices = store.prices(start, end)
    out = {}
    for ts, h in hours.items():
        day = dt.datetime.fromtimestamp(ts, TZ).date()
        out[ts] = hour_detail(h, prices.get(ts), tariffs, day)
    return out


def sum_details(details):
    tot = {k: 0.0 for k in ("load", "pv", "import", "export", "batt_in", "batt_out", "pv_house", "batt_house",
                             "net_house", "batt_in_grid", "batt_in_pv", "cost", "batt_value_out", "batt_cost_in")}
    tot["minutes"] = 0
    tot["missing_price"] = 0
    for e in details:
        for k in tot:
            if k in ("minutes", "missing_price"):
                continue
            tot[k] += e.get(k, 0.0)
        tot["minutes"] += e["minutes"]
        if not e["has_price"]:
            tot["missing_price"] += 1
    return tot


def battery_numbers(tot, cap, stored_delta=0.0):
    """Batterijcijfers. stored_delta = kWh die aan het eind meer in de batterij zit dan aan het begin.

    Opbrengst = waarde van de ontladen stroom - inkoopwaarde van de stroom die daarvoor nodig was.
    Stroom die nog in de batterij zit telt niet als verlies; die wordt gewaardeerd tegen de laadprijs.
    """
    out = tot["batt_out"]
    inn = tot["batt_in"]
    laadprijs = tot["batt_cost_in"] / inn if inn > 0.05 else None
    opbrengst = None
    if laadprijs is not None:
        verbruikt = max(inn - stored_delta, 0.0)
        opbrengst = tot["batt_value_out"] - laadprijs * verbruikt
    elif out <= 0.05:
        opbrengst = 0.0
    return {
        "geladen_kwh": round(inn, 2),
        "ontladen_kwh": round(out, 2),
        "uit_net_kwh": round(tot["batt_in_grid"], 2),
        "uit_zon_kwh": round(tot["batt_in_pv"], 2),
        "cycli": round(out / cap, 2) if cap else None,
        "opbrengst": round(opbrengst, 2) if opbrengst is not None else None,
        "laadprijs": round(laadprijs, 3) if laadprijs is not None else None,
        "gebruiksprijs": round(tot["batt_value_out"] / out, 3) if out > 0.05 else None,
    }


def stored_delta(store, start_day, end_day, cap):
    a, b = store.soc_edges(epoch(start_day), epoch(end_day))
    if a is None or b is None:
        return 0.0
    return (b - a) / 100 * cap


def totals_json(tot, cap, delta=0.0):
    return {
        "verbruik_kwh": round(tot["load"], 2),
        "opgewekt_kwh": round(tot["pv"], 2),
        "afname_kwh": round(tot["import"], 2),
        "terug_kwh": round(tot["export"], 2),
        "kosten": round(tot["cost"], 2),
        "batterij": battery_numbers(tot, cap, delta),
        "uren_zonder_prijs": tot["missing_price"],
        "meetminuten": tot["minutes"],
    }


def period(store, tariffs, periode, day, cap):
    if periode not in PERIODES:
        raise ValueError(f"onbekende periode: {periode}")
    start_day, end_day = period_bounds(periode, day)
    details = collect(store, tariffs, start_day, end_day)

    # Emmers voor de grafiek
    buckets = []
    if periode == "dag":
        for ts in range(epoch(start_day), epoch(end_day), 3600):
            buckets.append({"key": ts, "label": hhmm(ts)[:2], "items": []})
        index = {b["key"]: b for b in buckets}
        for ts, e in details.items():
            if ts in index:
                index[ts]["items"].append(e)
    elif periode in ("week", "maand"):
        d = start_day
        while d < end_day:
            buckets.append({"key": d, "label": DAGEN[d.weekday()] if periode == "week" else str(d.day), "items": []})
            d += dt.timedelta(days=1)
        index = {b["key"]: b for b in buckets}
        for ts, e in details.items():
            index[dt.datetime.fromtimestamp(ts, TZ).date()]["items"].append(e)
    else:
        for m in range(12):
            buckets.append({"key": m + 1, "label": MAANDEN[m], "items": []})
        for ts, e in details.items():
            buckets[dt.datetime.fromtimestamp(ts, TZ).month - 1]["items"].append(e)

    reeks = []
    for b in buckets:
        t = sum_details(b["items"])
        reeks.append({
            "label": b["label"],
            "zon": round(t["pv_house"], 3),
            "batterij": round(t["batt_house"], 3),
            "net": round(t["net_house"], 3),
            "kosten": round(t["cost"], 2),
            "heeft_data": t["minutes"] > 0,
        })

    tot = sum_details(details.values())

    # Vergelijking: dag met dezelfde dag vorige week, de rest met de vorige periode
    prev_day = shift(periode, day, -7 if periode == "dag" else -1)
    ps, pe = period_bounds(periode, prev_day)
    prev = sum_details(collect(store, tariffs, ps, pe).values())
    vergelijk = None
    if prev["minutes"] > 0:
        naam = {"dag": "vorige " + DAGEN_LANG[prev_day.weekday()], "week": "vorige week", "maand": "vorige maand", "jaar": "vorig jaar"}[periode]
        vergelijk = {"label": naam, "kosten": round(prev["cost"], 2)}

    today = dt.datetime.now(TZ).date()
    first = store.first_ts()
    return {
        "periode": periode,
        "datum": start_day.isoformat(),
        "titel": label(periode, start_day, end_day),
        "vorige": shift(periode, day, -1).isoformat(),
        "volgende": shift(periode, day, 1).isoformat() if shift(periode, day, 1) <= today else None,
        "eerder_beschikbaar": first is not None and first < epoch(start_day),
        "totaal": totals_json(tot, cap, stored_delta(store, start_day, end_day, cap)),
        "reeks": reeks,
        "vergelijk": vergelijk,
        "lopend": start_day <= today < end_day,
    }


DAGEN_LANG = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]


def battery(store, tariffs, day, cap):
    start, end = epoch(day), epoch(day + dt.timedelta(days=1))

    def day_stats(d):
        s, e = epoch(d), epoch(d + dt.timedelta(days=1))
        tot = sum_details(collect(store, tariffs, d, d + dt.timedelta(days=1)).values())
        soc_a, soc_b = store.soc_edges(s, e)
        delta = (soc_b - soc_a) / 100 * cap if soc_a is not None and soc_b is not None else 0.0
        nums = battery_numbers(tot, cap, delta)
        verlies = None
        if soc_a is not None and soc_b is not None and nums["geladen_kwh"] > 0.5:
            opgeslagen = (soc_b - soc_a) / 100 * cap
            v = tot["batt_in"] - tot["batt_out"] - opgeslagen
            netto_in = tot["batt_in"] - opgeslagen
            verlies = {
                "kwh": round(max(v, 0), 2),
                "procent": round(max(v, 0) / netto_in * 100) if netto_in > 0.3 else None,
            }
        nums["verlies"] = verlies
        nums["heeft_data"] = tot["minutes"] > 0
        return nums

    vol_ts, max_soc = store.first_soc_at_least(start, start + 9 * 3600, 99)
    curve = [{"uur": round((t - start) / 3600, 3), "soc": round(v, 1)} for t, v in store.soc_series(start, end)]

    lijst = []
    for i in range(1, 8):
        d = day - dt.timedelta(days=i)
        st = day_stats(d)
        if st["heeft_data"]:
            lijst.append({"dag": f"{DAGEN[d.weekday()].capitalize()} {d.day} {MAANDEN[d.month - 1]}",
                          "ontladen_kwh": st["ontladen_kwh"], "opbrengst": st["opbrengst"]})

    return {
        "datum": day.isoformat(),
        "vandaag": day_stats(day),
        "gisteren": day_stats(day - dt.timedelta(days=1)),
        "curve": curve,
        "nachtladen": {
            "vol_om": hhmm(vol_ts) if vol_ts else None,
            "max_procent": round(max_soc) if max_soc is not None else None,
        },
        "dagen": lijst,
        "dagen_samen": round(sum(x["opbrengst"] or 0 for x in lijst), 2),
        "capaciteit_kwh": cap,
    }
