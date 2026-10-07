# JEROC kontorsdemo 0.1.0

Öppna https://jeroc-atervinning.onrender.com/kontor efter att Render publicerat senaste Git-commit.
Samma repository och Render-tjänst används. Befintlig Build Command och `npm start` kan behållas.
Gårdsappen finns kvar på `/`; `/mobil` är också en aliasadress för webbdemon. Expo Go fungerar som tidigare.

## Prova flödet

- **Kajsa Nilsson:** granskning, kund, ID, betalningsuppgift och prisändringar med historik. Öppna #1412 och komplettera det. Standardbeloppet är 25 002 kr; ekonomi har gräns 25 000 kr.
- **Anna Nilsson:** attest upp till 25 000 kr och demoutbetalningar. #2039 kan attesteras; #2040 överstiger gränsen. Egna förberedda kort får inte attesteras.
- **Lars Andersson (VD):** alla verksamhetsmoment, attest upp till 100 000 kr och användaradministration. Kan skapa medarbetare och VD, men inte ändra systemadmin.
- **Systemadmin:** även systemadminkonton i den lokala demoanvändarvyn.

Dashboardens arbetsköer är klickbara. Invägningar har kundval, referens/ursprung efter kundval, materialrader, prisalternativ A/B/C eller eget engångspris, betalningsuppgift och manuell ID-verifiering.
Färdigställande skickar kortet för attest. Attest kontrollerar både maxbelopp och egen attest.
Attesterade och demoutbetalda kort låses. Rättelseutkast länkas till original och kund utan att originalet ändras.
Utskrift visar ett tydligt märkt demounderlag. Prisändringar och statusövergångar har person, kontor och tid i spårbarheten.

## Gränser för första versionen

Detta är en webbläsardemo med fiktiva uppgifter och ett separat lokalt lagringsutrymme (`jeroc.office.demo.v1`).
Demokontona är valbara exempel, inte riktig autentisering. Behörighetskontrollerna är demoregler i klienten.
Gårdsappens lokala vägningar synkas ännu inte till kontoret och kontona delas inte ännu med Expo-appen.
Ingen bank, Swish eller Visma är ansluten. Demoutbetalning skickar inga transaktioner och skapar inga riktiga betalningsfiler.
Rättelser är utkast; godkännande, saldon, kvittning och volym/statistikjustering är nästa steg.
Kundregistret och artikelpriserna är exempel; fullständig registeradministration och riktiga prisregler kommer senare.

Nästa steg är gemensam databas och serverkontrollerad inloggning/behörighet, därefter synkning mellan gård och kontor.
Återställ kontorsdemo påverkar bara kontorets testdata, inte mobilappens sparade viktkort.

## Verifiering

Tre kontorsflöden passerade: granskning → attest → demoutbetalning, attestgräns/VD-behörighet samt egen attest och rättelseutkast.
Mobilappens 22 flöden kontrollerades; sveptestets hjälpfunktion uppdaterades för att först scrolla fram kortet och det testet passerade därefter.
Produktionsbygge, 10 servertester inklusive `/kontor`-adressen och Expo-typkontroll passerade.
