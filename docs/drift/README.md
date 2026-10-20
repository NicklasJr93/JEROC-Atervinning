# Driftguide för ScrapPlanner

Granskad **2026-10-20** mot aktuell kod och pilotens driftkontroll. Detta är
ingången för den befintliga installationen. [Användarmanualen](../manual/README.md)
beskriver verksamhetsarbetet; [dokumentationsöversikten](../README.md) samlar
fördjupning och historik.

## Miljö och tjänster

| Resurs | Uppgift | Adress/anslutning |
| --- | --- | --- |
| `scrapplanner-website` · Static Site | Publik hemsida från `website/` | `scrapplanner.com`, med `www`-omdirigering |
| `scrapplanner-app` · Node Web Service | Kontor, mobil, terminaler och backend/API | `app.scrapplanner.com`, `mobile.scrapplanner.com` |
| `scrapplanner-db` · PostgreSQL | Plattformsregister, bolagsdata, dokument och privata filer | Intern `DATABASE_URL` på appservern |

App och databas är konfigurerade för Frankfurt. Kontoret och mobilen använder
samma backend och databas, men domänerna och Expo WebView har egna sessioner.
Säljsidan har ingen åtkomst till privata bolagsdata.

[render.scrapplanner.yaml](../../render.scrapplanner.yaml) beskriver pilotmiljön.
Den äldre [render.yaml](../../render.yaml) beskriver JEROC-demon och är inte
konfigurationen för den befintliga ScrapPlanner-piloten. Skapa inte nya resurser
för att uppdatera appkod. Behåll den separata demomiljöns databas och inställningar.

Vid driftkontrollen **2026-10-20** var kontor och mobil driftsatta, `/readyz`
svarade och Expo-paket för iOS och Android samt QR-sidan var tillgängliga.
Aktuell driftsatt commit och eventuell pågående utrullning läses i Render →
**scrapplanner-app → Deploys**; ett pushat GitHub-commit är inte i sig driftsatt.

## Konfiguration och hemligheter

Lägg privata värden i **Render → scrapplanner-app → Environment**. Git innehåller
variabelnamn och byggrecept, aldrig verkliga lösenord, API-nycklar, token eller
databasexporter. Kopiera inte hela miljön till chatt eller felloggar. Appserverns
hemligheter ska inte ha `VITE_`-prefix eller läggas på den statiska hemsidan.

| Variabel | Funktion |
| --- | --- |
| `SCRAPPLANNER_DEPLOYMENT_MODE` | `pilot` för den separata pilotprofilen; saknat värde väljer den äldre demoprofilen |
| `NODE_ENV` | `production` i driften |
| `DATABASE_URL` | Intern PostgreSQL-anslutning för rätt miljö |
| `SCRAPPILOT_PLATFORM_ADMIN_PASSWORD` | Privat bootstrapvärde som krävs av pilotprofilen; byte i env är inte ett återställningsflöde för ett redan skapat konto |
| `JEROC_DEMO_AUTO_SESSION` | `false` i pilotens Blueprint |
| `APP_URL`, `MOBILE_URL` | Betrodda HTTPS-ursprung för kontor respektive mobil, utan sökväg |
| `RESEND_API_KEY` | Gemensamma systemmejl via Resend |
| `ELKS_API_USERNAME`, `ELKS_API_PASSWORD` | API-inloggning för SMS via 46elks |
| `SCB_API_KEY` | Företagsuppslag via SCB |
| `ROARING_CONSUMER_KEY`, `ROARING_CONSUMER_SECRET` | Serverns personuppslag via Roaring |
| `GOOGLE_MAPS_BROWSER_API_KEY` | Webbläsarens adressförslag via Places; avsedd att lämnas till Google-biblioteket och begränsas till rätt webbplatser/API:er |
| `GOOGLE_ADDRESS_VALIDATION_API_KEY` | Valfri separat serverkontroll av adresser; begränsas till Address Validation API och appens utgående IP-intervall |
| `EXPO_GO_ENABLED`, `EXPO_TOKEN`, `EXPO_PUBLIC_WEB_APP_URL` | Det uttryckligen aktiverade Expo Go-testet, se nedan |

