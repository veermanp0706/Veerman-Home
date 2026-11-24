# Veerman Home

Eén app voor je huis: energie (Enphase-zonnepanelen en -batterij, met de echte all-in stroomprijs van Vattenfall FlexPrijsStroom), klimaat, licht en zonwering.

## Instellen

1. Vul bij **Configuratie** het IP-adres van je IQ Gateway en je JWT-token in.
   Het token maak je aan op entrez.enphaseenergy.com; het is een jaar geldig.
2. Controleer de tarieven. Bedragen zijn **inclusief btw**, zoals Mijn Vattenfall ze toont.
3. Start de app en open **Thuis** in de zijbalk.

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

## Historie uit Home Assistant

Staat **Historie aanvullen uit Home Assistant** aan (standaard), dan haalt de app
uurtotalen op uit het Energie-dashboard van Home Assistant: zon, afname, teruglevering
en batterij. Is het Energie-dashboard niet ingesteld, dan zoekt de app de sensoren van
de Enphase-integratie. Dit vult alleen de uren aan die de app zelf niet heeft gemeten,
en wordt elke 6 uur bijgewerkt. De kosten van die periode worden berekend met de
huidige tarieven uit de instellingen.

## Klimaat, licht en zonwering

Deze schermen lezen en bedienen alles via Home Assistant. Er is niets extra in te stellen;
de app vindt de apparaten zelf:

- **Klimaat**: alle thermostaten (`climate.*`), zoals Tado X via Matter. De naam is de ruimte
  uit Home Assistant. Vochtigheid komt van de thermostaat of van een vochtsensor in dezelfde ruimte.
- **Licht**: alle losse lampen (`light.*`), per ruimte. Hue-ruimtes en -zones worden overgeslagen,
  Hue-scènes (`scene.*`) staan bovenaan.
- **Zonwering**: zonweringen met twee rails (`cover.*_top_rail` en `cover.*_bottom_rail`) en de
  scènes uit de scripts `script.zonwering_*`. De actieve scène staat in de tekst-helper
  `input_text.zonwering_scene`. Percentages zoals in PowerView: de middelste rail vanaf boven,
  het product (onderste rail) vanaf onder.

Werken deze schermen niet, controleer dan of **Home Assistant API** aan staat bij de app.
