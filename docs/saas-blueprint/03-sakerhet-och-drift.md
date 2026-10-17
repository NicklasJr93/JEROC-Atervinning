# 03 – Säkerhet, drift och verifiering

Detta är ett byggrecept för en återanvändbar SaaS-kärna, daterat 2026-10-17.
Dokumentet inför inga skydd, ändrar ingen drift och är ingen ny säkerhetsrevision.
Krav och acceptansprov nedan är mål för nästa grund, inte påståenden om att
ScrapPilot redan uppfyller dem i alla kodvägar eller i Render.

Läs tillsammans med [översikten](README.md), [kärnan](01-saas-karnan.md),
[modulerna](02-moduler.md) och [byggreceptet](04-byggrecept.md).
Den tidigare [granskningen av 51 punkter](../security/launch-readiness-2026-10-14.md)
gäller kodversion `6ce403a`. ÄL 123 i [Ändringslistan](../Andringslistan.txt)
är fortfarande planerad rättning och verifiering inför live-demo.

## Vad dagens kod ger oss

Följande är användbara implementationsexempel. Kopiera principerna och testerna;
kopiera inte legacy-undantag, demoinloggningar eller verksamhetsantaganden.

| Område | Befintligt exempel | Gräns för återanvändning |
|---|---|---|
| Identitet | [platform-auth.mjs](../../server/platform-auth.mjs): saltad scrypt, slumpmässiga sessionstoken, hashad tokenlagring och åtta timmars utgångstid. | Ingen färdig MFA, generell SSO eller självbetjänad återställningslänk. |
| Cookie och CSRF | [platform-api.mjs](../../server/platform-api.mjs): HttpOnly, Secure på HTTPS/Render, SameSite, Origin-kontroll och CSRF för autentiserade skrivningar. | Ett gemensamt identitets- och återkallningsflöde över alla klienter återstår. |
| Bolag och Jobba som | [platform-auth.mjs](../../server/platform-auth.mjs): verklig aktör, effektiv användare, medlemskap och rotation av session/generation vid byte. | Begränsad kundsupportroll är planerad i ÄL 104; `platformAdmin` är inte den rollen. |
| Bolagslagring | [tenant-runtime.mjs](../../server/tenant-runtime.mjs) och [tenant-gateway.mjs](../../server/tenant-gateway.mjs): servervalt schema, separata lokala filer och ingen schemafallback för nya bolag. | Samma PostgreSQL-credential används över schemas; DB-isolering i drift är inte verifierad. |
| Bundna tjänster | [tenant-services.mjs](../../server/tenant-services.mjs): repositories, köer och anslutningar binds till bolaget på servern. | Ingen färdig generell modulkatalog eller gemensam auktoriseringsmotor. |
| Transaktioner | [database-runtime.mjs](../../server/database-runtime.mjs): delad PostgreSQL-klient, rollback-only och notifiering efter commit. | Separata SQLite-filer ger inte motsvarande transaktionsgräns. |
| Jobb och pengar | [visma-storage.mjs](../../server/visma-storage.mjs), [bank-payments.mjs](../../server/bank-payments.mjs) och [swish-payments.mjs](../../server/swish-payments.mjs): beständiga jobb, reservationer och uppföljning. | Inte en färdig generell jobbtjänst; simulatorer bevisar inte skarpa leverantörsflöden. |
| Filer | [article-media.mjs](../../server/article-media.mjs), [sickness-files.mjs](../../server/sickness-files.mjs) och dokumentarkivet: formatgränser, privat åtkomst respektive frysta PDF-versioner. | Ingen gemensam karantän, malwarekontroll eller komplett gallringsmotor. |

Konkreta öppna punkter får inte ärvas som ett färdigt säkerhetspaket:

- `archiveData` i [application.mjs](../../server/application.mjs) saknar egen
  skrivbehörighet och innehållsschema i den granskade grenen.
- Mobilens lösenordsbyte i [mobile-employee-api.mjs](../../server/mobile-employee-api.mjs)
  återkallar personalsessioner, men samordnar inte alla plattformssessioner.
- HTTP 408 ingår inte i klassningen av okänt resultat i
  [swish-client.mjs](../../server/swish-client.mjs). Det måste rättas före skarp adapter.
- [index.mjs](../../server/index.mjs) har `/healthz` som svarar 200 utan löpande
  kontroll av nödvändiga databasberoenden.
