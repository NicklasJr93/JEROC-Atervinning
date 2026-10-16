# Digital testbil och virtuell FMC003

Byggd 2026-10-16, ÄL 128. Separat mottagare och lagring enligt ÄL 129. Den godkända
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
och sparar de godkända mätpunkterna i en separat databas. Först efter commit
svarar den med mottaget antal poster. Puckens kö töms efter godkänd kvittens.

Standardflödet är nu **HTTP till en separat Node-process**, med egen SQLite-fil
för enbart syntetiska uppgifter. Processen startas vid första testsessionen.
Mottagarkortet visar lagrade mätpunkter och de tio senaste mottagna värdena;
liveinstrumenten i bilen beskriver fortfarande bilens aktuella läge.

Det är inte ett anslutningsprov via fysisk OBD, SIM eller publik tracker-TCP.
HTTP är vår syntetiska transportadapter, inte ett protokoll som FMC003 skickar
direkt. Den tidigare lokala pilotens TCP-mottagare är separat och inte driftsatt.
En egen tjänsteadress kan anges senare utan att ändra bilen eller dess Codec.
[Drift, lagring och senare anslutning](mottagartjanst.md).

### Täckning och mottagning

Tryck på **Ansluten** för att simulera utebliven mobiltäckning. Bilen fortsätter
köra och pucken köar mätpunkter. När täckningen återställs avkodas och kvitteras
de väntande paketen. Sparade mätpunkter, kvitterade paket och väntande poster beskriver olika steg.
Bilens liveinstrument kan därför ändras medan mottagarens statistik står stilla.

Om själva mottagartjänsten är otillgänglig visas det separat från utebliven
biltäckning. Samma frysta paket försöks igen med väntetid mellan försöken.
Även en avstängd bil fortsätter försöka leverera sitt sista väntande paket.
Det finns ingen reservväg som låtsas ta emot eller spara när tjänsten är nere.

Historik och buffert är begränsade. En full demobuffert ska ge ett uttryckligt
meddelande; den motsvarar inte en verifierad fysisk enhets minneskapacitet.

## Isolering och driftgränser

- Simulatorn importerar inga CRM-/tenanttjänster och skriver inte till riktiga
  fordon, kunder, arbetsordrar, CRM-databaser eller ordinarie integrationer.
- Testsessioner ligger i begränsat processminne. De överlever vanlig omladdning
  inom samma session men försvinner vid serveromstart/deploy eller utgångstid.
  Puckens oskickade kö ligger också i minnet. Mottagarens redan committade
  syntetiska mätningar överlever dess processomstart om lagringsmediet finns kvar.
  Det finns ingen körjournal eller positionslagring för riktiga personer.
- Egen slumpad HttpOnly-/SameSite-cookie, CSRF och origin-kontroll skyddar
  kommandona. Alla API-svar har `no-store`.
- Högst 32 samtidiga testsessioner, 30 minuters inaktivitet och två timmars
  absolut sessionstid. Motorn stoppas efter 20 minuters sammanhängande
  verklig körtid. Kommandon, läsningar och nya sessioner har trafikgränser.
- Servern tickar aktiva modeller en gång per sekund. Vyerna uppdateras ungefär
  en gång per sekund när sidan är synlig. Ingen CRM-databasfråga görs per tick.
- En nollställning startar en ny syntetisk dataström. Tidigare committade
  mätningar ligger kvar tills strömmen gallras efter 24 timmars inaktivitet.
  De blandas inte med den nya bilens statistik. Gamla strömmar är inte en
  publik sökbar historik. Ingen körning återupptas automatiskt efter webbomstart.
- SQLite-filen är standard. Render Free har ingen beständig diskgaranti mellan
  deployer; då kan även testmätningarna försvinna. Egen beständig disk eller
  separat `TELEMATICS_DATABASE_URL` behövs för att behålla dem över redeploy.
- Detta är inte en lastbalanserad eller belastningstestad plattform för tusentals
  verkliga fordon. En egen process delar fortfarande värddatorns resurser.

## Kod och verifiering

- Bilfysik och platser: `server/telematics/testcar-model.mjs`.
- Virtuell tracker: `server/telematics/virtual-fmc003.mjs`.
- Isolerat HTTP-API: `server/telematics/testcar-api.mjs`.
- Transport/processstart: `server/telematics/demo-client.mjs`, `demo-runtime.mjs`.
- Separat tjänst/lager: `server/telematics/demo-main.mjs`, `demo-service.mjs`, `demo-store.mjs`.
- Dashboard och karta: `src/testcar/`.

Lokalt används repots vanliga `npm run build` och `npm run dev`.
Riktade serverprov finns i `server/telematics-*.test.mjs` och browserprov i
`tests/testcar.spec.ts`. Verifieringen omfattar bland annat ankomst/spärr av
nuvarande plats, paus/återupptagning, täckningsbortfall, avkodning/kvittens,
sessionsisolering, återhämtning och mobilvy.

Första versionen verifierades med 65 riktade telematiktester och fem browserfall.
Den utökade versionens aktuella verifiering finns i [mottagarguiden](mottagartjanst.md).
Detta är lokal programverifiering; fysisk tracker och Render-deploy ingår inte i proven.

Officiellt protokollunderlag:
[FMC003 AVL-fält](https://wiki.teltonika-gps.com/view/FMC003_Teltonika_Data_Sending_Parameters_ID),
[insamling](https://wiki.teltonika-gps.com/view/FMC003_Data_acquisition_settings),
[GPRS/kvittens](https://wiki.teltonika-gps.com/view/FMC003_GPRS_settings)
och [Codec 8 Extended](https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended).
