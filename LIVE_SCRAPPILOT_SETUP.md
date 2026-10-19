# Live ScrapPilot – setup och överlämning till nytt Codex-projekt

Datum: 2026-10-19. Granskad källversion: `692e956` i
[NicklasJr93/JEROC-Atervinning](https://github.com/NicklasJr93/JEROC-Atervinning).
Kontrollera även senare ändringar innan implementation.

## Uppdraget från ägaren

Förbered en första riktig ScrapPilot-installation för JEROC i ett nytt
Codex-projekt med namnet **Live ScrapPilot**. Sätt upp **ny server, ny databas
och separat konfiguration**. Återanvänd den fungerande produkten och
artikelregistret; starta verksamhetshistoriken tom.

**Godkänd första pilot:** riktig kundregistrering → invägning →
kundgodkännande → attest → arkiverad PDF och fakturautkast i det riktiga
Spiris-företaget. Ekonomi granskar och bokför i Spiris; ScrapPilot läser tillbaka
bokföringsstatus och verifikationsnummer. `Attest + bokför` aktiveras först efter
verifierat skarpt flöde. Utbetalningar sköts enligt JEROC:s nuvarande arbetssätt.
Automatisk bank-/Swish-utbetalning ingår i en senare separat aktivering.

Den nuvarande installationen på `jeroc-atervinning.onrender.com` fortsätter
vara demo. Dess databas, konton, integrationer och data lämnas orörda.
Den här filen överlämnar arbetet; ingen ny server eller databas har skapats
genom att filen publicerades.

Arbeta vidare tills en konkret pilot kan granskas och provas. Börja med
kod och säker bootstrap lokalt, sedan isolerad infrastruktur och verifiering.
Skilj alltid mellan byggt, lokalt testat, driftsatt och verifierat i drift.

## Vad ägaren behöver ordna

1. **Domän och DNS-åtkomst.** Om `scrappilot.com` ägs eller går att köpa är
   `app.scrappilot.com` ett lämpligt appnamn; huvuddomänen kan användas för
   hemsidan senare. Domänens tillgänglighet har inte kontrollerats här.
   Render visar vilken DNS-post som ska sättas när den nya tjänsten och
   dess Custom Domain skapats. Vänta med DNS-ändring tills rätt mål är känt.
2. **Codex-projektet Live ScrapPilot.** Koppla det till samma GitHub-repo
   och bifoga denna fil. Arbeta med en separat arbetsgren och granskade
   ändringar; den befintliga demodeployen ska bevaras.
3. **Render-åtkomst och val av driftplan.** Återanvänd kontot men skapa
   nya tjänst-/databasresurser efter att live-starten är förberedd i koden.
   Lägg nya hemligheter i Render. Kostnader och faktiska backupfunktioner
   behöver kontrolleras mot vald aktuell plan.
4. **Skarp Spiris-åtkomst.** Kontrollera med Spiris att klienten får användas
   mot produktion och registrera liveadressens callback, exempelvis
   `https://app.scrappilot.com/api/integrations/visma/oauth/callback`.
   Adressen är ett förslag tills domänen är bestämd. En behörig användare
   ansluter det verkliga JEROC-företaget genom OAuth.
5. **Verkliga grunduppgifter och pilotpersoner.** Utse VD/admin, ekonomi
   och de första kontors-/gårdsanvändarna; bekräfta anläggning, bolagsuppgifter,
   aktuella priser och redovisningsinställningar. Börja med en anläggning.
6. **Åtkomst till artikelkatalogens läsande export.** Ordna en säker
   exportväg från den nuvarande miljön när importverktyget är granskat.
   Egna bilder och ändrade artiklar finns i databasen; GitHub räcker inte
   som fullständig källa. Lämna källdatabasen oförändrad.

Codex förbereder kod, bootstrap, katalogverktyg, tester, deployinställningar
och verifieringsprotokoll. Kontoägaren hanterar köp, erforderlig resursåtkomst,
privata värden och leverantörernas företagsgodkännanden. Börja med domänval och
Codex-projekt; första live-deployen följer efter kodens start- och säkerhetsarbete.

## Miljön vi ska skapa

- **Gemensam kodbas i det befintliga GitHub-repot**, separat deploykoppling
  för live. Ett nytt Codex-projekt innebär inte ett nytt produktrepo.
  Live deployas från en godkänd release/commit med automatisk utrullning av
  varje utvecklingsändring avstängd. Gör ändringar bakåtkompatibla med demon
  och skilj miljöernas startprofiler och konfiguration åt.
  Scanna filer innan publicering; kopiera inga `.env`, lokala databaser,
  exporter med persondata, certifikat eller tidigare hemligheter.
- Ny Render Web Service, exempelvis `scrappilot-live`, i EU-region. Välj en
  plan som håller tjänsten igång när köer och schemalagda jobb ska fungera.
- Ny PostgreSQL-databas med egen åtkomst och verifierad backup/restore.
  Välj region och plan efter faktiska krav och aktuell Render-prissättning.
- Egen HTTPS-adress. Använd den nya Render-adressen först; egen domän kan
  kopplas senare. Registrera nya callback-adresser hos berörda leverantörer.
- Nytt plattformsregister, privat systemadmin och JEROC som första riktiga
  bolag med VD-konto och verkliga anläggningar. Användare får egna konton.
- Behåll den serverstyrda bolagsisoleringen även när första piloten har
  ett bolag. Ett bolag ska aldrig väljas eller få rättigheter genom enbart
  klientens headers, bolags-ID eller menyval.

Skapa inte ett till JEROC med samma orgnr i den gamla miljön: befintlig
plattform har avsiktligt dubblettskydd. En ny databas har eget plattformsregister.
Återanvänd ingen gammal databaskoppling som reserv om den nya lagringen fallerar.

## Viktigt innan första start mot den nya databasen

**En tom databas ger i dag demodata igen. Det behöver ändras först.**
Standardstarten skapar JEROC-exempeldata och kompletterar sedan personal,
konton, fordon med mera. Den befintliga systemadmin-bootstrapen utgår dessutom
från en äldre JEROC-identitet. `JEROC_DEMO_AUTO_SESSION=false` är därför inte
en komplett produktionsinställning eller en rensningsfunktion.

Implementera en explicit live-startprofil med följande beteende:

1. Skapa ett första privat systemadminkonto utan att först skapa demopersonal.
   Hasha lösenord säkert; det får bara hämtas ur säker serverkonfiguration.
2. Provisionera bolaget med verkligt VD-konto, byte av tillfälligt lösenord
   vid första inloggning och endast nödvändiga grundinställningar.
3. Alla verksamhetsdomäner ska vara giltiga men tomma. Saknad domän får inte
   utlösa seedning av exempelpersoner, löner, kunder, viktkort eller order.
4. Bevara nödvändiga versions-, migrations- och seedmarkörer. Verifiera att
   tre omstarter samt uppgradering/migrering lämnar registren tomma.
5. Stäng alla demosnabbval och kända demoidentiteter på servern. Dolda knappar
   räcker inte. Försök med gamla demolösenord ska nekas i samtliga klienter.
6. Stäng gamla klienters automatiska import av lokala demoregister i live.
   Mobil/WebView får inte återföra gamla testdata från återhämtningscache.
7. Stäng `/testbil1`, publik röstdemo och testmiljöernas integrationsprover
   som standard i liveprofilen, även vid direkta HTTP-anrop. Behörig diagnostik
   för den riktiga Spiris-anslutningen får finnas separat.

`createTenantApplicationState` är en användbar grund för tomma bolag, men dess
nuvarande skydd och legacy-bootstrap måste anpassas genom ett uttryckligt
liveflöde. Bygg inte en generell oskyddad reset-endpoint som lösning.

## Överför artikelkatalogen, inte hela databasen

Förbered en **serverbehörig, läsande export** från det avsedda demobolaget.
Använd en granskad tillåtelselista och en versionsmärkt importfil. Uppgifter
som bara finns i den driftsatta databasen går inte att återskapa säkert från
GitHub-exempel. Begär nödvändig källåtkomst när importen faktiskt behöver den;
be aldrig om tokens eller lösenord i chatten.

### Det som ska följa med

- Artikel-ID eller dokumenterad ID-mappning, artikelnummer, namn, texter,
  enheter, aktivstatus och relevanta artikelrevisioner.
- Grupper/undergrupper, relationer, sorteringsordning och appvisning.
- Huvudbild, exempelbilder och bildordning, inklusive **faktiska bildbytes**
  från artikelbildarkivet och verifierade referenser i målbolaget.
- Artikelns moms-/avfallsklassificering och allmänna prisregler/prissteg.
- Ägargodkända aktuella baspriser. LME-/valutaunderlag måste ha en verifierad
  källa och tid; seedade `Exempelpris` får inte bli skarpa priser av misstag.
- ScrapPilot-varumärket och godkända statiska instruktionsbilder.

Visa en importöversikt med antal artiklar, grupper, bilder, varningar och
vilka priser som behöver kontrolleras. Validera scheman, relationer,
bildchecksummor och storleksgränser. Importen ska vara idempotent och kunna
kontrolleras utan skrivning. Gör ingen automatisk kopiering mellan bolag.

### Det som börjar tomt

- Kunder, kontaktuppgifter, referenser och ursprungsadresser; kundspecifika
  prisavtal och undantag med koppling till gamla kunder.
- Viktkort, pågående utkast, attest-/kundgodkännanden, rättelser, betalningar,
  prissnapshots från affärer, kundvolymer, saldon och lagerhändelser.
- Arbetsorder, transporthistorik, exempelavtal, kärl-/fordonsexempel,
  simulerade puckar och resor samt gamla portalidentiteter.
- Exempelpersonal, löner, stämplingar, tidrapporter, sjuk-/frisk-/ledighetsärenden
  och intyg. Verkliga användare och bemanning läggs upp uttryckligt.
- Testmejl, samtal/transkript, AI-uppföljningsärenden och testdokument/PDF.
- Integrationsjournaler, leverantörs-/fakturamappningar, outbox, leases,
  PDF-jobb, bankmedgivanden, sessioner och OAuth-token från demon.

Anläggningar, tillstånd, momsregler och ekonomiska inställningar granskas och
sätts upp för den verkliga verksamheten. Sandboxens kontoplan-ID, kostnadsställen,
betalningsvillkors-ID och projekt får inte antas motsvara ett skarpt företag.
Godkänd AI-supportkunskap kan importeras separat efter granskning av innehåll
och vilka uppgifter publika kunder ska få tillgång till.

## Referenser, integrationer och pengar

Lokal nyinstallation tar inte bort fakturor eller betalningar som redan finns
hos en extern leverantör. Bestäm referens-/nummerserie för live och kontrollera
att den inte kolliderar med tidigare exporter. Återansluts samma externa
företag ska gamla referenser och deras utfall stämmas av först.

**Nuvarande integrationsadaptrar är testadaptrar:** Spiris är sandbox,
Swish är MSS och Open Payments är sandbox. En ny server eller ett ändrat
env-värde gör dem inte till skarpa betalningsadaptrar.

Leveranser är avstängda under bootstrap och verifiering. **Skarp Spiris ska
vara verifierad och aktiverad när första verksamhetspiloten börjar.** Bank,
Swish och andra externa leveranser är fortsatt avstängda tills de ansluts
separat. Kontrollera spärrarna på servern för både direkta API-anrop och
bakgrundsjobb; dolda knappar eller enbart saknade nycklar räcker inte.
Kopiera inte gamla token eller testföretagets leverantörs-/faktura-ID:n.
Ett tekniskt sandboxprov ska vara tydligt avskilt från riktig verksamhetsdata.

### Spiris ingår från första piloten

1. Implementera produktionsstöd med verifierade leverantörsadresser och tydlig
   miljöbindning. Dagens `VISMA_ENVIRONMENT=sandbox`-adapter kan inte göras skarp
   enbart genom ett annat env-värde. Bevara det befintliga sandboxstödet i demon.
2. Kontrollera produktionsåtkomst för API-klienten, nödvändiga scopes och
   registrering av den nya HTTPS-callbackadressen. Anslut genom OAuth till
   **rätt verkligt Spiris-företag** och verifiera företagets identitet innan export.
3. Hämta och granska företagets faktiska kontoplan, momsregler, betalningsvillkor
   och eventuell anläggningsfördelning. Sandboxens ID:n ska inte återanvändas.
4. Använd första pilotens standard **Attest → leverantörsfakturautkast**.
   Skicka inte samma attestversion två gånger vid dubbelklick, återstart eller
   timeout. Kontrollera och återanvänd den tidigare överföringens identitet.
5. Låt ekonomi granska och bokföra utkastet i Spiris. Läs tillbaka verifierad
   bokföringsstatus och verifikationsnummer till rätt viktkort och dess historik.
   Ett mottaget utkast är inte bevis på bokföring eller genomförd utbetalning.
6. Behåll `Attest + bokför` avstängt tills den skarpa vägen har verifierats
   separat. Knyt underlag, attestversion och faktura till samma bolag i alla steg.
7. Säkerställ att utkastet inte startar en oavsiktlig bankbetalning via Spiris.
   Kontrollera hanteringen av `SkipSendToBank` och det verkliga företagets
   bankinställningar. Utbetalningen sker enligt JEROC:s nuvarande arbetssätt.

Verifiera minst en granskad riktig avräkning hela vägen till rätt fakturautkast,
ekonomis bokföring och återläst verifikation. Stäm av belopp, moms, konton,
leverantör och referens. Riktiga underlag ska vara avsedda affärshändelser;
använd inte en påhittad testfaktura i den riktiga bokföringen.

Skarpa pengar kräver dessutom bevisat dubblettskydd, reserverat underlag,
behörighet, mottagarkontroll och avstämning av oklara utfall. Timeout betyder
okänt resultat; kontrollera samma instruktion. Ett fel vid PDF eller senare
Spiris-bokföring får aldrig leda till en ny betalning. Registrera inte ett
simulatorresultat som faktisk betalning i live.

## Säkerhet och drift som måste lösas före riktig pilot

Utgå från ÄL 123 och ÄL 045 samt säkerhetsgranskningen i referenserna nedan.
Verifiera aktuell kod; gamla dokument innehåller också historiska uppgifter.
Kända kvarstående punkter i den granskade versionen:

- Lösenordsbyte i mobilen återkallar inte alla plattformssessioner. Samordna
  sessionsåterkallning mellan mobil, kontor och berörda portaler.
- `archiveData` kan sparas med enbart läsbehörighet. Inför särskild
  skrivkontroll, innehållsschema och storleksgränser samt negativa API-tester.
- Swish HTTP 408 klassas inte som okänt utfall. Rätta och verifiera innan
  någon skarp betalningsadapter ansluts.
- `/healthz` bevisar inte databasåtkomst. Inför separat beroendekontrollerad
  readiness med timeout och en användbar rutin för larm.
- Komplett backup och isolerat återställningsprov är inte verifierade.
  Omfatta plattformsregister, alla bolagsschemas, bild-/PDF-/intygsbytes,
  jobb och nödvändiga krypteringsnycklar. Återställ med leveranser avstängda.
- Kör bolags-/behörighets-/IDOR- och samtidighetsprov mot riktig PostgreSQL,
  inklusive filer, exporter, köer och byte av aktivt bolag/användare.
- Granska beroenden och hemligheter, faktiska säkerhetsheaders, känslig
  loggning, filåtkomst, kvoter och återhämtningsvy vid klientfel.

Bedöm även laglig grund, behörighet, gallring och tillgång till kund- och
personaluppgifter, särskilt sjukintyg. Databeständighet är inte detsamma som
fullständig backup eller en beslutad lagrings-/gallringsrutin.

## Render och hemligheter

Utgångspunkt i repot: Node `24.19.0`, `npm start` → `server/index.mjs`.
Behåll låsfiler och verifiera installation/bygge i den nya miljön.

| Inställning | Ny miljö |
| --- | --- |
| `NODE_VERSION` | `24.19.0`, eller separat verifierad kompatibel uppgradering. |
| `NODE_ENV` | `production`. Detta är inte i sig en spärr för demoseedning. |
| `DATABASE_URL` | Den nya databasens anslutning, lagrad som serverhemlighet. |
| `SCRAPPILOT_PLATFORM_ADMIN_PASSWORD` | Nytt privat slumpmässigt initialt lösenord, minst 16 tecken. Verifiera den nya bootstrapen och hantera efterföljande lösenordsbyten korrekt. |
| `JEROC_DEMO_AUTO_SESSION` | `false`, tillsammans med de faktiska kontospärrarna och liveprofilen ovan. |
| `EXPO_GO_ENABLED` | `false` vid första bootstrapen; aktivera separat om Expo Go behövs för piloten. |
| Integrationsnycklar | Lägg till först för den specifika granskade anslutningen. Återanvänd inte tidigare delade hemligheter. |

För första pilotens Spiris-anslutning behöver installationen sin egen säkert sparade
`VISMA_TOKEN_ENCRYPTION_KEY`: 32 slumpmässiga byte i base64. Befintliga token
kan inte dekrypteras med en ny nyckel. Den här planen importerar inga token.
Bevara en installations krypteringsnycklar i dess säkra återställningsrutin.

Utan Expo kan byggkommandot efter granskning vara:

```text
npm ci --include=dev --no-audit --no-fund && npm run build
```

Med Expo används repots `npm run build:render` och Expo-konfigurationen i
återanvändningsguiden. Startkommando är `npm start`. Anpassa Render-healthcheck
till verifierad readiness när den byggts. Registrera aldrig en databas eller
integration som fungerande enbart för att variabeln finns.

Spara inga hemligheter i denna fil, Git, frontend, byggloggar eller chatten.
Lägg bara publika värden i `EXPO_PUBLIC_*` och `VITE_*`.

## Arbetsordning och leverans

1. **Inventera och implementera livegrunden.** Läs kod och säkerhetsunderlag,
   skapa live-bootstrap och negativa tester, stäng demofallback/importer.
2. **Bygg och testa lokalt.** Behåll produktens befintliga funktioner och
   bolagsisolering. Gör fel, omstarter, tom data och saknad DB till provfall.
3. **Förbered katalogexport/import.** Leverera en granskbar översikt och
   `dry-run`. Ta bara med den godkända katalogen och dess egna beroenden.
4. **Sätt upp nya resurser.** Koppla samma repo till ny server/DB, privata hemligheter,
   TLS, readiness, driftlarm, backup och isolerat återställningsprov.
5. **Provisionera och importera.** Systemadmin, JEROC, VD/anläggningar och
   katalog. Verifiera tom affärshistorik och att omstart inte ändrar detta.
6. **Verifiera och anslut skarp Spiris.** Produktionsadapter, produktionsåtkomst,
   callback, rätt företag, ekonomiska inställningar och dubblettskydd måste vara
   klara före verksamhetspiloten. Håll automatisk bank/Swish avstängd.
7. **Genomför pilotprotokoll.** Ny kund → invägning → kundgodkännande →
   attest → arkiverad PDF och verkligt Spiris-utkast → ekonomis bokföring →
   återläst verifikation. Kontrollera rättigheter, priser, moms och spårbarhet.
   Prova kontor och mobil samt lagring efter deploy/återstart. Börja med en
   anläggning och ett par användare; stäm av mot nuvarande arbetssätt.
8. **Redovisa resultat.** Ange commit, ny miljö, exakta tester, blockerade
   funktioner, återställning och konkret nästa steg. Markera inte live redo
   medan obligatoriska prov saknas. Håll gamla demon separat.

Den nya Codex-agenten ska färdigställa all oberoende kod, dokumentation och
lokal verifiering innan den ber om saknad resursåtkomst eller konfiguration.
Be om en specifik sak i taget när det behövs; hemliga värden lämnas i
plattformens säkra inställningar. Skarpa leveranser öppnas först efter att
ägaren godkänt den konkreta anslutningen och pilotens kontroller är klara.

## Verifierat i denna överlämning

2026-10-19 kördes befintliga `platform-auth`, `tenant-runtime`,
`tenant-gateway` och `demo-weighing-reset`-tester på källversion `692e956`:
**39 godkända, 0 underkända, 1 PostgreSQL-test hoppades över** eftersom separat
testdatabas saknades. De lokala proven verifierar inte verklig Render-drift,
backup eller produktionsintegrationer. Ingen driftdata rensades.

## Källor att börja läsa

- [SaaS-blueprint och säkerhetskontrakt](docs/saas-blueprint/03-sakerhet-och-drift.md)
- [51-punktsgranskningen](docs/security/launch-readiness-2026-10-14.md)
- [Before demo release / ÄL 123](docs/planerade-uppdateringar.md#before-demo-release--säkerhet-drift-och-skalbarhet)
- [Ändringslista, bland annat ÄL 045 och 123](docs/Andringslistan.txt)
- [Tomt bolag och databasavgränsning](server/tenant-runtime.mjs)
- [Bolagsgateway och nuvarande bootstrap](server/tenant-gateway.mjs)
- [Plattformsinloggning och provisionering](server/platform-auth.mjs)
- [Standardseed och verksamhetstjänst](server/application.mjs)
- [Artikel- och prisregister](server/pricing.mjs)
- [Beständiga artikelbilder](server/article-media-storage.mjs)
- [Återanvändbar Expo Go-/QR-konfiguration](docs/expo-go-ateranvandning.md)

Om bara denna fil bifogas i nästa Codex-chat finns alla referenser under
`https://github.com/NicklasJr93/JEROC-Atervinning/blob/main/` följt av sökvägen.
Det nya Codex-projektets utvecklingsmiljö behöver åtkomst till samma källrepo.

## Startmeddelande till nya Codex-chatten

> Läs bifogade LIVE_SCRAPPILOT_SETUP.md och genomför uppdraget. Vi ska ha en
> ny separat server och databas för Live ScrapPilot. Behåll befintliga demon
> orörd och behåll en gemensam kodbas i samma GitHub-repo. Överför den godkända artikelkatalogen med grupper,
> bilder och prisregler, men börja utan testkunder, affärer och historik.
> Börja med live-bootstrap, demoskydd och säkerhetsbristerna; sätt sedan upp
> och verifiera den nya miljön. Skarp Spiris ingår från första piloten:
> attest skapar fakturautkast, ekonomi bokför i Spiris och ScrapPilot hämtar
> status/verifikation. Utbetalningar sköts som idag; automatisk bank/Swish
> aktiveras senare. Be inte om hemligheter i chatten.
