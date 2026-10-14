# ScrapPilot – granskning av 51 punkter inför skarp drift

Datum: 2026-10-14. Granskad kod: `6ce403a` på `main`.

Systemet har en användbar säkerhets- och transaktionsgrund. Behörigheter,
bolagsval, lösenordshashning, betalningsreservationer och flera bakgrundsjobb
kontrolleras på servern. Före skarp SaaS-drift behöver konkreta åtkomstfel
rättas och drift, återställning och belastning verifieras.

Underlaget är kodgranskning, riktade tester med tillfälliga SQLite-databaser och
mockade integrationer, beroendeskanning samt läsning av den publika tjänstens
HTTP-svar. Render-inställningar, databasens faktiska rättigheter, backupavtal
och kapacitet har inte inspekterats. Ingen separat PostgreSQL-testdatabas var
konfigurerad. Ingen produktionsdata eller extern betalning ändrades.

**På plats** betyder att ett skydd finns i granskade kodvägar och har stöd i
kod/tester, inte att varje möjlig kodväg eller driftkonfiguration är verifierad.
**Delvis** betyder att stödet finns men har en konkret lucka eller behöver
bredare verifiering. **Lucka** betyder att det efterfrågade skyddet saknas i
granskad implementation. **Ej verifierat** gäller framför allt extern drift.

## Hela listan

