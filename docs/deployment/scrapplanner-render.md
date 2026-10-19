# ScrapPlanner på Render: hemsida, app och databas

Blueprinten [render.scrapplanner.yaml](../../render.scrapplanner.yaml) skapar en
separat pilotmiljö i **ScrapPlanner Live**. Hemsidan presenterar ScrapPlanner som
en produkt av **EndorGroup**, med kontaktadress **nicklas@endorgroup.se**.
Den befintliga JEROC-demon använder sin gamla tjänst och databas och ska ligga kvar.

| Resurs | Innehåll | Publik adress |
| --- | --- | --- |
| `scrapplanner-website` · Static Site | Säljsidan | `scrapplanner.com` och dess `www`-omdirigering |
| `scrapplanner-app` · Web Service | Kontorsapp, mobil webbapp och backend/API | `app.scrapplanner.com` och `mobile.scrapplanner.com` |
| `scrapplanner-db` · PostgreSQL 17 | Nytt plattformsregister, bolagsdata och privata filer | Ingen publik databasåtkomst |

Appen och databasen körs i Frankfurt. Den statiska hemsidan ligger på Renders
CDN. Kontors- och mobilappen använder samma backend med relativa API-adresser;
varje domän har sin egen inloggningssession. Mobilappen kräver inte Expo Go.

## Skapa hela miljön

Om du bara har skapat workspacen:

1. Öppna **ScrapPlanner Live → New → Blueprint**.
2. Välj GitHub-repot **NicklasJr93/JEROC-Atervinning** och branch **`main`**.
3. Ange namn **ScrapPlanner Live** och **Blueprint Path**:

   ```text
   render.scrapplanner.yaml
   ```

4. Granska förhandslistan. Den ska innehålla **en Static Site, en Web Service
   och en ny PostgreSQL-databas**. Kontrollera de betalda planerna och totalen
   innan du väljer **Deploy Blueprint**.
5. Öppna sedan Blueprintens **Settings** och sätt **Auto Sync → No**. Fältet
   `autoDeployTrigger: 'off'` stänger redan av automatisk koddeploy för båda
   tjänsterna. Blueprintens automatiska synk är en separat inställning.

Render ansluter automatiskt den nya databasen via `DATABASE_URL`. Kopiera inte
den gamla demodatabasens anslutningssträng eller gamla integrationshemligheter.
Det behövs inga hemligheter i GitHub och inget Render Shell för första start.

### Om hemsidans Blueprint redan finns

Skapa inte en andra Blueprint som också hanterar `scrapplanner-website`.
Render kan annars skapa ytterligare resurser med namn som får ett suffix.

Använd den befintliga Blueprinten: byt dess **Blueprint Path** från
`website/render.yaml` till **`render.scrapplanner.yaml`** och välj **Manual Sync**.
Kontrollera att förhandslistan behåller hemsidan och lägger till appen och
databasen. Stäng även av **Auto Sync** för denna Blueprint.

Om den befintliga Blueprintens inställningsvy inte tillåter byte av filväg,
koppla först loss den gamla Blueprinten från resurserna och skapa därefter den
gemensamma Blueprinten. Render behåller tjänster när en Blueprint kopplas loss.
Granska resurslistan innan du godkänner ändringen; fortsätt inte om Render vill
skapa en extra hemsida. En resurs ska bara hanteras av en Blueprint åt gången.

## Första inloggningen och första bolaget

Vänta tills `scrapplanner-app` visar **Live**. Öppna dess riktiga
**`https://…onrender.com`-adress**, som Render visar på tjänsten.
Rotadressen öppnar kontoret. Egen domän och DNS behövs inte för detta steg.

1. Gå till appens **Environment** i Render och visa värdet för
   **`SCRAPPILOT_PLATFORM_ADMIN_PASSWORD`**. Render har genererat ett nytt,
   privat lösenord. Spara det i din lösenordshanterare; skicka det inte i chatten.
