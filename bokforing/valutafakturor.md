# Valutafakturor: EUR och USD med redovisning i SEK

Status 2026-10-23: arbetsyta och deterministisk bokföringsmotor. Ingen
bankanslutning eller automatisk kurskälla används. Kursen anges som **SEK
per en enhet EUR/USD**, med kursdatum och en underlagsreferens.

## Vad som fungerar

- Kund- och leverantörsfakturor i EUR/USD, med SEK som redovisningsvaluta.
- Redigerbara utkast och låsta utfärdade/bokförda original.
- Svenska momssatser 25, 12 och 6 procent samt dokumenterad ingen moms.
  Valutan får inte användas för att härleda skatteregeln.
- Blandade rader, separata nettobelopp och moms, frysta kurser och SEK-värden.
- Delbetalning och slutbetalning med faktiskt bankbelopp i SEK och en
  uttryckligt separat bankavgift. Existerande omatchad SEK-bankhändelse kan
  kopplas så att betalningen inte skapar ytterligare pengar.
- Kursvinst och kursförlust bokförs på 3960/7960; bankavgiften på 6570.
- Radvis delkredit och helkredit före eller efter betalning. Ett tillgodo
  redovisas separat och kan återbetalas med en ny bankhändelse. När krediten
  skapar ett nytt tillgodobelopp krävs en granskad kurs för kreditdatumet;
  moms och intäkt/kostnad återförs fortfarande med originalets frysta belopp.
- Balansdagsvärdering av öppen monetär fordran/skuld, med granskad kurs.
  En oförändrad kurs får en dokumenterad kontroll utan nollverifikation.
  Senaste bokförda värdering kan återföras genom länkad händelse.
- Öppna valutaposter fortsätter över ett riktigt årsavslut och nytt år.
  Betalningen använder det då kvarvarande bokförda värdet, inte den gamla
  ursprungskursen. Momsen bokförs inte en gång till vid betalningen.
- Utskriftsbara fakturor och kreditnotor med valuta, originalkoppling och
  svensk moms även angiven i SEK. HTML-filen kan öppnas och skrivas till PDF.

## Beräkningar

`foreign*Minor` är eurocent/US-cent. `*Cents` är alltid SEK-ören. Kursen
lagras som ett reducerat heltalsbråk och omräkningen använder BigInt.
Inget flyttal används för bokföringsbelopp.

Nettobelopp och moms omräknas och avrundas separat per rad. Fakturans
bokförda total är summan av dessa komponenter. Det kan skilja ett öre från
att multiplicera hela valutagrossot med kursen; den använda metoden och de
frysta beloppen följer med originalet och utskriften.

Vid delbetalning tas motsvarande andel av den kvarvarande valutapostens
bokförda värde bort. Den sista regleringen tar exakt återstående SEK-ören.
Vid kredit återförs ursprungsradens netto och moms kumulativt; summan av
flera små krediter blir exakt ursprungsvärdet. Förändringar efter
balansdagsvärdering ger en separat kursdifferens, inte ändrad historisk moms.

## Begränsning och användarbedömning

Denna arbetsyta stöder **faktureringsmetoden**. Nya valutafakturor kan inte
läggas upp eller utfärdas med kontantmetoden. EUR/USD är fakturavalutor;
bankkontot är fortfarande i SEK. Valutabankkonton, andra valutor, ROT i
valuta, omvänd moms samt specifika kombinationer av valuta och EU-/export-
regler är inte införda i denna arbetsyta och får inte simuleras genom
felaktigt val av momstyp.

Säljare och motpart anges i fakturan och fryses vid utfärdande. Användaren
ansvarar för rätt momsbedömning, faktisk betalning, avdragsrätt och granskad
kurskälla. Ingen faktura skickas, banköverföring görs eller aktuell kurs
hämtas automatiskt. Ett kundtillgodo/leverantörstillgodo ligger kvar i
reskontran tills reglering eller bokslutsbedömning görs.

## Integrationspunkter

Motorn ligger i `public/bokforing/suite/fx.js`. `fxDocuments` och `fxEvents`
är nya valfria samlingar. Varje bokförd händelse har en egen `fx-*`-källa,
kopplad verifikation och kontrollsnapshot. `validateFxState` returnerar
verifikationsanspråk samt signerade kund-/leverantörssaldon för kontroll
mot 1510/2440. `getFxTaxRows` lämnar deklarationsrader för fakturor och
krediter; betalningar och värderingar skapar ingen ny fakturamoms.
`getFxClosingIssues` listar öppna poster utan slutlig granskad
balansdagsvärdering.

Lagring och inloggning är samma lokala demo som övriga ekonomiflöden.
Detta dokument intygar inte full regelefterlevnad eller att en extern
redovisningsgranskning har genomförts.

Regelram och tidigare implementationplan:
[valuta och kontantmetod](utveckling/valuta-och-kontantmetod.md), med länkar
till BFL 4 kap. 6 § och mervärdesskattelagens regler om valutaomräkning
samt fakturans momsbelopp i redovisningsvalutan.
