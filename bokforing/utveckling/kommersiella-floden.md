# Artiklar, återkommande fakturor, projektmaterial och intäkter

Den här etappen utökar den lokala ekonomidemon. Det är programfunktioner för provning; verklig e-post, betalningar och myndighetsinlämning ingår inte.

## Genomförda flöden

- **Artikelregister:** artikelnummer, benämning, typ, enhet, pris exklusive moms, momssats, aktiv status och versionsnummer. Artiklar inaktiveras i stället för att raderas. Kundspecifika priser används före artikelns standardpris.
- **Artikel till faktura:** valda artiklar, mängder och kundpriser kopieras till ett vanligt fakturautkast. Originalpriset och artikelversionen sparas som ursprung. Artikeländringar skriver inte om fakturan. Utkastet kan sedan granskas och redigeras i den ordinarie fakturavyn.
- **Återkommande fakturor:** månad, kvartal, halvår eller år med frysta avtalsrader och priser. Körningen skapar fakturautkast till valt brytdatum. Samma avtalsperiod skapas högst en gång. Dag 31 återkommer efter februari där nästa månad har 31 dagar. Planer kan pausas och återaktiveras. En ändrad överenskommelse registreras som en ny plan.
- **Påminnelseunderlag:** endast utfärdade fakturor med kvarvarande fordran och passerad förfallodag kan få påminnelse. Belopp, datum och text bevaras. Gränssnittet påstår inte att ett utskick har skett. Påminnelseavgift och dröjsmålsränta bokförs inte i detta steg.
- **Projektmaterial från lager:** ett lageruttag skapar en länkad materialrad på projektet i samma användaråtgärd. Negativa lager och datumkonflikter stoppas av lagermodellen. Anskaffningskostnad och försäljningspris hålls isär. Den befintliga periodiska lagervärderingen sköter bokförd lagerförändring; uttaget bokar inte samma kostnad en gång till.
- **Intäktsperiodisering:** nettointäkt från en utfärdad kundfaktura kan omföras från dess försäljningskonto till 2990 och fördelas i ordning över 1–120 månader. En ny plan måste skapas inom fakturans räkenskapsår; en befintlig plan kan därefter fortsätta över årsskiftet. Moms och kundfordran påverkas inte av periodiseringen. Avrundningen gör att alla månader tillsammans ger exakt ursprungsbelopp. Samma intäkt kan inte fördelas två gånger. ROT-fakturor och krediterade fakturor spärras. En faktura som har en sådan plan får inte krediteras förrän en särskild återföring av planen har implementerats. Årsavslut och periodlås kontrollerar att planerade intäktsmånader i perioden har bokförts.
- **Pågående arbeten:** ett daterat, fryst bedömningsunderlag kan sparas med nedlagd kostnad, avtalad intäkt, färdigställandegrad, ansvarig och redovisningsbedömning. Underlaget bokför ingen automatisk värdering. Regler för uppdrag till fast pris/löpande räkning och valt redovisningsregelverk kräver fortsatt separat implementering och granskning.

## Avgränsningar

SEK och faktureringsmetoden används fortfarande. Flervaluta, valutakurser, kursdifferenser, kontantmetoden, fullständig automatisk räntehantering och elektroniska utskick ingår inte. Återkommande fakturor körs uttryckligen av användaren, inte av en server i bakgrunden. Fakturautkast från artikelregistret använder vanlig svensk momshantering i det befintliga fakturaflödet. Val av momssats och periodisering måste motsvara den verkliga affärens förutsättningar.

## Integration

`commercial.js` exporterar `validateCommercialState(state)`. Den accepterar äldre demodata utan de nya samlingarna och returnerar nya periodiseringsverifikationers ID:n samt nettojusteringen för konto 2990. Dessa verifikationer ska markeras som kontrollerade i den gemensamma validatorn. `commercial-workspace.js` exporterar `renderWorkspace(state)` och `handleAction(state, action, data)`; formulär och knappar använder nyckeln `commercial`.

De nya samlingarna är `commercialArticles`, `commercialPrices`, `commercialInvoiceOrigins`, `recurringPlans`, `commercialReminders`, `projectStockLinks`, `revenueSchedules` och `projectWorkpapers`. Räkenskapsårsbyten ska bevara planernas historik och fortsatta scheman. Aktuella artiklar och priser är registerdata; tidigare fakturarader och avtalsrader är frysta kopior.

Modelltester finns i `server/bokforing-commercial.test.mjs`; browserprov i `tests/bokforing-commercial.spec.ts`.