- [main.tsx](../../src/main.tsx) har laddningsvyer men ingen gemensam ErrorBoundary.
- Full backup, återställning, larm, realistisk PostgreSQL-belastning och en
  obligatorisk CI-gate är inte verifierade som färdiga helhetsfunktioner.

## Kärnans obligatoriska säkerhetskontrakt

Följande är en föreslagen typ, inte en export som redan finns i projektet.
Gatewayen skapar den efter autentisering och medlemskapskontroll.
En modul får inte konstruera den från JSON, URL, klientheaders eller en menyroll.

```ts
type ExecutionContext = Readonly<{
  tenantId: TenantId;
  actorId: UserId;
  effectiveUserId: UserId;
  sessionId: SessionId;
  sessionGeneration: string;
  allowedSiteIds: readonly SiteId[] | 'all';
  capabilities: readonly Capability[];
  enabledModules: readonly ModuleId[];
  audience: 'office' | 'employee' | 'customer' | 'carrier' | 'terminal' | 'machine';
  expiresAt: string;
  requestId: string;
  correlationId: string;
}>;
```

`actorId` är den verkliga inloggade personen. `effectiveUserId` är personen
vars arbetsvy används. Den verkliga identiteten får aldrig döljas i historiken.
Effektiva rättigheter ska vara skärningen mellan båda identiteternas tillåtna
åtgärder, anläggningar, modulåtkomst och eventuella supportbegränsningar.

Interaktiva bolagsanrop följer samma ordning:

1. Autentisera och kontrollera aktuell sessionsversion.
2. Välj ett tillåtet bolag från plattformsregistret.
3. Hämta aktiva medlemskap och aktuell behörighet från servern.
4. Kontrollera att modulen är aktiverad för bolaget.
5. Slå upp objektet genom ett tenantbundet repository.
6. Auktorisera åtgärden mot objektets ägare, anläggning och tillstånd.
7. Validera kommando, revision och eventuell idempotensnyckel.
8. Spara ändring, audit och outbox atomiskt; returnera en begränsad projektion.

En meny är vägledning. Samma regler gäller direkt API-anrop, filer, export,
WebSocket/SSE, bakgrundsjobb och integrationers callbacks.
Ett avstängt modulkort får inte lämna dess skriv-API öppet.
Jobb och provider-callbacks använder uttryckliga maskin-/leverantörspolicyer,
utan krav på en levande mänsklig webbläsarsession. Plattformsoperationer har
en separat `PlatformContext`; de ska inte tvingas välja ett kundbolag.

### Publika prover och besökscapabilities

En publik röstdemo kan använda en separat `PublicDemoContext`: servervalt
bolag, slumpad kortlivad capability och åtkomst till just det egna samtalet.
Den ger inget medlemskap och får aldrig godkännas som en generell kontors-
eller administratörsidentitet. Åtkomsten avgränsas både i route och resultat.
En besökare ska inte kunna lista historik eller byta ett objekt-ID för att
läsa någon annans transkript. Godkänd offentlig kunskap, CSRF/Origin-skydd
och beständiga globala/IP-/sessionskvoter behövs även när ingen login visas.

### Systemadmin och kundsupport

Plattformsadministratör får hantera bolag och välja arbetskontext. Det innebär
inte att token, lösenord eller krypteringsnycklar ska visas i gränssnittet.
MFA, återautentisering för känsliga åtgärder och återställningsrutin är krav
på den nya kärnan; de är inte färdiga funktioner i dagens plattform.

Kundsupport ska vara en egen namngiven identitet med uttryckliga bolag,
capabilities, orsak och utgångstid. Standardåtkomst ska utesluta utbetalning,
attest, användaradministration, HR-intyg och hantering av hemligheter.
Stödåtkomst ska synas tydligt i UI och audit och kunna återkallas omedelbart.

Att välja ett kundkonto får aldrig höja en supportpersons rättigheter.
Om ett bolag inaktiveras ska nya affärskommandon stoppas, öppna streams avslutas och
jobb följa en uttrycklig paus-/avvecklingspolicy utan att historik raderas.
Verifierade kvittenser och avstämning av redan påbörjade externa operationer
behöver en särskild avvecklingsväg så att okända utfall inte överges.

### Bolagsgränsen omfattar mer än SQL

