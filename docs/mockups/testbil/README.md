# ScrapPilot – digital testbil

Statisk bildmockup, framtagen 16 oktober 2026. Ingen interaktiv demo eller
ny applikationsfunktion ingår i själva bildleveransen. Användaren godkände
sedan mockupen och beställde implementation enligt ÄL 128.
[Den byggda simulatorn beskrivs här](../../integrationer/telematik/testbil.md).

[Öppna bilden i full storlek](01_Testbil_Dashboard.png)

![ScrapPilot – Din digitala testbil](01_Testbil_Dashboard.png)

Förslag till separat sida på `/testbil1`, med en fiktiv FMC003-utrustad
transportbil. Bilden visar pågående körning från Kontoret till Kund 1.
Kartan, rutten, kunderna, fordonsvärdena och mottagarstatistiken är
illustrationer med syntetiska uppgifter, inte verklig telemetri.
Implementationen använder sökvägen `/testbil1` efter deploy.

## Föreslaget flöde

- När motorn är av visas **Starta bilen**. På bilden är den redan på,
  vilket markeras med **Motor på** och en separat **Stäng av**-kontroll.
- Välj **Kontoret**, **Kund 1**, **Kund 2** eller **Hem** och påbörja körning.
  Kartan följer den simulerade bilen och visar återstående sträcka.
- **Pausa körning** stannar rörelsen utan att nollställa resan.
  **Nollställ testbilen** återställer simulatorn.
- Välj **1×**, **5×** eller **10×** för att prova resor snabbare.
- Instrumentpanelen visar syntetisk hastighet, varvtal, bränslenivå,
  motortemperatur och mätarställning samt en kort hastighetshistorik.
- Händelselistan visar start, påbörjad resa och mottagen telemetri.
  Mottagarpanelen skiljer mätpunkter, paket och väntande kö åt.

Den kommande simulatorn ska använda en avskild testkanal och får inte
skriva till verkliga fordon, arbetsordrar eller bolagsdata. Bildens
**Ansluten** och **Testdata mottagen** illustrerar önskade simuleringsstatusar;
de är inte bevis för en driftsatt mottagare eller ansluten fysisk tracker.

Den befintliga backendgrunden beskrivs i
[telematikdokumentationen](../../integrationer/telematik/README.md).
