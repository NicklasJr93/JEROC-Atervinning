# Fordon, GPS-enheter och körjournal – ÄL 130

Kontor 0.30.0, mobilwebb 0.13.0. Implementerat 2026-10-16 efter de godkända [bildmockuperna](mockups/fordon-telematik/README.md).

## Var delarna finns

- **Kontoret → Fordon & maskiner:** fordonsöversikt med sökning, anläggning, status och kommande åtgärder. Ett fordonskort har grunduppgifter, förare, service/besiktning, fel, dokument, körjournal och historik. Rubrik och flikar följer den gemensamma sticky-mallen.
- **Karta:** visar tillgängliga tjänstepositioner med datakälla och tidpunkt. Privata och oklassificerade positioner lämnas inte till kontoret. Saknade sensorer visas som okända.
- **Körjournal:** serverfiltrerad historik med sidor, detaljpanel och PDF/CSV-export. Perioder följer svensk kalenderdag. Exporten omfattar hela urvalet, inte bara sidan, och avvisar urval över 1 000 resor så att ingen tyst trunkering sker. Ofullständiga uppgifter ger ett tydligt utkast.
- **GPS-enheter:** sekundär flik med redan tilldelade enheter, kopplingar, flyttar och historik. Bolaget väljer befintligt fordon i dropdown och bekräftar. Ingen appaktivering eller QR-kod.
- **Systemadministrationen:** separat enhetsregister med modell, IMEI, profil och valfria SIM-uppgifter. Testsändare väljs uttryckligen och får ingen fysisk IMEI. Plattformens egen systemadmin registrerar och tilldelar enheter till aktiva bolag.
- **Appens Hem → Fordon & resor → Mitt fordon:** aktuellt tilldelat fordon, nästa förare, egen kontroll, fel med foto och Mina resor. Detta kompletterar den befintliga bottenmenyn.

## Ett gemensamt fordonsregister

`state.transport.vehicles` är fortfarande det enda fordonsregistret. Befintliga ID:n, förarkopplingar, arbetsordrar och transporthistorik bevaras. `state.fleet` lägger till profiler, service, bilagereferenser, resor och enhetskopplingar; den skapar inte en parallell fordonslista.

Personalens tidigare separata registerhantering länkar till Fordon & maskiner. Samma kontrollerade fordonseditor återanvänds vid skapande från en person. Även maskiner utan registreringsskylt stöds med inventarienummer eller intern identifiering.

Kärl- och transportkrav använder samma fordons-ID och dess stöd för kärltyper. Driftspärrade eller inaktiva fordon får inte nytilldelas/bokas eller påbörja körning. En verkstadsbokning med start och slut reserverar fordonet under intervallet; enbart en påminnelses förfallodatum spärrar inte all planering. Planerade tider tolkas i Europe/Stockholm, även vid sommartidsbyte. Redan sparad historik skrivs inte om.

Att markera service utförd eller fel åtgärdat häver aldrig en uttrycklig driftspärr. Hävning är en separat behörighetskontrollerad åtgärd med orsak.

## Föraren och resekompletteringen

Standardförare väljs uttryckligen per fordon. Ett aktivt val för nästa resa kan ersätta standarden under just den resan. Källorna skiljer standard, app, kontor, faktisk panel och okänd förare. Ett kontorsval påstår aldrig att ett RFID-blipp observerats.

Okänd eller motstridig förare hanteras i kontorets separata granskning. Tilldelning behöver en orsak och bevarar ursprunglig källa och spårbarhet. Att logga in tilldelar inte automatiskt en okänd resa till användaren.

När appen öppnas eller åter blir aktiv hämtas egna avslutade resor med saknade uppgifter, oavsett datum. Senaste visas först. Kortet ligger kvar medan föraren skriver; nya resor får inte kasta bort inmatningen. Vanligt arbete och navigation blockeras tills kön är klar. Det finns ingen Senare-knapp. Ingen sådan interaktion framtvingas medan föraren har en pågående resa.

Tjänst kräver ett konkret syfte eller en tillgänglig uttryckligen vald arbetsorder. Privat rensar tjänstesyfte och orderkoppling. Endast bekräftad serverlagring går vidare till nästa kort; fel eller osäkert svar behåller inmatning och samma anrops-ID. Stopp, utstämpling, tidregistrering och utloggning förblir möjliga servervägar.

Kontoret kan läsa tjänsteuppgifter men inte omklassificera en annans privatresa för att få se rutten. Efter omplacering försvinner aktuell fordons-/bilageåtkomst; föraren kan ändå läsa och komplettera sina egna historiska resor.

## Behörigheter och lagring

Kontoret har separata rättigheter för `fleetRead`, `fleetWrite`, `fleetExport` och `fleetUnblock`. Både faktisk och vald användares rättigheter och anläggningar kontrolleras på servern. VD och systemadmin följer befintlig rollmodell. Äldre registerbehörigheter fortsätter fungera för befintliga fordonskopplingar; de innebär inte automatiskt åtkomst till den nya körjournalen.

Appen använder den riktiga personalkakan och egen anställdprofil, aldrig en föraridentitet från klienten. Ett ogiltigt konto får ingen reservväg via demoheaders. Bolags-/sessionsbyte gör föråldrade anrop ogiltiga.

Kommandon använder revisionskontroll, transaktioner, anrops-ID och historik. Samma sparande kan återläsas efter tappat svar; ett ändrat innehåll kan inte återanvända anropsnumret. Filer lagras utanför CRM-aggregatet i ett separat, bolagsbundet binärlager. SQLite använder `fleet-files.sqlite` i respektive bolags datakatalog; PostgreSQL använder separat filtabell i bolagets databas/schema. Bilder valideras och storleksanpassas, PDF-struktur kontrolleras, och varje läsning behöver aktuell behörighet. Filnamn/URL ger ingen publik åtkomst.

