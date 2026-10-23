# Bokföring

Här samlas designförslag för ett **fristående bokföringsprogram med egen webbapp, eget API och en AI-assistent**. Skrotappen är en tänkt ansluten källa; bokföringsprogrammet ska även kunna användas självständigt och ta emot underlag från andra system.

**Nytt: [Tio mockuper för hela ekonomiarbetet i Åkes Hantverk AB](helhet-mockups/README.md)** – företagsstart, offert och faktura, inköp, betalningar, lön, inventarier, moms och bokslut i en sammanhängande designserie. Bilderna visar planerad funktionalitet; de första tio stilförslagen finns kvar nedan.

**Status 2026-10-23:** en utökad ekonomidemo är kodad i `public/bokforing/suite/`. Kund- och leverantörsfakturor har egna sidor för lista, nytt utkast, redigering och visning. Leverantörsflödet har även en lokalt verifierad inkorg för PDF och bilder. Arbetsflödena använder en gemensam verifikationsbok och fiktiva uppgifter för Åkes Hantverk AB. Den tidigare inköpsdemon och båda serierna med bildmockuper bevaras. En GitHub-push måste följas upp mot faktisk deploystatus: Render kan vara inställt på automatisk deploy, men en push bevisar inte att versionen är live.

## Sökbar wiki för användare och granskare

Den klickbara wikimockupen finns efter publicering på **https://app.scrapplanner.com/bokforing/wiki/** och öppnas även via **Wiki & granskning** i appmenyn. Den innehåller 20 artiklar inom sex områden: kom igång, arbetsflöden, kontroller, moms/ROT, granskning och utveckling.

Sök på exempelvis `radera faktura`, `ROT`, `underlag` eller `sparfel`, filtrera på område och dela länken till en enskild artikel. **För revisorn** ger en läsordning från omfattning och kända begränsningar till konkreta flöden, kod och tester. Artiklarna skiljer mellan implementerat i demon, avgränsade funktioner, planerat arbete och guider.

Wikin är en publik läsvy. Den läser inte besökarens bokföring, dokumentdatabas eller företagsuppgifter och ger inga granskningsgodkännanden. Beskrivningarna och testantalen avser uttryckligen demoversion `920a135`; källänkar till kod och dokumentation är låsta till samma version. Det är dokumentation av programmets funktion, inte ett revisionsutlåtande.

Innehållet underhålls i [wiki/content.js](../public/bokforing/wiki/content.js), separat från layout och sökning. Vid nya funktionsändringar ska berörda artiklar, begränsningar, versionsreferens och testbevis uppdateras tillsammans. Det finns ännu inget redaktörsgränssnitt eller gemensamma granskningsanteckningar.

[![Wikins startsida](preview/wiki-start.png)](preview/wiki-start.png)

[Granskningsguiden](preview/wiki-granskning.png) · [Wiki på mobil](preview/wiki-mobil.png)

Wikietappen är lokalt verifierad med produktionsbygge, ett HTTP-integrationstest och sju browserfall: sex för wikin och en befintlig mobilregression för bokföringsappen. Sökning, delbara adresser, filter, källor, statusar och isolering från bokföringsdata ingår.

## Klickbar demo

Efter publicering öppnas den utökade versionen på **https://app.scrapplanner.com/bokforing**. Den tidigare inköpsversionen finns då på `/bokforing/klassisk.html` med sina tidigare sparade exempel. Ingen inloggning, betalning eller extern anslutning behövs för att prova ekonomidemon.

