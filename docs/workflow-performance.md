# Terminal- och mottagningsprestanda – 0.13.0

## Vad som ändras

Tidigare bestod terminalvisningen av prisuppslag, prissnapshot, utskick och
återläsning av terminaltillstånd. Nu gör `POST /api/application/customer-review`
detta som en enda operation. Servern läser det sparade kortet, kontrollerar
rättigheter och aktuell version, beräknar priser med befintliga regler, reserverar
terminalen och sparar granskningen. PostgreSQL får en gemensam commit över
applikations- och terminalregistret. En misslyckad reservation återställer båda.

Kontoret använder den bekräftade kortprojektionen och godkännandesessionen
direkt. Väntande redigeringar sparas före kommandot. Ändringar som görs medan
svaret är på väg bevaras; konkurrerande ändringar blir en uttrycklig konflikt.
Ett omskick med oförändrade priser kan återanvända den frysta prisversionen.

Kontors-, terminal- och miljöläsningar använder riktade, konsekventa
lästransaktioner utan skrivlås. Miljön läser rätt källa och beräknat lager
i stället för samtliga historiska original. Vid mottagningsbekräftelse sker
lagerkontroll efter förvärvat lås, och svaret innehåller den sparade ändringen.
Mottagningen kan därför visas direkt utan en blockerande full återläsning.

SSE notifierar efter commit. PostgreSQL LISTEN/NOTIFY förmedlar ändringar
även mellan serverinstanser. Notifieringar innehåller endast domän/revision;
datahämtning kontrollerar användare och anläggningsrättigheter. Vid
återanslutning hämtas aktuellt tillstånd. Kundgodkännandet har reservhämtning
var 30:e sekund när realtiden inte är frisk. Miljövyn har även en periodisk
säkerhetshämtning var 30:e sekund. Gemensam kontorsdata stäms av var 30:e
sekund med fungerande realtid och var åttonde sekund vid avbrott.
Övriga modulers befintliga uppdateringsflöden påverkas inte av denna release.

Terminalnärvaro är separat från ärendeskrivningar. Visningskvittensen gäller
exakt renderat ärende-ID, version och hash. Ett gammalt renderingskvitto kan
inte markera en ny version som visad. Sessions- och behörighetskontroller
görs även inne i det samlade kommandot.

## Beständiga PDF-jobb

Migration `terminal-demo-002.sql` lägger till jobb för preliminära,
kundgodkända och slutliga PDF-milstolpar. Jobbet köläggs i samma transaktion
som milstolpen, med oföränderlig avräkningsversion och anläggningssnapshot.
Genereringen ligger efter commit och blockerar inte knapptrycket.
Låsning, tidsbegränsad arbetsreservation och återförsök gör att en omstart
inte tappar dokumentet. Unikt dokumentoriginal förhindrar dubbelarkivering.
Historiska milstolpar kvarstår när kunden senare avbryter eller underlaget rättas.

Jobben skickar inte NVV-rapporter, meddelanden eller betalningar. Ett
kundgodkänt dokument är fortsatt skilt från internt attesterat underlag.
PDF-visning kan ligga något efter den direkt bekräftade statusen.

## Uppmätt jämförelse

Jämförelsen använder föregående main `dbfaf61` och den nya koden mot samma
lokala PostgreSQL 18, med nya separata scheman och samma testdata. För att
synliggöra kostnaden för många rundor läggs **20 ms konstgjord fördröjning per
SQL-anrop** till. Detta är inte ett uppmätt värde för Render. SQL-antalet
inkluderar BEGIN/COMMIT. Varje rad avser ett varmt prov, inte en P95-mätning.

| Operation | SQL före → efter | Tid före → efter |
| --- | ---: | ---: |
| Kontorsdata | 43 → 5 | 945 → 115 ms |
| Terminalstatus | 41 → 5 | 883 → 112 ms |
| Miljösession | 62 → 4 | 1 321 → 91 ms |
| Miljötillstånd | 91 → 5 | 1 927 → 113 ms |
| Lagerkontroll | 120 → 5 | 2 536 → 115 ms |
| Visa kundgranskning, hela serverkedjan | 95 → 15 | 2 038 → 369 ms |

