# Kontorswebben – mockuper

Designbilder med fiktiva exempeldata, framtagna 2026-10-07. Uppladdning av
mockuper ändrar inte appen och aktiverar inga betalningar eller integrationer.

## Betalningsuppgifter på invägningskortet

[Öppna mockup](01_Invagning_Betalningssatt.png)

Godkänd design för ÄL 023: Bankkonto, Swish, Kontant och Kreditfaktura som
kompakta val med metodens inmatningsfält direkt under. Gemensam manuell
ID-kontroll ligger kvar. Rutan används när invägningskortet kompletteras före
attest.

## Kundlista – nytt designförslag

[Öppna kundlistan](02_Kundlista.png)

- Sök namn, organisationsnummer, kundnummer eller registreringsnummer.
- Filtrera kundtyp och öppna viktkort; sortera efter senaste aktivitet.
- Visa senaste inlämning, vikt under rullande 12 månader, öppna viktkort,
  saldo och antal kundanpassade prisregler.
- Hela kundraden öppnar kundkortet. Kunden får ingen gemensam A/B/C-nivå;
  prisnivå beräknas separat för varje artikel.

![Kundlista](02_Kundlista.png)

## Kundkort – nytt designförslag

[Öppna kundkortet](03_Kundkort_Oversikt.png)

- Flikar: Översikt, Vägningar, Priser, Uppgifter & betalning samt Rättelser & saldo.
- Översikt med rullande tolvmånadersperiod, nettovikt, antal inlämningar,
  avräknat värde efter rättelser, utbetalt och månadsgraf över invägd vikt.
- Per artikel: volym under perioden, A/B/C-nivå, faktiskt kundpris och
  nästa volymgräns. Kundanpassade regler går före ordinarie volympris.
- Senaste viktkort med länk och aktuell status; kontakt, betalningsprofil,
  sparade referenser, ursprungsadresser och registrerade fordon i sidokolumnen.
- Saldo och rättelse med länk till originalvägningen. I exemplet är rättelsen
  redan inkluderad: 91 927,20 kr avräknat minus 83 527,20 kr utbetalt ger
  +8 400,00 kr kvar att betala. Rättelsen ska inte dras av en gång till.

![Kundkort](03_Kundkort_Oversikt.png)

Kundvyerna är designförslag för granskning, ännu inte godkända som låst design
eller införda som en beställd koduppdatering i ÄL. Fullständigt kundkort,
saldo-/rättelseflöde och kundadministration finns ännu inte i den publicerade
kontorsdemon. Vid genomförande ska statistik, kundpriser, betalningsuppgifter
och ändringsknappar följa användarens behörigheter.