Det tekniska namnet `SCRAPPILOT_…` finns kvar av kompatibilitetsskäl trots
produktnamnet ScrapPlanner. Byt inte env-, cookie- eller lagringsnamn som en
varumärkesändring. Första bootstrap och DNS beskrivs i den
[ursprungliga installationsguiden](../deployment/scrapplanner-render.md).

Efter en env-ändring behöver den aktiva tjänsten startas med de nya värdena.
Kontrollera Renders val för att spara, bygga och deploya; enbart ett sparat
formulär eller en uppdaterad YAML i Git bevisar inte att ändringen används.
För leverantörernas övriga inställningar, scopes och certifikat används
respektive [integrationsguide](../integrationer/README.md).

## Inloggning, bolag och leverantörsstatus

Personliga konton autentiseras på servern. Behörigheter och anläggningsåtkomst
kontrolleras också där. En användarheader, bolagsparameter eller dold knapp
ersätter inte sessionens rättigheter. Pilotprofilen startar ett privat
plattformsregister och tomma bolagsregister; produktionsdrift ska inte ändras
till demoprofilen för felsökning.

- Personalens mobilinloggning hittar det aktiva bolag som kontot hör till.
- Systemadmin kan välja bolag utan att skapa en egen anställning i varje bolag.
  **Jobba som** är ett skrivbart arbetsläge; kontrollera bolagsremsan före arbete.
- Systemadministrationens utskickstest och SaaS-förbrukning kräver det egna
  plattformssammanhanget, utanför bolagets arbetsyta.
- Inbjudningar, engångslösenord och återställning har egna flöden. Använd dem
  för befintliga konton; skapa inte ett nytt bolag eller konto för att kringgå
  ett lösenordsproblem.

Se [personalinbjudningar](../personal-inbjudningar.md),
[delegerad användarhantering](../delegerad-anvandarhantering.md),
[lösenordsåterställning](../losenordsaterstallning.md) och
[systemadmin i mobilen](../mobil-systemadmin.md).

| Tjänst/flöde | Vad den aktuella implementationen innebär |
| --- | --- |
| Resend/46elks | Verkliga uttryckliga testutskick och kundlänkar finns. Systemmejl används också av kontoinbjudningar, återställning och den valbara PDF-kopian efter attest. Ett accepterat leverantörskvitto är inte ett leveransbevis. |
| Google-adresser | Kompletta Places-träffar fyller adress, postnummer och ort direkt. Servervalidering är ett valfritt komplement. |
| SCB/Roaring | Företags- och personuppslag har separata leverantörer. Roarings bekräftade uppslag journalförs som fakturaunderlag per SaaS-bolag. |
| Kundgodkännande | Kundlänken använder kundens Godkänn följt av personalens uttryckliga fysiska ID-kontroll. BankID är inte anslutet. |
| Spiris, NVV, bank och Swish | Nuvarande adaptrar är avgränsade till Spiris sandbox, NVV TEST, Open Payments sandbox och Swish MSS. Produktionsstöd och faktisk aktivering är separata arbeten; nya produktionsnycklar gör inte dessa adaptrar skarpa. |
| Transportaviseringar | Underlag är förberett; automatiska SMS-utskick är fortsatt ett kommande flöde. |

Att systemet visar **Registrerad/Konfigurerad** betyder i flera paneler att
en variabel finns. Det verifierar inte leverantörens rättigheter, saldo,
kvoter, fakturering eller domän/IP-begränsningar. Prova det avsedda flödet och
skilj testresultatet från konfigurationsstatusen.

## Uppdatera och kontrollera

Pilotens Blueprint har hemsidans automatiska deploy på commit och appens
automatiska deploy avstängd. Blueprintens **Auto Sync** är en separat inställning
och ska hanteras separat från appkodens deployment.

