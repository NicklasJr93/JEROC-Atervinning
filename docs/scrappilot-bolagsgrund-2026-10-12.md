# ScrapPilot – bolagsgrund, 12 oktober 2026

Kontor 0.20.0 och mobilwebb 0.7.0 skiljer produktnamnet ScrapPilot från kundbolaget. JEROC Återvinning är första kundbolaget. Befintliga verksamhetsregister och dokument raderas inte.

## Aktivera systemadmin i Render

När nuvarande administratör fortfarande har det offentliga demolösenordet måste den första plattformsinloggningen få ett privat lösenord:

1. Öppna webbtjänsten i Render → **Environment** → **Edit**.
2. Lägg till `SCRAPPILOT_PLATFORM_ADMIN_PASSWORD` med ett nytt privat lösenord på minst 16 tecken. Render **Generate** fungerar; spara värdet privat.
3. Spara och starta deploy. Behåll befintlig `DATABASE_URL` och befintliga integrationsinställningar.
4. Öppna `/kontor`, logga in som `admin` med det nya initiallösenordet och byt lösenord när appen begär det.
5. Därefter används lösenordet du valde i appen. Initialvariabeln återställer inte ett redan skapat plattformskonto vid omstart.

Det gamla administratörskontots identitet bevaras. När privat bootstrap konfigureras ersätts även dess offentliga mobilcredential och tidigare mobiladminsessioner återkallas. Ett redan privat administratörskonto kan importeras utan initialvariabeln. Övriga befintliga JEROC-demokonton ändras inte automatiskt; de är fortfarande demokonton och ska ersättas eller stängas av inför verklig kunddrift. Nya bolag får inga sådana konton.

Utan privat bootstrap skapas ingen plattformsadministratör från ett känt demolösenord. Kontorets nya inloggning förklarar att konfiguration krävs. Serverns hälsokontroll och befintliga mobilmodul kan starta; en misslyckad plattformsaktivering raderar ingen verksamhetsdata.

## Skapa bolag och första VD-kontot

Systemadmin öppnar **Bolagsadministration**, anger bolagsnamn, organisationsnummer, VD:s namn och e-post. Organisationsnumret normaliseras och kontrollsiffran valideras. E-postadressen blir VD-kontots inloggning.

Servern reserverar bolags-ID och lagring, provisionerar register och aktiverar bolaget först när det är klart. Återförsök behåller samma bolags-ID. Misslyckad provisionering ger ingen åtkomst till ett halvfärdigt bolag.

VD:s slumpade tillfälliga lösenord visas endast i skapandesvaret och sparas endast som hash. Systemadmin kopierar och lämnar vidare uppgifterna. **Automatisk e-postleverans är inte ansluten.** Första inloggningen tillåter bara lösenordsbyte och utloggning; mobilens VD-konto aktiveras först när bytet har lyckats.

Om uppgifterna tappas bort kan systemadmin explicit välja **Nytt tillfälligt lösenord** innan VD har slutfört lösenordsbytet. Tidigare tillfälliga sessioner och lösenord blir ogiltiga. Funktionen återställer inte ett redan aktiverat VD-konto.

Nya bolag har inga kunder, artiklar, viktkort, lagerhändelser, transporter eller demopersonal. Första VD-personprofilen och en anläggning skapas; anläggningens verkliga adress och tillstånd behöver kompletteras. VD får uttryckliga verksamhetsbehörigheter, men ingen påhittad attestgräns eller rätt att attestera egna underlag. Sådana inställningar måste fastställas.

## Jobba som bolag och konto

Systemadmin kan välja bolag och därefter ett aktivt konto inom bolaget. Standardvalet är systemadministratörens egna, bolagsavgränsade rättigheter. Ett VD-val använder VD:s rättigheter. Bolagets VD kan inte välja ett annat kundbolag eller upphöja sig till plattformsadministratör.

Verksamhets-API hämtar organisation, faktisk administratör och effektiv användare från serversessionen. Identitetsheaders autentiserar inte kontoret. Byte roterar cookie, CSRF och sessionsgeneration och loggas med faktisk och effektiv identitet samt bolag. Gamla flikar, cachade skrivningar och händelseströmmar kan inte följa med till det nya bolaget.

