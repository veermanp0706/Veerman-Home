"""Vertaling van de teksten die de server teruggeeft (Nederlands -> Engels).

De berekeningen blijven in het Nederlands; alleen het antwoord wordt bij
?taal=en vertaald. Onbekende teksten blijven ongewijzigd.
"""

import re

EXACT = {
    # algemeen / status
    "zojuist": "just now",
    "Wifi": "Wi-Fi", "Ethernet": "Ethernet", "Mobiel": "Mobile",
    "Gateway": "Gateway", "Omvormers": "Inverters", "Batterij": "Battery", "Meters": "Meters", "App": "App",
    "Productie (zon)": "Production (solar)", "Verbruik (net)": "Consumption (grid)",
    "Totaal verbruik": "Total consumption", "Meter": "Meter",
    "communiceert niet": "not communicating",
    "is niet actief": "not active",
    "de DC-schakelaar staat uit": "the DC switch is off",
    "al meer dan een dag geen melding": "no report for more than a day",
    "gateway niet ingesteld": "gateway not configured",
    "De gateway antwoordt niet. Controleer of hij aan staat en verbonden is met je netwerk.":
        "The gateway is not responding. Check that it is switched on and connected to your network.",
    "Het wifisignaal van de gateway is zwak.": "The gateway's Wi-Fi signal is weak.",
    "De gateway heeft geen verbinding met de Enphase-cloud. Lokaal werkt alles, maar de Enphase-app krijgt geen gegevens.":
        "The gateway has no connection to the Enphase cloud. Everything works locally, but the Enphase app receives no data.",
    "De status van de omvormers kon niet worden opgehaald.": "The inverter status could not be retrieved.",
    "De status van de batterij kon niet worden opgehaald.": "The battery status could not be retrieved.",
    "De prijzen van vandaag ontbreken; de kosten zijn daardoor niet compleet.":
        "Today's prices are missing, so the costs are incomplete.",
    "De prijzen van morgen zijn nog niet binnen.": "Tomorrow's prices have not arrived yet.",
    "Je token is verlopen. Maak een nieuw token aan op entrez.enphaseenergy.com.":
        "Your token has expired. Create a new token at entrez.enphaseenergy.com.",
    # historie
    "vorige week": "last week", "vorige maand": "last month", "vorig jaar": "last year",
}

DATE_WORDS = {
    "maandag": "Monday", "dinsdag": "Tuesday", "woensdag": "Wednesday", "donderdag": "Thursday",
    "vrijdag": "Friday", "zaterdag": "Saturday", "zondag": "Sunday",
    "januari": "January", "februari": "February", "maart": "March", "april": "April", "mei": "May",
    "juni": "June", "juli": "July", "augustus": "August", "september": "September",
    "oktober": "October", "november": "November", "december": "December",
    "jan": "Jan", "feb": "Feb", "mrt": "Mar", "apr": "Apr", "jun": "Jun", "jul": "Jul",
    "aug": "Aug", "sep": "Sep", "okt": "Oct", "nov": "Nov", "dec": "Dec",
    "ma": "Mon", "di": "Tue", "wo": "Wed", "do": "Thu", "vr": "Fri", "za": "Sat", "zo": "Sun",
    "week": "Week",
}


def _date(s):
    """Vertaalt een datumlabel als alle woorden erin dag-, maand- of weeknamen zijn."""
    words = re.findall(r"[A-Za-z]+", s)
    if not words or not all(w.lower() in DATE_WORDS for w in words):
        return None
    return re.sub(r"[A-Za-z]+", lambda m: DATE_WORDS[m.group(0).lower()], s)


RULES = [
    (r"^(\d+) min geleden$", lambda m, t: f"{m[1]} min ago"),
    (r"^vandaag (\d\d:\d\d)$", lambda m, t: f"today {m[1]}"),
    (r"^gisteren (\d\d:\d\d)$", lambda m, t: f"yesterday {m[1]}"),
    (r"^(\d+) van (\d+)$", lambda m, t: f"{m[1]} of {m[2]}"),
    (r"^vorige (\w+)$", lambda m, t: "last " + DATE_WORDS.get(m[1].lower(), m[1])),
    (r"^temperatuur is hoog \((.+)\)$", lambda m, t: f"temperature is high ({m[1]})"),
    (r"^De opslag van de gateway is voor (.+)% vol\.$", lambda m, t: f"The gateway storage is {m[1]}% full."),
    (r"^Melding van de gateway: (.+)$", lambda m, t: f"Gateway message: {m[1]}"),
    (r"^Omvormer (\d+) \((.*?)\): (.+)\.$", lambda m, t: f"Inverter {m[1]} ({m[2]}): {t(m[3])}."),
    (r"^Batterij( \d+)?: (.+)\.$", lambda m, t: f"Battery{m[1] or ''}: {t(m[2])}."),
    (r"^De meter '(.+)' staat uit\.$", lambda m, t: f"The meter '{t(m[1])}' is off."),
    (r"^Je token verloopt over (\d+) dagen\. Maak op tijd een nieuw token aan\.$",
     lambda m, t: f"Your token expires in {m[1]} days. Create a new token in time."),
]
RULES = [(re.compile(p), f) for p, f in RULES]


def text(s):
    if s in EXACT:
        return EXACT[s]
    for rx, fn in RULES:
        m = rx.match(s)
        if m:
            return fn(m, text)
    d = _date(s)
    return d if d is not None else s


def translate(obj, taal):
    if taal != "en":
        return obj
    if isinstance(obj, str):
        return text(obj)
    if isinstance(obj, list):
        return [translate(x, taal) for x in obj]
    if isinstance(obj, dict):
        return {k: translate(v, taal) for k, v in obj.items()}
    return obj
