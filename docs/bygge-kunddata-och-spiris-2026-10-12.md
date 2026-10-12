# Kunddata och Spiris – kontor 0.19.0, mobilwebb 0.6.0

Bygget genomför de sex beställda områdena i ÄL 084–086 och 088–095. Google-adressförslagen (087) väntar på anslutningsuppgifterna.

## Ändringar

1. **Gemensamma kunduppgifter.** Företag/BRF får momsval även i mobilens Ny kund. Servern normaliserar och kontrollerar organisations-/personnummer, telefonnummer, Swish och strukturerade adresser från mobil och webb. Organisationsnummer sparas med tio siffror; svenska kontaktnummer sparas med landskod. Privatperson kan registreras utan personnummer. Befintliga individuella betalningsvillkor och ekonomiska kunduppgifter bevaras vid mobiländringar.
2. **Automatiska mobilpriser.** När en färdig mobilvägning med kund kommer till kontoret beräknar servern artikel-/kundpris och tolv månaders volym. Saknad kund eller prisgrund visas som väntande beräkning, separat från saknad prisbehörighet. Upprepad synkronisering skapar inte ett nytt kort eller dubbelräknar volymen.
3. **Återanvänd uppgifter aktivt.** Kryssrutorna för kundadress till ursprung och kundtelefon till Swish börjar avmarkerade. Ursprung kopierar även postnummer och ort. Manuellt sparade ursprungsadresser/referenser läggs till som kundens framtida val; tangenttryck och avbrutna ändringar gör det inte.
4. **Tydligt kundkort.** Kundkort öppnas i läsläge. Redigera kund byts mot Spara kunduppgifter/Avbryt i högra hörnet. Kontakt- och betalningsuppgifter ändras i samma arbetskopia; Avbryt kastar den och sparfel behåller den. Dubblettvarning erbjuder befintlig kund eller ett uttryckligt separat kundkort.
5. **Spiris-resultat och uppföljning.** Viktkortet har ett kompakt överföringskort och viktiga Spiris-händelser i den vanliga spårbarheten. Tekniska ID:n/full journal visas under detaljer. Förberedande exportfel blir synliga även innan ett API-anrop gjorts. Bokföringsuppföljningen läser bara kopplade underlag, kontrollerar företag och verifikationsuppgifter och har en tidsgräns. Verifierat saknade utkast kan återskapas genom en aktiv adminåtgärd med ett separat idempotent försök.
6. **Demo-genvägar.** Två små knappar fyller Niklas eller chef/admin på mobilens inloggningssida. De loggar inte in automatiskt och visas bara när servern bekräftar de avsedda demokontona och deras ursprungliga demouppgifter.

Ändrade kontaktuppgifter skrivs i gemensam databas. Inga gamla kundgodkännanden, attestversioner eller PDF-original skrivs om. Äldre felaktiga identifierare behöver rättas inför ett nytt kundgodkännande; detta är ingen automatisk registerkontroll av bolag eller momsregistrering. Företags-Swish med 123-nummer behåller sitt separata format.

## Prova efter Render-deploy

- Skapa en företagskund i mobilen med momsregistrerad Nej och en komplett adress. Färdigställ en vägning. Öppna kortet på kontoret: kundval, momsstatus och serverberäknade priser ska följa med.
- Prova de avmarkerade kopieringsrutorna. Spara ett nytt ursprung och en ny referens; kontrollera att de går att välja vid nästa vägning för samma kund.
- Öppna kundkortet och prova Redigera → Avbryt, sedan Redigera → Spara. Ogiltigt organisationsnummer/telefonnummer ska ge ett konkret fel. Inga extra siffror tas bort för att få ett nummer att passa.
- Attestera ett nytt komplett kort med sandboxöverföring aktiverad. Följ resultatet i det kompakta Spiris-kortet och spårbarheten. Slutför därefter utkastet i Spiris sandbox och använd Uppdatera nu som systemadmin för att verifiera verklig bokföringsåterläsning.
- För raderingstest: radera ett JEROC-utkast i sandbox. Efter två verifierade kontroller minst fem minuter isär kan systemadmin återskapa det. Finns en motsvarande bokförd faktura ska knappen inte visas. Ett osäkert svar ska kräva granskning.

Äldre ofrysta mobilkort som redan har skapats utan pris använder fortsatt **Beräkna priser**. Nya kort får automatisk beräkning. Bokföring och betalning är skilda statusar.

## Verifiering och drift

Produktionsbygget och Expo-typkontrollen passerade. De 17 slutliga UI-kontrollerna omfattade kundens läs-/redigeringsläge, momsregistrering, kopieringsrutorna, demoinloggningen, prisbehörigheter och Spiris-status/spårbarhet. Riktade servertester omfattade canonical lagring, återanvända kundval, automatisk prissättning, terminalens formatkontroll och behörigheter. Spiris-export/uppföljning verifierades med mockade providersvar mot både SQLite och isolerad lokal PostgreSQL, inklusive dubbelklick, frånkoppling, fel företag, ändrad attestkälla och osäkert POST-svar.

Inga tester skickade till Spiris eller NVV, betalade något eller ändrade Render-databasen. Verklig bokföringsåterläsning/radering ska fortfarande provas i sandbox efter deploy; den är inte bekräftad av mocktesterna.

Inga nya obligatoriska Render-variabler behövs. Befintlig databas och Spiris-anslutning används. Databasindex skapas idempotent vid start. Uppföljningstiden finns i integrationsinställningarna, standard 30 dagar. `JEROC_DEMO_AUTO_SESSION=false` stänger även demo-genvägarna. Det befintliga Expo-skalet laddar den uppdaterade mobilwebben; skalets version är oförändrad.

Tekniska regler och begränsningar för uppföljning: [bokforingsuppfoljning.md](integrationer/spiris-visma/bokforingsuppfoljning.md).
