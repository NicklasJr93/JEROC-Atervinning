# Deklarationer och årsredovisning

Version `SE-2026-10-23.1`. Funktionsläge: verkliga lokalt genererade filer, manuell granskning och manuell inlämning. Inga API-anrop till Skatteverket/Bolagsverket görs, inga deklarationer undertecknas och en nedladdning är ingen inlämningskvittens. Underlagen lagras i demons webbläsare och är inte ett produktionsarkiv.

## Användarflöde

Öppna **Deklarationer** (`#declarations`). Välj typ, ange verklig identitet själv, granska beloppen och bekräfta kontrollerna. Spara en granskningsversion och hämta dess fil i listan längst ned. Demoidentiteten `DEMO` accepteras inte för deklaration. Använd inte fiktiv bokföring i en verklig myndighetsinlämning.

Varje version sparar indata, källunderlag, skapandetid och formatversion. Sparade versioner skrivs inte över i gränssnittet. Om relevant bokföring ändrats stoppas nedladdningen tills en ny version har skapats och granskats. Detta är en lokal integritetskontroll, ingen serverbaserad behörighets- eller arkiveringsgaranti.

## AGI: XML, 2026

- XML följer Skatteverkets instans-/komponentnamnrymder 1.1, med HU och IU samt stöd för föräldrafrånvaro/FU. Den versionerade tekniska beskrivningen är **1.1.18.2**.
- Beloppen hämtas från **utbetalda** lönekörningar, både modern lön och äldre stödd lön. Bokförd men ännu inte utbetald lön deklareras inte av detta flöde. Granskat bruttolöneåterkrav räknas i ursprunglig redovisningsmånad; skatteavdraget sänks inte av arbetsgivarens återkrav.
- Vanlig svensk kontant bruttolön rapporteras i 011, vanlig skattepliktig övrig förmån i 012 och avdragen preliminär skatt i 001. HU innehåller 487 och 497. Beloppen rapporteras i hela kronor, och HU:s skatteavdrag summerar de faktiskt exporterade personbeloppen.
- [Årsgränsen för arbetsgivaravgift](lon-arsgrans-2026.md) tillför 131/132 för avgiftsfri ersättning och 010 för tidigare perioders avgiftsfria belopp som tas upp när gränsen passeras. Noll avgift på grund av ålder är ett annat fall och innebär inte automatiskt 131/132. Årsavstämningen bevarar löneoriginal och uppdaterar deklarationsunderlaget; förändrat underlag kräver en ny granskad deklarationsversion.
- Användaren anger person-/samordningsnummer med tolv siffror. Datum och kontrollsiffra kontrolleras, och födelseåret måste matcha den moderna löneprofilens åldersgrundande uppgift. Det verifierar inte personens identitet hos Skatteverket.
- Specifikationsnummer och personnummer låses mot tidigare sparad AGI för samma anställd/månad. Detta hindrar att en vanlig rättelse av misstag blir ytterligare en individuppgift. Identitetsbyte/borttagning kräver separat myndighetsflöde och stöds inte här.
- Föräldrapenning/VAB kan anges per person och dag i den valda redovisningsmånaden, med timmar. API-modellen stöder även procent. Gränssnittet kräver granskning även när frånvarolistan är tom. Retroaktiv frånvaro, borttagning och specialrättelser hanteras separat.
- Nolldeklaration kan skapas för månad utan utbetald lön, efter granskning av arbetsgivarens redovisningsskyldighet.

**Avgränsning:** endast 2026, vanlig svensk lön och den avgiftsberäkning som löneunderlaget faktiskt stöder. Inte SINK, pensioner, utlandsanställningar, bilförmånsfält, individuella internationella avgiftsavtal eller fullständig hantering av alla AGI-fält. Arbetsgivaravgiften kan uttryckligen justeras som ett granskat belopp i hela kronor. Juridisk rätt och tidpunkt för bruttolöneåterkrav kräver individuell granskning; tekniskt XML-godkännande är inte en sådan bedömning.

## Moms: riktig XML enligt eSKDUpload 6.0

- Organisationsnummer (10 siffror med bindestreck), period, officiella svenska taggnamn och deras ordning följer Skatteverkets dokumentation.
- Filen deklarerar ISO-8859-1; icke-ASCII-tecken i upplysning kodas som numeriska XML-entiteter. Filens byte fungerar därför med deklarerad kodning.
- Perioden måste matcha bolagets registrerade månad, kvartal eller helår. Godtyckliga datumintervall godtas inte. Den nuvarande exporten förutsätter hela kalendermånader; förkortade perioder med annan start/slutdag behöver separat hantering.
- Beloppen kommer från den avstämda momsrapporten. Oklassificerade, ej stödda eller oavstämda poster stoppar export. Negativ moms att återfå stöds.
- Varje ruta trunkeras till hela kronor. Ruta 49 räknas **efteråt** från de exporterade utgående momsbeloppen minus ruta 48, så att separata öresbortfall inte skapar en obalanserad deklaration.