Bolagsadministrationen visar länkar till bolagets kontor, mobil, terminal och partnerportaler. Publika bolagslänkar väljer endast vilken inloggningsmiljö som används; de ger inga läsrättigheter eller medlemskap. Mobil, terminal, kund, åkeri och chaufför måste fortfarande logga in med respektive eget konto.

## Lagring och integrationer

- Befintlig JEROC-lagring återanvänds. Nya bolag får servergenererade PostgreSQL-scheman med strikt `search_path` utan `public`-fallback. En saknad lagringsmiljö stoppar anropet.
- Varje bolag har egna repository-instanser, domändokument, revisionsräknare, sessionsuppgifter, bild/PDF-arkiv, nummerföljder, terminal- och integrationsköer. Lokalt används separata SQLite-filer.
- PostgreSQL-notifieringar använder bolagsspecifika kanaler. Mobilens/portalernas API-anrop bär en kontroll av ursprungligt bolag, och kontorets anrop bär den ursprungliga sessionsgenerationen.
- Kontors-, mobil- och transportcachar, väntande ändringar och läsdeduplicering avgränsas per bolag och användare/session. Bilder med samma fil-ID får inte återanvända en annan bolagsversion från webbläsarcachen.
- Spiris får egen bolagsbunden OAuth-anslutning, provideridentitet, ekonomiinställningar och journal. Delad OAuth-applikation kan återanvändas. JEROC:s token, providerpin och NVV-certifikat kopieras inte. Callback använder bara den aktuella verifierade bolagsanslutningen; byte av bolag under pågående OAuth kräver nytt anslutningsförsök.
- Bakgrundsjobb arbetar med sin fasta bolagsinstans, oberoende av vem systemadmin för tillfället arbetar som. Spiris återauktoriserar plattformssessionen vid interaktiva integrationsåtgärder.
- Nya bolags PDF-underlag använder egna företagsuppgifter. Frysta underlag och arkiverade PDF-bytes ändras inte av senare bolags-/kontobyten. JEROC:s juridiska bolagsidentitet ersätts inte med produktnamnet ScrapPilot.

Detta är en grund för flerföretagsdrift, inte abonnemang/betalning eller allmän självanmälan. Databasavgränsningen är scheman och servervalda tjänster; särskilda databasroller per bolag och RLS är inte infört. Full säkerhetsgranskning, driftsövervakning/kapacitetsprov, självanmälan, mejlleverans och bredare personalinbjudningar till kontoret är separata fortsättningsarbeten. Nya bolags egna NVV-certifikat behöver en särskild säker konfigurationsväg innan deras NVV-anslutning aktiveras.

## Logga och verifiering

Produktloggan används som `/images/scrappilot-logo.svg`. Vektororiginal, tryck-PDF och PNG-exporter finns i [branding](branding/README.md). SVG innehåller verkliga banor och två färger, inga inbäddade bitmappar eller typsnittsberoenden.

Verifieringen omfattar två bolag med identiska kund-, person-, fil-, viktkort- och export-ID:n; skydd mot godtyckliga headers/bolagsval; obligatoriskt lösenordsbyte; samtidiga skapandeförsök; återutfärdat förstgångslösenord; gamla flikar och notifieringar; separata Spiris-token/journaler; egna PDF-identiteter; mobilens och portalernas cache/inloggningar. Databastester körs mot tillfälliga lokala PostgreSQL-scheman, aldrig mot Render-databasen. Inga NVV-rapporter, verkliga utbetalningar eller nya Spiris-underlag skickas av byggets verifiering.

Genomförda kontroller: 24 fokuserade plattforms-/runtime-/gateway-/notifieringstester med lokal PostgreSQL, 67 Spiris-regressionstester och 9 tenantfall, 19 terminaltester samt riktade miljö-, personal-, mobil- och PDF-tester. Sex UI-fall för bolagsadministration/lösenord, sju portal-/terminalfall och fem mobilfall passerade. Produktionsbygget och Expo TypeScript passerade. Den byggda appen kördes även med riktig lokal API-server: systemadmininloggning/lösenordsbyte, bolagsskapande, återutfärdat startlösenord, byte till bolagets arbetsyta och separat första VD-inloggning verifierades utan browserfel. Befintliga UI-tester som bygger på den avvecklade kontors-demoväljaren är inte en verifiering av den nya produktionsinloggningen.
