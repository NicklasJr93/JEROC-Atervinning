# Planerade framtida uppdateringar

Senast uppdaterad: 2026-10-13.

Utbetalningsbuntar/betalfil, dashboards och mejlinkorg avvaktar fortsatt enligt
användarens beslut. Bankmottagare och bankmotor är planerade för ett senare
gemensamt bygge; ingen bankimplementation startas genom denna planering.
Ordningen är inte en prioritering.

## Bankmottagare: svenskt konto, bankgiro, plusgiro och IBAN

Status: Planerad, ÄL 109, 2026-10-13. Byggs senare tillsammans med bankmotorn.

- **Banköverföring** får undervalet **Svenskt bankkonto / Bankgiro / Plusgiro / IBAN**
  med respektive nummerfält och obligatoriskt mottagarnamn. Banknamn, BIC/SWIFT,
  bankland och mottagaradress krävs när vald betalningstjänst behöver dem.
- Gemensam modell och servervalidering används av kundregister, mobil, kontor,
  utbetalningspopup, PDF och integrationer. Normalisera nummer utan att förlora
  inledande nollor; rensa inaktiva fält vid typbyte. Kontrollsiffra och IBAN-mod97
  tillsammans med format/landslängd bevisar inte kontoägande eller bankstöd.
- Äldre bankposter utan undertyp läses som svenska konton. Frysta attestunderlag
  och hashvärden bevaras; senare mottagarrättningar följer befintliga krav på
  behörighet, orsak, historik och revision. Betalningsunderlag kommer från den
  frysta versionen, inte från senare ändrade kund-/leverantörsuppgifter.
- Spiris-förifyllning och export mappar samma mottagartyp till `Clearing` /
  `BankAccountNumber`, `BankgiroNumber`, `PlusgiroNumber` eller `BankIban` /
  `BankBic`, med `BankName` / `BankCountryCode` när tillämpligt.
- Bankland, kundland och betalningsvaluta hålls isär. IBAN innebär inte
  automatiskt utländsk valuta eller att utlandsbetalningar är aktiverade.

Underlag: [Ändringslistan, ÄL 109](Andringslistan.txt),
[Spiris och bankbetalfil – förstudie](integrationer/spiris-visma/forstudie.md).

## Bankmotor och Open Payments sandbox

Status: Separat planerad integration. Användaren har registrerat Open Payments
sandbox för AIS/PIS; faktiskt API-/bankstöd och anslutning återstår att verifiera.
Byggs senare med mottagarfälten i ÄL 109. Ingen produktionsaktivering ingår här.

- Börja med en isolerad sandboxadapter för betalningsinitiering (PIS), syntetiska
  testmottagare och verifierad statusåterläsning. Fastställ tjänstens aktuella
  autentisering, godkännandeflöde och bankprodukter före implementation.
- Kontrollera varje mottagartyp, land och valuta mot den valda bankens/tjänstens
  verkliga stöd. Registrerad AIS/PIS innebär inte att bankgiro, plusgiro, alla
  IBAN-länder, valutor eller kontotyper fungerar genom samma API.
- Återanvänd serverns låsta avräkningsunderlag, utbetalningsbehörighet och spärr
  till verifierad bokföring i rätt Spiris-företag. Varje instruktion får beständig
  journal, reservation, dubblettskydd och spårbar koppling till attestversionen.
- Skapad, skickad, väntande, avvisad, okänd och verifierat genomförd betalning
  hålls isär. Ett mottaget API-anrop eller genomfört bankgodkännande räcker inte
  som betalningsbevis; bankens dokumenterade slutstatus och matchande underlag
  måste återläsas. Oklart resultat kontrolleras utan ny pengainstruktion.
- Bekräftad betalning följs av separat PDF-revision och Spiris-betalningsbokföring
  mot rätt eget konto. Fel i dessa steg får inte skicka betalningen igen.
- **AIS som möjligt tillval:** läsa anslutna egna konton och kontosaldo efter
  rätt kontobehörighet/samtycke. Visa källa och uppdateringstid; tillgängligt och
  bokfört saldo skiljs åt om API:t lämnar båda. Saldovisning planeras separat
  från betalningsinitieringen; ett saldo är ingen betalningsbekräftelse eller
  garanti för betalning.
