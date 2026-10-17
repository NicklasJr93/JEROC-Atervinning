# SaaS-kärnan: identitet, bolag, arbetsytor och gemensamma vyer

Detta är ett byggrecept för en återanvändbar SaaS-grund, med ScrapPilot som konkret förebild.
Det beskriver ett mål för kommande produkter; dokumentationen extraherar inga paket och ändrar ingen körande funktion.
**Finns idag** betyder att motsvarande kod har identifierats i repot. **Mål** är ett kontrakt att implementera och verifiera.
Säkerhetskrav och modulgränser fördjupas i [säkerhetsreceptet](03-sakerhet-och-drift.md) och [modulreceptet](02-moduler.md).

## 1. Dela produkten i tre lager

1. **SaaS-kärna:** bolag, identitet, medlemskap, behörigheter, arbetsytor och gemensamma tjänster/UI-mönster.
2. **Verksamhetsmoduler:** exempelvis dispatch, personal, tid, fordon och utrustning.
3. **Produkt-/branschlager:** produktens sammansättning, varumärke och exempelvis återvinningens viktkort/NVV-regler.

Produktägarens plattformsadministration och kundbolagets arbetsyta är två skilda
åtkomstytor inom denna arkitektur. Plattformen ansvarar för provisionering och
supportåtkomst; en bolagsvy arbetar alltid inom ett verifierat bolag.

Kärnan får inte kräva att ett bolag har viktkort, skrotartiklar, chaufförer eller ett visst ekonomisystem.
En produktinstallation väljer moduler och branschregler. Bolaget väljer sina inställningar inom produktens ramar.
Bygg först en modulär applikation med tydliga kontrakt; separata nätverkstjänster behövs när drift eller belastning motiverar det.

## 2. CoreIdentity: person är inte samma sak som konto

**Målmodell:**

| Begrepp | Ansvar | Får inte automatiskt innebära |
|---|---|---|
| `Account` | Autentiserbar identitet, verifierade kontaktvägar, credentialstatus | Anställning, bolagsåtkomst eller chefsrättigheter |
| `Person` | En människa i bolagets verksamhet | Egen inloggning eller konto hos produktägaren |
| `Membership` | Koppling mellan konto och bolag, aktivstatus och behörighetsprofil | Åtkomst till andra bolag |
| `SiteAssignment` | Tillåtna anläggningar/avdelningar inom medlemskapet | Aktuell arbetsplats eller alla framtida platser |
| `ServicePrincipal` | Maskinidentitet med avgränsade rättigheter | Mänsklig systemadministratör |

Ett konto kan ha flera medlemskap. Ett bolag kan ha personer utan inloggning och externa kontaktpersoner.
Anställning, lön och sjukfrånvaro ligger i HR-moduler med egen åtkomstkontroll, inte i kontots generella profil.
Undvik e-post som stabil primärnyckel: en e-postadress kan ändras och är en separat verifierbar kontaktväg.

**Finns idag:** plattformskonto, medlemskap och verksamhetsperson är skilda strukturer i
[platform-auth.mjs](../../server/platform-auth.mjs) och [tenant-runtime.mjs](../../server/tenant-runtime.mjs).
Personen kopplas till verksamhetsanvändaren via `userId`; mobilens autentiseringskonto kopplas via `personId`.
Identiteten synkroniseras mellan befintliga delar. Det är en grund att utveckla, inte ett redan fristående identitetspaket.

## 3. Gör bolag, plats och audience explicita

