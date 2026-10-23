# Individuell lönehantering, version SE-2026-2026-10-23

Den nya lönearbetsytan använder riktiga tabellvärden för skatteavdrag, individuella anställningsunderlag och en gemensam huvudbok. Den är fortfarande en avgränsad demo. Den innebär inte att en komplett löneprodukt eller full arbetsrättslig efterlevnad har verifierats.

## Det som är implementerat

- Separat granskad löneprofil per anställd: födelseår, A-skattsedelns tabell/kolumn, avtalat timvärde för frånvaro, semesterregel, betalda semesterdagar och referens till avtal eller rutin. Nya och uppdaterade profiler har också en dokumenterad förväntan om årsersättningen.
- Faktiska månadsvisa skattetabeller 29–42 för 2026, lönekolumn 1 och 3, för skatteunderlag upp till 80 000 kronor. Underlaget innehåller skattepliktig kontant lön och förmåner. Ören bortses från vid uppslag mot kronintervallet.
- Tabellernas fasta kronbelopp är extraherade ur Skatteverkets PDF:er, SKVFS 2025:20. Varje tabell har käll-URL och SHA-256 för originalfilen. Uppdateringsskriptet kontrollerar år, tabellnummer och att intervallen är sammanhängande.
- Extra ersättning och semesterbelopp klassificeras var för sig som återkommande tidsbestämd lön eller engångsbelopp. Engångstabell 2026, kolumn 1 och 3, används för stödda anställda med regelbunden lön. Användaren måste ange och bekräfta beräknad helårslön inklusive förmåner och engångsbelopp. Programmet gissar inte årsunderlaget. Öretal på det framräknade skatteavdraget faller bort.
- Tidigare engångsbelopp hålls utanför månadstabellens underlag för senare regelbundna kompletteringar. Båda typerna ingår fortfarande i arbetsgivaravgiftens månadsunderlag.
- Dokumenterat individuellt skattebeslut kan användas som alternativ, med användarangivet avdrag och obligatorisk beslutsreferens.
- Arbetsgivaravgifter för vanlig svensk anställning 2026: 31,42 procent, 10,21 procent för födda 1938–1958, noll för födda 1937 eller tidigare. För födda 2003–2007 används 20,81 procent upp till 25 000 kr per kalendermånad från 1 april 2026, därefter 31,42 procent. Kompletterande lön räknar med redan bokfört underlag i samma månad.
- [Årsgränsen 1 000 kr](lon-arsgrans-2026.md) följs kumulativt i det nya löneflödet. Lön och skattepliktiga förmåner räknas med; skattefria utlägg undantas. Vid passage förs tidigare avgiftsfri ersättning till den aktuella periodens avgiftsunderlag och AGI 010/011/012, med bevarade löneoriginal. Separat årsavstämning hanterar berörda avgiftsdifferenser och äldre löner.
- Individuell frånvaro: lönedrag med uttryckligen granskat timvärde, 80 procent sjuklön och karens motsvarande 20 procent av en genomsnittlig veckas sjuklön. Karensen begränsas till sjuklönen och tidigare karens i samma registrerade sjukperiod räknas av. Automatiken omfattar högst sjukperiodens första 14 kalenderdagar. Sjukfrånvaron får inte överstiga kalenderdagarnas fysiska timantal, månadens schema eller separat angivna och bekräftade schematimmar för sjukperioden.
- Sammalöneregel med separat semestertillägg (förvalt 0,43 procent per dag) samt procentregel med granskat semesterlönegrundande underlag (förvalt 12 procent). Antalet dagar kontrolleras mot manuellt granskat saldo. Avvikande avtalade procenttal kan anges och fryses med lönekörningen.
- Separata fält för skattepliktiga förmåner och granskade skattefria utlägg. Förmånen ingår i skatte- och avgiftsunderlaget, men är inte en extra kontant utbetalning. Förmånens underliggande inköpskostnad bokförs separat.
- Utkast → individuell granskning → bokföring → registrerad nettolöneutbetalning → reglering via skattekonto. Bokförda löneunderlag fryses och alla verifikationer bevaras.
- Obetald bokförd lön kan återföras med datum, orsak och länk till originalet. Därefter kan ett nytt granskat underlag skapas. Extra positiv lön kan registreras efter ordinarie körning; månadens samlade skatte- och avgiftsunderlag används.
- Äldre demokörningar bevaras. Endast obokförda äldre utkast kan tas bort uttryckligen. En äldre ordinarie körning hindrar att samma månadslön skapas på nytt.

