# Attest, bokföring och utbetalning

Kontor 0.23.0, ÄL 103, 2026-10-13. Bygget använder Spiris sandbox och
Swish Merchant Swish Simulator. Ingen riktig Swish-/bankutbetalning aktiveras.
Inga nya Render-variabler behövs.

## Prova från ett nytt viktkort

1. Slutför kundgodkännande och eventuell mottagningsbekräftelse.
2. Vid Attest väljer du **Attestera · skapa utkast** för granskning först,
   eller **Attestera & bokför** för automatisk bokföring i sandbox.
3. Attesten sparas direkt. Kortet **Utbetalning**, under Attest, visar
   utkast, pågående bokföring eller **Bokförd i Spiris** med verifikation.
4. Ett utkast kan bokföras senare i Spiris eller med **Bokför i Spiris**
   hos oss. **Uppdatera status** gör en aktiv kontroll av samma underlag.
5. **Betala ut** öppnas först efter verifierad bokföring. Popupens
   uppgifter är låsta; **Redigera** öppnar betalsätt/mottagaruppgifter.
   Ändringar kräver orsak. Belopp och kundidentitet är fortfarande låsta.
6. Swish-popupen visar förberedelse, sändning och verifierat resultat.
   Ett mottagningskvitto från Swish är inte slutlig betalningsbekräftelse.
7. Efter verifierat `PAID` arkiveras en ny PDF-version med
   **Testutbetalning bekräftad · Swish MSS**, betalningstid, referens och
   maskerade mottagaruppgifter. Senaste PDF blir standard; original finns kvar.
8. Om registrering i Spiris sandbox är aktiverad under Integrationer → Swish
   registreras betalningen på samma bokförda faktura och valt eget bankkonto.
   Betalningsverifikationen visas separat från fakturans ursprungliga verifikation.

Automatisk utkastöverföring efter attest behöver fortfarande vara aktiverad
i Spiris-inställningarna och ingå i kortets frysta ekonomiunderlag. Äldre kort
utan den konfigurationen kan behöva den befintliga manuella exportvägen innan
bokföringsknappen kan användas.

## Behörigheter och status

**Bokföra attesterade underlag i Spiris** är en egen användarbehörighet.
Den behövs för både valet Attestera & bokför och den senare bokföringsknappen.
Även verklig användare bakom Jobba som behöver behörigheten och rätt anläggning.
Systemadmin får den genom sin roll. Attestera ett underlag och genomföra dess
utbetalning är fortsatt separata behörigheter.

Övre kortet **Betalningsuppgifter** visar det godkända underlagets uppgifter.
Det nya **Utbetalning** visar genomförandet och eventuella reviderade instruktioner.
Den blå elektriska kanten markerar nästa tillgängliga åtgärd. En genomförd
Swish-simulering ligger kvar som resultat och öppnas med Visa utbetalning.

Spiris-fel efter ett verifierat Swish-resultat ändrar inte betalningsresultatet.
PDF-arkivering och betalningsbokföring kan återhämtas var för sig. Ett okänt
resultat kontrollerar samma instruktion; inga nya pengaförsök skapas automatiskt.
Nya betalningar kan inte registreras genom den gamla manuella demovägen.

Teknisk JSON är dold under **Avancerat** i Swish-popupen. Kopierbar
felsökningsinfo maskerar mottagaruppgifter och hemligheter. Ingen e-post skickas
automatiskt. Swish-symbolen kommer från
[Swishs officiella utvecklarportal](https://developer.swish.nu/favicon.svg).

## API och beständighet

Befintligt utkast omvandlas med `POST /v2/supplierinvoicedrafts/{id}/convert`.
Resultatet verifieras mot fryst leverantör, referens, konteringsrader, moms,
belopp, utkast-ID och bokföringsverifikation. Bokföring reserveras beständigt
före POST; förlorat svar får endast återläsas. Bokföringskön väljer sina egna
förfallna jobb innan sidbegränsning, så äldre utkast inte blockerar nya begäranden.

Swish-sändningen kräver samma bokförda obetalda faktura och Spiris-koppling som
vid reservationen. En fördröjd Swish-bekräftelse återanvänder den sparade
anslutningsversionen även för betalningsbokföringen. Återanslutning pausar den
istället för att flytta betalningen till en ny koppling.

## Verifiering

Produktionsbygge och fokuserade browserprov passerar för delad attest,
behörighet, kortplacering, elektrisk kant, låsta betalningsfält, redigering,
maskerad avancerad information och separata betalnings-/bokföringsstatusar.

De riktade servertesterna passerar för attest, API-session/CSRF, konvertering,
kö, fryst bokföringsunderlag, utbetalningsspärr, samtidighet, omstart,
anslutningsbyte, osäkra svar och oföränderliga PDF-versioner.
Två sammanhängande prov använder faktiska Spiris-/Swish-tjänster, SQLite-journal
och PDF-motor, med injicerade nätanrop. Upprepade kontroller ger en konvertering,
en Swish-instruktion, en Spiris-betalningsregistrering och en bekräftelse-PDF.
Tillfälligt Spiris-fel förhindrar inte PDF-bekräftelsen.

Inga externa API-skrivningar gjordes i dessa kontroller. PostgreSQL-specifika
testfall hoppades över eftersom en isolerad testdatabas saknas. Det faktiska
sandboxprovet av automatisk bokföring görs från kontorsappen efter deploy.