**Mål:** bolagsoperationer använder `ExecutionContext` enligt
[säkerhetskontraktet](03-sakerhet-och-drift.md#kärnans-obligatoriska-säkerhetskontrakt).
Det innehåller bland annat `actorId`, `effectiveUserId`, `tenantId`, platsåtkomst,
`audience`, capabilities, session/generation, utgångstid och korrelations-ID.
Plattformsoperationer får en separat `PlatformContext` utan tenant;
det betyder aldrig "första bolaget".
`audience` skiljer exempelvis office, employee, customer, carrier, terminal och machine åt.
Ett giltigt kontorskonto eller publikt bolagsval får inte automatiskt användas som en kund- eller terminalsession.
Servern härleder åtkomsten från session, medlemskap, aktuell objektägare och tillåten operation.
Ett ID i URL, header, webhook eller jobbpayload är en uppgift att kontrollera, inte ett åtkomstbevis.

Aktiv plats är ett arbetsval inom tillåtna platser. En redan skapad post behåller sin registrerade plats.
Menyfilter och aktiv plats är presentation; servern kontrollerar även läsning, ändring och export på objektnivå.

**Finns idag:** [tenant-gateway.mjs](../../server/tenant-gateway.mjs) väljer serverbundna tjänster.
[tenant-public-context.ts](../../src/tenant-public-context.ts) fångar publikt bolagsval utan att ge registeråtkomst.
[ActiveSitePicker.tsx](../../src/employee/ActiveSitePicker.tsx) låter personal välja bland tilldelade aktiva anläggningar.
Portalerna har separata autentiseringsflöden. Ett generellt `audience`-kontrakt enligt ovan är målbilden.

## 4. Skilj tre administrationsroller åt

| Roll | Målansvar | Förbjuden genväg |
|---|---|---|
| Plattformsadmin | Provisionera bolag, hantera produktdrift och särskilt godkänd bolagsåtkomst | Oavsiktlig åtkomst till alla bolag från varje vanlig vy |
| Bolagsadmin | Konton, behörigheter och inställningar inom ett bolag | Skapa plattformsadministratörer eller byta tenant via klientdata |
| Begränsad support | Hjälpa till i namngivna bolag under en avgränsad supportsession | Ärva plattformsadmins alla operationer |

**Finns idag:** plattformsactor har `platformAdmin`; bolagsanvändaren har nivå och explicita permissions.
"Plattformens systemadmin · egen behörighet" skiljs i bolagsväljaren från "namn · bolagets konto".
Att arbeta som ett bolagskonto innebär att det effektiva kontots begränsningar ska gälla.
Historik ska behålla både den verkliga aktören och den effektiva användaren.

**Mål, inte färdig funktion:** separat supportroll med tilldelade bolag, tidsgräns, anledning/ärendereferens,
tydlig banner, uttryckligt avslut och egen audit. Support får inte hantera plattformsroller eller läsa hemligheter.
Känsliga operationer kräver separat rättighet; en titel som VD eller chef ersätter inte den kontrollen.

Kodförebilder: [PlatformCompanySwitcher.tsx](../../src/platform/PlatformCompanySwitcher.tsx),
[PlatformGate.tsx](../../src/platform/PlatformGate.tsx), [platform-auth.mjs](../../server/platform-auth.mjs).

## 5. Gör sessionens tillstånd till ett tydligt flöde

**Mål:** `anonymous → authenticated/password-change-required → platform-home eller tenant-selection → tenant-workspace`.
Utgångar är logout, tidsgräns, avstängt konto, återkallat medlemskap eller avslutad supportsession.
Skydda API:er även när klienten fortfarande visar en gammal vy. Dold navigation är ingen sessionskontroll.

**Finns idag:** [PlatformLogin.tsx](../../src/platform/PlatformLogin.tsx),
[PlatformPasswordChange.tsx](../../src/platform/PlatformPasswordChange.tsx) och `PlatformGate` hanterar huvudstegen.
Servern använder slumpmässiga sessionsvärden, lagrade tokenhashar, utgångstid och återkallelse vid logout.
Plattforms-API:t sätter HttpOnly-cookies och använder CSRF-/kontextkontroller; detaljer granskas i säkerhetsreceptet.
Första lösenordsbytet spärrar fortsatt användning tills serverns byte lyckats.

**Mål:** plattformens startsida ska fungera utan vald tenant och utan att öppna någon bolagsdatabas.
En riktig `leaveTenant()` avslutar bolags-/supportkontext men behåller tillåten plattformsinloggning.
Logout avslutar inloggningen. "Till systemadministration" och "Logga ut" är två olika handlingar.
Nuvarande adminvy finns, men nuvarande serverflöde har en historisk JEROC-koppling; kopiera inte den som neutral kärna.

## 6. Byt bolag och behörighet som en säker gräns

**Målrecept för ett byte:**

1. Stoppa nya ändringar och hantera pågående formulär med ett tydligt spara/avbryt-val.
2. Servern verifierar målbolag, medlemskap och eventuell effektiv användare; inga nya rättigheter hämtas från klienten.
3. Servern roterar sessions-/kontextvärden och skapar en ny generation; föregående kontext blir ogiltig.
4. Klienten avbryter gamla HTTP-anrop, stänger SSE/WebSocket-strömmar och tömmer tenantbundna cacheposter.
5. Svar från tidigare generation får inte fylla nya formulär, listor, notifieringar eller offlineköer.
6. Den nya arbetsytan laddar en verifierad kontext innan moduler och bakgrundsabonnemang startas.

Nyckla beständig klientcache med tenant, audience och principal. Använd generation för pågående arbete och sessionscache.
En gammal offlineändring får aldrig omtolkas till det nya bolaget; bevara dess ursprung och begär ny kontroll.
Bakgrundsjobb och strömmar måste återkontrollera åtkomst även efter att den ursprungliga HTTP-requesten avslutats.

**Finns idag:** `PlatformGate` laddar om sidan vid bolagsbyte och key:ar arbetsytan med organisation/generation.
[session.ts](../../src/platform/session.ts) skickar kontextheaders bara till eget API och behåller anropets explicita generation.
Servern avvisar gammal kontext; [tenant-gateway.mjs](../../server/tenant-gateway.mjs) hanterar tenantbundna strömmar.
Det fullständiga beteendet ovan är ett acceptanskrav för varje ny cache-, stream- och offlinemodul.

## 7. Provisionera bolag som ett återupptagbart arbete

**Finns idag:** skapa bolag tar namn, organisationsnummer, VD-namn och VD-e-post.
[PlatformAdmin.tsx](../../src/platform/PlatformAdmin.tsx) använder stabilt `requestId` för samma skapandeförsök.
Servern reserverar identiteter, provisionerar lagring och första konto, och markerar `provisioning`, `active` eller `failed`.
Det första VD-kontot får ett slumpmässigt tillfälligt lösenord och obligatoriskt lösenordsbyte.
Tillfälliga uppgifter visas en gång; vanlig läsning returnerar inte lösenord eller lagringsscheman.
Nya bolag får tom verksamhet och en första plats utan kopierade demokunder, priser eller rapporter.
Detta finns i [platform-auth.mjs](../../server/platform-auth.mjs) och [tenant-runtime.mjs](../../server/tenant-runtime.mjs).

**Mål för nästa produkt:**

1. Reservera tenant och ägare med idempotency; verifiera unikhet med databaskrav.
2. Kör versionssatta kärn- och modulmigrationer; registrera misslyckande utan att öppna halvt färdig tenant.
3. Skapa administratörens medlemskap med fastställda rättigheter och vald första plats.
4. Skicka en tidsbegränsad engångsinbjudan via serverns utkorg; spara tokenhash, aldrig den råa länken i audit.
5. Aktivera efter godkänd inbjudan och verifiering; gör status, omsändning och spärr synliga för behörig admin.

E-postlevererad inbjudan med ovanstående egenskaper är ett förslag, inte det befintliga tillfälliga-lösenordsflödet.
Återförsök måste återuppta samma provisionering; misslyckad mejlleverans får inte skapa ett andra bolag eller konto.

## 8. Tenantbunden lagring utan implicita genvägar

**Finns idag:** nya PostgreSQL-bolag har servergenererat separat schema och schemaavgränsade tjänster/pooler.
`tenantRuntimeEnvironment` ersätter `search_path` utan `public`-fallback och använder separata lokala SQLite-sökvägar.
Schema-ID hämtas ur plattformsregistret och valideras; det accepteras inte som godtycklig browserinställning.
Plattformsregistret och verksamhetsdata har olika ansvar men nyttjar den driftskonfiguration som installerats.

**Begränsning idag:** applikationen använder delat databaslogin; schemaavgränsningen är inte PostgreSQL RLS
eller separata databasroller per bolag. Ett felaktigt kvalificerat SQL-anrop eller komprometterad server kan överskrida den gränsen.
`REVOKE ... FROM PUBLIC` ersätter inte en avgränsad applikationsroll eller serverns objektkontroller.
Första JEROC-bolaget har historisk lagring i `public`; den kompatibiliteten är inte mall för nya produkter.

**Mål:** `TenantRepositoryFactory.open(verifiedTenantContext)` är enda vägen till verksamhetsrepository.
Saknad tenant, schema eller tenantstatus ger fel; kärnan får inte falla tillbaka till ett demobolag, standardbolag eller `public`.
Migration och explicit import är egna administrerade vägar. Lägg inte automatisk demoseed i ordinarie läsning.
Logisk tenantidentitet ska finnas i dokumentmetadata, jobb, integrationer, audit och cache även när databasen är schemaavgränsad.
Öka databasisoleringen om hotbild, avtal eller drift kräver det; en databas per tenant är ett alternativ, inte ett krav från start.

## 9. Global konfiguration och bolagets egna kopplingar

| Nivå | Exempel | Hantering i målbilden |
|---|---|---|
| Installation | Databasanslutning, produktens OAuth-klient, krypteringsnyckel, tillåtna callback-URL:er | Driftens secret store/environment, aldrig klienten |
| Bolag | Godkänt externt företag/konto, tokens, certifikat, vald sandbox/live-miljö | Tenantbunden krypterad lagring och avgränsad administrering |
| Person/session | Godkännande, verifierad principal, förfallotid | Återkalleligt och kopplat till rätt tenant/audience |

Bolagsinställningar ska inte kräva en ny uppsättning Render-variabler per kund.
Krypteringsformat behöver nyckelversion, rotation och tenant/provider-bindning; returnera bara maskerade statusfält till UI.
Återanslutning är inte samma sak som att kopiera föregående bolags credentials. Ett nytt externt bolag kräver ny verifiering.
Utgående OAuth-state och inkommande callback/webhook måste kopplas till en serverlagrad tenantkontext, inte användarens senaste bolagsval.
Sandbox och live ska skiljas i credentials, resursreferenser och utföranderättigheter; miljöbyte får inte återanvända betalnings-ID:n.
Verifiera inkommande webhooks med leverantörens dokumenterade signatur eller
motsvarande autentisering, tidsfönster och replay-/dupliceringsskydd.
Tenantbindning i payload bevisar inte avsändaren. Provideranrop och konfigurerbara
fetch-URL:er behöver en egress-/SSRF-policy med destination, protokoll,
DNS-/redirectkontroll och spärr mot interna/metadatadestinationer.

**Finns idag:** bland annat Spiris har tenantbundna anslutningsflöden och krypterade tokens; `tenant-runtime.mjs`
skiljer delade OAuth-inställningar från bolagsspecifika värden och rensar vissa ärvda integrationsvärden för nya bolag.
Alla integrationer är ännu inte en enhetlig anslutningsplattform; säker onboarding av varje leverantör måste granskas separat.

## 10. Generera navigation från samma betrodda modulregister

**Finns idag:** kontorsmenyn och specialvillkor ligger i [OfficeApp.tsx](../../src/office/OfficeApp.tsx).
Den filtreras på permissions; workspaces lazy-loadas. Generell modul-/abonnemangsmotor finns inte.
Entrypoints och separata portaler väljs i [main.tsx](../../src/main.tsx).

**Mål:** betrodda modulmanifest deklarerar route, audience, menygrupp, ordning, översättningsnyckel och permission.
Servern kombinerar installerade moduler, bolagets aktiva rätt till modulen och principalens objekträttigheter.
Samma beslut gäller API, export, notifieringsräknare och jobb; kundens frontendläge kan inte aktivera en modul.
Publika callbacks kan behöva tas emot efter avstängning för att avsluta tidigare arbete säkert enligt modulens livscykel.

Plattformens meny: Bolag, Supportåtkomst, Drift och plattformsinställningar.
Bolagets meny: Översikt, aktiverade verksamhetsmoduler och Administration.
Administration samlar användare/behörigheter, platser, integrationer och bolagsinställningar.
Detta är föreslagen struktur; dagens meny är verksamhetsanpassad och innehåller fler separata poster.

## 11. Återanvänd sidtyper och interaktionsregler

**Listvy:** sticky titel, primär handling, flikar, sök/filter; paginerat innehåll och tydlig tom/fel/laddarstatus.
**Detaljvy:** breadcrumbs/tillbaka, titel och primära handlingar; spara/avbryt visas i redigeringsläge.
**Kalender:** gemensamt resurs-/tidskontrakt, synlig tidszon, alternativ till drag/drop och servervaliderade konflikter.
**Integrationsvy:** begripligt anslutningskort för användaren och separat behörig felsökning med maskerad teknisk information.
**Mobil:** få permanenta navigationer; moduler tillför uppgifter och genvägar med tydlig progress och återhämtning.

**Finns idag:** [OfficePageHeader.tsx](../../src/office/OfficePageHeader.tsx) mäter skalet och samlar sticky sidkontroller.
[page-header.css](../../src/office/page-header.css) hanterar mobilhöjd och utskrift; översiktens summeringar ligger i innehållet.
[WeightCardRows.tsx](../../src/office/WeightCardRows.tsx) stödjer klickbar rad, tangentbord och kompakt preview.
[useWeightCardListNavigation.ts](../../src/office/useWeightCardListNavigation.ts) bevarar listkontext vid tillbaka.
Generiska motsvarigheter måste extraheras utan viktkortsnamn och få samma fokus-, touch- och navigationsbeteende.

## 12. Branding, språk och datatyper hör hemma i kärnan

**Mål:** produktvarumärke och bolagsvarumärke har separata inställningar; säkra uppladdade loggor och begränsade designvärden.
Behåll produktens identitet i plattform/inloggning och visa aktivt bolag tydligt i arbetsytan.
Språk väljs med språknamn, exempelvis Svenska/English; flagga ensam anger inte språk entydigt.
Lagra översättningsnycklar i navigation/komponenter och en verifierad språkpreferens per konto; bolaget får ett standardspråk.
Lagra tidpunkter i UTC, lokal kalenderdag som datum och bolagets IANA-tidszon separat.
Beräkna dygn, arbetspass och sommartidsbyten med vald policy; översättningen får inte flytta en rapporterad arbetsdag.

**Finns idag:** produktlogga och bolagsnamn separeras i [ProductBrand.tsx](../../src/platform/ProductBrand.tsx) och `PlatformGate`.
Mycket UI-text och `Europe/Stockholm` är fortfarande hårdkodat; full språk-/tidszonsplattform är mål, inte färdig funktion.
[data-format.ts](../../src/data-format.ts) delar normalisering/validering mellan webb, mobil och auktoritativ server.
Behåll telefon som landskod/E.164 där tillämpligt, organisationsnummer som validerad sträng och adress i strukturerade delar.
Identifierare och kontonummer är strängar; kontrollsiffra bevisar format, inte ägare, momsregistrering eller bankavtal.
Normalisering får inte hitta på saknade uppgifter eller skriva om ett historiskt signerat underlag.
Pengar kräver valuta och exakta decimaler/heltalsunderenheter; tidsintervall och måttenheter ska ha uttalade datatyper.

## 13. Stabilt kärn-API och föreslagen katalog

**Målportar:** `Identity`, `TenantContext`, `Authorization`, `TenantRepositoryFactory`, `Audit`, `Documents`,
`Jobs`, `IntegrationConnections`, `Notifications`, `Clock`, `Locale` och `ModuleRegistry`.
En modul använder dessa portar; kärnan importerar inte modulens viktkort, karensberäkning eller transportstatusar.
Portar behöver versionssatta DTO:er, transaktions-/felkontrakt och tester som andra produkter kan köra oförändrade.

```text
apps/office/                 # Produktens sammansättning och routes
apps/employee/               # Mobil sammansättning och audience
apps/portals/                # Kund/partner/terminal, separat autentisering
packages/core/              # Identitet, tenantkontext, policy och kärnportar
packages/ui/                # Sidtyper, tillgängliga kontroller och designvärden
packages/contracts/         # Versionssatta API-/eventkontrakt
modules/dispatch/            # Eget manifest, API, policy, UI, tester och migrationer
modules/people/             # Personalkärna; tid/frånvaro kan vara egna moduler
modules/time/               # Stämpel, rapportering, granskning
modules/recycling/          # Branschspecifika regler och objekt
adapters/                   # Databas, leverantörer, storage och driftsmiljö
```

Strukturen ovan är ett förslag. Dagens `src/` och `server/` ska inte flyttas enbart för att trädet ser rätt ut.
Extrahera först ett avgränsat kontrakt med grön verifiering och ett andra användningsfall; se [byggreceptet](04-byggrecept.md).