- Alla repositoryhandles är bundna till ett servervalt bolag.
- Cache, sökindex, exporter, jobb, idempotens och rate limits har tenantnyckel.
- Filnycklar och nedladdningar kontrolleras mot bolag och objektbehörighet.
- OAuth-state binds till bolag, session, anslutningsgeneration och utgångstid.
- Bolagsbyte avbryter väntande klientanrop och rensar gammal arbetscache.
- Fördröjda svar från föregående bolag ignoreras av klienten.
- Ett saknat schema eller konto ger fel; ett annat bolag används aldrig som reserv.

Välj och dokumentera en DB-isoleringsmodell: schema per bolag med kontrollerade
roller, separata databaser eller delade tabeller med genomgående tenantnyckel
och verifierad RLS. Nuvarande schemaindelning är ett möjligt utgångsläge,
inte bevis för att DB-användaren omöjligen kan läsa över bolagsgränsen.

## Filer, hemligheter och återställning

Filer ska ha klassificering, tenant, ägarobjekt, storlek, innehållstyp,
kontrollsumma, versionsnummer, skapare och lagrings-/gallringsregel.
Publik logga och privat sjukintyg får aldrig dela åtkomstpolicy.
Original som styrker ekonomi ska vara oföränderliga; rättelser skapar ny version.

Lagringsadaptern kan börja med databasens BYTEA och senare använda privat
objektlagring. Affärsmodulen ska använda fil-ID, inte känna till bucket eller disk.
Nedladdning kräver ny auktorisering; eventuell signerad URL är kortlivad.
Uppladdning ska ha kvot, avkodning/typkontroll och riskanpassad karantän/skanning.

Miljövariabler/secret files lagrar plattformens serverhemligheter.
Kundens OAuth-token eller egna integrationsuppgifter lagras krypterat och
tenantbundet bakom en credential-adapter. De ska inte bli frontendkonfiguration.
Krypteringsnycklar behöver versions-ID och en provad rotationsprocedur.
Rotation får inte göra befintliga anslutningar oläsbara utan kontrollerad migrering.

Backup måste omfatta plattformsregister, bolagsdata, filer, jobbstatus och
återställningsbara nyckelreferenser. Fastställ RPO och RTO innan försäljning
av driftnivåer. Export av ett register är inte en full backup eller PITR.
Återställ till separat miljö med externa leveranser spärrade och kontrollera
att redan utförda betalningar och meddelanden inte skickas igen.

## Jobb, integrationer och okända resultat

Gemensamt jobbformat ska innehålla tenant, modul, operation, stabilt jobb-ID,
idempotensnyckel, payloadversion, skapare, försök, lease och nästa körning.
Jobb ska återauktoriseras enligt sin uttryckliga tjänstepolicy; en fryst
klientsession är inte ett obegränsat mandat att utföra framtida åtgärder.

Tillstånd skiljs åt: köad, pågående, väntar, slutförd, definitivt avvisad,
okänt utfall, blockerad och manuellt granskningskrävande.
HTTP 200/202 från en leverantör betyder bara vad just den operationens
dokumenterade kontrakt säger; det är inte automatiskt genomförd betalning.

Vid timeout eller förlorat svar efter en möjlig sidoeffekt:

1. Behåll reservationen och samma externa instruktion-ID.
2. Markera okänt utfall och visa vad systemet vet.
3. Återläs samma operation med begränsad backoff.
4. Skapa ingen ny betalning förrän tidigare utfall säkert har avförts.
5. Eskalera till manuell granskning när automatiken saknar säkert svar.

Leverantörsfel ska inte blockera andra bolags köer. Använd kvoter, tidsgränser,
leases och rättvis schemaläggning. Misslyckade jobb ska finnas kvar med säker
diagnostik, ansvarig åtgärd och larm; de får inte bara försvinna ur kön.

En lease räcker inte för att stoppa en gammal worker som återupptas efter
att någon annan tagit över. Kontrollera aktuell ägar-/fencingtoken vid commit,
och använd provider-idempotens och avstämning för externa sidoeffekter.

Inkommande webhooks måste autentiseras enligt providerkontraktet, verifieras
mot tidsfönster/replay och dedupliceras före affärsändring. Behåll råa bytes
för signaturkontroll där protokollet kräver det. Kundvalda utgående URL:er
behöver SSRF-skydd: godkända HTTPS-destinationer, DNS-/redirectkontroll,
spärr mot loopback/interna nät/metadatatjänster och begränsad svarsstorlek/tid.