| Område | Vad som går att prova |
| --- | --- |
| Företaget | Bolagsuppgifter, momsperiod, räkenskapsår och insyn i demobolagets ingående balanser. Kalenderår 2026, SEK och faktureringsmetoden används. |
| Projekt och offert | Kunder, projekt, tid/material, offert, registrerat kundgodkännande och fakturautkast från offert. |
| Kundfakturor | Egna fakturasidor, kund-/leveransuppgifter, referenser, villkor, artikelnummer/enhet, rabatter, avgifter och pris inklusive/exklusive moms. Utfärdande med verifikation och fakturanummer, kopia till nytt utkast, utskrift/spara som PDF, delbetalningar, förberedda påminnelser och länkad helkredit av obetald faktura. |
| ROT | Markerade arbetsrader efter rabatt, 2026-beräkning, uppgivet personutrymme, kundbetalning, demobegäran, demobeslut, delvis/helt avslag och separat skatteutbetalning. Material, resor, frakt och fakturaavgift ingår inte i underlaget. [Regler och avgränsning](rot-regler.md). |
| Inköp | Egna leverantörsfakturasidor med underlagsvisare, lokal fil-/kamerainkorg, dokumentkoppling, kontakt-/betalningsreferenser och redigerbara utkast. Vanlig moms, inköp utan moms och bekräftad omvänd byggmoms, med en kostnadsrad per faktura. Bokföring, delbetalning och helkredit av obetalda fakturor. |
| Bank, kassa och skatt | Fiktiva kontohändelser, matchning, betalning mot befintlig händelse, avgifter, kassa-/skatteöverföringar, lån och ränta. |
| Bokföring | Gemensam huvudbok, manuella verifikationer inom stödda konton, balansering, bevarade original och länkade rättelser. Dokumentstyrda konton hanteras i sina egna flöden. |
| Lön | Anställda, månads-/timlön, manuella frånvaro-, semester-, förmåns- och utläggsbelopp, lönebesked, bokföring, simulerad utbetalning och skatte-/avgiftsreglering. AGI exporteras som gransknings-CSV. |
| Inventarier | Omklassificering av ett redan bokfört utrustningsinköp, nyttjandeperiod, månadsavskrivning, utrangering och försäljning. |
| Materiallager | Artiklar, inleveranser, uttag, inventering och periodisk lagervärdering med bokföringsunderlag. |
| Periodisering | Förutbetalda kostnader från redan bokförd kostnad och månatlig kostnadsföring enligt en spårbar plan. |
| Moms och rapporter | Momsunderlag med verifikationskoppling, fastställande av komplett momsperiod, reglering via skattekonto, resultat, balans och CSV-export. |
| Avslut och granskning | Avstämningschecklista, periodlåsning, dokumenterad upplåsning, bokning av årets resultat, ingående balansunderlag för nästa år och granskningspaket i JSON. |

### Fakturering på egna sidor

**Kundfakturor** visar listan. Klick på en faktura öppnar dess egen sida med uppgifter, summering, betalningar och historik. **Ny kundfaktura** öppnar en stor arbetsyta med sektioner för villkor, kund, leverans, fakturarader, ROT och avgifter. En varning skyddar osparade ändringar när du lämnar arbetsytan.

Spara först ett utkast. Från fakturans sida kan du granska och utfärda, registrera betalning, kopiera till nytt utkast eller skriva ut/spara PDF. Utfärdade uppgifter fryses; en rättelse sker genom det kreditflöde som stöds. Kund- och säljaruppgifter på nya fakturor sparas som egna dokumentuppgifter, så senare registerändringar inte ändrar återutskriften. Äldre sparade demofakturor kan fortsatt öppnas utan reset.

Artikelnummer, enhet, referenser och leveransuppgifter är dokumentuppgifter. Rabatter, avgifter och prisets momsgrund påverkar däremot beräkningen, moms, ROT-underlag och verifikation. Kostnadsställe och prislistnamn är märkning i denna version; de ger ingen automatisk dimensionsrapport eller prisuppslagning.

Se [jämförelsen med de visade Fortnox-bilderna](fakturering-jamforelse.md) för skillnaden mellan vad som finns, vad som är avgränsat och vad som återstår. Exempelvis OCR, kontantfaktura, återkommande fakturor, flera valutor, RUT och kundfakturans intäktsperiodisering ingår inte ännu.