Terminalkedjan går från fyra HTTP-anrop till ett, med cirka 84 % färre
SQL-anrop och 82 % kortare tid i detta prov. De 80 borttagna SQL-rundorna
motsvarar ensamma 1 600 ms vid provets 20 ms fördröjning. Därutöver försvinner
tre HTTP-rundor till webbläsaren. Exempelvis skulle 80 ms HTTP-rundtid ge
ytterligare 240 ms för den tidigare kedjan. Det senare är en beräkning,
inte en extra mätning eller en garanti om Render.

I de riktade webbläsarproven utan konstgjord fördröjning gav åtta samlade
kommandon median **42,8 ms på servern** och **49,2 ms till webbläsarsvaret**
(server 25,4–82,1 ms, webbläsare 33,8–92,0 ms). Alla hade 15 SQL-anrop.
Detta mäter lokal respons; tid till terminalens faktiska visning mäts separat
genom renderingskvittensen.

Före denna release mättes läsningar på den dåvarande Render-tjänsten:
kontorsdata cirka 2,21 s, terminalstatus 2,70 s, miljötillstånd 5,01 s och
lagerkontroll 5,33 s. Den nya tjänsten och användarens planuppgradering
behöver mätas på plats innan en verklig tidsvinst på Render kan anges.

## Reproducera säkert lokalt

`JEROC_TEST_DATABASE_URL` ska peka på en **separat lokal testdatabas**, aldrig
den gemensamma Render-databasen. Skriptet skapar och tar bort ett eget schema
men gör även terminal- och kortskrivningar inom detta schema. Inga externa
NVV-/meddelande-/betalningsanrop används.

```sh
npm ci
npm run build
# Sätt JEROC_TEST_DATABASE_URL till den lokala testdatabasen.
node scripts/measure-workflow-performance.mjs . 20
```

Andra argumentet är konstgjord SQL-fördröjning i millisekunder; använd `0`
för vanliga lokala tider. För baslinjen kan föregående commit packas upp i
en separat katalog med dess byggda `dist-server` och installerade beroenden.
Kör det nya skriptet med katalogen som första argument. Varje körning får
sitt eget schema. Utskriften visar antal/tider/storlek, inte kunddata eller
databasens anslutningsuppgift.

Riktade kontroller omfattar verklig PostgreSQL-rollback mellan register,
samtidig terminalreservation och lagerkontroll, idempotens, återanslutning,
föråldrade versioner, kundgodkännande/attest, rollbyte, sparade redigeringar,
PDF-arkivering och arbetsreservation efter omstart. 13 olika berörda
webbläsarfall har passerat, tillsammans med serverkontroller och
produktionsbygget. Tester använder separata databaser utan externa anrop.

## På Render

Befintlig `DATABASE_URL` används; migrationerna körs automatiskt före
serverstart. Ingen manuell rensning eller ny miljövariabel behövs.
Efter publicering ska kontoret laddas om för uppdaterad sessionscookie.
Terminalens befintliga inloggning återanvänds.

En betald webbtjänst undviker gratisplanens vila och ger andra resursramar.
Kontrollera också att webbtjänst och PostgreSQL ligger i samma region och
att `DATABASE_URL` använder databasens interna adress. Testa med en redan
uppvaknad tjänst när vanliga knapptryck jämförs; redovisa kallstart separat.

Det samlade svaret innehåller `Server-Timing`: total kommandotid, poolväntan,
SQL-tid, tid i låsfrågor, commit och antal frågor. Tiden i låsfrågor inkluderar
själva SQL-rundtiden och är inte ren låsväntan. Fälten innehåller inga SQL-
parametrar. Webbläsarens nätverksvy kan därmed skilja serverarbete från nätet.
Gör nya riktiga mottagningar först som ett vanligt, avsiktligt användarprov;
prestandaverifiering ska inte skapa extra rapporter eller betalningar.