## Acceptansmatris – samtliga 51 punkter

Varje rad är ett krav och ett föreslaget bevis. En ruta blir godkänd först
när provet körts mot rätt byggversion och relevant miljö med sparat resultat.
Mockade leverantörer, SQLite och lokal kodgranskning ska anges som sådana.

### Identitet, behörighet och indata

| Nr | Kontroll | Krav på kärnan | Acceptansprov |
|---|---|---|---|
| 1 | Autentisering | Slumpmässiga, hashat lagrade sessionstoken med utgångstid och serverkontrollerad sessionsversion. | Manipulerad, utgången och återkallad token nekas; klienttid får inte förlänga sessionen. |
| 2 | Auktorisering | Kontrollera aktiv verklig/effektiv användare, capability och objekttillstånd vid varje operation. | Inloggad läsare nekas skrivning, export och privilegiehöjning genom direkt API. |
| 3 | Bolagsisolering | Bolag kommer från verifierad serverkontext; data och sidoeffekter binds till samma bolag. | Två bolag med samma objekt-ID kan inte läsa, ändra, exportera eller följa varandras jobb. |
| 4 | IDOR | Objektuppslagning sker inom tenant och tillåten anläggning/ägare. | Byt ID i URL, body, fil-ID och nested relation; ingen främmande data exponeras. |
| 5 | Rate limits | Beständiga, budgeterade gränser per relevant konto, adress, bolag och dyr operation. | Trafik över gräns ger 429 utan sidoeffekt; fördelade anrop kan inte kringgå kontogränsen. |
| 6 | Brute force | Begränsa lösenord, OTP och återställningsförsök utan kontouppräkning. | Samma konto från flera adresser bromsas; okänd användare får motsvarande svar och arbetskostnad. |
| 7 | Indatavalidering | Strikta serverscheman, kroppsstorlek, format, kvot och domänregler för alla skrivvägar. | Extra fält, djupa objekt, ogiltiga belopp och arkivpayload nekas före ändring. |
| 8 | XSS | Text renderas som text; HTML och länkar följer uttrycklig sanerings-/protokollpolicy. | Skriptpayload i namn, mejl, wiki och filnamn körs inte i visning eller export. |
| 9 | SQL/ORM-injektion | Bind värden; allowlista dynamiska identifierare och scheman. | Injektionssträngar och otillåtna schema-/sorteringsnamn kan inte ändra frågans struktur. |
| 10 | CSRF | Cookieautentiserade mutationer kräver CSRF och kontrollerat ursprung; GET ändrar inte säkerhetskontext. | Cross-site POST och länkburet bolagsbyte nekas; korrekt samma-origin-flöde fungerar. |
| 11 | Filuppladdning | Typ/storlek/innehåll, säkra namn, behörighet, kvot och riskanpassad karantän. | Fel MIME, polyglot, enorm bild, skadligt dokument och främmande fil-ID avvisas eller isoleras. |
| 12 | Hemligheter | Endast server/vault; krypterade tenantcredentials, redigering utan återläsning och provad rotation. | Git-/bundle-/loggskanning hittar inga nycklar; rotation behåller kontrollerad åtkomst. |
| 13 | Miljöseparering | Dev, test, staging och produktion har separata DB/credentials och leveransspärrar. | Teststart med produktions-URL blockeras; staging kan inte skicka skarp betalning/mejl. |
| 14 | Lösenordshashning | Modern saltad password-KDF med dokumenterade parametrar och uppgraderingsväg. | Samma lösenord ger olika hash; verifiering och parameteruppgradering fungerar utan klartext. |
| 15 | Återställning | Engångstoken, kort giltighetstid, hashad lagring och neutral återkoppling. | Återanvänd, utgången och modifierad länk nekas; temporär första åtkomst förfaller enligt policy. |
| 16 | Sessionsåterkallning | Logout och säkerhetsändringar återkallar samtliga berörda klienter och streams. | Byt lösenord i mobilen; gamla kontors-/portal-/mobilsessioner och tokens slutar fungera. |
| 17 | CORS | Exakt betrodda ursprung och credentials-policy; ingen slentrianmässig wildcard. | Främmande origin får ingen credentialåtkomst; tillåtna klienter klarar preflight. |
| 18 | Säkerhetsheaders | Anpassad CSP, frame-policy, nosniff, referrer-policy och HSTS för avsedd HTTPS-drift. | Kontrollera faktiska HTML/API/filsvar i staging; nödvändiga OAuth- och appflöden fungerar. |
| 19 | Känsliga loggar | Maskera token, lösenord, personnummer, bankdata och providerpayload; säkra fel-ID. | Utlös fel med markerade testhemligheter; varken logg, UI-diagnos eller telemetry läcker dem. |
| 20 | Audit | Beständig logg för aktör, effektiv användare, bolag, objekt, åtgärd, tid och version. | Genomför supportändring, attest, radering och betalning; båda identiteterna och resultatet kan följas. |

