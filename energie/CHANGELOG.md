# Wijzigingen

## 1.1.0

Minder is meer: Ontwerp 3.

- Menu: Stroom · Klimaat · Licht · Zonwering · Instellingen. De pagina Thuis is weg. De app opent op de pagina waar je het laatst was.
- Energie heet nu **Stroom**, zonder tandwiel. Drie tabs: Overzicht, Prijzen & advies en Systeem. Op de iPad staan ze als submenu onder Stroom in de zijbalk.
- Overzicht: geen melding meer over wanneer het tarief zakt en geen goedkoop/duur-label. Nieuw: de batterijgrafiek van vandaag, met het nachtlaadblok.
- Prijzen & advies (was Prijzen en Advies):
  - het advies voor vannacht staat bovenaan;
  - één prijsgrafiek voor vandaag en morgen, met de verwachte zon (gele lijn) en het laadblok van vannacht (groen), alles in de legenda;
  - daaronder Beste moment voor apparaten, Waarom dit advies en Hoe goed is het advies;
  - het blok met de stappen voor de Enphase-app is weg, net als de lijst met prijsblokken en de opbouw van de prijs.
- Het advies verschijnt zodra de prijzen van morgen binnen zijn en wordt om 00:00 nog eens doorgerekend met de nieuwste weersverwachting. Er komt geen pushmelding meer voor het advies.
- Systeem: alleen de status in het oranje blok; paneeltegels met opbrengst in 3 decimalen, zonder de teksten over het zwakste en beste paneel; de batterijgrafiek staat nu op Overzicht.
- Klimaat en Zonwering: het weer als lucht op de achtergrond van het blok, met het adres van de woning, zon op en zon onder, luchtvochtigheid en wind. Het adres stel je in bij Instellingen → Woning.
- Klimaat: de kleuren lopen nu van blauw bij 10° tot rood bij 25°.
- Zonwering: de app herkent aan de stand van de gordijnen welke scène actief is (binnen 3%), ook als iemand ze met de hand of de PowerView-app heeft verzet. Anders staat er "Eigen stand". Geen vinkje meer, alleen uitlichten.
- Kopjes van blokken zijn groter dan de tekst eronder.

## 1.0.0

- Nieuw ontwerp (Ontwerp 2) voor iPhone en iPad, met dezelfde onderdelen op elk scherm: titel boven de oranje band, glazen kaarten, één soort knoppen en schakelaars.
- Menu onderin: de actieve pagina licht oranje op en staat vetgedrukt. Thuis is alleen oranje als je erop staat.
- Energie heeft vier moderne tabs bovenaan die blijven staan bij scrollen: Overzicht, Prijzen, Advies en Systeem.
  - Overzicht (was Nu en Historie): stroomkosten van vandaag en het uurtarief, de energiestromen en daaronder de historie. Tik op een staaf in de grafiek voor de waarden van dat moment; tik ernaast en je ziet weer het geheel.
  - Advies is een eigen tab en verschijnt zodra de prijzen van morgen binnen zijn (de app kijkt vanaf 12:00 elke 5 minuten), met "prijzen bekend sinds".
  - Systeem (was Systeem en Status): 9 paneeltegels met status, opbrengst van vandaag, vermogen en temperatuur; de batterij met grafiek en statusgegevens; de gateway. Meters en "Over je panelen" zijn weg; de app-status staat nu bij Instellingen.
- Thuis: bovenaan Woonkamer, stroomkosten tot nu en batterij. Nieuw: "Nu slim om te doen" (zonwering bij veel zon, goedkoopste uren, batterij-advies), de Hue-groepen als snelle knoppen, zonwerings-scènes, en de ruimtes per verdieping in de kleur van hun temperatuur.
- Klimaat: weerbericht (temperatuur, weer, luchtvochtigheid, windkracht en -richting) en de ruimtes per verdieping uit Home Assistant, gekleurd van 10° blauw tot 30° rood.
- Licht: Hue-kamers en -zones (Keuken met Keukenraam, Eettafel, Woonkamer, Achtertuin) met een schakelaar en helderheid van laag tot hoog. Scènes per groep via ✦ in een onderblad.
- Zonwering: weerbericht in de band.

## 0.9.0

- De Enphase energie-app heet nu **Veerman Home**: één app voor het hele huis, met een nieuw icoon (glazen huis met de zon erachter).
- Nieuw menu: Energie · Klimaat · Thuis · Licht · Zonwering. Thuis staat in het midden en is het startscherm.
- Energie: de vijf bestaande schermen (Nu, Historie, Prijzen, Systeem, Status) staan ongewijzigd achter een schakelaar bovenin.
- Thuis: binnentemperatuur, stroomprijs en batterij, de zonwering met snelle scènes, de ruimtes, de lampen en de energie van dit moment.
- Klimaat: temperatuur, vochtigheid en doeltemperatuur per ruimte, met − en + (Tado X via Matter).
- Licht: Hue-scènes, alle lampen per ruimte aan en uit, helderheid, en "Alles uit".
- Zonwering: de zeven PowerView-scènes en per zonwering de middelste rail en het product, met een raampje dat de stand laat zien.
- iPad: liggend staat het menu als zijbalk links en staat de inhoud in kolommen; staand is de app iets breder.
- Instellingen open je met het tandwiel op Thuis of Energie (en op de iPad onderin de zijbalk).

## 0.8.0

- Adviseur voor het nachtladen: elke middag, zodra de prijzen van morgen bekend zijn, rekent de app uit wanneer en tot hoever je de batterij vannacht het beste van het net laadt. De app stuurt zelf niets aan; je stelt het in de Enphase-app in.
- Zonverwachting via Open-Meteo voor jouw dak (richting en hellingshoek), elke dag bijgesteld aan de werkelijke opbrengst.
- Verwacht verbruik per uur op basis van je eigen metingen.
- Adviesblok op Nu, een pagina met het hele advies en een stappenplan, en "Hoe goed is het advies?" (achteraf doorgerekend t.o.v. je vaste schema).
- Instellingen: je huidige laadschema en je dak. Melding om 15:00 als het advies afwijkt van je schema.

## 0.7.0

- Nieuwe pagina Systeem (was Batterij): opbrengst van vandaag per zonnepaneel, met een waarschuwing als een paneel duidelijk achterblijft, daaronder de batterij, en "Over je panelen" met totalen, records en temperatuur.
- "Gisteren" en de lijst met dagen op de batterijpagina zijn vervallen.
- Menu in de volgorde Historie, Systeem, Nu, Status, Prijzen.
- Nu: de prijsgrafiek per uur is vervallen.
- Historie: geen klikken meer op de grafiek en geen batterijgrafiek; nieuw: zelfvoorzienend en eigen gebruik van zon.
- Prijzen: beste moment voor apparaten (1, 2 of 3 uur), omlijnd in de grafiek.
- Meldingen via de Home Assistant-app: negatieve of zeer lage prijs, goedkoopste moment morgen, batterij niet vol, storing, token verloopt bijna. In te stellen bij Instellingen.

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
