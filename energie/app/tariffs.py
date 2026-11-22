"""Vattenfall FlexPrijsStroom: van beursprijs naar wat een kWh je echt kost of oplevert.

Bedragen in de instellingen zijn inclusief btw, zoals Vattenfall ze toont.
"""

import datetime as dt


class Tariffs:
    def __init__(self, opts):
        self.btw = float(opts.get("btw", 21)) / 100
        self.inkoop = float(opts.get("inkoopvergoeding", 0.015))
        self.eb = float(opts.get("energiebelasting", 0.110848))
        self.verkoop = float(opts.get("verkoopvergoeding", 0.0))
        self.saldering_tot = dt.date.fromisoformat(str(opts.get("saldering_tot", "2027-01-01")))
        self.fixed_day = (
            float(opts.get("vaste_leveringskosten_dag", 0.196915))
            + float(opts.get("netbeheer_dag", 1.309704))
            - float(opts.get("vermindering_eb_dag", 1.723173))
        )

    def import_price(self, epex):
        """All-in prijs per afgenomen kWh."""
        return epex * (1 + self.btw) + self.inkoop + self.eb

    def export_value(self, epex, day):
        """Wat een teruggeleverde kWh oplevert."""
        if day < self.saldering_tot:
            # Saldering: wegstrepen tegen afname, inclusief energiebelasting en inkoopvergoeding.
            return self.import_price(epex) - self.verkoop
        inkoop_ex = self.inkoop / (1 + self.btw)
        # Vanaf 2027: beursprijs zonder btw, minimaal 50% van (beurs + inkoopvergoeding) tot 2030.
        floor = 0.5 * (epex + inkoop_ex) if day < dt.date(2030, 1, 1) else epex
        return max(epex, floor) - self.verkoop

    def breakdown(self, epex):
        beurs = epex * (1 + self.btw)
        return {
            "beurs": round(beurs, 4),
            "inkoop": round(self.inkoop, 4),
            "energiebelasting": round(self.eb, 4),
            "totaal": round(beurs + self.inkoop + self.eb, 4),
        }

    def saldering_actief(self, day):
        return day < self.saldering_tot
