# ScrapPilot

ScrapPilot är produktens namn. JEROC Återvinning är ett kundbolag och behåller sin egen identitet i bolagsprofil, avräkningar och transportdokument.

Den godkända loggan har rundade former och högst två färger:

| Färg | RGB / HEX |
| --- | --- |
| Marinblå | 11, 32, 55 / `#0B2037` |
| Dov grön | 94, 126, 96 / `#5E7E60` |

## Filer

- [Logga i SVG](scrappilot-logo.svg) — master för webb och skalbar produktion.
- [SP-symbol i SVG](scrappilot-symbol.svg) — kvadratisk variant för appikon och små ytor.
- [Logga i vektor-PDF](scrappilot-logo-print.pdf) — för tryckleverantörer.
- [Logga i PNG](scrappilot-logo-vector.png) och [symbol i PNG](scrappilot-symbol-vector.png) — transparenta rasterexporter av vektorerna.
- [Godkänd originalbild](scrappilot-logo-rounded.png) — bevarad som referens.

SVG-filerna består av verkliga konturbanor, även bokstäverna. Inga bilder är inbäddade och inga typsnitt behöver installeras. Den godkända PNG-bildens former har vektoriserats med VTracer 0.6.15, utan att monogrammet eller ordmärket har ritats om. Bildens subtila rasterstruktur har ersatts av de två jämna färgerna ovan. PDF och PNG har exporterats från samma SVG med CairoSVG 2.9.1.

Appen använder `/images/scrappilot-logo.svg` och `/images/scrappilot-symbol.svg`. Kopiorna i `public/images` ska motsvara masterfilerna här.

Behåll proportionerna och använd ett lugnt utrymme runt loggan. Anpassa fysisk storlek, trådfärger och eventuell separation av de två färgerna tillsammans med tryck- eller brodyrleverantören. Vid liten brodyr passar SP-symbolen bättre än hela ordmärket. Bolagsloggor på juridiska dokument ersätts inte av produktloggan.
