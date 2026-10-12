# Prestandagranskning – JEROC, 12 oktober 2026

Granskad kod: `0f42418`, kontor 0.17.2 och mobilwebb 0.5.0. Produktionsbyggets
huvudfil `index-BTFDQCfp.js` verifierades i webbläsarprovet.

**Det finns tydliga flaskhalsar i dataläsning och bakgrundsuppdatering.**
Vanliga kontors-, artikel-, terminal- och mobilläsningar är redan snabba i
de varma driftproven. Integrationer, Personal och logistik sticker ut.
Flera av deras kodvägar läser stora historikdokument eller använder skrivlås
trots att användaren bara öppnar en sida. Dessa problem går att åtgärda stegvis.

Rapporten är en granskning och ett åtgärdsförslag. Ingen appfunktion ändrades
under granskningen. Nya rapporter, fakturor eller betalningar skickades inte.

## Vad som mättes

- 36 HTTPS-läsningar mot 12 befintliga driftendpoints, tre prov per endpoint,
  i följd: 33 behörighetskontrollerade API-läsningar och tre öppna healthz-prov.
  Skyddade endpoints använde behöriga demokonton. Alla svarade HTTP 200.
  Endast nödvändiga demosessioner skapades/avslutades; inga verksamhetskommandon
  skickades. Befintliga GET-rutter kan själva utföra registerunderhåll.
- Webbläsarprov av kontorets start, Integrationer, Spiris-inställningar,
  invägningar, artiklar, arbetsorder och Personal, samt 31 sekunders inaktiv vy.
- Lokal PostgreSQL 18: uppmätta frågeantal och ett varmt prov för centrala
  läsningar, lagerkontroll och kundterminalvisning, i ett separat testschema.
- Separat syntetiskt tillväxtprov med ungefär 0, 2 och 10 MB historik och tre
  mätningar per datastorlek. Tillfälliga lokala scheman och konton städades bort.
- Kodgranskning av server, lagring, behörighet, mobil, terminal, webb,
  integrationsköer, dokument/bilder, realtid och bakgrundsjobb.

Driftproven mäter hela vägen från denna arbetsmiljö genom dess nätverksproxy
till Render. De är **median och intervall för tre varma prov, inte P95 eller
ett belastningstest**. Webbläsaren var desktop-Chromium utan CPU-/nätsimulering.
HTTPS verifierades via systemets CA-bunt. Browserrouting stängde av HTTP-cache
och den isolerade webbläsaren kunde inte använda SSE över proxyn; den använde
appens reservhämtning. Därför är bildomladdningar och extra reservpollning i
just detta prov inte bevis för samma beteende i användarens vanliga webbläsare.

Render-planer, resursutnyttjande, interna databasadressen, regioner och
databasens anslutningsgräns är ännu inte bekräftade. Lås-/poolväntan och tiden
hos externa API:er saknar full uppdelad mätning i driften. Fysiska mobiler,
kundterminalens autentiserade kundvy och samtidiga användare behöver senare
verifieras separat. Befintliga säkerhetskontroller testades inte om i en full
korrekthetssvit; detta var en prestandagranskning.

## Uppmätt i driften

| Läsning | Median | Intervall | Svar efter uppackning | Överfört med gzip, median |
| --- | ---: | ---: | ---: | ---: |
| Kontorsdata | 128 ms | 127–152 ms | 33,8 kB | 4,7 kB |
| Artikel-/prisregister | 89 ms | 85–130 ms | 29,6 kB | 4,3 kB |
| Miljösession | 76 ms | 66–126 ms | 0,7 kB | 0,4 kB |
| Miljötillstånd | 400 ms | 274–597 ms | 107,2 kB | 11,3 kB |
| Integrationskatalog | **1 604 ms** | 1 307–1 877 ms | **3,9 kB** | 1,1 kB |
| Sparade Spiris-inställningar | **3 133 ms** | 3 093–3 441 ms | 1 265,9 kB | 65,3 kB |
| Terminalens personalstatus | 77 ms | 69–85 ms | 33,8 kB | 4,4 kB |
| Arbetsorder/lager/kärl | **1 484 ms** | 1 414–1 616 ms | 33,0 kB | 5,0 kB |
| Personal | **1 490 ms** | 1 206–1 506 ms | 24,0 kB | 3,8 kB |
| Personlig mobilöversikt | 106 ms | 91–202 ms | 6,7 kB | 0,7 kB |
| Mobilens vägningar/katalog | 110 ms | 96–144 ms | 16,3 kB | 4,0 kB |

Kontrollendpoint `/healthz` låg på 115–259 ms. Mätningarna har naturlig
nätverksvariation och kan inte användas för att dra av en exakt fast nätkostnad.

