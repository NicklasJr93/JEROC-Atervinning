# Krediter, ROT-rättelser och intäktsperiodisering

Implementerat i den lokala bokföringsdemon. Underlagen är fiktiva. Gränssnittet skickar inga begäranden, rättelser eller bankbetalningar till Skatteverket.

## Arbetsflöde

Under **Krediter & återbetalningar** kan användaren nu även välja en ROT-faktura eller en faktura med intäktsperiodisering. Valda originalrader och nettobelopp ger en separat förhandsgranskning. Den visar exakt kreditjournal, ändrat ROT-belopp, eventuell skatteåterbetalning och uppdelning mellan redan redovisad intäkt och kvarvarande förutbetald intäkt. Ingen journal skapas när förhandsgranskningen sparas. Bekräftelsen avvisas om relevanta bokföringsuppgifter har ändrats sedan förhandsgranskningen.

Krediten bokförs först efter användarens uttryckliga granskning. För ROT krävs referens till hanteringen av det ändrade myndighetsärendet. När mottaget ROT överstiger återstående avdrag krävs också bekräftelse att återbetalningen verkligen har genomförts; samma transaktion bokför då D1510/K1930 och den kopplade bankhändelsen. Motsvarande kundtillgodo kan återbetalas separat. Programmet verkställer aldrig en banköverföring.

På **Moms & ROT** finns ett fortsatt rättelseflöde för fakturor med en ROT-person: förbered nytt kvarstående anspråk, registrera beslut, registrera faktisk utbetalning samt registrera ett senare återkrav. Återkrav återöppnar kundfordran och minskar bankkontot; intäkt och moms bokas inte på nytt. Den rättade kundandelen måste vara betald innan en ny rättelsebegäran skapas. Ett avslag kan minska kundens avdrag men aldrig höja det.

## Kontroller och historik

- Originalfaktura, originalverifikation och äldre ROT-fördelningar, ansökningar och betalningar bevaras. Den gamla myndighetshistoriken valideras mot ett fryst originalunderlag.
- Separat, append-only rättelsehistorik knyter krediten till ändrat avdrag, externa referenser och eventuella återbetalningar. Valideringen räknar om belopp från originalraderna och stämmer av journalsidor, bankhändelser och reskontrasaldon.
- ROT-belopp efter kredit begränsas av tidigare godkänt/reserverat belopp och kvarvarande avdragsgrundande arbetskostnad. En materialkredit skapar inte i sig ett högre ROT-avdrag. Överbetalning från Skatteverket får inte lämnas som godkänt avdrag.
- Datumordning, låsta perioder, fastställda momsperioder, dubbla referenser, överkreditering, obefogade återbetalningar och ändrade historiska underlag kontrolleras.
- Moms återförs från originalets momsrader med kumulativ öresfördelning. Momsrapporten inkluderar även separata valuta- och kontantmetodflöden exakt en gång.
- Intäktskrediten fördelas proportionellt över den ursprungliga avtalstiden. Redan intäktsförd del rättas separat från kvarvarande skuld på konto 2990. Framtida månadsbelopp räknas om. Helt krediterad plan avslutas; historiska månadsverifikationer ändras inte. Ett annat ekonomiskt innehåll, exempelvis kredit för en specifik leveransmånad, kräver en separat bedömd rättelse.

## Regelversion och avgränsningar

ROT-demon använder redan fastställd regelversion för betalningar 2026. Den antar inga framtida procentsatser. Skatteverkets sida om [delbetalning och årsskifte](https://www.skatteverket.se/foretagorganisationer/sjalvservice/svarpavanligafragor/rotochrutarbete/foretagrotochrutarbetefaq/narskajagsomutforareansokaomutbetalningdakundenbetalatbaraendelavfakturabeloppetexempelvisviddelfaktureringochvadhanderombetalningargorspabadasidornaavettarsskifte.5.71004e4c133e23bf6db800013003.html) lästes 2026-10-23. Den anger proportionering av delbetalningar och ansökan senast 31 januari året efter betalningsåret. Det innebär att betalningar 2026 kan ingå i begäran senast 2027-01-31; det innebär inte att modellen stöder en ny betalning under 2027.

Den tekniska kredit-/återbetalningsmodellen ersätter inte bedömningen av hur ett visst befintligt myndighetsärende ska rättas. Användaren bekräftar att den externa ärendehanteringen är genomförd. Programmet kontrollerar inte Skatteverkets faktiska beslut, skatteutrymme eller äganderätt.

Flerpersonsfakturor kan krediteras och betalda skattebelopp återbetalas, med bevarad ursprunglig personfördelning. **Ny automatisk begäran efter kredit av en flerpersonsfaktura är spärrad** eftersom befintliga betalningar saknar tillräcklig personvis avräkning. Det kräver en separat personvis avstämning. Kvittning av ROT-fakturor är också spärrad; använd explicit kundbetalning/återbetalning.

## Integration och test

`validateSettlements()` inkluderar `validateRotCreditEvents()` och lämnar samtliga nya återbetalningsverifikationer och signerade kundfordringsjusteringar till huvudvalideringen. Dessa belopp får inte läggas till en gång till. `validateRotApplications()` granskar äldre ROT-underlag i den frysta historiska vyn. `getRotCreditClosingIssues(state)` ger `{invoiceId,message}[]` för ännu oavslutade rättelseanspråk, beslut eller skatteutbetalningar inför årsavslut. Vanliga kundfordringar bärs i reskontran som tidigare.

Serverprov: `node --test server/bokforing-rot-credit-completion.test.mjs`.
Webbläsarprov: `tests/bokforing-rot-credit-completion.spec.ts` (förhandsgranskning/bekräftelse och återläsning för ROT respektive intäktsperiodisering).