Det finns ingen påhittad XML-standard. Verifieringen följer det offentliga eSKDUpload-exemplet och tagg-/balansreglerna; någon publicerad separat moms-XSD har inte lagts till.

## INK2: INFO.SRU + BLANKETTER.SRU

- Stöd: **aktiebolag**, beskattningsperiod **2026P4**, det vill säga räkenskapsår som slutar 1 september–31 december 2026.
- En ZIP innehåller riktiga `INFO.SRU` och `BLANKETTER.SRU`, med CRLF, ISO-8859-1 och blanketterna `INK2-2026P4`, `INK2R-2026P4`, `INK2S-2026P4`. Vid inlämning packar användaren upp och väljer de två SRU-filerna enligt myndighetstjänstens instruktion.
- Den officiella fältkatalogen finns i `declarations-sru-fields.js`, genererad från Skatteverkets XLS-filer, inte antagna BAS/SRU-koder. Gränssnittet visar alla fält i dessa tre blanketter.
- Bokföringen ger ett kontomappat grundförslag. Användaren måste granska **samtliga** rutor, hela-kronor-avrundning, ej avdragsgilla kostnader, underskott, skatt och eventuella särskilda bilagor. Skattemässiga justeringar fylls i manuellt; programmet gissar inte avdragsrätt.
- Kontroller omfattar fältnummer, datatyper/tecken, tillåtet beskattningsår, motstridiga fält, balans i INK2R, summering av resultaträkning, summering av skattemässiga justeringar samt överföringen av resultat mellan blanketterna.
- Kreditsaldon räknas per originalfaktura med dess verifikationer, betalningar, krediter, ROT-återbetalningar och uttryckliga kvittningar, samt per valutadokument och dess händelser fram till balansdagen. Exempel: en kundfordran 1 000 kr och en annan kunds tillgodo 300 kr visas som fordran 1 000 kr och kundförskott 300 kr, inte netto 700 kr. Samma beräkning används för leverantörer, SRU och årsredovisning. Konto 2490 föreslås som övrig skuld 7369. Journalposter på 1510/2440 utan dokumentkoppling (t.ex. enbart importerad huvudbok) stoppar export: de behöver kompletteras med avstämd reskontra, eftersom ett kontosaldo inte visar om olika motparter har blandade kredit- och debetsaldon. Kontantmetodens egna huvudboksposter undantas då dess återbetalningsfordringar/skulder förs separat på 1680/2490.
- Ändrat bokföringsunderlag kräver en ny granskad exportversion.

**Avgränsning:** endast de tre angivna blanketterna. Specialbilagor som N8/N9, andra företagsformer, andra beskattningsperioder och koncernbidragsspärrade underskott (7672) stöds inte av detta flöde. XML/SRU-format innebär inte att en skattebedömning eller mottagarkontroll hos Skatteverket har genomförts.

## Årsredovisning: utskrivbart K2-dokument

HTML-filen kan öppnas och skrivas ut/sparas som PDF. Den innehåller förvaltningsberättelse, väsentliga händelser, flerårsöversikt (upp till fyra lagrade år), soliditet, förändringar i eget kapital, resultatdisposition, kostnadsslagsindelad resultat- och balansräkning med delsummeringar, noter och underskriftsrader.

Året måste vara avslutat med befintliga bokslutskontroller. Öppna eller omappade poster stoppar. Jämförelseår hämtas från registrerade räkenskapsår; utan historik krävs uttrycklig bekräftelse att det verkligen är bolagets första år. Över 30 procents omsättningsförändring mot jämförelseåret kräver kommentar. Kredit- och debetsaldon räknas per dokument vid den historiska balansdagen och särredovisas i presentationen, utan att ändra huvudboken. Samma regel gäller native- och valutafakturor; 1510/2440 utan dokumentkoppling stoppar dokumentet. Oväntade negativa anläggningstillgångar/lager/bank och vissa skuldposter stoppas för klassificering.

Följande måste anges och granskas: verksamhet/risker/fortsatt drift, årets och efterföljande väsentliga händelser, förändringar i eget kapital, redovisningsprinciper, anläggningstillgångarnas förändringar/avskrivningar, personal, säkerheter/eventualförpliktelser, långfristiga skulder, närståendeförhållanden och skatt. Det räcker inte att endast ange generella standardtexter om bolagets förhållanden kräver mer. Resultatdispositionen måste stämma med fritt eget kapital. Ort, datum och samtliga styrelseledamöter/VD krävs. Negativa fria medel kräver ingen fiktiv utdelning.

