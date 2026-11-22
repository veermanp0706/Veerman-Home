# Wijzigingen

## 0.6.0

- Historie vernieuwd: dagoverzicht met een ring (welk deel van je verbruik uit zon, batterij en net kwam), een grafiek met boven de lijn wat binnenkwam en onder de lijn waar het naartoe ging, per kwartier op de dagweergave, en de laadtoestand van de batterij.
- Tik op een kolom voor de waarden van dat moment.

- Het ophalen van de historie uit Home Assistant startte niet: de toegangssleutel werd bij de start van de container gewist. Opgelost.
- Op Status staat nu altijd of de historie uit Home Assistant aan staat, en zo niet, waarom.
- Tijden in het logboek staan nu in Nederlandse tijd.
- Nieuw app-icoon: een glazen zon met een gloeiende bliksem.
- Historie: stroomkosten met twee cijfers achter de komma.

## 0.5.1

- Historie aanvullen uit Home Assistant: de app haalt uurtotalen op uit het Energie-dashboard (of de Enphase-integratie) voor de periode van vóór de app, inclusief de prijzen van die dagen. Te zien op Status onder App.
- Omvormers die 's nachts slapen geven geen storing meer. Een storing komt alleen nog als een omvormer overdag langer dan een uur niets meldt terwijl de rest wel werkt.

## 0.5.0

- Nieuw liquid-glass-ontwerp: doorschijnende glaskaarten, glanzend oranje kop en een zwevend glazen menu.
- Nieuw lettertype: Manrope.
- Instellingenpagina via het tandwiel naast "Live" op Nu.
- Weergave Licht, Donker of Automatisch (volgt je telefoon, ook bij zonsopgang en zonsondergang).
- Taal Nederlands of English; alle teksten in beide talen.

## 0.4.1

- Historie: het blokje met de opbrengst van de batterij is weg; de stroomkosten staan nu gecentreerd.

## 0.4.0

- Nieuw scherm Status: werkt alles nog? Per onderdeel de stand van zaken, met bovenaan een samenvatting en eventuele aandachtspunten.
  - Zonnepanelen en omvormers: per paneel het huidige vermogen, laatste melding, en of de omvormer communiceert.
  - Batterij: status, laadtoestand, temperatuur, communicatie, slaapstand.
  - Gateway: bereikbaarheid, wifi of ethernet en signaal, verbinding met de Enphase-cloud, opslag, firmware, en tot wanneer het token geldig is.
  - Meters: of de meters voor productie, verbruik en batterij actief zijn.
  - App: versie, prijzen binnen, database.
- Een rode stip bij Status in het menu als er iets aandacht nodig heeft, ook als je op een ander scherm bent.
- Menu met vijf knoppen: Prijzen, Historie, Nu (uitgelicht in het midden), Batterij, Status.
- Waarschuwing als het token binnen 30 dagen verloopt.

## 0.3.4

- iPhone-icoon: oranje zonnepaneel op een donkere achtergrond, zodat het oranje ook in de donkere stijl van het beginscherm zichtbaar blijft.

## 0.3.3

- iPhone-icoon: wit zonnepaneel op oranje, zodat het ook zichtbaar blijft als het beginscherm in de donkere stijl staat.

## 0.3.2

- Nieuw app-icoon: het zonnepaneel uit de zijbalk (solar-power-variant), zwart op oranje. Ook als PNG, zodat de iPhone het gebruikt bij "Zet op beginscherm".
- Icoon en logo in de App Store van Home Assistant.

## 0.3.1

- Het paneel Energie is ook te openen voor gebruikers die geen beheerder zijn (`panel_admin: false`).

## 0.3.0

- Energiestromen: groter diagram waarin zon, batterij, net en huis allemaal met elkaar verbonden zijn. De app berekent welke stroom van waar naar waar gaat (bijvoorbeeld zon naar batterij, of net naar batterij bij nachtladen).
- Geanimeerde stippen lopen van bron naar bestemming, twee keer per verversing. Lijndikte volgt het vermogen. Bij de systeeminstelling "minder beweging" staan de animaties uit.
- Bedragen en kWh overal met drie decimalen, ook op Nu en Prijzen.

## 0.2.1

- Scherm Nu: de melding zegt nu vanaf wanneer stroom weer voordelig is (eventueel morgen), of tot wanneer het voordelig blijft. Komt er eerst een duur blok, dan waarschuwt hij daarvoor.
- Historie en Batterij: kWh, bedragen en cycli met drie decimalen.

## 0.2.0

- Nieuw scherm Historie: kosten, verbruik, opwek, afname en teruglevering per dag, week, maand en jaar, met vergelijking met de vorige periode en een grafiek van waar je stroom vandaan kwam (zon, batterij of net).
- Nieuw scherm Batterij: laadcurve van vandaag, controle of het nachtladen gelukt is, geladen en ontladen, verlies, cycli en opbrengst per dag.
- Opbrengst van de batterij: waarde van de ontladen stroom min de inkoopwaarde van de stroom die daarvoor nodig was. Stroom die nog in de batterij zit telt niet als verlies.
- Scherm Nu toont vermogens in watt.
- Zwarte focusrand na een klik weggehaald; bij gebruik van het toetsenbord blijft hij zichtbaar.
- Nieuwe instelling: batterijcapaciteit (standaard 5,0 kWh).

## 0.1.1

- Installatie gerepareerd: de app wordt gebouwd op de nieuwe basis-image van Home Assistant.

## 0.1.0

- Eerste versie: scherm Nu (live energiestromen, prijs van dit moment, kosten vandaag) en scherm Prijzen (vandaag en morgen, blokken, opbouw van de prijs).
- Gateway lokaal uitlezen, opslag per minuut, EPEX-prijzen via EnergyZero, Vattenfall-tariefberekening.
- Historie en Batterij volgen in een volgende versie.
