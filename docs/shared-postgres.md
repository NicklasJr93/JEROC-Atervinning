# Gemensam verksamhetsdatabas – kontor 0.11.0 / mobil 0.3.0

Render använder befintlig `DATABASE_URL`. Migrationen körs automatiskt när
servern börjar använda lagringen. Den raderar inga befintliga tabeller.
Terminal- och miljöregistren använder fortsatt sina befintliga migrationer.
Utan PostgreSQL vägrar verksamhets-API:erna att spara på Render. Lokal utveckling
kan använda beständig `.data/application.sqlite`; SQLite är ingen Renderreserv.

`jeroc_application_documents` innehåller versionerade, schema-validerade JSONB-modeller
för pricing, office, mobile, transport, outbox, personnel/personnelAuth och
logistics/logisticsAuth. All verksamhetsändring av dessa
modeller görs i en databastransaktion under radlås. Det är en samlad modell för den
nuvarande demon; stor drift kan senare dela upp den i fler normaliserade tabeller.
`jeroc_application_meta` ger ett gemensamt lås för samtidiga affärsändringar.
`jeroc_application_audit` sparar händelser och faktiska/utförande användare.
`jeroc_application_imports` bevarar importerade original. Detta är inte en färdig
backupmotor, händelseloggen marknadsförs inte som WAL/PITR eller återställning.

## Import och lokala original

Efter inloggning hämtas serverns aktuella data. Gamla lokala register importeras
en gång och deras råa original sparas både i serverns importarkiv och i
`<tidigare lokal nyckel>.legacy-before-postgres` på ursprungsenheten.
Ett orört serverexempel kan ersättas av motsvarande öppna lokala testkort.
Befintliga ändrade serverposter skrivs aldrig över av en gammal webbläsare.
Konflikter arkiveras och en återkoppling visas; originalen finns kvar för granskning.
Äldre betalningar/rättelser och låsta lokala kort som inte kan styrkas av serverns
kundgodkännande importeras till arkivet, inte till den aktiva ekonomijournalen.
Detta bevarar data utan att påstå att osignerade kort är attesterade eller utbetalda.
Oläsbara lokala register lämnas orörda; inget automatiskt reset görs.

Prismotorns tidigare serverminne måste fångas före driftsättning och importeras
med adminens engångsverktyg `scripts/migrate-live-pricing.mjs`. Importen bevarar
historik och snapshot-ID:n och skickar inga externa händelser. Ett prisregister
som redan ändrats efter driftsättning blockeras för manuell granskning.

## Klienter och behörigheter

Mobil och Expo använder `/api/application/mobile`. Expo är fortfarande samma
mobilwebb via WebView. En färdig mobilvägning ger exakt ett kontorskort med stabilt
sourceId; nummer tilldelas av servern. Utkast syns i mobilen; färdiga kort i kontoret.
Nuvarande mobilkonto är uttryckligt demo-Niklas på Norrtälje. Riktig personal-
inloggning och val av anläggning i mobilen är ett separat kommande arbete.

Kontor och planering använder `/api/application/office` respektive `/transport`.
Servern läser den beständiga behörighetsmodellen, filtrerar anläggningar/priser/
bankuppgifter och kontrollerar skrivåtgärder. Ändrad kund-/atteststatus måste styrkas
av terminaltjänsten. Betalningsjournalen är låst och beloppen verifieras mot det
attesterade saldot. Utbetalningar är fortsatt manuell demoregistrering.
Nya arbetsorder, lager, kärl och avtal använder `/api/logistics/office` och
anläggningsfiltrering på servern. Arbetsorder är samma order-ID i
transportmodellen; versionerat underlag och utförande ligger i `logistics.details`.
Kund- och åkerikonton samt sessionshashar ligger i `logisticsAuth`, aldrig i
klientens register. Portalerna använder egna säkra sessionscookies.
Den befintliga planeraren hämtar hela transportregistret och kräver därför
fortfarande åtkomst till alla anläggningar. Använd ett sådant konto för den.
Kontorets valbara demokonton och X-Demo-identiteter är inte produktionsautentisering.
Använd bara testdata tills verklig inloggning införts.

Webbläsarlagring används för återhämtningscache, osparad kö och UI-inställningar.
Klienterna hämtar andra användares ändringar ungefär var fjärde sekund.
Ändringar på olika fält kan förenas; konflikter på samma fält stoppas. Osparat
arbete behålls lokalt och försöks igen vid återanslutning. En konflikt kräver
kontroll innan ändringen kan sparas; den får inte tyst skriva över serverdata.

PDF-original, fryst dokumentdata och kontrollsummor sparas i separata
PostgreSQL-tabeller enligt [dokumentarkivet](pdf-archive.md).
Bilder/mockuper/appkod ligger i GitHub; serverhemligheter ligger i Render.
Backendlager och ändringslogg följer modellfält automatiskt; nya moduler måste
använda den gemensamma lagringen och ha migration samt riktade återläsningstester.
Inga Visma/NVV/BankID/bank/SMS/e-postleveranser aktiveras. Utkorgen lagras men skickar
inget. Backup/återställning och Sentry är planerade enligt ÄL 045.

## Utveckling och kontroller

`npm ci && npm run build && npm run dev`. Bygget kompilerar samma Zod-domänmodeller
som används i klienten till `dist-server/domain-models.mjs` för Node. Kör bygget
igen efter ändring av delade modeller. `npm run test:server` bygger modellerna
innan serverkontrollerna. Tester mot PostgreSQL använder endast den separata
`JEROC_TEST_DATABASE_URL` och skapar/raderar egna isolerade scheman, aldrig driftdata.