| Nr | Kontroll | Nuläge | Vad vi har och vad som återstår |
|---|---|---|---|
| 1 | Autentisering, token och giltighetstid | Delvis | Slumpmässiga sessionstoken, hashad lagring och utgångstid finns. Äldre demokonton kan fortfarande autentisera trots att inloggningsgenvägar döljs; faktisk kontostatus i drift behöver kontrolleras. |
| 2 | Behörighet per objekt/åtgärd | Delvis | Servern kontrollerar aktör, verksamhetsanvändare, aktivitet, rättigheter och anläggning. Ett bekräftat undantag tillåter arkivskrivning med enbart `view`. |
| 3 | Bolagsisolering | Delvis | Servervalda bolagskontexter, separata schemasökvägar, cookies och cacheavgränsning finns. Lokala isoleringstester passerar; PostgreSQL-prov och databasrättigheter behöver verifieras. Samma DB-credential används över schemas. |
| 4 | IDOR | På plats i granskade vägar | Kort, anläggningar, chaufförsuppdrag, kund/åkeriportal, terminaler och privata intyg har ägarskaps-/behörighetskontroller. Inget direkt IDOR hittades i stickproven. |
| 5 | Rate limiting | Delvis | Flera inloggningar och bolagsval begränsas. Ingen gemensam begränsning för dyr API-trafik eller lyckade inloggningar hittades. SMS och fristående mejlutskick har ännu inget motsvarande helt flöde. |
| 6 | Brute force | Delvis | Plattformen har beständig begränsning per konto och adress. Flera övriga inloggningar begränsar bara per adress eller konto+adress. Proxyadress och fördelade försök behöver hanteras. |
| 7 | Servervalidering av indata | Delvis | Strikta kommandon, kroppsgränser och domänvalidering finns. `archiveData` tar emot godtyckliga objekt utan innehållsschema eller specifik skrivbehörighet. |
| 8 | Output encoding/XSS | På plats i granskade vägar | React-text, textbaserad mejlvisning och tillåtna HTTPS-länkar. Inget rått HTML-exekveringssänk hittades i appen. |
| 9 | SQL-injektion | På plats i granskade vägar | Parametrar binds; tabellnamn väljs från tillåtna listor och scheman valideras före interpolation. Ingen injektionsdefekt hittades i granskade frågor. |
| 10 | CSRF | Delvis | Kontorsskrivningar använder CSRF-token och Origin-kontroll. Övriga cookies är SameSite Strict med gatewaykontroll. Bolagsval via GET kan fortfarande framtvinga byte/utloggning via en länk. |
| 11 | Filuppladdning | Delvis | Storlek, bildformat, pixlar, metadata, säkra namn och privat intygsåtkomst kontrolleras. HR-PDF kontrolleras bara med filmarkörer; scanning/karantän eller innehållssanering saknas. |
| 12 | Hemligheter | Delvis | Serverkonfiguration, krypterade integrationstoken och maskerad felsökning finns. Git-historiken och Render har inte genomgått full hemlighetsskanning. Nyckelrotation behöver ett kontrollerat flöde. |
| 13 | Miljöseparering | Delvis | Integrationerna har test-/sandboxspärrar och flera tester använder isolerade databaser. Egen staging med egna hemligheter/DB är inte verifierad. Browserstart kan ärva `DATABASE_URL`. |
| 14 | Lösenordshashning | På plats | Saltad scrypt och timing-safe jämförelse används, inte reversibel kryptering eller enkel SHA-hashning. |
| 15 | Lösenordsåterställning | Delvis | Behörighetskontrollerad kontoåterställning finns. Allmänt glömt-lösenord-flöde med expirerande engångslänk saknas; temporära initiallösenord har ingen separat giltighetstid. |
| 16 | Återkallande av sessioner | Delvis | Utloggning och lösenordsbyte återkallar sessioner inom respektive flöde. Mobil- och plattformslösenord är inte synkroniserade i båda riktningarna. |
| 17 | CORS | På plats för samma ursprung | Ingen wildcard-CORS hittades i produktion. Appen arbetar mot samma ursprung och kontrollerar Origin. |
| 18 | Säkerhetsheaders | Delvis | `nosniff` och flera `no-store`-svar finns. Publika HTML-svar saknade CSP, HSTS och frame-restriktioner vid kontrollen. |
| 19 | Känsliga uppgifter i loggar | Delvis | Integrationssvar maskeras och många loggar är generiska. Ett oväntat affärsfel skriver fortfarande omaskerad exception-stack till logg. |
| 20 | Affärsspårbarhet | På plats i centrala flöden | Aktör, tid, version, ändringsorsak, godkännande, överföring och betalningshändelser sparas. Gemensam förvaltning och lagringstider återstår. |
| 21 | Databasindex | Delvis | Index för Spiris-kö, dokument och idempotens finns. Index för flera miljöfilter i JSON-fält saknas; riktiga query plans behöver kontrolleras. |
| 22 | N+1 | Delvis | Flera läsvägar använder samlade SQL-projektioner. Vissa jobbinläggningar/workeroperationer gör fortfarande arbete per post. Ingen systemomfattande mätning finns. |
| 23 | Querygränser/paginering | Lucka i viktiga listor | Kontors-, mobil- och transportvyer returnerar fortfarande hela domänvyer; miljöläsningar kan samla alla matchande poster. Vissa journaler har gränser. |
| 24 | Connection pooling | Delvis | Begränsade pg-pooler används. Många separata pooler per bolag ger cirka 25 möjliga anslutningar, plus 2 för intyg när den lagringen startas; ingen central totalbudget finns. Detta är konfigurerad kapacitet, inte uppmätt användning. |
| 25 | Transaktionsgränser | På plats i granskad PostgreSQL-kod | Nästlade operationer delar klient och commit, fel markerar rollback och notifiering sker efter commit. SQL-koden och tester stöder detta; riktig PG-integration har inte körts här. SQLite över separata filer har inte samma garanti. |
| 26 | Samtidighet/race conditions | Delvis | Revisioner, transaktioner och beständiga jobbleases finns. Verkliga flerprocessprov mot PostgreSQL saknas i denna granskning; en Swish-timeout-gräns behöver rättas. |
| 27 | Optimistisk/pessimistisk låsning | På plats i centrala flöden | Versionskontroller och databaslås används där samtidiga ändringar spelar roll. Grova lås för hela bolagsdomäner blir dock ett prestandaproblem vid tillväxt. |
| 28 | Unika DB-constraints | Delvis | Originalmottagning, lager-/rapporteringspar, dokument, köjobb och Spiris-idempotens har constraints. Flera affärsidentiteter inuti JSONB skyddas av applogik/lås i stället för egna unika DB-kolumner. |
| 29 | Idempotens | Delvis | Betalningsreservation, beständig instruktion och skydd mellan bank/Swish finns och återstart/repetition testas. HTTP 408 i Swish klassas felaktigt som definitivt avslag och kan öppna för ny instruktion. |
| 30 | Atomiska räknare/lager/balanser | På plats i granskade flöden | Lagerändringar, versionsräkning och reservationer sker under transaktion/lås. Verifiering med verklig samtidig PG-belastning återstår. |
| 31 | Säkra migrationer | Delvis | Transaktioner och advisory locks används. Gemensam migrationshistorik och färdig rutin för kompatibla rullande releaser saknas. Automatisk rensning vid demogenerationsbyte måste begränsas till avsiktlig demodrift. |
| 32 | Release-/migrationsrollback | Delvis | SQL-rollback finns och kompatibilitetsbegränsningar dokumenteras. Komplett provad återgång av kod, schema, filer och integrationstillstånd saknas. |
| 33 | Backuper | Ej verifierat för hela systemet | Modulvis export finns. Komplett schemalagd backup av alla schemas, plattform, PDF, bilder och intyg samt Render/PITR-inställningar har inte verifierats. |
| 34 | Återställningsprov | Delvis | Modulvisa återställningstester finns och utvalda lokala tester passerar. Ingen verifierad full databas-/PITR-återställning till separat miljö finns i underlaget. |
| 35 | Radering och lagringstid | Delvis | Sessionsrensning, avaktivering och skydd av original finns. Gemensamma regler för gallring av HR-intyg, loggar, filer, historik och avslutade bolag saknas. |
| 36 | Felhantering | Delvis | Många API- och integrationsfel visar felstatus och bevarar tidigare data. React ErrorBoundary saknas; chunk-/renderfel kan ge vit sida. Okända betalningsresultat behöver fortsatt särskiljas från avslag. |
| 37 | Säkra återförsök/backoff | Delvis | Pollning och backoff finns; förlorade betalnings-POST återsänds normalt inte blint. Swish HTTP 408 är ett undantag som behöver rättas; generisk Retry-After-hantering saknas. |
| 38 | Timeouts | Delvis | Flera HTTP-/provider- och poolanskaffningstimeouts finns. Databasens statement-/lock-timeout är inte satt i appkoden; driftens eventuella DB-inställningar är okända. |
| 39 | Circuit breaker/felisolation | Delvis | Köer, felstatus och separata integrationsoperationer isolerar många fel. Ingen gemensam provider-circuit breaker finns; vissa långsamma workers delar körning. |
| 40 | Bakgrundsjobb | På plats för byggda köflöden | Beständiga köer/workerflöden för Spiris, bank/Swish och PDF finns. NVV skickas direkt med beständig försökshistorik; mejlsynk är request-driven. Framtida SMS/mejl/importbehov måste bedömas när respektive flöde byggs. |
| 41 | Misslyckade jobb/dead letter | Delvis | Blockerade/okända integrationsjobb sparas och syns. Terminalens PDF-jobb kan återförsökas utan tydligt slutläge, dead-letter-stopp eller driftlarm. |
| 42 | Cron/worker-låsning | På plats i granskad kökod | Timerloopar kan köras per process; beständiga jobbclaims/leases skyddar de granskade köerna. En global scheduler-ledare krävs därför inte för dessa jobb. Flerprocessprov mot PostgreSQL har inte körts här. |
| 43 | SSE/WebSocket | Delvis | SSE har auktorisering, heartbeat, cleanup, revisionsskydd och pollningsfallback. Tillfälligt läsfel klassas som avslutad session och kan stänga SSE tills vyn startas om. |
| 44 | Externa API-gränser | Delvis | Spiris-paginering, cache, pollning och bounded retries finns. Providerövergripande trafikbudget och generisk hantering av 429/Retry-After är inte färdiga. |
| 45 | Observability | Delvis | Server-Timing, säkra integrationsdiagnoser och affärsjournaler finns. Gemensamma request-ID, strukturerad driftlogg, mätvärdeslagring och felspårning saknas. |
| 46 | Health/readiness | Delvis | `/healthz` och startinitialisering finns. Efter start returnerar health alltid 200, även om databasen eller nödvändiga köer senare slutar fungera. |
| 47 | Övervakning/larm | Ej verifierat i Render | Repo innehåller inte färdiga larm för köålder, felandel, databasutrymme, anslutningar eller misslyckad backup. Eventuella Render-larm har inte inspekterats. |
| 48 | Automatiserade tester | Delvis | 100 servertestfiler och 70 browsertestfiler finns. Kritiska negativa tester körs lokalt. Ingen CI-pipeline som kräver tester före deploy hittades; flera PG-tester hoppades över och två fixtures misslyckades före assertions. |
| 49 | Beroendeskanning/låsfiler | Delvis | Två låsfiler och `npm ci` finns. Ingen återkommande CI-skanning hittades. Denna körning flaggar `sharp` och Expo-beroenden; nåbarhet och kompatibla åtgärder behöver utredas. |
| 50 | Belastnings-/felprov | Delvis | Samtidighet, återstart, borttappade svar, fördröjning och flera felvägar testas. Ingen full realistisk flerbolags-, flerprocess- eller längre belastningskörning mot PostgreSQL hittades. |
| 51 | Arkitektur jämfört med skala | Delvis | Gemensam Node-tjänst och PostgreSQL är en rimlig grund för en liten drift. Hela domänobjekt, grova skrivlås, stora listor och många pooler per bolag behöver ändras och mätas före stor SaaS-tillväxt. |

