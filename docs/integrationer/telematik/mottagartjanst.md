# Separat mottagartjänst för testpucken

ÄL 129, 2026-10-16. Detta är en fungerande syntetisk tjänst för `/testbil1`.
Den verkliga FTC134-piloten och CRM:s bolags-/fordonsregister ändras inte.

## Så fungerar det nu

```text
Webbläsare → testbil/virtuell FMC003 i webbservern
                       ↓ Codec 8E-bytes via HTTP
              separat Node-mottagare
                       ↓ avkodning, CRC, whitelist
              separat SQLite-databas
                       ↓ commit
              fyrabyteskvittens → puckens kö töms
```

`npm start` och `npm run dev` startar mottagarprocessen automatiskt vid första
testsessionen. Den lyssnar enbart på loopback och en slumpad ledig port. Webbservern
skapar ett internt slumpat tjänstelösenord. Det skickas inte till webbläsaren,
skrivs inte i loggar och behöver inte läggas i Render för standardläget.
Barnprocessen får inga CRM-anslutningssträngar eller integrationshemligheter.

Mätningarna går genom riktig HTTP och en databastransaktion, inte en intern
reservsimulering. Liveinstrumenten fortsätter vid avbrott. Pucken skickar ett
paket åt gången, behåller exakt samma bytes vid okänt resultat och väntar
1–30 verkliga sekunder mellan misslyckade transportförsök. Strömbunden unik
recordhash hindrar dubbla rader efter återförsök och mottagaromstart.

En misslyckad läsning av mottagarstatistik återkallar inte en redan giltig ACK.
Tidigare statistik visas tills en ny summary kan bekräftas. Fel/okänd status
markeras i mottagarkortet, separat från simulerad biltäckning.

## Lagring och gränser

Standardfil: `.data/telematics-demo/receiver.sqlite`, separat från CRM:s data.
SQLite använder WAL och full synkronisering. Endast godkända syntetiska
positions-/sensorvärden sparas; råpaket, hemligheter och okända I/O-fält sparas inte.

- Högst 128 syntetiska strömmar, 20 000 poster per ström och 200 000 totalt.
- Efter 24 timmar utan lyckad mottagning gallras hela strömmen. Det bevarar
  dubblettskyddet för aktiva strömmar. Underhåll körs varje minut och vid lageranrop.
- Full lagring avvisar paketet utan ACK. Puckens kö är fortfarande begränsad
  till 1 000 mätpunkter; ev. bortfall markeras i enhetens diagnostik.
- En nollställning får en ny ström och blandar inte gammal statistik med ny körning.
- Mottagarens summary returnerar högst tio poster. Webbläsaren kan inte välja
  ström, databas, serveradress, bolag eller verkligt fordon.

Databasfilen överlever mottagarens processomstart om filsystemet består.
**Render Free garanterar inte filen mellan deployer/instansbyten.** För sådan
beständighet behövs beständig disk eller egen PostgreSQL. Bilens aktuella läge
och ännu oskickade kö ligger fortfarande i webbprocessens minne och återställs
vid omstart. Backup/återställning för riktig fordonsdata ingår inte i denna demo.

## Senare: egen tjänst och databas

Koden stödjer följande valfria servervariabler. Inget av detta behövs för att
prova standardläget i befintlig installation.

| Variabel | Funktion |
| --- | --- |
| `TELEMATICS_SQLITE_PATH` | Egen fil på beständig disk, om SQLite används. |
| `TELEMATICS_DATABASE_URL` | Egen PostgreSQL för enbart syntetisk telemetri; ersätter SQLite. Återanvänd inte CRM:s `DATABASE_URL`. |
| `TELEMATICS_SERVICE_URL` | HTTPS-adressen till en separat mottagartjänst. HTTP tillåts endast på loopback vid lokala prov. Ingen path, query eller inbäddad hemlighet. |
| `TELEMATICS_SERVICE_TOKEN` | Samma privata tjänstetoken i webbapp och separat tjänst, 32–512 synliga ASCII-tecken. Behövs vid fristående drift. |
| `TELEMATICS_HOST` | På mottagartjänsten: `127.0.0.1` lokalt eller `0.0.0.0` bakom en betrodd HTTPS-ingång. |
| `PORT` | Mottagartjänstens HTTP-port, vanligtvis satt av värdplattformen. |

Fristående tjänst använder samma repo och Node-version:

```sh
npm ci --include=dev --no-audit --no-fund
npm run telematics:receiver
```

Sätt först dess egna variabler via tjänsteplattformen. Starten avvisas utan giltig
token. Hälsokontroll är `GET /healthz` utan behörighet, med enbart `{status:"ok"}`.
`GET /readyz` kontrollerar databasen och kräver tjänstetoken. Alla datarutter
kräver Bearer-token, har body-/anslutnings-/trafikgränser och okachade svar.
De är servergränssnitt, inga nya publika webbläsar-API:er.

PostgreSQL-adaptern är förberedd med en liten pool, transaktioner, index,
unikvillkor och lås runt samtidiga kvotkontroller. En separat databas behövs;
adaptern har ännu inte verifierats mot en verklig PostgreSQL-instans här.
SQLite är den verifierade demovägen. Detta är inte en verifiering av kapacitet
för tusentals fordon; den nuvarande kvotlåsta lagringen är avsiktligt begränsad.

Inget nytt Render-projekt, ingen betald tjänst och ingen databas har skapats av
denna kodändring. En senare publik TCP/TLS-ingång för fysisk FMC003 behöver
en separat transportadapter och verifierad enhetsprovisionering. Den syntetiska
HTTP-kanalen ska inte öppnas som godtycklig mottagare för verkliga personpositioner.

## Verifiering

```sh
node --test server/telematics-*.test.mjs
npm run build
npx playwright test tests/testcar.spec.ts --workers=1
```

Riktade tester provar riktig processgräns, HTTP, databasskrivning, omstart och
deduplicering, mottagaravbrott/backoff, avstängd motors sista paket, felaktiga
ACK/CRC, sessioner, gallring och kvoter. Browserproven skiljer livevärden från
lagrade värden, kontrollerar fördröjd ACK och mobilvyn. Fysisk tracker, publik
TCP, PostgreSQL och Render-deploy ingår inte i den lokala verifieringen.

Verifierat 2026-10-16: **100/100 telematiktester**, **7/7 browserfall** och
`npm run build` passerade. Ett extra browserprov mot den byggda webbservern
och dess riktiga separata mottagarprocess bekräftade cookie/CSRF, körning,
lagrade SQLite-poster, kvittenser och tabellen med mottagna värden.
