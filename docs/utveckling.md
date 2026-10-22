# Utveckla ScrapPlanner

Granskad 20 oktober 2026 mot projektets kommandon och kataloger.
[Dokumentationsöversikt](README.md) · [Användarmanual](manual/README.md) · [Drift](drift/README.md).

## Starta lokalt

Använd **Node.js 24 LTS, minst 24.19.0 och lägre än 25**, för rootprojektet,
Expo och hemsidan. `.nvmrc`, CI och Render anger 24.19.0. Äldre uppgifter om
Node 22 gäller inte detta verifierade runtimekontrakt.
Använd projektets låsfiler och en lokal testmiljö. Kör följande i repots rot:

```sh
npm ci
npm run build
npm run dev
```

Första bygget genererar även `dist-server/domain-models.mjs`. Utvecklingskommandot
startar Vite på port **5173** och API-servern på port **3000**; Vite skickar
`/api` till servern. Öppna `/kontor/` eller `/mobil/` på Vites adress.
Stoppa med Ctrl+C. Om portar redan används, avsluta den tidigare körningen först.

Utan `DATABASE_URL` använder den lokala demoprofilen beständig SQLite i `.data/`.
Demo och pilot har olika startprofiler. Använd lokal testdata och kontrollera
processens konfiguration innan du startar: peka inte en utvecklingsserver mot
pilotens databas eller leverantörsanslutningar. Pilotprofilen kräver en egen
PostgreSQL-databas och privat bootstrap; se driftguiden.

Servern läser sin konfiguration från processens miljö. Anta inte att en skapad
`.env`-fil automatiskt läses av alla startkommandon. Hemligheter och databasfiler
ska ligga utanför Git. Använd fiktiva identiteter och leverantörssvar i prov.

För ett lokalt produktionsbygge:

```sh
npm run build
npm start
```

Node serverar då webbbygget och API:t på port 3000, om `PORT` inte anger annat.
`npm run preview` visar bara statiska filer och ersätter inte backend.

Windows- och Mac-startfilerna i repots rot är genvägar för lokal demonstration.
De installerar beroenden, bygger och startar på port 4173. De är inte ett sätt
att ansluta till den befintliga pilotinstallationen; äldre utskrifter i dessa
skript beskriver demoprojektet. Vanliga användare öppnar pilotens webb-/mobiladress.

## Hitta i koden

| Plats | Innehåll |
| --- | --- |
| `src/office/` | Kontor, viktkort, attest, kunder, personal och inställningar |
| `src/pages/` | Mobilwebbens sidor och vägningsflöde |
| `src/platform/` | Plattformskonto, bolagsval och systemadministration |
| `src/customer-intake/` | Kundens självservice via SMS och terminal |
| `src/customer-identity/`, `src/person-register/` | Nummerfält, personuppslag och granskning av förslag |
| `src/address-assistance/` | Gemensam adresshjälp |
| `server/` | API, sessioner, bolagsisolering, lagring, dokument och leverantörsadaptrar |
| `tests/` | Playwright-prov och isolerade API-fixturer |
| `expo/` | Expo-skal som öppnar mobilwebben i WebView |
| `website/` | Fristående publik webbplats med egen låsfil och egna prov |
| `public/bokforing/` | Publik bokföringsdemo med separat lokal demodata; inget produktions-API |
| `scripts/` | Bygge, start, kontroller och uttryckliga import-/exportverktyg |
| `docs/` | Manual, drift, ämnesguider, ÄL och designunderlag |

Versionsetiketter finns i `src/model.ts` och `src/office/model.ts`. Ett
versionsnummer är inte bevis på vilken commit som körs i Render. Genererade
`dist/`, `dist-server/`, lokala databaser och provresultat ska inte checkas in.

## Kontroller

| Kommando | Kontrollerar |
| --- | --- |
| `npm run build` | Domänmodeller, TypeScript och webbbygge |
| `npm run test:server` | Bygger domänmodeller och kör serverns testsamling |
| `npm test` | Playwrights testsamling; startar en egen server med disponibla testdatabaser |
| `npm run test:ui` | Playwrights interaktiva provvy |
| `npm run build:render` | Webbbygge, Expo-beroenden, Expo-typkontroll och villkorligt Expo-förbygge |

Kör riktade prov för det ändrade beteendet. Kommandon i ämnesguiderna visar
vilka server- och browserfall som hör till funktionen. Bygg domänmodellerna
med `node scripts/build-domain-models.mjs` före fristående `node --test` när de
berör modeller som kompileras från TypeScript.

Om Chromium saknas:

```sh
npx playwright install chromium
```

Playwright använder `/usr/bin/chromium` om den finns. Annars används dess
installerade Chromium; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` kan ange en annan.
Konfigurationen finns i `playwright.config.ts`. Testerna återanvänder inte en
utvecklingsserver: portarna 5173 och 3000 måste vara lediga. Startaren använder
en tillfällig katalog för SQLite, filtrerar bort databas-/leverantörshemligheter
och verifierar en unik markör innan teststegen får börja. `.env` läses inte av
denna testserver. Kör en browserkörning i taget mot dessa portar.

CI kör hela serverurvalet mot en egen PostgreSQL 17-tjänst. För motsvarande
lokala prov, använd en separat disponibel databas och ange den i både
`JEROC_TEST_DATABASE_URL` och `JEROC_TEST_POSTGRES_URL` innan `npm run test:server`.
Ange aldrig verksamhetens `DATABASE_URL` som testanslutning. Utan dessa
testvariabler kan PostgreSQL-specifika prov hoppas över; redovisa det i resultatet.

För Expo-typkontrollen separat:

```sh
npm --prefix expo ci
npm run expo:check
```

För den publika webbplatsen, följ [website/README.md](../website/README.md).
Dess bygge och tester körs i `website/`, separat från applikationens kommandon.

## Från ändring till leverans

1. Läs relevant ÄL-post, ämnesguide och godkända mockuper. Återanvänd befintligt UI.
2. Gör ändringen med samma serverkontroller för konto, bolag och anläggning som
   övriga flödet. Klientens val eller headers ersätter inte serverns behörighet.
3. Verifiera berörda flöden med isolerade data. Rapportera vilka kontroller som
   körts och eventuella kvarstående fel; gamla provantal gäller sina leveranser.
4. Uppdatera befintliga guider och ÄL i samma commit. Följ
   [dokumentationsreglerna](README.md#så-underhåller-vi-dokumentationen).
5. Pusha granskad kod. Appen uppdateras genom en separat Render-deploy;
   se [driftguiden](drift/README.md). Skilj GitHub-version, lyckat bygge och
   verifierad drift åt. Dokumentändringar kräver ingen omstart av appen.

Återanvändning i ett annat produktprojekt beskrivs i
[SaaS-blueprinten](saas-blueprint/README.md); den är inte startinstruktionen
för att ändra den här befintliga installationen.