## Bekräftade fel och begränsningar att prioritera

1. **Samordna identitet och sessioner.** Ett lokalt prov ändrade samma
   användares mobillösenord. Den befintliga kontorssessionen och det gamla
   kontorslösenordet fortsatte fungera. Plattformen synkroniserar bara åt ett
   håll. Lösenords-/säkerhetsändring behöver återkalla åtkomst i alla berörda
   inloggningsflöden.
2. **Avsluta demoinloggningar inför verklig drift.** Ett äldre seedat
   medarbetarkonto kunde logga in i ett lokalt prov med privat bootstrap och
   dolda demogenvägar. Dold knapp är inte avaktiverat konto. Vilka sådana
   konton som faktiskt är aktiva i Render behöver kontrolleras. Tidigare
   delade hemligheter bör roteras via säker konfiguration, utan att nya värden
   kopieras till chatt eller Git.
3. **Stäng arkivskrivning för läsbehörighet.** Ett lokalt användarkonto med
   endast `view` kunde spara godtycklig `archiveData` med HTTP 200. Kräv egen
   skrivbehörighet, schema, innehållsgränser och kvot. Provet avsåg tjänsten
   bakom gatewayen och visar inget kringgående av autentiseringen.
4. **Behåll Swish-timeout som okänt utfall.** Mockad HTTP 408 blev
   `rejected`; en uttrycklig ny betalning kan därefter få ny instruktion.
   Okänt utfall ska i stället reservera kortet och kontrolleras med samma
   instruktion. Swish-koden använder för närvarande MSS-simulator, så detta
   prov flyttade inga pengar. Rätta före en skarp Swish-adapter.
