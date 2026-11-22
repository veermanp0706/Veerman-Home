# Wijzigingen

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