1. Granska ändringen och relevanta prov enligt [utvecklingsguiden](../utveckling.md).
   Notera vilken commit som ska driftsättas och om databasmodeller/migrationer ändras.
2. Push till rätt branch. På **scrapplanner-app → Manual Deploy**, välj den
   granskade versionen. **Deploy latest commit** använder senaste commit på
   tjänstens branch; kontrollera att det verkligen är den avsedda versionen.
3. Behåll byggkommandot `npm ci --include=dev --no-audit --no-fund && npm run build:render`
   och startkommandot `npm start`. Node-versionen i Blueprinten är 24.19.0.
4. Följ bygg- och startloggar tills Render visar **Live**. Kontrollera commit,
   databasberedskap samt berörda kontors-/mobilflöden. Inloggad funktion måste
   provas med rätt konto och bolag; en publik startsida räcker inte.
5. Vid klientcache: ladda om webben. Stäng och öppna Expo-vyn igen om dess skal
   eller paket ändrats. Kontrollera att arbete som ännu inte sparats tas om hand.

| Kontroll | Betydelse |
| --- | --- |
| `GET /healthz` → 200 | Node-servern svarar; ingen garanti för databas eller leverantörer |
| `GET /readyz` → 200 | Servern kan läsa plattformens datalager; Render använder denna för trafikberedskap |
| `GET /readyz` → 503 | Nödvändig databasåtkomst är inte tillgänglig |
| `GET /expo/status` | Expos separata beredskap och förberedda plattformar |
| `/expo-go` och `/expo-go-qr.svg` | Startsida respektive QR-kod för det konfigurerade Expo-testet |

Databasmigrationer/tabellinitiering körs när respektive serverlager öppnas.
Byggsteget kompilerar gemensamma domänmodeller till `dist-server/domain-models.mjs`.
PDF-jobb och andra beständiga uppgifter ligger i databasen. En omstart är inte
en återställning av affärshistoriken. Börja med Blueprintens enda appinstans;
flera instanser kräver granskning av bland annat gemensamma leverantörskvoter.

## Expo Go och mobil

Mobilwebben fungerar utan Expo på `https://mobile.scrapplanner.com/mobil/`.
Expo är ett tillfälligt skal för pilottest, inte en publicering i appbutikerna.
Blueprinten har Expo avstängt som grundläge; det aktuella livetestet är
uttryckligen aktiverat i appens Environment.

Använd `EXPO_GO_ENABLED=true`, privat `EXPO_TOKEN` och
`EXPO_PUBLIC_WEB_APP_URL=https://mobile.scrapplanner.com/mobil/` för testet.
`RENDER_EXTERNAL_URL` tillhandahålls av Render och används för manifest och
paket. `/expo/status` redovisar `warmedPlatforms`; `ready: true` betyder att
både iOS och Android förberetts. Att webbappen är Live betyder inte att Expo
redan är klart. En Expo-störning ska inte stoppa kontoret eller verksamhetens API.