5. **Verifiera återställning och driftsignaler.** Ta full backup av samtliga
   schemas och BYTEA-filer, återställ till separat miljö och säkerställ att
   återställning inte skickar gamla betalningar igen. Definiera RPO/RTO,
   kontrollera readiness mot nödvändiga beroenden och larma på köstopp och
   backupfel.
6. **Säkra leverans och klientfel.** Utred skanningsfynd, inför automatiska
   releasekontroller och komplettera säkerhetsheaders, loggmaskering och
   ErrorBoundary med en återhämtningsvy. Intygs-PDF behöver en beslutad
   säker uppladdnings-/nedladdningspolicy.
7. **Gör tillväxt mätbar.** Lägg gränser/paginering på listor, minska
   helobjektskrivningar, budgetera pooler och skapa index utifrån riktiga
   query plans. Kör sedan kontrollerad last och partiella avbrott mot en
   separat PostgreSQL-miljö. En betalplan ensam tar inte bort dessa kodkostnader.

## Verifiering som utfördes

- Auth-/gateway-/mobilinloggning: **34 passerade**, inga fel.
- Betalning, köer, externa API-projektioner och följdflöden: **196 passerade,
  2 PostgreSQL-beroende tester överhoppade**, inga fel.
- Upload, mejl, SSE och terminal: **48 passerade, 1 PostgreSQL-beroende
  test överhoppat**, inga fel. Vissa tester överlappar föregående körning.