Integrationskatalog och sparade Spiris-inställningar kontaktar **inte Spiris**.
Deras väntan kan därför inte förklaras med Spiris server eller antalet
kontovalmenyer. Alla kontofält återanvänder samma hämtade kontolista.

I webbläsarprovet tog kataloganropet 2 399 ms, Spiris-inställningarna 3 327 ms,
och sidan visade kontofälten efter 3 878 ms. Rubriken Integrationer syntes redan
efter 337 ms, men kortens data var då fortfarande på väg. En automatisk
förhandsvisning startade efter inställningarna och tog ytterligare 1 262 ms;
den svarade 422 eftersom ekonomiinställningarna ännu inte var kompletta.

Komprimering är redan aktiv på Render: gzip i HTTP-proven och Brotli i
webbläsaren. Att bara lägga till komprimering är därför inte huvudåtgärden.

## De viktigaste flaskhalsarna

### 1. Stor historik läses för små status- och inställningssvar

`vismaIntegration` innehåller anslutning, inställningar, kontoplaner,
sandboxförsök, råa svar, exportkö och historik i samma JSON-dokument.
En liten statusfråga läser ändå hela dokumentet från PostgreSQL.

Spiris-inställningarnas slutrespons läser samma dokument **tre gånger**:
inställningar, anslutning och kontolistor. Det tillkommer sessions-,
behörighets- och anläggningsläsningar. Modell från koden: cirka 23 SQL-anrop
inklusive BEGIN/COMMIT; detta antal är inte uppmätt för den levande rutten.

**Förslag:** små SQL-projektioner för anslutningsstatus och en gemensam
inställningsläsning. Skicka kontolistan separat och återanvänd den efter
företag, räkenskapsår och revision. Historik hämtas först när den öppnas.

Källor: [visma-sandbox.mjs](../server/visma-sandbox.mjs),
[visma-export.mjs](../server/visma-export.mjs), [index.mjs](../server/index.mjs).

### 2. Läsningar tar gemensamt skrivlås och läser alla moduler

Personal, logistik och den äldre chaufförsportalen använder en skrivtransaktion
även för GET. Den gemensamma applikationstransaktionen låser en enda metarad,
läser alla domäner och jämför hela JSON-dokument före/efter. Integrationshistorik
kan därmed göra en personalläsning eller vanlig sparning långsammare.

**Förslag:** gör GET till riktade läsningar. Flytta registerunderhåll och
uppdatering av bemanningsuppgifter till rätt kommando eller bakgrundsjobb.
Låt kommandon läsa och skriva berörda register/poster. Behåll gemensam commit
för förändringar som faktiskt måste vara atomiska.

Källor: [application-storage.mjs](../server/application-storage.mjs),
[application.mjs](../server/application.mjs), [logistics.mjs](../server/logistics.mjs),
[personnel.mjs](../server/personnel.mjs).

### 3. Kontoret arbetar i bakgrunden även på andra sidor

- Full arbetsorder-/logistikvy hämtas var femte sekund för menyns räknare.
- Full kontorsdata och full miljövy hämtas dessutom normalt var 30:e sekund.
- Prisregistret hämtas vid menybyten, även när sidan inte behöver priser.
  Artikelsidan hämtar samma register ytterligare en gång.
- Arbetsorder-, lager-, personal- och planeringsvyer har egna uppdateringar
  ovanpå de gemensamma. Vissa timers kan starta överlappande anrop.

Det blir från koden cirka **16 fulla GET/minut per synlig kontorssession** med
arbetsorder-/miljöbehörighet och frisk realtid, före sidans egna anrop.
25 sådana sessioner ger cirka 400/minut. Det är
en beräkning av timers, inte ett genomfört 25-användarprov. Enbart femsekunders-
hämtningen står för 12 av 16: att ersätta den tar bort ungefär **75 % av denna
grundtrafik**, inte 75 % av all väntetid.

**Förslag:** liten räknar-/revisionsrespons för menyn, gemensam pågående
hämtning/cache per behörighet, uppdatering via befintlig SSE, sidstyrda detaljer,
paus i dold/offline flik och en gles, lätt reservkontroll.

Källor: [OfficeApp.tsx](../src/office/OfficeApp.tsx),
[EnvironmentSession.tsx](../src/office/EnvironmentSession.tsx),
[shared-data.ts](../src/shared-data.ts).

### 4. Integrationer laddas i flera led

Session → integrationskatalog → Spiris-inställningar → förhandsvisning.
Vid ny session tillkommer inloggningsanrop. Full miljödata laddas samtidigt
och kan konkurrera om resurser trots att den inte används på integrationssidan.

**Förslag:** dela session från miljöregistret, återanvänd katalogen, börja
hämtning av känd vald integration direkt när behörigheten verifierats, och
slå ihop små startuppgifter. Visa redan sparade val direkt med diskret
uppdateringsstatus. Automatisk förhandsvisning ska invänta nödvändiga fält
och vara avbrytbar; servern kontrollerar alltid före sparande/export.

