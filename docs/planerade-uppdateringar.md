# Planerade framtida uppdateringar

Senast uppdaterad: 2026-10-12.

De tre områdena nedan avvaktar enligt användarens beslut. Ingen implementation
startas innan respektive område tas upp igen. Ordningen är inte en prioritering.

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