### Leverantörsfakturor och inkomna underlag

**Inköp → Inkomna underlag** öppnar en lokal inkorg. Välj **Ladda upp fil**, dra in filer eller använd **Ta foto** på en mobil som stöder kameravalet. PDF, JPEG, PNG och WebP stöds: högst 15 MB per fil, 10 filer åt gången, 100 MB totalt och 20 kopplade underlag per faktura. Identiska filinnehåll känns igen med SHA-256 även om filnamnet är ett annat.

Från ett okopplat underlag kan du välja **Skapa fakturautkast** eller **Koppla till befintlig**. En påminnelse eller komplettering ska kopplas till den befintliga fakturan i stället för att registreras som en ny skuld. Nytt och redigerat utkast öppnas på egen sida, med originalunderlaget bredvid fakturauppgifter och konteringsförslag på större skärmar. Bilder kan zoomas och roteras i visningen; originalfilen ändras inte. PDF visas med webbläsarens PDF-stöd och kan laddas ned.

Fyll uppgifterna manuellt och spara utkastet innan du granskar och bokför. Ingen OCR-/AI-tolkning eller e-postmottagning är ansluten. OCR/betalningsreferens, bankgiro, plusgiro och IBAN är sparade dokumentuppgifter; de validerar inte betalningsmottagaren och utlöser ingen betalning. Kostnadsställe är märkning, inte en färdig redovisningsdimension. Flera kostnadsrader, blandade momssatser, verklig attest och fler kreditfall återstår.

Kopplade originalfiler kontrolleras vid sparande och bokföring. Efter bokföring kan fler underlag läggas till som kompletteringar med historik, utan att ursprungliga uppgifter, bilagor, verifikation eller skuld skrivs om. Utkast kan få underlag bortkopplade; filer som är kopplade till sparade fakturor kan inte tas bort genom inkorgen. En fakturakopia får varken det gamla fakturanumret, originalets underlag eller betalningar.

Filerna ligger separat i IndexedDB-databasen `scrapplanner-bokforing-documents-v1`; fakturadata innehåller dokumentens metadata och kopplingar. **Återställ demo återställer bokföringen och tar bort kopplingarna, men behåller uppladdade filer i inkorgen.** Filerna kan därefter kopplas på nytt eller tas bort som okopplade underlag. Rensad browserdata kan ta bort dem. Detta är ingen serverarkivering eller garanti för långsiktigt bevarande.

Se [leverantörsflödet och förslagen för övriga arbetsytor](leverantorsfakturor-och-arbetsytor.md). Verifikationer, projekt/offerter, lön, bank och bokslut är fortsatt prioriterade för nästa utbyggnad.

Prova uppladdningen med [ett fiktivt fakturaunderlag](exempel/leverantorsfaktura-demo.png). Spara bilden och välj den i **Inkomna underlag**, skapa sedan ett utkast och ange fakturans uppgifter. Bilden är märkt som testunderlag och innebär ingen verklig betalningsbegäran.

[![Leverantörsfaktura med kopplat original](preview/leverantorsfaktura-detalj.png)](preview/leverantorsfaktura-detalj.png)

[Ny leverantörsfaktura](preview/leverantorsfaktura-ny.png) · [Mobilvy](preview/leverantorsfaktura-mobil.png) · [Underlagsinkorg](preview/underlagsinkorg.png)

Skärmbilder från den körbara ekonomidemon:

[![Översikt i den utökade ekonomidemon](preview/ekonomi-overview.png)](preview/ekonomi-overview.png)
[![Ny kundfaktura på egen arbetsyta](preview/faktura-ny.png)](preview/faktura-ny.png)
[![Fakturans egen sida med betalningar och historik](preview/faktura-detalj.png)](preview/faktura-detalj.png)

