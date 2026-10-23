# Andra testomgången – 23 oktober 2026

**66 nya automatiska testfall. Hela sviten: 2 451 godkända, 0 underkända och 0 överhoppade.**

| Nya fall | Antal |
| --- | ---: |
| Fakturakrav, kund-/bolagsbyte, krediter och frysta original | 15 |
| Delbetalningar och återbetalningar i vanlig fakturering, valuta och kontantmetod | 12 |
| Lönegräns, AGI, återkrav och årsbedömningar | 19 |
| Momsgrunder, periodgränser, återföringar och deklarationer | 20 |

Två produktfel hittades och rättades:

- **REVIEW2-PAY-008:** en redan bokförd, obetald lön kunde kringgå en slutlig årsbedömning under 1 000 kr. Både den nya och äldre lönemodulen kräver nu en uttrycklig ny årsavstämning före utbetalning. Testerna provar även noll nettolön och flerpersonskörningar.
- **REVIEW2-VAT-001:** en momsfri affär kunde återföras i en redan fastställd momsperiod. Återföringar som ändrar deklarationsrutor stoppas nu även när momsbeloppet är noll. Rättelse i nästa öppna period och momsneutrala inköpsrättelser fungerar fortfarande.

Två nya webbläsarprov kontrollerar fakturaspärrar vid omladdning, kopiering, uppdatering av gränssnittet och ett forcerat knapptryck. De visar också att nekad bokföring lämnar sparade uppgifter oförändrade. Resultat från slutproven redovisas i den maskinläsbara rapporten och wikin.

Metod: oberoende beloppsfacit och jämförelser mellan olika uppdelningar av samma affär, kontroll efter JSON-återläsning och negativa prov med krav på oförändrat tillstånd. Alla 2 385 tidigare automatiska tester kördes om tillsammans med de 66 nya. Antalet fall är inte ett antal verifierade lagkrav.

Kör nya modellfall: `node --test server/bokforing-review2-*.test.mjs`.

Detta är en teknisk granskning av stödda demofall. Serverlagring, identifierade användare, bolagsisolering och hållbar arkivering ingår inte. Full regelefterlevnad eller lämplighet för skarp drift är inte styrkt. Tidigare PDF-rapporter behålls som historiska resultat.
