# Enphase energie-app

Een snelle app voor je Enphase-zonnepanelen en -batterij, met de echte all-in stroomprijs van Vattenfall FlexPrijsStroom.

## Instellen

1. Vul bij **Configuratie** het IP-adres van je IQ Gateway en je JWT-token in.
   Het token maak je aan op entrez.enphaseenergy.com; het is een jaar geldig.
2. Controleer de tarieven. Bedragen zijn **inclusief btw**, zoals Mijn Vattenfall ze toont.
3. Start de add-on en open **Energie** in de zijbalk.

## Wat de app doet

- Leest de gateway elke paar seconden lokaal uit. Hij verandert niets aan je instellingen.
  Alleen als de live-meting van de gateway uit staat, zet de app die aan, net zoals de Enphase-app doet.
- Bewaart per minuut een gemiddelde op de Pi (`/data/energie.db`).
- Haalt elk uur de EPEX-prijzen op bij EnergyZero, voor morgen vanaf 13:00.
- Rekent per uur: (beursprijs × 1,21) + inkoopvergoeding + energiebelasting.
- Teruglevering: tot de saldering stopt even veel waard als afname, min de verkoopvergoeding.
  Daarna de beursprijs zonder btw, met het minimum van 50% tot 2030.

## Problemen

- **"token geweigerd"**: het token is verlopen. Maak een nieuw token aan en vul het in.
- **Geen prijzen**: EnergyZero is tijdelijk niet bereikbaar. De app probeert het elke 5 minuten opnieuw.
- **Status bekijken**: open in de web-app het adres `api/status`.
