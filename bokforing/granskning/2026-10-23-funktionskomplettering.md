# Funktionskomplettering 2026-10-23

Den här etappen bygger vidare på den fristående bokföringsdemon. Verkliga beräkningar, bokföringshändelser, rättelser och exportfiler har tillkommit. Bokföringen ligger fortsatt i webbläsaren enligt den valda etappindelningen. Det är inte en verifiering av produktionsdrift eller generell regelefterlevnad.

## Nya sammanhängande flöden

- SIE 4: PC8/CP437, förhandsgranskning, kontomappning, import, dubblettskydd, källfil och binär export. En syntetisk export har också kontrollerats i SIE-gruppens testtjänst utan rapporterade filfel; detta innebär ingen certifiering.
- Valuta: kund-/leverantörsfaktura i EUR/USD, betalning i SEK, bankavgift, kursdifferens, delkredit, återbetalning och balansdagsvärdering.
- Kontantmetod: separat nytt övningsbolag, flera fakturarader, proportionell moms vid delbetalning, kredit/återbetalning, bokslutsbokning och betalning nästa år utan dubbel moms.
- Lön: individuell semesterintjäning, uttag/slutersättning och bruttolöneåterkrav efter utbetalning med fordran, delbetalning och korrigerat AGI-underlag.
- Rättelser: granskat följdflöde för ROT och intäktsperiodiserade fakturor. Historiska fakturor, beslut och journaler bevaras.
- Deklarationer: AGI XML, moms XML, INK2/INK2R/INK2S i SRU ZIP för 2026P4 samt utskrivbart K2-dokument med jämförelsetal, noter och resultatdisposition för det stödda bolagsfallet.
- Årsarkiv: källunderlag från de nya flödena följer med granskningspaketet; senare betalningar ändrar inte ett redan fryst årsarkiv.

## Verifiering

- Produktionsbygge: godkänt (`npm run build`).
- Slutlig TypeScript-kontroll: godkänd (`npx tsc -b --pretty false`).
- 455 godkända automatiska servertester: 454 modell-, lagrings-, AI- och integrationskontroller samt ett separat HTTP-test.
- 107 unika webbläsarfall godkända efter grundkörning och omprov. De omfattar både den äldre demon och de nya arbetsytorna.
- AGI:s genererade XML har validerats mot de officiella XSD-filerna; SRU-ZIP har öppnats och kontrollerats som faktiska filer.

Grundkörningen i webbläsaren gav 104 godkända och tre avbrott. Ett nytt kontantmetodsprov förutsatte felaktigt att första sidladdningen redan skrivit till localStorage; provet rättades till att kontrollera att lagringen förblir orörd före bekräftelse. Två andra prov nådde tidsgränser under samtidig typkontroll. Återkommande fakturering passerade oförändrat vid omprov. Det längre resetprovet fick 90 sekunders totalbudget, med oförändrade funktionskontroller. Ett avslutande omprov av dessa tre och deklarationsdelens fem fall gav 8/8 godkända.

Produktionsbygge och typkontroll körs med `npm run build` respektive `npx tsc -b --pretty false`. Modell-/HTTP-/lagringsproven körs med:

```sh
node --test --test-concurrency=2 server/bokforing-*.test.mjs
```

Webbläsarproven körs mot den riktiga Node-servern med separat tillfällig SQLite-miljö, utan produktionsdatabaser:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npx playwright test -c scripts/playwright-bokforing.config.mjs
```

AGI-proven validerar genererade filer mot de kontrollerade officiella XSD-filerna med Python/lxml. SRU-proven öppnar ZIP-innehållet och kontrollerar verkliga fält, teckenkodning och summeringar. Se även [formatkällorna](../deklarationer.md).

## Konkreta fynd som rättats under granskningen

- Kredit före intäktsperiodiseringens start stoppas vid förhandsgranskning, bokföring och återläsning.
- SIE-verifikationer med bokförd resultatöverföring på 8999 stoppas; de får inte räknas som löpande kostnader. Ingående balans på 2098/2099 stöds separat.
- Utkast till valuta-/kontantmetodsfakturor stoppar relevant periodlåsning och årsavslut.
- AGI-rättelse behåller person och specifikationsnummer. Äldre lön hänförs till faktisk betalningsmånad; osäkra blandningar med den moderna lönemotorn spärras.
- Momsfilen måste avse bolagets registrerade deklarationsperiod.
- Nya källunderlag ingår i årsarkiv och granskningspaket.
- Kund- och leverantörssaldon presenteras brutto per dokument i SRU/K2. Ett tillgodo hos en part döljs inte av en annan parts skuld. Okopplade reskontrasaldon kräver avstämning före export.

## Kvarvarande gränser

Detta ersätter inte granskning av företagets affärsfakta eller val av redovisningsregler. SIE flyttar huvudboken men skapar inte reskontra eller dokumentarkiv. Kontomappning krävs utanför den stödda kontoplanen. Valuta och kontantmetod har uttryckliga begränsningar; kombinationen stöds inte. En ny ROT-begäran efter kredit av en flerpersonsfaktura kräver ännu separat personvis hantering och spärras i programmet.

Lönens tabeller och deklarationsformat är versionerade för de angivna 2026-fallen. Kollektivavtal, internationella löner och alla särskilda förmåner ingår inte. K2-dokumentet gäller det avgränsade mindre privata aktiebolaget, inte samtliga K2-/K3-företag. Digital signering, myndighetsinlämning och mottagningskvittenser ingår inte.

Serverlagring, inloggning, bolagsisolering, långsiktig arkivering och produktionens åtkomstkontroll ingår inte i denna etapp. Ande ger förslag och förklaringar; den är inte auktoriserad revisor och utför inga bokföringsåtgärder.