2. Logga in med användarnamn **`admin`** och det genererade lösenordet.
3. Byt det tillfälliga lösenordet när appen begär det. Första inloggningen kräver
   lösenordsbyte innan bolagsadministrationen kan användas.
4. Bolagslistan ska vara tom. Skapa **JEROC Återvinning AB** som första riktiga
   bolag med korrekta företagsuppgifter och ett verkligt VD-konto. VD:n får byta
   sitt tillfälliga lösenord vid första inloggningen.
5. Lägg upp bolagets verkliga anläggningar, personal och behörigheter.

Pilotprofilen startar med plattformsadministratören och tomma bolagsregister.
Den ska inte fylla den nya databasen med demokunder, viktkort, order, personal
eller betalningar. Import av den granskade artikelkatalogen är ett separat
efterföljande steg; kopiera inte hela demodatabasen.

Den här leveransen förbereder driften och första inloggningen. Den innebär
inte att hela systemet är godkänt för skarpa kunduppgifter, utbetalningar eller
produktionsbokföring. Den planerade säkerhetsgranskningen före demo/live och
verifiering av det verkliga verksamhetsflödet återstår.

## Domäner och DNS

Blueprinten lägger till domänerna på rätt tjänst. När resurserna finns, öppna
**Settings → Custom Domains** på respektive tjänst och använd exakt de DNS-värden
som Render visar där:

| DNS-namn | Ska peka på |
| --- | --- |
| `scrapplanner.com` | Hemsidans Static Site, enligt Renders anvisning för rotdomänen |
| `www.scrapplanner.com` | Hemsidan; Render omdirigerar till rotdomänen |
| `app.scrapplanner.com` | Appens Web Service |
| `mobile.scrapplanner.com` | Samma Web Service som `app` |

För `app` och `mobile` använder du normalt CNAME till **appens faktiska
`…onrender.com`-värdnamn**, utan `https://` eller sökväg. Använd inte hemsidans
värdnamn för dessa två. För rotdomänen använder du Renders visade ALIAS/ANAME-
eller A-instruktion som din DNS-leverantör stödjer.

Render verifierar domänerna och utfärdar HTTPS-certifikat. Kontrollera därefter
att `app.scrapplanner.com` öppnar kontoret och `mobile.scrapplanner.com` öppnar
mobilappen. Hemsidans **Logga in** länkar till kontorsdomänen; mobilknappen länkar
till mobildomänen. Länkarna fungerar först när respektive domän är kopplad.

## Vad som ingår i startkonfigurationen

| Inställning | Betydelse |
| --- | --- |
| `SCRAPPLANNER_DEPLOYMENT_MODE=pilot` | Uttrycklig pilotstart med privat plattformsbootstrap och tomma register |
| `NODE_ENV=production` | Produktionsläge för Node |
| `DATABASE_URL` | Automatisk intern anslutning till den nya databasen |
| `SCRAPPILOT_PLATFORM_ADMIN_PASSWORD` | Nytt privat bootstraplösenord; används när administratören skapas |
| `JEROC_DEMO_AUTO_SESSION=false` | Ingen automatisk demosession |
| `EXPO_GO_ENABLED=false` | Ingen Expo/Metro-process i pilottjänsten |
| `APP_URL` och `MOBILE_URL` | Värdnamn för rätt ingång till kontors- respektive mobilapp |

Inga Spiris-, Swish-, bank-, NVV-, mejl- eller AI-hemligheter läggs till av denna
Blueprint. Pilotprofilen stänger externa test-/demoanslutningar som standard.
Spiris-koden är hittills byggd för sandbox; dess produktionsanslutning och
produktionscallback ska färdigställas och verifieras separat. Lägg inte bara in
produktionsuppgifter i en sandboxinställning och förvänta dig skarp bokföring.

## Drift, lagring och uppdateringar

