"""Tijdhulpjes: alles wordt opgeslagen in UTC, getoond in Nederlandse tijd."""

import datetime as dt
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Amsterdam")


def day_bounds(day):
    """Begin en einde (epoch-seconden) van een lokale kalenderdag, ook bij zomer/wintertijd."""
    start = dt.datetime.combine(day, dt.time(0), TZ)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(0), TZ)
    return int(start.timestamp()), int(end.timestamp())


def parse_day(value):
    today = dt.datetime.now(TZ).date()
    if value in (None, "", "vandaag", "today"):
        return today
    if value in ("morgen", "tomorrow"):
        return today + dt.timedelta(days=1)
    return dt.date.fromisoformat(value)


def hhmm(epoch):
    return dt.datetime.fromtimestamp(epoch, TZ).strftime("%H:%M")