Källor: [IntegrationsWorkspace.tsx](../src/office/IntegrationsWorkspace.tsx),
[SpirisAccountingPanel.tsx](../src/office/SpirisAccountingPanel.tsx).

### 5. Mobildata och prishantering får onödigt mycket arbete

Gårdsbehöriga får full vägning/kund/katalog-data var åttonde sekund även i
Hem, Tid och Schema. På servern räknas kundspecifika priser om för varje
kund × artikel vid läsningar och sparningar av mobilregistret. Volymhistorik
skannas återkommande. Det är snabbt med dagens lilla data i driftprovet,
men skalar dåligt när kund- och vägningshistoriken växer.

**Förslag:** egen katalogrespons med revision, sidstyrd vägningshämtning,
prisuppslag för vald kund/artikel och indexerade volymsammanställningar.
Små kommandon/delrespons i stället för hela före-/efterbilder. Behåll
offlinekön, konflikthantering och bekräftelse först efter lyckad serversparning.

Även timkrav räknar igenom historiken från aktivering vid många skyddade
åtgärder. Dagssammanställningar och index per person/dag behöver införas när
historiken växer; frånvaro, rättelser och nattpass måste fortfarande slå igenom.

### 6. Bilder och gemensamt startpaket är för stora

Alla appfamiljer laddar ett gemensamt paket på **907 kB rå JavaScript**, cirka
253 kB gzip. Integrationsdelen är bara 59 kB rå/17 kB gzip. Sidans egen lilla
modul förklarar alltså inte väntan på den varma kataloghämtningen.

Logotypen är cirka **1 MB**, materialbildsatlasen **3,6 MB**, kopparatlasen
**3,4 MB** och gårdsbilden cirka **2,4 MB**. Uppladdade bilder använder redan
små mobilvarianter och lat laddning, men demobildernas stora PNG:er gör inte det.

**Förslag:** separat startpaket för kontor/mobil/externa portaler, mindre
WebP/AVIF-logotyp och materialminiatyrer, och förladdning av trolig nästa sida
när appen är ledig. Bevara originalbilder och godkänd design.

Webbläsarprovet visade sju uppgifter över 50 ms, totalt 593 ms, under hela
provsekvensen. Ingen CPU-mätning på fysisk mobil har gjorts. Blixtkanten finns
inte på integrationssidan och har redan paus utanför skärmen; den är inte
huvudmisstänkt för integrationsväntan.

### 7. Exportkö, dokument och samtidighet behöver byggas för tillväxt

- Spiris-arbetaren går igenom alla attester var 20:e sekund och läser hela
  källistan igen per kort, även redan köade kort. Köa efter attestens commit
  och återställ inkrementellt med en unik versionsnyckel.
- Exporter körs i följd och upprepar referens-/företagskontroller. Använd
  små, versionsbundna uppslag och begränsad parallellism. Låt webben få en
  beständigt köad status och följ arbetet med progress.
- Dokumentlistans reservväg kan generera saknade PDF:er innan läsningen
  svarar. Lista metadata först, köa saknade filer och rendera separat.
- Lösenordskontroll använder synkron scrypt på flera ställen. Flytta till
  begränsad asynkron bearbetning och kontrollera konto/version igen innan
  sessionssparande. Lösenordsskydd och spärrar ska behållas.
- Databaspoolernas sammanlagda tak är 25 anslutningar per serverprocess.
  Fler instanser multiplicerar detta. Mät kö/anslutningar före ändrat tak.
- Gör heta kort, order, sessionsposter, integrationstester och köjobb till
  indexerade/paginerade poster stegvis. Flera nuvarande JSON-filter matchar
  inte befintliga kolumnindex. Indexförslag ska verifieras med EXPLAIN i testdata.

Källor: [visma-export.mjs](../server/visma-export.mjs),
[documents/model.mjs](../server/documents/model.mjs),
[employee-time.mjs](../server/employee-time.mjs),
[environment-storage.mjs](../server/environment-storage.mjs).

## Kontrollerad lokal verifiering

Varmt enstaka prov med liten, ny testdata och lokal PostgreSQL, utan konstgjord
nätfördröjning. SQL-antal inkluderar BEGIN/COMMIT.

| Flöde | SQL-anrop | Lokal tid |
| --- | ---: | ---: |
| Kontorsdata | 5 | 15 ms |
| Terminalstatus | 5 | 11 ms |
| Miljösession | 4 | 7 ms |
| Miljötillstånd | 5 | 11 ms |
| Personal | 7 | 11 ms |
| Logistik | 10 | 11 ms |
| Personlig mobilöversikt | 6 | 7 ms |
| Mobilens vägningar | 3 | 14 ms |
| Prisregister | 3 | 7 ms |
| Lagerkontroll | 5 | 12 ms |
| Visa kundgranskning på terminal | 14 | 30 ms |