- Lagring: **48 passerade, 24 PostgreSQL-beroende tester överhoppade**,
  inga fel. Utvalda återställningsprov: **3 passerade**.
- Databasruntime och miljö-/terminalprestanda: **20 passerade**, inga fel.
- Tenant/gateway/site/cache: **19 passerade, 1 PostgreSQL-test överhoppat**;
  **6** ytterligare objektbehörighetstester och **1** parameterbindningstest
  passerade. Barnagentens isolerade assertioner verifierade också schemaval
  och maskering. Dessa körningar är ingen verifiering av Render-databasen.
- **Två materialtester misslyckades under fixtureinitialisering**:
  `/api/pricing/users` svarade 403 i stället för förväntat 200, före testernas
  säkerhetsassertions. Fixtures läckte en lokal server vid det felet. Det
  egna hängande testförloppet avslutades; inget produktionsfel eller
  behörighetskringgående härleds från dessa två testfel.
- Separata ofarliga lokala prov bekräftade lösenordsgapet, demokontot,
  arkivskrivningen, Swish 408-gränsen, oförändrade aktiva PDF-bytes samt
  exception-text i serverlogg. Inga exploaterbara XSS-/SQL-injektionsfel
  demonstrerades.
- Publika HTTPS-HTML och `/healthz` svarade 200. HTML hade `nosniff` men
  ingen CSP, HSTS eller X-Frame-Options. HTTP→HTTPS-kontrollen fick timeout;
  redirect-beteendet är därför inte verifierat.
- `npm audit --omit=dev` för webb/server: **1 paket markerat high**, `sharp`
  **0.34.5**, med tre advisories. Npm rapporterade ingen automatisk fix.
- Samma skanning för Expo: **38 markerade paket (31 high, 7 moderate)**.
  Detta kommer från **tre unika advisories**, bland annat `braces`,
  `node-forge` och `uuid`, som fortplantas till beroende paket. Det betyder
  inte 38 separat bevisade exploaterbara brister i appen.
- Låsfilerna ändrades inte och inga automatiska `audit fix` kördes.

Tester är riktade och delvis överlappande. Hela testsamlingen kördes inte.
Ingen redan körande, främmande testprocess stoppades.

## Kod som underbygger bedömningen

| Område | Referenser |
|---|---|
| Gateway, bolag och objekt | [tenant-gateway.mjs](../../server/tenant-gateway.mjs), [tenant-runtime.mjs](../../server/tenant-runtime.mjs), [platform-auth.mjs](../../server/platform-auth.mjs), [logistics.mjs](../../server/logistics.mjs) |
| Lösenord och arkivgap | [mobile-employee-api.mjs](../../server/mobile-employee-api.mjs), [personnel.mjs](../../server/personnel.mjs), [application.mjs](../../server/application.mjs) – arkivgrenen vid rader 980–996 |
| Betalningar | [swish-client.mjs](../../server/swish-client.mjs) – HTTP-fel vid rad 144, [swish-payments.mjs](../../server/swish-payments.mjs) – retry vid rader 323–327 och klassning vid 677–680, [bank-payments.mjs](../../server/bank-payments.mjs) |
| Databas och skala | [database-runtime.mjs](../../server/database-runtime.mjs), [application-storage.mjs](../../server/application-storage.mjs), [environment-storage.mjs](../../server/environment-storage.mjs), [visma-storage.mjs](../../server/visma-storage.mjs), [migrations](../../server/migrations) |
| Klientfel, filer och SSE | [main.tsx](../../src/main.tsx), [article-media.mjs](../../server/article-media.mjs), [sickness-files.mjs](../../server/sickness-files.mjs), [useTerminalDemo.ts](../../src/office/useTerminalDemo.ts), [TerminalApp.tsx](../../src/terminal/TerminalApp.tsx) |
| Drift och skanning | [index.mjs](../../server/index.mjs), [render.yaml](../../render.yaml), [package-lock.json](../../package-lock.json), [Expo-låsfil](../../expo/package-lock.json), [ÄL 045 och övrig planering](../Andringslistan.txt), [databasdokumentation](../shared-postgres.md) |

Granskningen ändrar ingen applikationskod eller driftkonfiguration. Punkterna
ovan är ett underlag för nästa implementation och verifiering.
