# Avräkningsnota – reviderad A4-mockup

Designförslag enligt användarens bifogade avräkningsnota och godkända
fältgranskning 2026-10-10. Befintlig JEROC-logga, mörkblå rubrik/materialtabell,
ljusblå köparruta, ljusgrön säljarruta och grön utbetalningssumma bevaras.

| Version | Bild och PDF |
| --- | --- |
| Efter kundgodkännande och intern attest – simulerat företagsexempel | [Bild](01_Avrakningsnota_A4.png) · [A4-PDF](01_Avrakningsnota_A4.pdf) |
| Förhandsvisning före kundgodkännande och attest | [Bild](02_Avrakningsnota_Preliminar_A4.png) · [A4-PDF](02_Avrakningsnota_Preliminar_A4.pdf) |

[Hämta den fristående mockupen](JEROC_Avrakningsnota_Mockup.zip), packa upp
och öppna `index.html`. Växla mellan slutligt demoexempel och preliminär vy
med länken ovanför dokumentet. Skriv ut / spara PDF använder webbläsarens
utskrift. GitHubs vanliga HTML-visning kör inte prototypen.

## Ändringar från den bifogade bilden

- Ett komplett köparblock istället för dubbla JEROC-företagsuppgifter.
- Avräknings-ID, säljarspecifikt självfakturanummer och invägningsnummer
  står en gång vardera och behålls som skilda identiteter.
- Utfärdandedatum och mottagningsdatum skiljs åt. Anläggning, total
  nettovikt, dokumentversion och SEK framgår.
- Kundgodkännandet och JEROC:s interna attest visas separat, med tid,
  godkännandemetod och koppling till dokumentversionen.
- Sorteringsavdrag och kvittning mot tidigare kundsaldo förklaras.
  Materialvärde 37 479 kr minus sorteringsavdrag 150 kr ger avräkningsbelopp
  37 329 kr. Exemplet kvittar ytterligare 500 kr mot tidigare minussaldo:
  utbetalning 36 829 kr. Nettovikt är 3 033 kg.
- Utbetalningsrutan visar bankkonto med maskerat nummer och planerad dag.
  Ingen faktisk betalning, bokföring eller integration påstås.
- Självfakturering och omvänd betalningsskyldighet avser det fiktiva
  företagsexemplet. Omvänd betalningsskyldighet betecknas inte som 0 % moms.
  Privatinköp och andra momsfall behöver villkorsstyrda varianter i appbygget.
- Preliminär version är tydligt märkt PRELIMINÄR – EJ BOKFÖRD, saknar
  slutligt självfakturanummer och visar ännu ej genomförda godkännanden.

Alla namn, nummer, avtal, godkännanden och belopp är exempel. Detta är en
fristående dokumentmockup, inte en ny funktion i kontorsappen. Inget läses
eller skrivs i databasen och inga BankID-, Visma-, bank-, NVV- eller
meddelandeanrop görs. Denna PDF är ett designunderlag i GitHub; inget
automatiskt verksamhetsarkiv har införts.

PDF-originalets uppgifter och status avser utfärdandet. Senare betalningar
eller bokföringsreferenser hör till digital ärendeinformation och eventuella
separata kvitton/bilagor; de ska inte skriva över ett godkänt original.

## Återskapa

```bash
node docs/mockups/avrakning/render-mockups.mjs
```

Använder repots befintliga Playwright och Chromium. Renderingens kontroller
avser båda A4-varianterna, tio materialrader, belopp, versionsstatus, unika
huvudnummer och laddad logga. Appens verksamhetskod är oförändrad.

Fakturafält och villkorsstyrning utgår från [Skatteverkets faktureringsregler](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering.4.58d555751259e4d66168000403.html).
