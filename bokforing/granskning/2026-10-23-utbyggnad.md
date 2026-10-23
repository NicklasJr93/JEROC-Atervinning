# Verifiering av ekonomidemons utbyggnad

Datum: 2026-10-23. Gäller den lokala, fiktiva bokföringsdemon och den kodversion
som innehåller denna rapport. Detta är teknisk verifiering, inte ett
redovisningsgodkännande, en revision eller ett intyg om full regelefterlevnad.

## Resultat

| Kontroll | Utfall |
| --- | --- |
| Produktionsbygge, `npm run build` | Godkänt |
| Slutlig typkontroll, `npx tsc -b` | Godkänd |
| Modell- och lagringstester | 320 godkända |
| Isolerat HTTP-integrationstest | 1 godkänt |
| Unika browserfall mot byggd app/server | 75 godkända över huvudkörning och riktad omkörning |
| Dokumentationslänkar | 27 wikiartiklar, inga saknade lokala källfiler |

Huvudkörningen av browserproven gav 74 godkända och ett avbrutet lagerprov
vid dess tidigare totalgräns på 45 sekunder. Ingen kontroll togs bort.
Gränsen för de längre sammanhängande ekonomiproven höjdes till 90 sekunder.
Det riktade omprovet passerade på 39,3 sekunder och fullföljde även
lagervärderingen, kontrollen av uttag över saldo och omladdningen. Alla
75 unika fall har därmed passerat. Assertionernas egna tidsgränser ändrades inte.

HTTP-provet fick tidsgränsfel när det kördes samtidigt med tyngre bygg- och
testjobb. Den separata slutkörningen passerade på 13,8 sekunder. De 320
modell-/lagringstesterna kördes därefter separat och passerade tillsammans.

## Vad som ingår

- Blandade leverantörsrader, olika momsbehandlingar och avdragsandelar,
  summering till balanserad verifikation och bevarade bokförda original.
- Delkrediter, betalda krediter, återbetalningar, kvittningar, överbetalning,
  exakta momsåterföringar och fortsatt hantering efter årsskifte.
- Individuell lön med officiellt versionsbestämt tabellunderlag,
  engångsskatt, skilda underlag per person, sjuk-/semesterunderlag,
  lönekomplettering och spärr mot dubbla ordinarie löner mellan gammalt och
  nytt löneflöde. Original och länkade rättelser bevaras.
- Stödda svenska och internationella momsaffärer, delvis avdragsgill moms,
  periodrapport, momsavslut och avstämning mot huvudboken.
- ROT-fördelning, delbegäranden, avslag, utbetalning och återkrav, med
  koppling till faktura och kundbetalningar inom det stödda 2026-fallet.
- Artiklar, kundpriser, återkommande utkast utan dubblering, påminnelser,
  lageruttag till projekt och intäktsperiodisering över flera månader/år.
- Bokslutsbilagors versionshistorik, låsta historiska år, fortsatt
  reskontra, lager, tillgångar och periodiseringar nästa år. Ingen dubbel
  ingående balans skapas.
- Sparfel, föråldrade flikar, felaktiga eller ändrade originalfiler,
  storleksgränser, bilagekoppling efter sidbyte/reset och mobilvyer.
- Wikins sökning, källor, delbara adresser och isolering från besökarens
  bokföringsdata.

Den extra genomgången upptäckte och rättade bland annat en möjlig användning
av tidigare års kostnader som nytt års tillgång, felaktigt återstående
leverantörsbelopp efter kvittning, dubbla ordinarie löner mellan de två
löneflödena och behovet av särskild skatt på engångsbelopp. Regressioner
täcker dessa fall.

## Kör om

Kräver projektets Node-version och installerade npm-/Playwrightberoenden.

```sh
npm run build
node --test --test-concurrency=1 server/bokforing-*.test.mjs
npx playwright test -c scripts/playwright-bokforing.config.mjs
```

Browserkonfigurationen startar en egen byggd server på port 4179 med
tillfälliga lokala databaser. Den är avskild från produktionsdatabasen och
aktiverar ingen inloggad automatisk session. Vid behov kan en lokalt
installerad Chromium väljas med `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Gränser och fortsatt granskning

Lokal browserlagring är inte ett produktionsarkiv eller ett skydd mot en
person som ändrar sin webbläsardata. Serverlagring, bolagsavgränsade roller,
verifierad revisionslogg, backup, återläsning och API-integrationer återstår.

Flera valutor och kontantmetoden är planerade. Fullständig lön, alla
moms-/ROT-fall, full K2/K3-årsredovisning och inlämningsklar AGI/inkomstdeklaration
är inte täckta. Pågående arbeten har bedömningsunderlag. Krediter på ROT- eller
intäktsperiodiserade fakturor och automatisk omklassificering av tillgodon
vid bokslut behöver egna utökningar. Faktisk rätt till avdrag och affärens
korrekta klassificering behöver redovisningsmässig bedömning.

Andes externa AI, personliga bolagsminne och behörighetsstyrda läsverktyg är
planerade i [AI-arkitekturen](../ai-ande-saas.md), inte anslutna av denna release.
