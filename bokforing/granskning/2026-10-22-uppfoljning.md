# Rättningar efter provgranskningen – 22 oktober 2026

**Status: rättat i källkoden och verifierat lokalt. Render-publicering av den
nya versionen återstår.** Den ursprungliga [livegranskningen](2026-10-22.md)
och dess resultat bevaras som historik.

## Åtgärdade fynd

| Fynd i första versionen | Rättning och verifiering |
| --- | --- |
| Inköpskostnad kunde bokföras på bank/fordran/intäkt/eget kapital | Inköpsmodellen har en uttrycklig lista över tillåtna inköpskonton. Editorn erbjuder samma lista. Modelltester nekar även balanserade rader med otillåtet konto. |
| Extra momsrader kunde godtas | Momskonton, belopp och debet-/kreditsida kontrolleras per stödjat inköpsfall. Kostnadsnetto och leverantörsskuld kontrolleras separat. Extra momspar och motbokade bruttoförhöjningar nekas. |
| En flik kunde skriva över en annan fliks bokning | Sparandet använder exklusiva Web Locks och jämför aktuell rårevision med den version fliken läste. En gammal flik pausas; läs in senaste innan nästa bokning. Browserprovet visar att båda bokningarna finns kvar efter omläsning och fortsatt arbete. |
| Sparfel kunde ge bokförd vy utan beständig sparning | UI-state byts först efter lyckad skrivning och återläsning. Vid fel visas ingen lyckad bokföringskvittens. Osäker kvittens kräver omläsning eftersom posten redan kan vara sparad. |
| Ande skymde bokföringsknappen | Launchern flyttas till reserverad plats i sidhuvudet. Pekarklick med fem konteringsrader fungerar på både dator och mobil. |

Reset får fortfarande ersätta hela den fiktiva lokala demoboken efter
bekräftelse. Även reset använder samordnad lagring och ny revision. Ett misslyckat
reset-sparande rensar inte den befintliga vyn, bokföringen eller chatten.
Ogiltiga äldre demodata bevaras och visas i läsläge tills uttrycklig reset.

## Verifiering

- Produktionsbygget passerar.
- 48 modelltester, inklusive balanserade negativa fall för konton,
  momskombinationer, skuld, nettosumma och extra motbokningar.
- 23 lagringstester för samtidiga skrivningar, gamla revisioner, reset till
  identiska exempel, sparfel, läsfel, osäker kvittens och saknad samordning.
- Sex pilotpolicytester och ett HTTP-integrationstest med egna disponibla
  testdatabaser. Den nya `storage.js` serveras med rätt MIME-typ; kontorets API
  kräver fortfarande session.
- Tio browserregressioner mot det byggda programmet med egen lokal appserver:
  kontofilter, fel total/moms, dubbelklick/omladdning, två flikar, sparfel,
  osäker kvittens, reset-sparfel, ogiltiga äldre data och femradig kontering
  med pekarklick på 1 440 × 1 000 samt 390 × 844.
- Oberoende kodgranskning av modell, lagringsmodul och UI:s sparningsflöde.

Regressionsprov finns i [modelltesterna](../../server/bokforing-demo-model.test.mjs),
[lagringstesterna](../../server/bokforing-demo-storage.test.mjs) och
[browserproven](../../tests/bokforing-demo.spec.ts). Browserproven ingår även i
CI:s prioriterade urval. Ovanstående resultat avser den lokala riktade körningen.

## Avgränsning och publicering

Detta är fortfarande syntetisk browserlokal bokföring. Web Locks samordnar
flikar som kör den uppdaterade lagringsmodulen. Äldre redan öppna programversioner,
direkt localStorage-manipulation och andra klienter är ingen säkerhetsgräns.
Stäng och öppna äldre demoflikar efter Render-publiceringen. Utan stöd för
samordning visas demon i läsläge.

Rätt kostnadsslag mellan tillåtna kostnadskonton kräver fortfarande saklig
bedömning. Momskategorierna i exemplen är förbestämda; systemet verifierar inte
verkliga parters momsstatus eller avdragsrätt. Kreditnotor, tillgångsinköp och
andra nya affärsflöden behöver egna granskade regler.

Serverbok, behörigheter, hållbara rättelseverifikationer/revisionshistorik,
periodhantering och lagstadgat dokumentarkiv ingår inte i denna rättning.
Rättningarna är inte en certifiering av regelefterlevnad.

Publicera den granskade versionen på `scrapplanner-app` enligt
[driftguiden](../../docs/drift/README.md#uppdatera-och-kontrollera), kontrollera
`/bokforing` och `/bokforing/storage.js` och gör om de berörda flödena i en ny
demoflik innan länken beskrivs som den uppdaterade versionen.