Öppna [Expo Go-sidan](https://app.scrapplanner.com/expo-go). Telefonen behöver
rätt Expo-konto och ett separat ScrapPlanner-konto. Se
[hela Expo-instruktionen](../expo-go-live.md) för drift, QR och telefonprov.

## Felsök i rätt steg

| Symtom | Börja här |
| --- | --- |
| GitHub visar ändringen men appen gör det inte | Jämför commit i Render Deploys med granskad GitHub-commit; kontrollera rätt tjänst/domän och ladda sedan om klienten |
| `/readyz` ger 503 | Appens startlogg, rätt intern `DATABASE_URL`, databasens tillgänglighet och migrationernas fel. Byt inte till en annan miljös databas som reserv. |
| En anställd saknar inloggning eller en meny | Kopplat aktivt konto, inbjudans aktivering samt sparade konto-/anläggningsrättigheter; ett personalkort är inte ensamt en aktiv inloggning |
| Google visar gata men inget postnummer | Välj komplett adress med husnummer. Kontrollera Places-detaljer och därefter eventuell separat servervalidering; en hel gata kan ha flera postnummer. |
| Google nekar serverkontrollen | Address Validation API i samma Google-projekt som servernyckeln, fakturering samt alla aktuella IP-intervall under Render → Connect → Outbound, inklusive CIDR-suffix |
| SCB/Roaring nekar eller ger ingen träff | Rätt nummer och typ, aktivt leverantörskonto samt rätt servervariabler. Gör inte upprepade köpta personuppslag för att prova århundraden. |
| Mejl/SMS accepteras men syns inte | Leverantörens status/logg, mottagare, skräppost eller telefonnät. Skilj accepterat, nekat och osäkert svar; tryck inte om på ett osäkert utskick utan granskning. |
| Kontorets PDF-kopia saknas | Aktiverad inställning och mottagare, intern attest, slutligt arkiverat PDF-original och därefter mejlkön; kundens Godkänn skickar inte kopian |
| Expo visar väntan/fel | `/expo/status`, aktuell plattform och Render-logg. Prova mobilwebben separat för att skilja skalet från inloggning/API. |

Fördjupning: [Google](../integrationer/google-adresser.md),
[SCB](../integrationer/scb-foretagsregister.md),
[Roaring/förbrukning](../personuppslag-och-saas-forbrukning.md),
[systemutskick](../integrationer/systemutskick.md),
[PDF-kopia](../integrationer/vagt-underlag-epost.md) och
[kundlänkar](../kundgodkannande-lankar.md).

## Lagring, backup och återställning

PostgreSQL innehåller både verksamhetsmodeller och separata register för bland
annat plattform, användning, dokument och filinnehåll. PDF-original och privata
artikelbilder behöver omfattas av databasens backup. GitHub innehåller kod och
statiska tillgångar; det återskapar inte driftsdatabasen. Lokal SQLite är för
utveckling och är ingen reserv för pilotens PostgreSQL.

Det finns ingen verifierad generell backup-/återställningsfunktion för hela
installationen i appen. Äldre modulspecifika exporter, revisionsloggar eller
importarkiv ska inte beskrivas som en sådan backup. Renders aktuella databasplan,
återställningsfönster och tillgängliga exporter kontrolleras i Render; denna
guide intygar ingen genomförd återläsning.

Inför återställning: välj en identifierad backup/tidpunkt, kontrollera vilken
data som omfattas och prova i en separat databas. Verifiera bolag, konton,
viktkort, PDF-filer och relevanta integrationsjournaler innan trafik flyttas.
Håll utskick och externa åtgärder under kontroll så återställda jobb inte
orsakar nya sändningar. Radering av verksamhetsdata eller återläsning över den
aktiva databasen är en separat driftåtgärd med eget beslut.

En **rollback av koddeployen återställer inte databasen**. Kontrollera att den
äldre versionen kan läsa nuvarande schema och data innan rollback. Externa
mejl, SMS, bokföringshändelser och betalningar återtas inte av en kod- eller
databasåterställning; de måste stämmas av mot leverantörens faktiska utfall.

## Detaljreferenser och historik

- [Gemensam databas](../shared-postgres.md) och [PDF-arkivet](../pdf-archive.md)
  beskriver datamodeller och äldre leveranser. Deras äldre påståenden om
  demoinloggning eller avsaknad av utskick är historik; använd aktuella
  konto- och integrationsguider ovan för dagens funktioner.
- [Installationsguiden för ScrapPlanner](../deployment/scrapplanner-render.md)
  beskriver hur pilotmiljön sattes upp och varför resurserna är separata.
- [Äldre demo-publicering](../render.md) gäller den gamla demotjänsten.
- [Ändringslistan](../Andringslistan.txt) redovisar leveranser och kvarstående
  arbeten. En leveransrad ersätter inte kontroll av faktisk driftaktivering.

Uppdatera denna guide när driftarkitektur, deployförfarande eller konfiguration
ändras. Leverantörsdetaljer hålls i respektive ämnesguide och länkas härifrån.