## Sådant som inte är automatiserat eller färdiggranskat

Lönekolumn och skattetabell hämtas inte från den anställdes verkliga A-skattsedel. Användaren måste kontrollera dem. Månadstabellernas procentintervall över 80 000 kronor, andra år, tvåveckorslön, sjömän och utlandsfall ingår inte i tabellautomatiken. Engångsbelopp utan regelbunden lön, slutreglering efter anställningens upphörande och andra kolumner kräver separat granskning. Ingen skatteberäkning ersätts med en påhittad tabell.

Anställningsavtal, kollektivavtal, arbetsschema, rätt till sjuklön, karensbefrielse, återinsjuknande och semesterlönegrundande frånvaro behöver bedömas. Motorn fastställer inte arbetstagarens rättigheter genom att bara räkna fram ett belopp. Den senare [semesterutbyggnaden](lon-komplettering.md) tillför granskad intjäning, individuella saldon, uttag och slutlig semesterersättning för uttryckliga regler. Samtliga semesterårs-/avtalsvarianter, tjänstepension och försäkringsrapportering är inte täckta.

Arbetsgivaren bekräftar vanlig svensk anställning och granskar förväntad årsersättning. Prognosen används för skatteavdragets undantagsregel; faktisk ackumulerad ersättning styr den nya avgiftskontrollen. Äldre profiler och löneoriginal behåller tidigare regler tills de uppdateras eller årsavstäms. Växa-stöd, forskning, regionala avdrag, utsändning och andra särskilda avgiftsfall ingår inte. [Arbetsgång och rättskällor för årsgränsen](lon-arsgrans-2026.md).

Negativ rättelse efter att pengar betalats ut görs i det separata [bruttolöneåterkravsflödet](lon-komplettering.md). Originalutbetalningen bevaras, en fordran bokförs och faktiska inbetalningar samt eventuell skattekreditering registreras separat. Det ger korrigerat AGI-underlag i ursprungsmånaden utan minskat skatteavdrag. Allmän nettokvittning och direkt rättelse/inlämning hos Skatteverket ingår inte; rättsliga förutsättningar och tidpunkt måste granskas.

Löneområdets CSV är **granskningsunderlag**. Den separata [deklarationsarbetsytan](deklarationer.md) skapar AGI XML för stödda 2026-fall efter granskning. Ingen arbetsgivardeklaration skickas och inga löner eller skatter betalas via bank i denna demo.

## Tekniska kontrollpunkter

`payroll-engine.js` validerar före och efter varje ändring. Personunderlag, regelversion och beräkning sparas tillsammans. Beräkningen räknas om vid bokföring; förändrat underlag stoppar den. Verifikationer, betalningar och skatt kopplas till körningen. Samma ordinarie person/månad kan inte skapas två gånger.

För befintliga data är `payrollProfiles`, `payrollBatches` och `payrollContributionReviews` valfria. De gamla `payrollRuns` ändras inte. `validatePayrollBatches(state)` lämnar kontoeffekter och verifikations-ID:n till den gemensamma valideringen. Profiländringar skriver inte om historiska lönebesked.

## Källor

- [Skatteverket: skattetabeller för arbetsgivare](https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skattetabeller.4.96cca41179bad4b1aa8a46.html), PDF-tabeller för 2026, SKVFS 2025:20. Kontrollerat 2026-10-23.
- [Skatteverket: engångsbelopp](https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skatteavdrag/engangsbelopp.4.361dc8c15312eff6fd3225e.html) och [SKVFS 2025:21, 2 och 4 §§](https://www4.skatteverket.se/rattsligvagledning/467244.html), kolumn 1 och 3 för 2026. Kontrollerat 2026-10-23.
- [Skatteverket: arbetsgivaravgifter](https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/arbetsgivaravgifter.4.233f91f71260075abe8800020817.html), inklusive den daterade ungdomsnedsättningen. Kontrollerat 2026-10-23.
- [Försäkringskassan: sjuklön](https://www.forsakringskassan.se/arbetsgivare/sjukdom-och-skada/sjuklon).
- [Semesterlag (1977:480), 16 a–16 b §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/semesterlag-1977480_sfs-1977-480/).

`scripts/update-payroll-tax-tables.py` återskapar tabellfilen från de officiella källorna. Skriptet kräver Python 3 och `pdftotext`; det körs inte automatiskt av besökarens webbläsare eller vid en löneutbetalning.
