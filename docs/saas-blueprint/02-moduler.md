# 02 · Återanvändbara moduler

[Överblick](README.md) · [Kärna](01-saas-karnan.md) · [Säkerhet](03-sakerhet-och-drift.md) · [Byggrecept](04-byggrecept.md)

Inventering: 17 oktober 2026. Detta är ett byggrecept med en beskrivning av nuläget.
Kodexemplen nedan är föreslagna kontrakt; de är inte ett redan implementerat modulsystem.

## Börja med en modulär monolit

Behåll en kodbas och en sammanhållen applikation med tydliga domängränser.
En modul ska kunna användas av flera produkter utan att känna till deras varumärke eller verksamhetsord.
Den behöver inte ha en egen server, databas eller deployment för att vara en modul.

Flytta ut en tjänst först när mätningar eller driftkrav motiverar det: egen skalning, säkerhetsgräns,
annat protokoll, resurskrävande jobb eller behov av oberoende releaser.
Telematikens TCP-mottagning är en rimlig framtida tjänstegräns; ett vanligt utrustningsregister är sällan det.
Separata tjänster kräver också övervakning, versionshantering, leveransgarantier och felhantering mellan tjänsterna.

## Tre delar i varje modul

1. **Modulmotor:** validering, regler, kommandon, läsmodeller och persistenskontrakt, utan React eller varumärke.
2. **Produktadapter:** kopplar exempelvis en generell bokning till ScrapPilots chaufför, kärl och arbetsorder.
3. **UI:** lista, detalj, kalender eller mobilvy som anropar motorn genom godkända kontrakt.

En kalenderkomponent och en bokningsmotor är två olika saker.
Kalendern ritar tider, resurser och förslag. Motorn bestämmer om bokningen får göras och sparar den atomiskt.
Samma motor kan användas av webb, mobil, import eller API; klientens kalender får aldrig vara enda kontrollen.

## Vad som ska ligga i kärnan

Kärnan äger bolag, identiteter, medlemskap, sessioner, platsåtkomst, behörighetspolicy och gemensam audit.
Den tillhandahåller också avgränsad databasåtkomst, filreferenser, modulregistrering och integrationsinfrastruktur.
Se [kärnreceptet](01-saas-karnan.md) och [säkerhetskraven](03-sakerhet-och-drift.md).

**Kunder, generella arbetsordrar, fakturor, personal och fordon är inte obligatoriska kärnobjekt.**
De kan vara återanvändbara basmoduler när en produkt behöver dem.
En produkt för exempelvis föreningsadministration ska inte behöva installera Dispatch för att få användarkonton.

Domäner delar stabila ID:n och små läskontrakt. Undvik ett enda stort person- eller uppdragsobjekt
med löner, sjukintyg, betalningar, GPS-positioner och kalenderuppgifter i samma projektion.

## Illustrativ moduldefinition

```ts
type ModuleManifest = {
  id: string;                    // exempel: "equipment"
  version: string;               // modulens kod-/kontraktsversion
  requires: { id: string; range: string }[];
  permissions: string[];
  entitlement: string;           // bolagets rätt att använda modulen
  navigation: NavEntry[];        // plats, etikett, ikon och behörighetskrav
  routes: UiRoute[];
  api: ApiRegistration[];        // även serverkrav; inte bara menyfilter
  migrations: Migration[];
  jobs: JobDefinition[];
};
```

Registreringen ska validera unika modul-ID:n, routes och behörigheter samt kompatibla beroenden.
Versionsnumret i manifestet ersätter inte databasens migrationsversion eller händelsernas schemaversion.
Aktiverade moduler och betalplan är bolagsdata; användarens behörigheter är ett separat lager.

**Tillåtet interaktivt anrop = aktiv bolagssession + aktiverad modul + behörighet + tillåtet objekt/plats.**
Servern kontrollerar hela kedjan för API, filer och exporter. Bakgrundsjobb
använder en avgränsad maskinidentitet och aktuell jobb-/modulpolicy. Webhooks
autentiseras enligt leverantörskontraktet och binds till en betrodd anslutning;
de kräver ingen inloggad webbläsare. Avstämning av tidigare operationer kan
behöva fortsätta under en moduls kontrollerade avveckling.
En dold flik eller lazy-loaded React-komponent är ingen säkerhetsgräns.
Behörighet vid ”jobba som” ska följa kärnans uttryckliga policy för verklig och effektiv användare.

I nuläget finns ingen generell manifest-/entitlementmotor i ScrapPilot.
Kontorets meny är en deklarerad array med rättigheter i [OfficeApp.tsx](../../src/office/OfficeApp.tsx).
Den är en bra startpunkt för registrering, men bevisar inte att moduler kan installeras separat.

