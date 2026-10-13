# Blockerat Swish-test – diagnos och återkontroll

Kontor 0.23.1, 2026-10-13. Swish MSS och Spiris sandbox.

Invägning 3026 hade ett sparat jobb med status `blocked`, ingen provider-
respons och felkoden `accounting_amount_invalid`. Den förberedda begäran
innehöll korrekt `"amount": "240.00"`. Det delade Spiris-utkastet hade
240 kr i debet/kredit och 0 kr moms. De uppgifterna förklarar inte felet
vid den senare kontrollen av den bokförda fakturan. Grundorsaken på det
driftsatta kortet är ännu inte verifierad i detta bygge.

## Prova på det befintliga kortet

1. Öppna 3026 efter att Render visar 0.23.1.
2. Öppna det sparade utbetalningstestet och tryck **Kontrollera status**.
3. Om kontrollen stoppas visar feltexten vilket Spiris-fält som felar.
   **Avancerat → Kopiera felsökningsinfo** innehåller även
   `error.details.provider`, `field` och `valueType`.
4. Om kontrollen godkänns förblir betalningen oskickad. Först ett uttryckligt
   tryck på **Fortsätt testutbetalning** återköar samma instruktion.

Du behöver inga nya Render-variabler. Skapa inget nytt viktkort för att
kringgå kontrollen. Beloppet `240` är ett giltigt JSON-tal; Swish får redan
det föreskrivna textbeloppet `240.00`.

## Gränser för återupptagning

Kontrollen avser det befintliga frysta underlaget och den ursprungliga
Spiris-fakturan/kopplingen. Både aktuell och ursprunglig behörighet måste
fortfarande gälla. Mottagare, belopp och instruktions-ID ändras inte.
Tidigare skickade instruktioner, okända utfall och bekräftade betalningar
får inte återköas. Att hämta status är åtskilt från att uttryckligen fortsätta.

Diagnosen innehåller fältnamn och värdetyp, inte råa belopp eller faktura-
payloads. Den strikta internkontrollen av kronor/ören behålls; negativa
eller ogiltiga värden görs inte positiva eller korrigeras automatiskt.

## Verifiering

Fokuserade kontroller täcker giltiga 240-kronorsunderlag, felaktiga Spiris-
beloppsfält, aktiv återkontroll utan betalningssändning, explicit fortsättning
av samma oskickade instruktion, behörighet och spärr mot dubbelsändning.
Provideranrop i dessa kontroller är isolerade testdubblar.

- Spiris-export: 54 godkända kontroller; 2 befintliga PostgreSQL-kontroller
  överhoppade eftersom en isolerad testdatabas saknas.
- Swish-betalningar: 24 godkända kontroller.
- API med verklig cookie, behörighet och CSRF: 5 godkända kontroller.
- Utbetalningsvyn i Chromium: 7 godkända kontroller.
- Produktionsbygget med TypeScript och Vite passerar.

Ingen databasstruktur ändras. Ingen extern betalning eller bokföringssändning
utfördes i verifieringen. Återkontrollen av driftsatta 3026 måste fortfarande
göras efter deploy för att fastställa det faktiskt felande fältet.