- Anslutningsuppgifter hanteras på servern. Sandboxens klientuppgifter kan
  förberedas i Render enligt guiden nedan; ingen adapter läser dem ännu.
  Återkopplingsadressen fastställs när bankens godkännandeflöde implementeras.

Underlag: [Ändringslistan, ÄL 109](Andringslistan.txt),
[Planerat utbetalningsflöde](integrationer/utbetalningar-plan.md),
[Open Payments sandbox – förberedelser](integrationer/openpayments-sandbox-setup.md),
[Attest, bokföring och utbetalning](integrationer/attest-bokfor-utbetalning-2026-10-13.md).

## Utbetalningsbuntar och betalfil

Status: Avvaktar. API-/bankförstudie finns; buntflödet och bankexporten är inte byggda.

- Markera individuella attesterade kort med bankkonto och samla dem i en bunt.
- Granska mottagare, belopp, total och betalningsdatum före filgenerering.
- Reservera korten för bunten så att samma utbetalning inte hamnar i två aktiva buntar.
- Spara filversion och händelsen **Betalfil genererad** med datum, användare och ingående kort.
- En befintlig fil kan laddas ner igen från samma bunt. Genererad fil innebär inte betald;
  genomförd betalning får separat bekräftelse och historik.
- Bekräfta bank, filformat, tjänst/avtal och avsändaruppgifter innan bankexporten färdigställs.
  Roslagens Sparbank/Swedbank är preliminärt bankval.

Underlag: [Spiris och bankbetalfil – förstudie](integrationer/spiris-visma/forstudie.md).

## Rollanpassade dashboards

Status: Avvaktar implementation. Klickbara mockuper finns.

- Kontorist, ekonomi/attest, transportledare, gruppledare, VD, systemadmin,
  gårdsmedarbetare och chaufför får översikter utifrån sina arbetsuppgifter.
- **Mitt arbete** visar prioriterade ärenden, nästa åtgärd och direktlänk till rätt kort eller order.
- Chefsvyn visar bland annat obemannade uppdrag, frånvaro som påverkar bokningar och avvikelser.
- **Verksamheten** visar volym, inköpsvärde och materialfördelning med datum- och anläggningsfilter.
- Innehållet styrs av faktisk behörighet och anläggningsåtkomst.
- AI-stöd är en möjlig senare utökning; prioritering och tillåtna åtgärder styrs av regler.

Underlag: [Rollernas dashboardmockuper](mockups/roll-dashboard/README.md), ÄL 075.

## Mejlinkorg med flera brevlådor och AI-förslag

Status: Avvaktar implementation. Klickbar mockup finns.

- Börja med Microsoft 365/Outlook under **Integrationer**. Flera konton och gemensamma
  brevlådor kan anslutas med individuellt styrd åtkomst.
- En samlad mejlsida har valet **Alla tillgängliga inkorgar** och filter per brevlåda.
  Varje mejl visar mottagande adress; svaret föreslår samma avsändarbrevlåda.
- Trådar, sökning, bilagor och automatisk hämtning av nya mejl.
- Tilldela ansvarig, använd arbetsstatus **Ny / Pågår / Klar** och interna kommentarer.
- Koppla mejl till kund, arbetsorder, kärl eller befintligt ärende. Arbetsorder kan
  förifyllas från mejlet och granskas före skapande.
- Outlook sköter mejlleverans; JEROC sparar ärendekopplingar, ansvarig, arbetsstatus
  och historik i PostgreSQL. Anslutningsuppgifter lagras krypterat på servern.
- Senare AI-stöd kan föreslå sammanfattning, koppling och svar. Användaren granskar
  och väljer själv att skapa ärendet eller skicka svaret.
- Outlook-anslutning och faktiska läs-/svar-/ärendeflöden byggs före AI-stödet.

Underlag: [Mejlinkorgens mockup](mockups/roll-dashboard/README.md), ÄL 075.
