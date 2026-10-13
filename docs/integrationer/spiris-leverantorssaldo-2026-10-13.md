# Spiris leverantörsrestbelopp och Swish

Kontor 0.23.2, ÄL 106, 2026-10-13.

3026 stoppades med `accounting_amount_invalid` före något Swish-anrop.
Återkontrollen i 0.23.1 pekade ut `RemainingAmountInvoiceCurrency`.
Eftersom fältet redan hade passerat kontrollen för ett ändligt JSON-tal
visar den efterföljande feltexten att restbeloppet var negativt. En generell
kontroll för icke-negativa betalningsbelopp användes på leverantörsskulden.

Spiris aktuella OpenAPI beskriver de två restbeloppen som läsbara numeriska
fält utan någon angiven lägsta gräns eller utfästelse om tecken. Rättningen
hanterar den observerade negativa representationen och tidigare positiva
representationer inom samma verifierade fakturakontext.

## Belopp och bekräftelse

En normal bokförd leverantörsfaktura i SEK med positiv total och
`IsCreditInvoice: false` kan exempelvis ha en skuld på `-240`.
En obetald skuld på 240 kr tillåter en positiv Swish-begäran med
`"amount": "240.00"`. Kreditfakturor, andra valutor och andra beloppsfält
omfattas inte av denna tolkning.

Hela skulden måste motsvara samma frysta avräkning och fakturatotal.
Nollsaldo, delvis betalt, avvikande restbelopp och betalning som redan är
betald/skickad till banken spärras. Om båda restbeloppsfälten finns måste
de ange samma SEK-skuld. Ogiltiga värdetyper och delar av ören avvisas.

Efter verifierad Swish PAID registreras ett positivt betalningsbelopp på
exakt samma Spiris-faktura. Ursprungligt tecken sparas i
`remainingBeforeSignedCents`; skuldens storlek finns i
`remainingBeforeCents`. Avstämningen kräver noll i restbeloppen, betald
status och en unik matchande banktransaktion med betalningsverifikation.
Äldre reserverade registreringar återläses utan ytterligare POST.

## Fortsätt 3026

När Render visar 0.23.2, öppna det befintliga testet och tryck
**Kontrollera status**. Om alla övriga kontroller går igenom visas
**Fortsätt testutbetalning**. Den återanvänder samma sparade instruktion.
Statuskontrollen skickar ingen betalning. Inga nya Render-variabler eller
databasändringar behövs.

## Verifiering

- Bokföringsmotor, Spiris-export och den nya saldokontrollen: 71 godkända
  kontroller, 2 befintliga PostgreSQL-kontroller överhoppade utan isolerad
  testdatabas. Bland annat en reproduktion med 3026 och skuld på -240 kr.
- Betalningsregistrering: 22 godkända kontroller, inklusive positiva/negativa
  fulla skulder, partiella och avvikande skulder, betald/bankstatus,
  oförenliga restbeloppsfält och förlorat svar utan omsändning.
- Produktionsbygge med TypeScript och Vite passerar.

Provideranrop i kontrollerna är testdubblar. Ingen extern betalning eller
bokföringssändning utfördes vid verifieringen.