[Öppna fakturans mobilbild](preview/faktura-mobil.png) eller [ekonomiöversikten på mobil](preview/ekonomi-mobile.png). Den tidigare [ROT-bilden](preview/ekonomi-rot.png) visar gränssnittet före ombyggnaden av fakturasidorna.

### Prova ett sammanhängande ROT-flöde

1. Öppna **Kundfakturor** och välj ROT-utkastet för Maria. Arbete 17 600 kr, material 8 000 kr och resa 800 kr ger 33 000 kr inklusive moms.
2. Granska och utfärda fakturan. Planerat ROT blir 6 600 kr och kundens del 26 400 kr.
3. Registrera kundbetalningen på 26 400 kr. Förbered sedan demobegäran och bekräfta utfört arbete samt elektronisk betalning.
4. Registrera ett demobeslut: 6 600 kr för fullt godkännande eller exempelvis 5 000 kr för delvis avslag.
5. Registrera skatteutbetalningen. Vid ett beslut på 5 000 kr ligger 1 600 kr kvar att få från kunden. Följ samma belopp i huvudboken och rapporterna.

På **Bank & kassa** finns också tre omatchade exempel. Kund- och leverantörsbetalningarnas formulär kan använda en befintlig kontohändelse, så att en andra händelse inte skapas för samma betalning. Bankavgiften bokförs direkt i bankvyn.

### Kontroller och sparande

Modellen kräver balanserade konteringar, giltiga datum och konton samt heltalsbelopp i ören. Den stoppar bland annat dubbla källbokningar, överbetalning, bokning i låsta perioder, samma ROT-utrymme på flera demofakturor och ändring/radering av befintliga verifikationer genom programmets funktioner. Utfärdade fakturor fryses och rättas med kredit. Behandlingshistoriken registrerar modellåtgärder; den är inte en extern revisionslogg.

Sparade uppgifter kontrolleras även mot fakturor, reskontra, betalningar, löner, inventarier, lager, periodisering och moms. Två uppdaterade flikar samordnas med Web Locks och lagringsrevision. En ändring visas som sparad först efter lyckad skrivning och återläsning. Vid konflikt eller sparfel visas en banner; läs in senaste innan du fortsätter. Ogiltiga tidigare data bevaras tills du uttryckligen väljer reset.

Den utökade versionen använder nyckeln `scrapplanner-bokforing-suite-v2`. Den tidigare inköpsdemons nyckel `scrapplanner-bokforing-demo-v1` lämnas orörd. **Återställ demo** kräver bekräftelse och ersätter den nya versionens fiktiva bokföringsdata. Uppladdade filer i den separata dokumentdatabasen behålls, medan kopplingarna till fakturorna återställs. Browserlagring och modellkontroller skyddar inte mot en person som ändrar data direkt i webbläsaren.

### Den här versionens gränser

Detta är en sammanhängande testversion med stödda affärsfall, inte ett färdiggranskat redovisningsprogram för skarp drift. Ande ger kontextbundna, exempelbaserade förklaringar; ingen extern språkmodell eller auktorisation ingår. Skatteavdrag, arbetsgivaravgift, frånvaro och nyttjandeperioder bygger på angivna demoantaganden, utan automatisk skattetabell eller arbetsrättslig beräkning.

ROT stöder en person per faktura och kundbetalningar under 2026, med hela kunddelen betald före begäran. Faktisk rätt till avdrag och personens utrymme verifieras inte. Kredit av en redan betald faktura, återbetalning, vissa rättelser och ytterligare moms-/lönefall kräver fortsatt utveckling. Materiallager registreras separat och värderas som handelsvaror på 1460/4960; pågående arbeten och produktion ingår inte. Projektförbrukning skapar inte automatiskt lageruttag. Periodiseringen avser förutbetald kostnad; upplupna kostnader kan behöva en granskad manuell verifikation.

