# Digital testbil och virtuell FMC003

Byggd 2026-10-16, ÄL 128. Den godkända
[bildmockupen](../../mockups/testbil/README.md) är designunderlag.

## Öppna sidan

Efter deploy finns sidan på **`/testbil1`** på samma domän som ScrapPilot.
Ingen inloggning, fysisk tracker, API-nyckel eller ny Render-variabel behövs.
`jeroc.se/testbil1` fungerar först om den domänen faktiskt pekar på appen;
den här ändringen konfigurerar inte domäner eller DNS.

Varje webbläsarsession får en egen fiktiv testbil. Den börjar vid **Kontoret**
i Norrtälje med motorn av. Platsnamn, personer, resor, sensorvärden och
koordinater hör enbart till den syntetiska demonstrationen.

## Prova ett körvarv

1. Tryck **Starta bilen**. Motorn går på tomgång och en tändningshändelse skickas.
2. Välj **Kund 1**, **Kund 2** eller **Hem** och tryck **Kör till …**.
3. Följ bilen på kartan och hastighet, varvtal, bränsle och motortemperatur.
   **1×/5×/10×** ändrar den simulerade tiden, inte serverns tickfrekvens.
4. **Pausa körning** behåller resan och den aktuella positionen.
   **Fortsätt körning** återupptar samma resa.
5. Vid ankomst blir destinationen **Nuvarande plats**. Den går inte att välja
   som en ny körning. Servern kontrollerar detta även för direktanrop.
6. **Stäng av** stoppar motorn. Om det görs mitt på en rutt står bilen kvar
   **Längs vägen**, inte vid startplatsen eller den ännu ej nådda destinationen.
7. Välj en ny destination eller bekräfta **Nollställ testbilen** för att börja om.

Destinationerna är fasta, fiktiva platser. Rutterna följer handlagda punkter
och är inte navigationsanvisningar. Kartan använder OpenStreetMap med attribution;
en lokal illustrerad bakgrund finns om kartbilderna inte kan hämtas.

## Tre separata delar

**Testbil → virtuell FMC003 → syntetisk mottagare**

Bilmodellen räknar ut position och körsträcka längs rutten. Hastighet och
motorvärden varierar inom rimliga demogränser. Detta är konstruerade värden,
inte ett påstående om vad en viss verklig bil lämnar via OBD.

Den virtuella FMC003-modulen läser bilmodellens värden, skapar poster var
15:e simulerad sekund och försöker skicka var 30:e. Tändningshändelser
prioriteras. Posterna kodas som riktiga Codec 8 Extended-bytes med CRC och
FMC003:s AVL-enheter. Mottagaren använder den befintliga strikta avkodaren
och svarar med mottaget antal poster. Puckens kö töms efter godkänd kvittens.

Detta är en **lokal programkoppling i serverprocessen**. Det är inte ett
anslutningsprov via fysisk OBD, SIM, TLS eller publik TCP. Webbsidan styr
simulatorn via HTTP; varken webbläsaren eller simulatorn försöker ansluta till
en riktig tracker. Den separata telematikplattformen för produktion återstår.

### Täckning och mottagning

Tryck på **Ansluten** för att simulera utebliven mobiltäckning. Bilen fortsätter
köra och pucken köar mätpunkter. När täckningen återställs avkodas och kvitteras
de väntande paketen. **Mätpunkter**, **Paket** och **I kö** beskriver olika steg.
Bilens liveinstrument kan därför ändras medan mottagarens statistik står stilla.

Historik och buffert är begränsade. En full demobuffert ska ge ett uttryckligt
meddelande; den motsvarar inte en verifierad fysisk enhets minneskapacitet.

## Isolering och driftgränser

- Simulatorn importerar inga CRM-/tenanttjänster och skriver inte till riktiga
  fordon, kunder, arbetsordrar, databaser eller integrationer.
- Testsessioner ligger i begränsat processminne. De överlever vanlig omladdning
  inom samma session men försvinner vid serveromstart/deploy eller utgångstid.
  Det finns ingen beständig körjournal eller positionslagring för riktiga personer.
- Egen slumpad HttpOnly-/SameSite-cookie, CSRF och origin-kontroll skyddar
  kommandona. Alla API-svar har `no-store`.
- Högst 32 samtidiga testsessioner, 30 minuters inaktivitet och två timmars
  absolut sessionstid. Motorn stoppas efter 20 minuters sammanhängande
  verklig körtid. Kommandon, läsningar och nya sessioner har trafikgränser.
- Servern tickar aktiva modeller en gång per sekund. Vyerna uppdateras ungefär
  en gång per sekund när sidan är synlig. Ingen CRM-databasfråga görs per tick.
- Minnet är lokalt för en serverinstans. Detta är inte en lastbalanserad eller
  belastningstestad plattform för tusentals verkliga fordon.

## Kod och verifiering

- Bilfysik och platser: `server/telematics/testcar-model.mjs`.
- Virtuell tracker: `server/telematics/virtual-fmc003.mjs`.
- Isolerat HTTP-API: `server/telematics/testcar-api.mjs`.
- Dashboard och karta: `src/testcar/`.

Lokalt används repots vanliga `npm run build` och `npm run dev`.
Riktade serverprov finns i `server/telematics-*.test.mjs` och browserprov i
`tests/testcar.spec.ts`. Verifieringen omfattar bland annat ankomst/spärr av
nuvarande plats, paus/återupptagning, täckningsbortfall, avkodning/kvittens,
sessionsisolering, återhämtning och mobilvy.

Verifierat 2026-10-16: 65/65 riktade telematiktester, 5/5 browserfall och
`npm run build` passerade. Ett separat browserprov mot det byggda HTTP-systemet
verifierade riktig sessionscookie/CSRF, motorstart, körning och mottagna paket.
Detta är lokal programverifiering; fysisk tracker och Render-deploy ingår inte
i dessa prov.

Officiellt protokollunderlag:
[FMC003 AVL-fält](https://wiki.teltonika-gps.com/view/FMC003_Teltonika_Data_Sending_Parameters_ID),
[insamling](https://wiki.teltonika-gps.com/view/FMC003_Data_acquisition_settings),
[GPRS/kvittens](https://wiki.teltonika-gps.com/view/FMC003_GPRS_settings)
och [Codec 8 Extended](https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended).