## Prova med testbilen utan fysisk puck

1. Öppna **Systemadministration → Telematikenheter**, registrera en **Testsändare** och tilldela den önskat bolag.
2. Arbeta som bolaget. Under **Fordon & maskiner**, välj ett befintligt fordon, anläggning och uttrycklig standardförare med aktiv personalinloggning.
3. Öppna `/testbil1` i samma webbläsare med motorn av. I **Använd testbilen i ett bolag** väljer behörig administratör den tilldelade testsändaren och ansluter. Den första kvitterade motor-av-observationen gör kopplingen möjlig.
4. Under bolagets **GPS-enheter**, välj rätt fordon och bekräfta kopplingen. Starta sedan testbilen, kör till en annan av de fiktiva platserna och stäng av motorn.
5. Invänta kvittens. Resan visas i körjournalen med simulerad källa. Logga in som standardföraren i appen och komplettera resan. Privat skyddar rutten från kontoret; tjänst med syfte blir ett användbart exempel i exporten.
6. Före frånkoppling ska motorn vara av och sista paketet kvitterat även i bolagslagret. Vid utloggning/bolagsbyte återupptas ingen gammal skrivbehörighet automatiskt. Återgå till samma bolag och välj **Återanslut** uttryckligen, låt sista paketet levereras och koppla sedan från. Nollställning kräver först säker frånkoppling.

Testpucken skickar verkliga Codec 8E-bytes till den separata HTTP-/SQLite-mottagaren. CRM-bryggan använder bara avkodade och kvitterade serverskapade paket. Ett misslyckat CRM-commit lämnar paketet i kön för säkert återförsök. Beständig enhetslease hindrar två testbilar från att samtidigt använda samma testsändare.

Den accelererade testbilens tid omvandlas uttryckligen till en ordnad syntetisk mottagningstid. Den är ingen verifierad verklig körtid eller modell för hur offline-hårdvarans händelsetid ska tolkas. För verkliga enheter behålls kontrollen av felställd klocka.

## Puckbyte

[Detaljerad rutin](integrationer/telematik/enhetskoppling.md): Påbörja byte stänger gammalt intervall och reserverar målet. Under flytt skapas inga resor på det nya fordonet. Efter fysisk flytt krävs ny motor-av-observation och separat bekräftelse. Omladdning bevarar flyttläget. Återgång kräver uttrycklig återinstallation och ett nytt intervall. Sena poster hänförs till historisk koppling eller granskning; gamla bilens mätarvärde/förare följer inte med.

Bolagsöverlåtelse är avsiktligt spärrad i det vanliga registret. En tilldelad fysisk enhet kan inte bara flyttas till ett annat bolag med en dropdown.

## Verifiering och kvar före fysisk drift

- **87/87** riktade serverprov i `server/fleet*.test.mjs`, `server/platform-fleet.test.mjs` och `server/personnel-fleet-gate.test.mjs`.
- **35/35** kritiska browserfall: kontorets fleet 7, mobil/testbil 14 samt Hem/stämpelklocka/bolagsseparerad cache 14. Därutöver riktade regressioner för gamla fordons-/planeringsberoenden.
- `npm run build` och `npm run expo:check` godkända.
- Befintliga beroenden: transportmodellen **41/41**, personal/fordon **8/8**, utrustning **4/5**. Utrustningens återstående kontorsklick skyms av en sticky-rubrik i mobilviewport; samma fel reproducerades med både tidigare HEAD-produktionskod och tidigare test på separat Vite-server. Det är en kvarstående separat layoutregression, inte en godkänd full utrustningssvit.
- Samlad serversvit: **1 303 tester, 1 249 pass, 45 skip, 9 fail**. Alla nio fel har körts separat mot både denna kod och den oförändrade basen `eab634b`; de återkommer identiskt före fleet-ändringen. Det gäller transportens gamla adressfixture, tre miljökortsflöden, läsprojektionsdomäner, mejldomänens generiska läsning, miljökvitto i materialflödet, mobilens anläggningsfixture och ett närvarotests förväntade statuskod. De är kvarstående separata regressioner; hela projektsviten är inte grön.

Äldre tester som kör kontoret med enbart demoheaders/snabbknapp utan plattformssession behöver uppdateras för nuvarande autentisering innan de kan ingå i en full browserkörning. Åtkomstkontrollerna har inte slagits av för att få dem att passera. Tre andra äldre testfixturer rättades med giltig personidentifierare, explicit anläggningsscope och säkrare cleanup; ekonomins produktionskod ändrades inte.

Riktade server- och browserprov täcker verkliga egna cookies, bolags-/objektåtkomst, omplacering, skyddad filhämtning, transaktionsfel, revisionskonflikter, dubbletter, verkstadsintervall, svensk sommartid, äldre chaufförsvägar, semilås och återhämtning. Testbilsbryggan är provad med separat riktig HTTP-process och SQLite, inklusive commitfel och utloggning.

Fysiskt FMC003/FTC134-prov, publik säker mottagartransport, APN/firmwarekonfiguration och framtida RFID/knapppanel återstår. En registrerad fysisk enhet innebär inte automatiskt en ansluten tracker. Ingen sådan anslutning eller betalad infrastruktur skapas av denna release.

Denna testintegration är ingen kapacitetsgaranti för tusentals fordon. Den separata mottagarens PostgreSQL-väg, produktionsretention, backup/återställning, inkrementell bearbetning, övervakning och belastningsprov behöver slutföras inför stor fysisk drift. Befintlig beständig disk/databas krävs fortsatt för att filer och syntetiska mätningar ska överleva server-/deploybyten.