Granskningspaket, AGI-CSV och balanser för nästa år är arbetsmaterial. De är inte färdiga myndighetsfiler, en årsredovisning eller en inkomstdeklaration. Den lokala filinkorgen ersätter inte serverlagring, användarbehörigheter, e-postmottagning, långsiktig arkivering, säkerhetskopiering, SIE eller externa API-/myndighetsanslutningar. Dessa delar återstår inför en skarp produkt. Ingen full regelefterlevnad eller extern redovisningsgranskning är verifierad genom denna demo.

### Körning och verifiering

Bygg med `npm run build` och starta med `npm start`. [Driftguiden](../docs/drift/README.md#uppdatera-och-kontrollera) beskriver separat publicering på Render. Inga nya miljövariabler, databasändringar eller produktionsanslutningar införs.

Modell- och lagringstester finns i `server/bokforing-suite-*.test.mjs`, `server/bokforing-invoice-model.test.mjs` och `server/bokforing-purchase-model.test.mjs`; browserflöden i `tests/bokforing-suite.spec.ts`, `tests/bokforing-invoice-pages.spec.ts`, `tests/bokforing-purchase-pages.spec.ts` och `tests/bokforing-documents.spec.ts`. Regressionstesterna för den tidigare versionen är kvar. Se även [provgranskningen av den äldre versionen](granskning/2026-10-22.md) och dess [uppföljning](granskning/2026-10-22-uppfoljning.md).

**Lokalt verifierat 2026-10-23:** produktionsbygge, 211 modell-/lagringstester inklusive den tidigare demon, ett HTTP-integrationstest och 49 browserfall mot den byggda servern. Proven täcker egna kund- och leverantörsfakturasidor, PDF/bilder, riktig IndexedDB-lagring, dubbletter, filgränser, kvotfel, ändrade original, bilagekomplettering utan ny skuld, osparade ändringar och sena svar efter navigering/reset. Tidigare betalnings-, kredit-, ROT-, löne-, moms-, lager- och periodiseringsflöden ingår också. Drag och släpp samt visning vid 1600 och 390 pixlar har provats manuellt utan JavaScript-fel eller horisontellt sidöverflöde. Kameraprovet använder filinput med kameraattribut; fysisk kamerahårdvara har inte provats. Detta är teknisk verifiering av demofallen, ingen redovisningscertifiering.

## Tidigare inköpsdemo

Den ursprungliga versionen verifierades på app-domänen 2026-10-22. Efter publicering av den nya ekonomidemon ligger den tidigare versionen på **https://app.scrapplanner.com/bokforing/klassisk.html**.

- Översikt med beräknade nyckeltal och senaste verifikationer.
- Underlagsinkorg och fakturavy med redigerbara konteringsrader.
- Demobokföring som kontrollerar belopp, moms, balans och underlagsversion samt stoppar dubbel bokföring.
- Huvudbok, bankmatchning, momsunderlag och rapporter som följer demobokens poster.
- En svävande demoassistent med kontextfrågor och exempelbaserade svar.
- Sparat demoläge i den egna webbläsaren och möjlighet att återställa exemplen.

Rättningarna begränsar inköpseditorns kontoval till det stödjade inköpsfallet och kontrollerar kostnadsnetto, skuld och tillåtna momsrader även i bokföringsfunktionen. En vanlig inköpsfaktura kan exempelvis inte få extra omvända momsrader eller bokas som en ökning av bankkontot. Ande ligger i reserverad plats i sidhuvudet.

Sparandet samordnas mellan uppdaterade demoflikar med Web Locks och kontroll av aktuell lagringsrevision. En gammal flik får inte skriva över nyare demodata. En bokning visas som genomförd först efter lyckad skrivning och återläsning. Vid konflikt, sparfel eller osäker kvittens pausas skrivningen med en synlig banner och **Läs in senaste demodata**. Den åtgärden återställer osparade ändringar i editorn. Ogiltiga äldre demodata bevaras tills användaren uttryckligen väljer reset.

Stäng och öppna äldre demoflikar efter publicering av rättningarna. Samordningen skyddar flikar som använder den uppdaterade koden; tidigare öppna versioner och direkt ändring av localStorage omfattas inte. Om webbläsaren saknar stöd för Web Locks visas demon i läsläge. Det är fortfarande browserlokal demodata, inte ett serverarkiv eller ett skydd mot manipulation.

Demon kräver ingen inloggning. Den använder en egen lagringsnyckel i webbläsaren och gör inga anrop till appens produktions-API:er, betalningstjänster eller externa AI-leverantörer. AI-svaren i denna version är exempelbaserade. Underlag och rapporter avser enbart Exempelbolaget AB.

Appservern mappar exakt `/bokforing` och `/bokforing/` till den fristående demosidan. Övrig autentisering och åtkomst till bolag ändras inte. Källkoden finns i [public/bokforing](../public/bokforing/).

Skärmbilder från den körbara demon:

[![Översikt i den klickbara demon](preview/oversikt.png)](preview/oversikt.png)
[![Underlag och kontering i den klickbara demon](preview/kontering.png)](preview/kontering.png)

Bygg med `npm run build` och starta med `npm start`. Appens vanliga driftinställningar gäller. Följ [driftguidens kontroll av Render-deploy](../docs/drift/README.md#uppdatera-och-kontrollera); faktisk version och deploystatus ska kontrolleras efter en GitHub-push oavsett om tjänsten använder automatisk eller manuell deploy.

Verifierat lokalt efter rättningarna: produktionsbygge, 48 modelltester, 23 lagringstester, sex pilotpolicytester och ett HTTP-integrationstest. Tio browserregressioner täcker bland annat två flikar, sparfel, osäker kvittens, reset och pekarklick på femradig kontering på dator/mobil. Se [uppföljningen med rättningar och avgränsning](granskning/2026-10-22-uppfoljning.md).

## Provgranskning av liveversionen

[Provrapport 2026-10-22](granskning/2026-10-22.md) beskriver 15 genomförda scenarier mot den ursprungliga liveversionen, inklusive medvetna fel, reset och mobilbokföring. Den bevaras som historiskt underlag för rättningarna ovan. Rapporten innehåller reproduktionssteg och en beskrivning för extern granskning. Ett godtyckligt sakligt fel mellan tillåtna kostnadsslag kan fortfarande kräva mänsklig bedömning; rättningarna är inte ett godkännande av full regelefterlevnad.

## Bildmockuper

Bildernas belopp, konton, förklaringar och statusar är fiktiva illustrationer och ska inte användas som redovisningsregler.

## Bildöversikt

Klicka på en bild för att öppna PNG-originalet. Numren 01–10 används när vi väljer och kombinerar favoriter.

| Förslag | Förslag |
| --- | --- |
| **01 · Nordisk översikt**<br>[![Nordisk översikt](mockups/01-nordisk-oversikt.png)](mockups/01-nordisk-oversikt.png)<br>Klassisk ljus översikt med nyckeltal, kassaflöde och senaste verifikationer. | **02 · Grön avstämning**<br>[![Grön avstämning](mockups/02-gron-avstamning.png)](mockups/02-gron-avstamning.png)<br>Luftig bankavstämning med bankhändelser och bokföringsposter sida vid sida. |
| **03 · Mörk ekonomicockpit**<br>[![Mörk ekonomicockpit](mockups/03-mork-ekonomicockpit.png)](mockups/03-mork-ekonomicockpit.png)<br>Mörk ekonomivy med resultat, prognos, periodstatus och avvikelser. | **04 · Underlag och kontering**<br>[![Underlag och kontering](mockups/04-underlag-och-kontering.png)](mockups/04-underlag-och-kontering.png)<br>Fakturaunderlag och konteringsförslag sida vid sida med AI-förklaring. |
| **05 · Lugn arbetsdag**<br>[![Lugn arbetsdag](mockups/05-lugn-arbetsdag.png)](mockups/05-lugn-arbetsdag.png)<br>Varm och uppgiftsstyrd startsida med tydligt nästa steg. | **06 · Huvudbok för proffs**<br>[![Huvudbok för proffs](mockups/06-huvudbok-for-proffs.png)](mockups/06-huvudbok-for-proffs.png)<br>Tät huvudbok med filter, debet/kredit, dokumentlänkar och AI-hjälp. |
| **07 · Samtal med AI-anden**<br>[![Samtal med AI-anden](mockups/07-samtal-med-ai-anden.png)](mockups/07-samtal-med-ai-anden.png)<br>Samtalsvy för frågor, källstödda förklaringar och förslag att granska. | **08 · Periodavslut steg för steg**<br>[![Periodavslut steg för steg](mockups/08-periodavslut-steg-for-steg.png)](mockups/08-periodavslut-steg-for-steg.png)<br>Guidad checklista för underlag, bank, reskontra, moms och periodavslut. |
| **09 · Förberett för granskning**<br>[![Förberett för granskning](mockups/09-forberett-for-granskning.png)](mockups/09-forberett-for-granskning.png)<br>Granskningsvy med rapporter, öppna frågor, avstämningar och dokument. | **10 · Bokföring på språng**<br>[![Bokföring på språng](mockups/10-bokforing-pa-sprang.png)](mockups/10-bokforing-pa-sprang.png)<br>Mobil granskning och godkännande tillsammans med en datorvy. |

## Alla bilder

| Nr | Bild | Inriktning |
| --- | --- | --- |
| 01 | [Nordisk översikt](mockups/01-nordisk-oversikt.png) | Klassisk ljus översikt med nyckeltal, kassaflöde och senaste verifikationer. |
| 02 | [Grön avstämning](mockups/02-gron-avstamning.png) | Luftig bankavstämning med bankhändelser och bokföringsposter sida vid sida. |
| 03 | [Mörk ekonomicockpit](mockups/03-mork-ekonomicockpit.png) | Mörk ekonomivy med resultat, prognos, periodstatus och avvikelser. |
| 04 | [Underlag och kontering](mockups/04-underlag-och-kontering.png) | Fakturaunderlag och konteringsförslag sida vid sida med AI-förklaring. |
| 05 | [Lugn arbetsdag](mockups/05-lugn-arbetsdag.png) | Varm och uppgiftsstyrd startsida med tydligt nästa steg. |
| 06 | [Huvudbok för proffs](mockups/06-huvudbok-for-proffs.png) | Tät huvudbok med filter, debet/kredit, dokumentlänkar och AI-hjälp. |
| 07 | [Samtal med AI-anden](mockups/07-samtal-med-ai-anden.png) | Samtalsvy för frågor, källstödda förklaringar och förslag att granska. |
| 08 | [Periodavslut steg för steg](mockups/08-periodavslut-steg-for-steg.png) | Guidad checklista för underlag, bank, reskontra, moms och periodavslut. |
| 09 | [Förberett för granskning](mockups/09-forberett-for-granskning.png) | Granskningsvy med rapporter, öppna frågor, avstämningar och dokument. |
| 10 | [Bokföring på språng](mockups/10-bokforing-pa-sprang.png) | Mobil granskning och godkännande tillsammans med en datorvy. |

## Fortsatt utveckling

Den klickbara demon kombinerar den ljusa översikten, vyn för underlag och kontering samt den svävande AI-assistenten. Prova arbetsflödena före nästa designbeslut. Ett skarpt fristående system kräver bland annat eget server-API, behörigheter, beständig och spårbar bokföring, periodlåsning, säker dokumentarkivering och redovisningsgranskning. Dessa delar ingår inte i webbläsardemon.

Bilderna ligger i [mockups/](mockups/). Övriga projektmockuper finns i [den gemensamma översikten](../docs/mockups/README.md).