## Aktivering, avstängning och kompatibilitet

Använd en liten uttrycklig livscykel: `disabled → provisioning → active → quiescing → disabled`.
Spara även ett tydligt felläge när provisioning eller migration inte kan slutföras.

- Aktivering kontrollerar beroenden, migrerar data och registrerar jobb innan modulen blir tillgänglig.
- `quiescing` stoppar nya affärskommandon och nya jobb; pågående jobb hanteras med lease och definierat avslut.
- Betalningar eller externa anrop med okänt resultat måste fortsatt kunna stämmas av; avstängning får inte gömma dem.
- Avstängning bevarar data och audit. Läsning/export kan tillåtas enligt en särskild, dokumenterad policy.
- Avinstallation och radering är egna åtgärder med retentionregler; de får inte ske som bieffekt av en dold meny.
- En modul med aktiva beroenden får inte stängas av utan kontrollerad avveckling av dessa beroenden.
- Återaktivering använder bevarad data och kontrollerar migrations-/kontraktskompatibilitet före start.

Varken en gammal webbläsarflik eller ett schemalagt jobb får kringgå ett nytt avstängningsbeslut.
Kontrollera aktuellt tenant-/modultillstånd på servern när åtgärden utförs.

## Modulkarta från dagens kod

| Modul | Finns i ScrapPilot | Krävs för portabel modul |
| --- | --- | --- |
| Personregister/HR | Person, anställning, lönedata, schema, frånvaro, kompetenser, kontokoppling. | Flytta identitetsberoendet från prisdomänen till kärnan; kapsla Dispatch-kopplingar. |
| Tid/stämpel | Start/rast/stopp, manuella poster, uppdragstid, timkrav, korrigering och spärrar. | Smala portar för person, arbetsschema och valfritt uppdrag. |
| Sjukfrånvaro | Perioder, friskanmälan, planerad återgång, intygsmetadata och sjuklöneunderlag. | Separat privat HR-domän och utbytbara avtals-/landspolicyer. |
| Tidattest | Månadsgranskning, inlämning, attest/återöppning, källstämplar och CSV. | Tydliga kontrakt mot tid, frånvaro och låsta perioder. |
| Dispatch | Dag-/veckoplanering, resurser, preliminära bokningar, karta och konflikter. | Separera kalender-UI, bokningsmotor och återvinningsadapter. |
| Fordon/maskiner | Service, fel, kontroller, driftspärr, journal, export och bilagor. | Flytta kanoniskt fordonsregister ur transportdomänen utan att byta ID:n. |
| Utrustning | Inventarier, utlämning/återlämning, service och personhistorik. | Liten person-/platsport i stället för beroende på hela HR. |
| Telematik | Testbil, virtuell puck, mottagarpilot, normalisering och enhetskopplingar. | Verifiera fysisk hårdvara; produktionslagring och drift för faktisk volym. |
| Mejl | Microsoft 365, flera inkorgar, tilldelad åtkomst och kundmatchning. | Provideradapter och valfri CRM-matchning. Google är inte därmed implementerat. |
| AI-support/röst | Godkänd wiki, röstprofil, transkript, kvoter och providerbyte. | Generisk grund utan JEROC-specifik kunskap; fortsatt snäv kontext. |

### HR, tid, sjukfrånvaro och närvaro

[personnel.mjs](../../server/personnel.mjs) innehåller verkliga kopplingar till `state.pricing.users`,
`createPricingStore`, transportbemanning, logistik, Fleet och tid. En generell HR-modul ska inte kräva artiklar/priser.
En person får finnas utan inloggning; ett användarkonto och en anställning är olika objekt.

[employee-time.mjs](../../server/employee-time.mjs) har separata projektioner, klockkommandon och tidsregler.
Arbetsordertiden kopplas idag till transport-/logistiklivscykeln i
[mobile-employee-api.mjs](../../server/mobile-employee-api.mjs) och [personnel.mjs](../../server/personnel.mjs).
Behåll stämpeltid och uppdragstid som olika underlag med uttrycklig beräkning, så att de inte dubbelräknas.

[employee-sickness.mjs](../../server/employee-sickness.mjs) äger privata sjukärenden och beräkningsunderlag.
Den vanliga frånvaron får schemaläggningsfakta; intyg, löneprofil och känslig uppföljning ska stanna i HR-domänen.
Sjuklön/karens är regelstyrt underlag och gör inte modulen till ett komplett löne- eller generellt HR-system.