Det här är ingen tidsprognos för Render. Det visar fungerande grundflöden
och vilket frågearbete som finns före datatillväxt och verklig konkurrens.

### Historiktillväxt utan större svar eller fler SQL-anrop

Syntetisk integrationshistorik: 1 kB slumpad testtext per loggrad. Storlekar
i PostgreSQL: 172 byte / 2 159 220 byte / 10 798 686 byte. En uppvärmning och
tre mätningar per storlek. Data skapades utanför den mätta tiden.

| Operation | Nästan tom historik | Cirka 2 MB | Cirka 10 MB |
| --- | ---: | ---: | ---: |
| Avgränsad kontorsläsning | 1,95 ms | 1,94 ms | 2,02 ms |
| Hela integrationsdomänen → 30 byte svar | 1,29 ms | 18,29 ms | 70,83 ms |
| Oförändrad transaktion, alla domäner → 11 byte svar | 4,37 ms | 31,51 ms | 121,12 ms |

Samma antal SQL-anrop och inga skrivningar. Den gemensamma transaktionen blev
cirka 28 gånger långsammare av orelaterad historik. Begränsad kontorsläsning
förblev snabb. Det bekräftar kopplingen i konstruktionen, men kvoten får inte
användas som en garanti för motsvarande effekt i driften.

## Föreslagen genomförandeordning

| Etapp | Innehåll | Förväntad effekt och mätmål |
| --- | --- | --- |
| 1 – Mätning och snabba läsvägar | Server-Timing för centrala API:er; små integrationsstatusar; en gemensam inställningsläsning; rätt cache; färre dubbla behörighetsläsningar | Mål: varma katalog-/inställningsläsningar 0,3–0,5 s och omedelbar visning av redan sparade val. Nu 1,6/3,1 s; detta är ett mål, inte bevisad tidsvinst. |
| 2 – Läsningar och bakgrundstrafik | GET utan skrivlås för Personal/logistik; små menyräknare; sidstyrda data; samordnad SSE/single-flight och lätt reservhämtning | Ta bort cirka 75 % av nuvarande grundtrafik genom att ersätta global femsekundershämtning. Mål: varma listor under 0,5 s, sparflöden utan externa API:er under 0,8 s vid representativ belastning. |
| 3 – Mobil och första besöket | Separata paket, bildvarianter, små sparkommandon, riktade priser och dagssammanställningar | Lägre bandbredd, färre omräkningar och stabilare respons när data växer. Faktisk vinst mäts på fysisk mobil och större testdata. |
| 4 – Växande register och arbetare | Separerad journal/kö, inkrementell attestköning, indexerade/paginerade poster och separat begränsad PDF-/integrationsbearbetning | Minskad historikkoppling och köbildning vid fler användare. Kapacitetstal anges först efter representativt samtidighetsprov. |

För externa Spiris/NVV-operationer behövs separata mätningar av varje HTTP-anrop,
tokenförnyelse och databasarbetet. Tidigare full Spiris-hämtning på 26,1 s är
verifierad, men dess delkostnader är inte uppdelade. Föreslå inte en ny fast
sluttid förrän detta finns. Inställningsvyn ska fungera med sparade val medan
en uttryckligen beställd uppdatering pågår.

## Krav på verifiering före och efter ändring

1. Registrera request-ID, total tid, auth, SQL-antal/tid, pool/låsväntan,
   serialisering, svarsstorlek och externa API-tider utan kundinnehåll/nycklar.
2. Jämför samma datamängd, användarbehörighet, plats och Render-plan.
   Separera kallstart, varm första hämtning och återbesök med cache.
3. Kör 1/5/20 samtidiga lokala användare med större kund-, kort-, order-,
   tid- och integrationshistorik. Mät P50/P95, event-loop, fel, lås och poolkö.
   Kör inte ett tungt belastningstest mot driftmiljön.
4. Behåll omedelbar behörighets-/anläggningskontroll, atomisk commit,
   kundgodkännandets version/hash, lagerkapacitet, samtidighetskonflikter,
   offlineåterhämtning och skydd mot dubbel faktura/rapport/betalning.
5. Kontrollera Render-planer/regioner/intern DATABASE_URL och observerad CPU,
   minne och databas-I/O. Resursökning föreslås utifrån uppmätt behov.

## Mätunderlag

[Drift-API:er, storlekar och tider](performance/2026-10-12/live-api.json) ·
[Webbläsarens anrop och renderingsprov](performance/2026-10-12/browser.json).
Filerna innehåller tider, sökvägar och storlekar, inga cookies, API-nycklar,
råa kunduppgifter eller privata dokument. Lokal reproduktion av grundflöden
finns i [workflow-performance.md](workflow-performance.md).