- PDF-arkiv, artikelbilder och privata bilagor använder PostgreSQL. Ingen
  persistent disk på webbtjänsten behövs för dessa filer. Börja med databasens
  angivna **1 GB** och följ lagringsutnyttjandet; utökning görs separat i Render.
- Databasen tillåter endast Renders interna nätverk (`ipAllowList: []`).
  Anslutningen i Blueprinten använder det interna värdnamnet. Renders externa
  databasanslutningar använder TLS; interna anslutningar har valfri TLS. Slå inte
  av certifikatkontroller för att lösa anslutningsfel.
- Renders betalda PostgreSQL-plan ger återställning till en tidigare tidpunkt:
  **3 dagar i Hobby**, **7 dagar i Pro** enligt dokumentationen kontrollerad
  20 oktober 2026. Logiska exporter kan också skapas. En verklig återläsning har
  inte verifierats av den här Blueprinten och ska provas innan skarp drift.
- `/healthz` visar att servern svarar. Render använder **`/readyz`** för att även
  kontrollera nödvändig databasåtkomst innan instansen får trafik.
- Håll appen på **en instans** i den första piloten. Skalning och separata
  bakgrundsarbetare är senare driftsteg med egna samtidighetstester.
- Publicera granskad kod med **Manual Deploy** på respektive tjänst. Använd
  **Manual Sync** när själva Blueprint-konfigurationen ska ändras. Kontrollera
  app, mobilinloggning och databas efter uppdatering. Återställning av en tidigare
  koddeploy återställer inte automatiskt databasen.

## Kostnad och granskade referenser

Renders publicerade prislista kontrollerad **20 oktober 2026** visar
**$7/månad** för webbtjänstens `0.5c-512mb` och **$6/månad** för databasens
`0.1c-256mb`: **$13/månad i grundläggande compute**. Hemsidan använder Static
Site. Workspace, bandbredd, extra lagring, domäner och eventuell skatt kan
tillkomma enligt Renders prislista. Planvalet är en första pilotnivå och kan
behöva höjas efter faktisk belastning. Inga Render-resurser har skapats eller
debiterats genom att denna fil lagts i GitHub; resurslistan ska granskas i Render
innan **Deploy Blueprint**.

## Verifiering av leveransen

- Blueprinten är validerad mot Renders officiella JSON-schema.
- Appens produktionsbygge (`npm run build`) är godkänt.
- De berörda pilot-, auth-, gateway-, tenant- och application-testerna har
  **72 godkända tester**. Ett PostgreSQL-specifikt test är överhoppat eftersom
  ingen separat PostgreSQL-testanslutning finns i utvecklingsmiljön.
- Kontrollerna omfattar tom bootstrap och tre omstarter, obligatoriskt
  lösenordsbyte, bolagsisolering, äldre webbläsarimporter, avstängda
  leverantörsanrop och vanlig attest med beständigt PDF-jobb.
- Ett bredare befintligt test, `legacy transport saves canonicalize changed
  address/phone fields and keep partial or invalid writes out` i
  `server/application-customer-sync.test.mjs`, faller även mot koden före
  denna leverans. Det är en separat kvarvarande kontrollpunkt inför live;
  hela projektets testsamling påstås inte vara godkänd.
- Ingen Render-resurs, faktisk PostgreSQL-uppstart i Render, DNS-verifiering
  eller backupåterläsning har utförts från denna utvecklingsmiljö. Kontrollera
  dessa efter att Blueprinten har skapats, före riktig verksamhetsdata.

- [Render Blueprint-specifikation](https://render.com/docs/blueprint-spec)
- [Hantera Blueprints och befintliga resurser](https://render.com/docs/infrastructure-as-code)
- [PostgreSQL, nätverk och lagring](https://render.com/docs/postgresql-creating-connecting)
- [Återställning och backup](https://render.com/docs/postgresql-backups)
- [Egna domäner](https://render.com/docs/custom-domains)
- [Aktuell prislista](https://render.com/pricing)