[employee-time-review.mjs](../../server/employee-time-review.mjs) låser godkända perioder och kontrollerar källstämplar.
Den mekaniken måste bevaras när källorna flyttas bakom portar.
[employee-presence.mjs](../../server/employee-presence.mjs) beräknar närvaro/tillgänglighet från klocka, rast,
schema, frånvaro och uppdrag. Exponera en smal läsmodell till Dispatch; lagra inte en fristående `available=true` som blir gammal.

Det stora [EmployeeProvider.tsx](../../src/employee/EmployeeProvider.tsx) binder idag ihop flera mobilflöden.
En återanvändbar mobilgrund bör registrera modulernas vyer/åtgärder och nödvändiga kompletteringskrav.
Varje spärr ska ange vad som saknas och vilka åtgärder som fortfarande är tillåtna, exempelvis friskanmälan eller hjälp.

### Kalender och Dispatch

[TransportCalendar.tsx](../../src/office/transport/TransportCalendar.tsx) ritar dag/vecka och lämnar bokningsförslag.
Den är typad mot `TransportOrder`, förare och fordon och använder transportens status-/etikettregler.
[TransportWorkspace.tsx](../../src/office/transport/TransportWorkspace.tsx) lägger till karta, kunder,
kärl-/materialfilter, personalens tillgänglighet och dokument. Detta är produktkod, inte en färdig generell kalender.

Extrahera ett UI-kontrakt för resurser, tidsintervall, bokningar, varningar och `onPropose`.
Låt en separat bokningsmotor kontrollera överlappning, resursstatus, plats, kompetens och revision på servern.
Produktadaptern översätter ScrapPilots transportorder till detta kontrakt och tillbaka.
Andra produkter kan då planera tekniker, rum eller maskiner utan begrepp som skrot, kärl eller chaufför.

### Fordon, utrustning och telematik

Det gemensamma fordonsregistret ligger idag i `state.transport.vehicles`, se
[personnel-vehicles.mjs](../../server/personnel-vehicles.mjs) och [fleet.mjs](../../server/fleet.mjs).
`state.fleet` äger kompletterande profiler, service, journal och relaterad historik.
Flytta ägarskapet till en valfri fordons-/tillgångsmodul; bevara ID:n och historiska bokningsreferenser.
Skapa inte ett andra register som långsiktigt måste synkroniseras med transportregistret.

[equipment.mjs](../../server/equipment.mjs) är en lämplig första extrahering: små kommandon och tydlig utlämningshistorik.
Personens utrustningsvy kan läggas till i HR utan att HR får skriva direkt i utrustningens data.

[fleet-telematics.mjs](../../server/fleet-telematics.mjs) hanterar tilldelning, koppling, flytt och historiska bindningar.
Bolagets fordonsregister är den betrodda källan; ett paket från en puck får inte välja tenant eller person.
[telematics/receiver.mjs](../../server/telematics/receiver.mjs) och [telematics/storage.mjs](../../server/telematics/storage.mjs)
är en separat mottagarpilot med egna skydd. Fysisk interoperabilitet och storskalig drift är inte verifierade av testbilen.
Pilotens databasadapter ska inte beskrivas som redan dimensionerad för tusentals verkliga fordon.

### Mejl, AI och integrationsadaptrar

[mail-service.mjs](../../server/mail-service.mjs) och [mail-api.mjs](../../server/mail-api.mjs) har tydliga service-/API-gränser.
Kundmatchning kan bli en valfri CRM-port. Inkorgarnas åtkomst är en egen kontroll utöver bolagstillhörighet.
Använd separata provideradaptrar för Microsoft och en eventuell framtida Google-koppling.

[ai-support.mjs](../../server/ai-support.mjs) bygger kundkontext av uttryckligen godkänd offentlig kunskap.
[voice-test-provider.mjs](../../server/voice-test-provider.mjs) är en användbar adaptergräns för röstmotorer.
Behåll HR, bankuppgifter, internpris och generell databasåtkomst utanför kundagentens kontext.
JEROC:s startpaket är en separat kundmall, inte standardkunskap för andra bolag.

[tenant-services.mjs](../../server/tenant-services.mjs) visar hur integrationer får servervald tenant och repository.
Återanvänd gemensam OAuth-/credentialinfrastruktur, men låt betalningar, bokföring och miljörapportering behålla sina domänregler.
En generisk integrationsmodul ska inte automatiskt ge alla produkter bank- eller myndighetsfunktioner.

## Portar mellan moduler

