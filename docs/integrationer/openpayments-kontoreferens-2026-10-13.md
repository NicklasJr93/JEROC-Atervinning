# Open Payments – mottagarkonto vid banktest

Rättat i kontor **0.28.1, ÄL 118** efter avvisningen på invägning 3027.
Open Payments svarade HTTP 400 med `JSON does not match any schemas from
'anyOf'` för `creditorAccount`. Betalningsförsöket blev `rejected` och hade
inget betalnings-ID från leverantören. Beloppet `540.00` var inte det
utpekade felet.

## Kontoreferensen

Det generella publicerade kontoschemat listar både IBAN, BBAN och separata
clearing-/kontofält. Ändringsloggen från januari 2026 beskriver de senare
som nya svarsfält för kontoinformation (AIS). De ska inte därför behandlas
som ett verifierat format för att initiera en domestic-betalning (PIS).

Nya instruktioner använder `payloadVersion: 2`:

- Svenska konton skickas som `creditorAccount: { bban, currency: 'SEK' }`.
  BBAN är den nationella kontosträngen: angivet clearingnummer följt av
  angivet kontonummer. Alla siffror och inledande nollor bevaras. Ingen
  utfyllnad, kontrollsiffra eller omvandling till ett IBAN gissas.
- IBAN skickas fortfarande som `{ iban, currency: 'SEK' }` med befintlig
  format- och kontrollsiffrevalidering.
- Avsändaren hämtas från det godkända bankmedgivandet, med bankens IBAN/BBAN.
  Om bankens AIS-svar bara har clearing-/kontofält översätts referensen till
  samma nationella BBAN-form utan att ändra det sparade bankkontot.
- Bankgiro och plusgiro behåller sin separata `swedish-giro`-produkt.

Nya PIS-anrop avvisar separata clearing-/kontofält lokalt före HTTP-anropet.
Clearing för Swedbank/sparbank som börjar med 8 måste ha fem siffror. Äldre
demo-clearing `8327` behöver kompletteras med en korrekt femte siffra eller
ersättas med ett verifierat svenskt IBAN. Systemet lägger inte till siffran.

Databasens kundfält och frysta avräkningsunderlag behåller clearing och konto
separat. Översättningen sker bara vid skapandet av bankinstruktionen.
Giltigt format bevisar inte att kontot finns eller att den valda testbanken
godtar mottagaren. Open Payments publika exempel visar IBAN; ändringsloggen
bekräftar BBAN och femsiffriga Swedbank-mottagare uttryckligen för Danske Bank.
Det exakta bankspecifika runtime-schemat är inte publicerat i OpenAPI-filen.

## Gamla försök och nästa prov på 3027

Redan sparade instruktioner och deras hashvärden skrivs inte om. Jobb utan
`payloadVersion` verifieras enligt den äldre versionen 1. Därmed kan äldre
bekräftelser och pågående instruktioner fortsatt avläsas utan att jämföras
mot ett nybyggt kontoformat. En obekant formatversion accepteras inte.

På ett uttryckligen nekat försök väljer användaren **Rätta uppgifter och gör
nytt test**. Komplettera mottagarkontot via **Redigera** och ange en orsak.
Det skapar ett nytt jobb med ny instruktion och `retryOf` till det gamla.
Ursprungsförsöket finns kvar. **Uppdatera betalstatus** skickar ingen ny
betalning. Ett oklart eller pågående försök får inte dupliceras.

PDF- och Spiris-kvittens kräver fortsatt återläst `ACSC` med matchat belopp,
SEK, mottagare, avsändarkonto och referens. Ett accepterat POST eller en
signering markeras inte som genomförd utbetalning.

## Källor och provgräns

- [Open Payments OpenAPI v1.3.3](https://docs.openpayments.io/openpayments_api.yaml).
- [AIS-kontofält, januari 2026](https://docs.openpayments.io/docs/changelog/2026-01.md).
- [BBAN/Swedbank-clearing, maj 2025](https://docs.openpayments.io/docs/changelog/2025-05.md).
- [Swedbank: nationell kontosträng](https://www.swedbank.se/privat/betala-och-overfora/iban-och-bic.html).
- [Swedbank: clearingnummer](https://www.swedbank.se/privat/betala-och-overfora/overforingar.html).

Rättningen verifieras med isolerade adapter-/motor-/kvittensprov och ett
produktionsbygge. Inga nya betalningar har skickats till Open Payments eller
Spiris av dessa kontroller. Nästa verkliga sandboxprov sker från viktkortet
efter deploy och mottagarrättning. Inga nya Render-variabler behövs.