### Databas, samtidighet och återställning

| Nr | Kontroll | Krav på kärnan | Acceptansprov |
|---|---|---|---|
| 21 | Index | Index för tenant, relationer, status, tid och verkliga vanliga sökningar. | EXPLAIN ANALYZE på representativ volym visar rimlig kostnad för kritiska listor och jobbclaims. |
| 22 | N+1 | Läsprojektioner hämtar data samlat med begränsad frågetillväxt. | Jämför SQL-antal för 1, 50 och 500 poster; inga hemliga följdfrågor per rad. |
| 23 | Paginering | Servergränser och stabil cursor/sortering för alla växande listor och exportflöden. | Stor tenant ger begränsat svar; sidbyte under samtidiga ändringar hanteras utan dataläckage. |
| 24 | Pooling | Central totalbudget för anslutningar över moduler, bolag och processer. | Starta många bolag/workers; anslutningar håller budgeten och poolväntan har timeout. |
| 25 | Transaktioner | Relaterad data, audit och outbox har en commit; externa anrop sker utanför DB-lås. | Injicera fel mellan delsteg; allt återställs och ingen extern åtgärd körs före commit. |
| 26 | Race conditions | Kritiska kommandon förblir korrekta över flera processer och omstarter. | Parallella betalningar, bokningar och tilldelningar mot riktig PostgreSQL ger ett giltigt utfall. |
| 27 | Låsning | Revision/CAS eller specifika radlås där dubbla uppdateringar spelar roll. | Två användare sparar gammal revision; en får begriplig konflikt utan förlorad ändring. |
| 28 | Unika constraints | Affärskritisk unikhet skyddas i databasen, inom rätt tenant. | Parallella inserts med samma affärsnyckel ger en post; annat bolag påverkas inte. |
| 29 | Idempotens | Stabil operationsnyckel, payloadfingerprint och återspelat resultat för sidoeffekter. | Dubbeltryck, tappat HTTP-svar och omstart skapar inte ny betalning/order; ändrad payload nekas. |
| 30 | Atomiska saldon | Lager, räknare och reserveringar uppdateras atomiskt med dokumenterad invariant. | Samtidiga uttag/insättningar ger korrekt saldo och tillåter inte negativt otillåtet lager. |
| 31 | Migrationer | Versionsförd historik, låsning och kompatibla expand/contract-steg; inget oavsiktligt demoreset. | Kör uppgradering på representativ kopia och blandade appversioner utan förlust av original. |
| 32 | Rollback | Provad kod-/schema-/fil-/integrationsstrategi med tydlig gräns för irreversibla steg. | Avbryt release och återgå; data och redan skickade externa instruktioner behåller korrekt betydelse. |
| 33 | Backup | Schemalagd komplett backup/PITR enligt vald drift, inklusive filer och plattform. | Kontrollera backupålder, omfattning, åtkomst och larm vid fel; registerexport räcker inte. |
| 34 | Restore | Regelbundna isolerade återställningsprov med RPO/RTO och leveransspärrar. | Återställ alla bolag/filer, verifiera checksummor och att gamla jobb inte betalar/skickar igen. |
| 35 | Retention/radering | Beslutade regler per dataklass, juridisk lagring, soft delete och faktisk gallring. | Avsluta bolag och gallra förfallen HR-data; lagstadgade original bevaras och åtkomst återkallas. |

### Fel, jobb, observability och skala

