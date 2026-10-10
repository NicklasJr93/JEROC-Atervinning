# Dynamisk NVV-diagnostik i TEST

Diagnostiken jämför anslutningsprofiler utan att byta Render-inställningar eller
ändra den ordinarie rapportörens uppgifter. Den får endast köras av en inloggad
systemadmin som arbetar som systemadmin och har åtkomst till alla anläggningar.

## Kontroller och avgränsning

- Tre på förhand granskade, giltiga generella testcertifikat: Testbolag 1,
  det äldre Bolag A och Testbolag 2. Deras offentliga SHA-256-fingeravtryck
  är uttryckligen tillåtna i klienten; andra uppladdade certifikat avvisas.
- Standard-TLS och uttrycklig TLS 1.2. Varje diagnostikoperation får en isolerad
  klient, ny OAuth-token och nya TLS-handshakes med verifierad server.
- Anslutningskontroll läser `/avfallstyper` och `/transportsatt`.
- Avgränsad läsning av `/anteckningar` använder ett kort tidsintervall och
  en post per sida. Endast antal och organisationsnummer sammanfattas;
  uppgiftslämnare, kontaktuppgifter och råa kundposter arkiveras inte.
- Provrapportering använder endast `POST /insamlingar` i NVV:s fasta testmiljö,
  med syntetiska mottagningsuppgifter och en unik referens per försök.
  Inga viktkort, mottagningar, lager, utbetalningar eller ordinarie rapporter ändras.

Först kontrolleras anslutningen. Vid lyckad kontroll provas certifikatets
tiosiffriga organisationsnummer som verksamhetsutövare utan ombud. Vid fel
1023 provas den dokumenterade alternativa rollen: JEROC som verksamhetsutövare
och certifikatorganisationen som ombud med samtliga ombudskontakter. Fel på
anslutning eller autentisering avbryter den profilen. Ingen obegränsad sökning
efter organisationsnummer görs.

Vid accepterat avfalls-id stoppas ytterligare provutskick och den exakta
anteckningen läses tillbaka. Vid timeout, avbrott eller oklart svar stoppas
ytterligare utskick tills försöket kontrollerats; samma reservation skickas
inte på nytt. Ett lyckat kodlisteanrop eller tomt lässvar räknas inte som
godkänd rapportering eller som bevis för NVV:s tolkade rapportörsidentitet.

## Server-API

`GET /api/environment/nvv/diagnostics` visar konfigurationens TEST-status och
senaste 50 diagnostikförsöken, utan externa anrop. Det ordinarie testformulärets
historik hålls separat.

`POST /api/environment/nvv/diagnostics` tar följande struktur, högst 32 KiB:

```json
{
  "requestId": "ett-nytt-uuid",
  "idempotencyKey": "unik-nyckel",
  "operation": "check",
  "profile": { "tls": "tls12" }
}
```

`operation` är `check`, `read` eller `submit`. `submit` tar ett `payload` med
endast dokumenterade insamlingsfält. `read` får ange `sourceRunId` för en
tidigare accepterad diagnostikrapport med samma certifikat. Utan detta läses
endast det korta tidsintervallet. URL, headers, token och godtyckliga transport-
eller certifikatalternativ kan inte anges.

En förhandsgodkänd certifikatprofil kan skickas tillfälligt i HTTPS-bodyn som
`profile.certificate` med `p12Base64` och `password`. Dessa används endast i
serverminnet för operationen och ingår aldrig i databas, historik, audit eller
svars-DTO. De ska inte läggas i Git, loggar eller skärmbilder. Idempotensen binds
till offentligt fingeravtryck, TLS-val, operation och payload – inte till
privata certifikatbytes eller lösenord.

`GET /api/environment/nvv/diagnostics/runs/:id` visar en befintlig reservation
eller ett avslutat försök och gör inget nytt NVV-anrop. Svaren visar verklig
HTTP-status, TLS-protokoll/chiffer, offentlig certifikatmetadata och säkert
NVV-svar. Databasreservationen skapas före nätverksanropet; inget nätverksanrop
håller ett databaslås.

## Återställning och regression

Diagnostikförsöken ingår i den redan beständiga entiteten `nvvSandboxRuns` med
markören `diagnosticOperation`. Ingen särskild tabell eller migration krävs.
Återställning eller GET återspelar aldrig ett utskick. En oavslutad reservation
visas som okänd efter 120 sekunder.

Riktade kontroller:

```sh
node --test server/nvv-client.test.mjs server/nvv-client-cache.test.mjs server/nvv-sandbox.test.mjs server/nvv-diagnostics.test.mjs
npm run build
```