**Avgränsning:** mindre privat aktiebolag, vanlig K2-verksamhet utan koncern, obeskattade reserver/specialposter utanför kontomappningen eller särskilda instrument. K2-versionen för år som börjar efter 31 december 2025 har nya begränsningar (bl.a. utländsk filial, aktierelaterad ersättning, sammansatta instrument, kryptotillgångar och vissa företag med fastigheter eller väsentliga uppskjutna skatteförhållanden). Användaren måste bekräfta att tillämpningsområdet är uppfyllt, även undantagen i 1.1B–C. Saknade tidigare år måste importeras; systemet skapar aldrig jämförelsesiffror.

Dokumentet är ett granskningsbart utskriftsoriginal för den angivna avgränsningen. **Digital inlämning till Bolagsverket, digital underskrift, fastställelseintyg och revisionsberättelse genereras inte.** De senare handlingarna behöver upprättas/undertecknas separat där de krävs. Detta är därför inte ett komplett digitalt Bolagsverksflöde eller generellt stöd för varje K2-/K3-företag.

## Officiella källor och fastställda versioner

Hämtade och granskade 2026-10-23:

- [AGI teknisk beskrivning 1.1.18.2](https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/tekniskbeskrivningochtesttjanst/tekniskbeskrivning11182.4.7eada0316ed67d7282a791.html)
- [AGI huvudschema 1.1](https://xmls.skatteverket.se/se/skatteverket/da/arbetsgivardeklaration/arbetsgivardeklaration_1.1.xsd), SHA-256 `821f4a5b896cb13bda1bb700f5ca3302f2a30b6e7446c5c96c9790c0690e4b4b`.
- [AGI komponentschema 1.1](https://xmls.skatteverket.se/se/skatteverket/da/arbetsgivardeklaration/arbetsgivardeklaration_component_1.1.xsd), SHA-256 `ed8926751d7691f34a1294e7fd623fbcb9f1ef2f831b414a3006910aead9b0cd`.
- [Officiella AGI XML-exempel](https://www.skatteverket.se/download/18.1522bf3f19aea8075ba810/1765448451193/Exempelfiler_XML.zip), bland annat fil 18 med HU/IU/FU.
- [SRU teknisk information](https://www.skatteverket.se/foretag/inkomstdeklaration/forredovisningsbyraer/tekniskinformationomfiloverforing.4.13948c0e18e810bfa0cca8.html).
- [SRU 2026P4:s officiella paket](https://www.skatteverket.se/download/18.5fb2fa71a0b0adb74a18b3/1791362773267/_Nyheter_from_beskattningsperiod_2026P4.zip), SHA-256 `6fb927bf49196a17e838e802f233a753c51a2e7840cbecfc66dc4ddc46332efe`. Kataloger: `INK2_SKV2002-34-01-26-04.xls`, `INK2R_SKV2002-34-01-26-04.xls`, `INK2S_SKV2002-34-01-26-04.xls`; typregler `Vardeforrad_2027.xls`; format från `Medieleverantorsinfo_2026.xlsx` och `Filexempel.xlsx`.
- [Moms XML/eSKDUpload 6.0, officiell formatbeskrivning](https://www.skatteverket.se/foretag/moms/deklareramoms/lamnamomsdeklarationviafilietjansten.4.2fb39afe18dabf1e4d223cc.html).
- [BFN:s K2-vägledning, konsoliderad 2025, giltig för år påbörjade efter 2025-12-31](https://www.bfn.se/wp-content/uploads/vl16-10-k2ar-kons2025.pdf), särskilt 1.1–1.1C, 3.4, kapitel 4, 5.5 samt notreglerna i kapitel 18.

AGI:s original-XSD lagras under `server/fixtures/bokforing-declarations/`. Fältkatalogens numeriska koder hämtas från ovanstående officiella SRU-specifikation. Regelversioner behöver uppdateras uttryckligen inför nya år; programmet stoppar okända år i stället för att återanvända gamla deklarationsformat tyst.

## Verifiering

`server/bokforing-declarations.test.mjs` kontrollerar XSD-filerna mot SHA-256 och **validerar genererad XML med lxml mot de officiella schemana**, öppnar ZIP-filer med Python zipfile och verifierar ISO-8859-1, fältkoder, år, balanser, summor, felaktig identitet, manipulerade versioner och ändrat källunderlag. `server/bokforing-declaration-payroll-integration.test.mjs` provar utbetald lön och bruttolöneåterkrav hela vägen till XSD-validerad AGI. `server/bokforing-payroll-threshold.test.mjs` provar även gränspassage, 010/131/132, förmåner och återkrav som ändrar årsunderlaget. Python 3 med lxml behövs för dessa schematester; saknad validator får testet att misslyckas, inte hoppa över kontrollen.

Webbläsarproven i `tests/bokforing-declarations.spec.ts` provar användarens arbetsyta, obligatorisk granskning och faktiska nedladdningar. Testresultat är teknisk verifiering av angivna fall, inte myndighetsgodkännande eller en auktoriserad redovisningsgranskning.