| Nr | Kontroll | Krav på kärnan | Acceptansprov |
|---|---|---|---|
| 36 | Felhantering | Begripliga fel, bevarat arbete och ErrorBoundary; okänt utfall skiljs från avslag. | Simulera render-/chunk-/API-fel; återhämtningsvy visas utan tyst korruption eller vit sida. |
| 37 | Retries | Begränsad backoff/jitter och Retry-After endast för säkert återförsökbara operationer. | Timeout efter möjlig betalning leder till återläsning av samma ID, aldrig blind ny POST. |
| 38 | Timeouts | HTTP-, pool-, statement- och lock-timeouts med avbrotts-/städpolicy. | Hängande provider och DB-lås avslutas inom budget; inga eviga leases eller låsta klienter. |
| 39 | Felisolation | Separata providerbudgetar och circuit breaker där upprepade fel annars sprids. | Stäng en leverantör; andra bolag och funktioner fortsätter och återgång sker kontrollerat. |
| 40 | Bakgrundsjobb | Långsamma sidoeffekter körs beständigt med versionerad payload och tenantbindning. | Starta om mellan reservation och leverans; jobbet återupptas utan tapp eller dubbelutförande. |
| 41 | Dead letter | Ändligt retrytak, granskningsläge, säker diagnostik och manuell åtgärd. | Permanent fel når synligt slutläge och larm; återkörning kräver verifierat mandat. |
| 42 | Cron/claims | Atomiska claims/leases, fencing vid commit och provider-idempotens skyddar övertagande. | Pausa leaseägaren, låt annan ta över och återuppta den gamla; ingen dubbel sidoeffekt. |
| 43 | SSE/WebSocket | Aktuell auktorisering, heartbeat, reconnect, cursor/revision och cleanup. | Byt bolag/behörighet och bryt nätet; gammal stream stängs och rätt scope återansluts. |
| 44 | Externa API | Bounded paginering, kvot, 429/Retry-After och försvar mot oändliga cursorloopar. | Flera sidor, upprepad cursor och throttling ger komplett kontrollerat resultat inom budget. |
| 45 | Observability | Strukturerade säkra loggar, request/job-ID, metrics och spårbar kontext. | Följ ett misslyckat UI-kommando till jobb/provider med ett fel-ID utan känslig payload. |
| 46 | Health/readiness | Liveness mäter process; readiness mäter nödvändiga beroenden efter start. | Ta bort DB-åtkomst under drift; readiness faller utan att frivillig Expo-start styr CRM-hälsa. |
| 47 | Larm | Ägare och larm för felandel, köålder, DB-utrymme/anslutningar och backup/restore. | Utlös varje larm i staging och dokumentera mottagning, åtgärd och återställning. |
| 48 | Automatiska tester | CI-gate för auth, tenant, negativa rättigheter, pengar och kritiska modulkontrakt. | En avsiktlig behörighetsregression stoppar merge/release; PG-prov körs i separat miljö. |
| 49 | Beroenden | Låsfiler, kontrollerade uppgraderingar och återkommande dependency-/secret-scan. | Ren reproducerbar installation; fynd har åtgärd eller dokumenterad nåbarhets-/riskbedömning. |
| 50 | Last/felprov | Realistisk flerbolagslast, samtidighet, långkörning och partiella fel mot PostgreSQL. | Mät p95/p99, fel, låstid och köålder vid dokumenterat mål; återhämtning håller invariants. |
| 51 | Arkitektur/skala | Kapacitetsmål styr normalisering, processgränser och pooler; isolera högvolymtelemetri. | Mät målbelastning och flaskhals innan uppdelning; CRM:s svarstid skyddas under ingest-last. |

## Gate före demo, pilot och skarp drift

För en publik demo krävs kontrollerad syntetisk data, serveravstängbara
demokonton, rättade åtkomstfel och verifierade bolags-/sessionsgränser.
En demo får inte presenteras som redo för riktiga personuppgifter eller pengar.

Före pilot med riktiga kunddata krävs dokumenterade beslut och godkända prov
för samtliga tillämpliga rader ovan, full restore, driftansvar och återgång.
Testprotokollet ska ange commit, miljö, testdata, resultat och kvarstående risk.
Avsteg behöver ägare, motivering och tidsgräns; en allmän grön etikett räcker inte.

Skarpa pengar, telefon, SMS och mejl har dessutom separata leverantörsgates:
rätt avtal/behörighet, miljöspärr, mottagarkontroll, kvoter, idempotens och
verifierat slutresultat. Sandboxens godkännande ersätter inte dessa kontroller.

Den återanvändbara grunden är klar när en ny tom testprodukt klarar samma
negativa tester, utan ScrapPilots kunder, register, priser, demokonton eller
legacy-undantag. Först då är den ett praktiskt skelett för nästa SaaS.