| Konsument | Smal port | Vad som inte följer med |
| --- | --- | --- |
| Tid, utrustning, Fleet | Aktiv person, namn, tillåtna platser, stabilt person-ID. | Lön, intyg, full HR-historik. |
| Dispatch | Tillgängliga intervall, kompetensstatus, resursens driftstatus. | Diagnos, sjuklöneprofil eller behörighet att ändra HR. |
| Tid | Valfritt uppdrags-ID, ägare/tilldelning och start/stopp-kontrakt. | Hela transport-/kund-/prismodellen. |
| Mejl | Exakt matchning till tillåtna kundsammanfattningar. | Hela kundregistret eller betalningsuppgifter. |
| AI-support | Versionerad, godkänd offentlig kunskap för bolag och plats. | Godtycklig sökning i ERP-databasen. |

Portarnas indata valideras och serverkontexten väljer tenant. Objekt-ID:n är referenser, inte åtkomstbevis.
En modul får läsa genom publicerat kontrakt; den får inte själv skriva i en annan moduls tabeller eller state.
Behov av synkron, atomisk ändring mellan moduler hanteras av en applikationstjänst i samma transaktion.
Ett efterföljande integrationsmeddelande ersätter inte atomisk kontroll när exempelvis en dubbelbokning måste stoppas.

## Dataägande, händelser och konsistens

Varje domän äger sina data, migreringar och invariants. Kärnan tillhandahåller transaktionen och tenantgränsen.
I dagens [application.mjs](../../server/application.mjs) sammansätts flera domäner i samma repository-operation;
det är ett användbart nuläge att kapsla, inte skäl att införa nätverksanrop mellan alla funktioner.

```ts
type DomainEvent = {
  eventId: string;
  tenantId: string;             // sätts av servern
  type: string;                 // exempel: "work_item.started"
  schemaVersion: number;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  actorId: string;
  effectiveUserId: string;
  correlationId: string;
  payload: unknown;             // validerat schema per händelsetyp
};
```

Affärsändring, audit och outboxpost skrivs i **samma transaktion**. Leverans sker efter commit.
Konsumenten deduplicerar på tenant, konsument och event-ID och sparar kvittensen atomiskt med sin egen ändring.
Utgå från leverans minst en gång: använd versioner, säkra retries, backoff och synligt felläge för slutligt misslyckade jobb.
Skicka inte känsliga HR-/bankdetaljer i generiska händelser. Använd minsta nödvändiga innehåll och skyddade läskontrakt.

[transport-integrations.mjs](../../server/transport-integrations.mjs) och
[transport/types.ts](../../src/office/transport/types.ts) innehåller en befintlig transportutkorg och händelsetyper.
De är förebilder, inte en redan färdig generell meddelandebuss med alla produktionsgarantier.
Versionera kontrakten och migrera konsumenter; anta inte global ordning mellan olika objekt.

## Tre möjliga produktpaket

| Produkt | Obligatoriskt | Valfria tillägg |
| --- | --- | --- |
| Enkel personalportal | Kärna, personregister, tid/stämpel. | Sjukfrånvaro, tidattest, utrustning. |
| Fältservice | Kärna, kundmodul, uppdrag, bokningsmotor/kalender, person-/resursregister. | Tid, Fleet, mejl, AI-support. |
| ScrapPilot | Kärna och återvinningens artiklar, viktkort och avräkningsflöde. | HR/tid, Dispatch, Fleet/telematik, utrustning, mejl, AI och ekonomiadaptrar. |

Paketen visar återanvändning; de betyder inte att allt ovan redan kan aktiveras per bolag i befintlig kod.
Beroenden ska uttryckas i manifestet. Valfria samarbeten använder portar och fungerar även när motparten saknas.

## Extrahera i denna ordning

1. Kapsla identitet, platsåtkomst, policy, audit och repository i kärnan; behåll befintliga tenantgränser.
2. Inför modulregister med serverkontrollerade beroenden, meny/API och livscykel utan att ändra produktens beteende.
3. Använd utrustning som första liten modul; följ med mejl och AI-support där serviceadaptrar redan finns.
4. Bryt loss personregister, därefter tid/stämpel, sjukfrånvaro och tidattest med skyddade kontrakt.
5. Separera kalender-UI och bokningsmotor och lägg dagens Dispatch ovanpå som produktadapter.
6. Flytta kanoniskt fordonsregister med bevarade ID:n; låt Fleet och Dispatch dela denna referens.
7. Skala ut telematik eller andra tjänster först efter mätbart behov och verifierade drift-/leveranskontrakt.

En extrahering är klar först när dess viktiga flöden fungerar både med och utan valfria moduler,
bolags-/platsisoleringen består och uppgradering, avstängning samt återaktivering har verifierats.
