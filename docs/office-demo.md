# JEROC kontorsdemo 0.7.3

## Nytt i 0.7.3 – terminalfix och visuell guidning

Efter **Avbryt kundvisning** går det att visa en ny version på samma lediga
terminal utan att först ändra pris eller vikt. Det nya försöket får ett eget
utskicks-ID; återförsök av samma försök återanvänder sitt ID för att undvika
dubletter. Misslyckat utskick visar felet i terminaldialogen, som förblir öppen.
Den avbrutna versionen ligger kvar i historiken.

På öppna invägningskort får nästa tillgängliga moment en diskret pulserande
blå kontur. Övriga momentkort dämpas cirka 15 procent och går fortfarande
att använda. Guidningen följer sparade uppgifter och behörigheter; den lägger
inte till någon text som Börja här eller Nästa steg. Material, sammanställning
och spårbarhet behåller sin vanliga visning. Inställningen för minskad rörelse
ger en stilla kontur. Befintliga spärrar och attestregler gäller fortsatt.

**Miljö & mottagning** döljs på kort utan farligt avfall och visas när en sådan
artikel läggs till. Redan registrerade mottagningar visas fortsatt för
spårbarheten även om kortets artiklar senare ändras. Efter lyckad
mottagningsbekräftelse eller miljörättelse fälls ett expanderat kort ihop;
vid fel förblir det öppet. Fysisk mottagning är fortfarande oberoende av
kundgodkännande och utbetalning.

Eriks gamla textmarkör för privatperson ersätts en gång med ett syntetiskt
demo-personnummer. Egna kundnummer och redan låsta avräkningar bevaras.
Obekräftade miljöunderlag från det gamla Erik-exemplet kan därmed användas
utan samma formatfel. Valideringsfel för org-/personnummer visas på svenska;
formatkontrollen är ingen identitetsverifiering.

Denna release raderar inga kort, mottagningar eller historik. Mobil/Expo är
fortfarande en separat lokal demo och skickar inga invägningar till kontoret.
Utbetalning är manuell; Naturvårdsverket, BankID, SMS, e-post och Visma är
fortfarande inte anslutna. Befintlig databas och Renderinställningar återanvänds.

**Releasekontroll 0.7.3:** 35 riktade servertester, inklusive PostgreSQL,
och 24 riktade Playwright-kontroller passerade. Produktionsbygge och
Expo-typkontroll passerade. Oförändrad omsändning, felåterförsök, miljörättelse,
hopfällning, villkorlig visning, guidning och bevarade kundsnapshot ingår.

## Nytt i 0.7.2 – artikelrader och arbetsköer

**Lägg till artikel** vid materialrubriken öppnar artikelval och vikt på ett
öppet invägningskort. Behörigheten **Lägga till artiklar på öppna invägningar**
är separat från att ändra artikelregistret. Kajsa får den en gång; VD och
systemadmin har den enligt befintliga regler. Återkallade rättigheter bevaras.
Serverns prismotor räknar raderna, befintliga manuella priser bevaras. Dolda
eller otillgängliga priser markeras som ej färdigberäknade. Kort som väntar
på kund, är godkända, attesterade eller utbetalda kan inte få nya materialrader.

Prova på **2053**: Lägg till artikel → Blybatterier → ange vikt → Lägg till.
Miljökortet visas då med den nya farliga avfallsraden. Befintlig mottagning
på 2050 bevaras och ändras genom **Rätta miljöuppgifter**, aldrig nollställning.
Kontorets invägningskort är fortfarande lokala demokort; miljömottagning och
kundgodkännande lagras gemensamt på servern. Detta är ingen ny produktionsauth.

Menyn heter **Kundgodkännande**, med samma ikonstorlek som övriga menyval.
Arbetsköerna, inklusive Rättelser, visar blå markör endast när aktiva kort finns. Markörens
antal kommer från samma filter som kön; historik räknas inte.

**Releasekontroll 0.7.2:** 117 servertester inklusive PostgreSQL passerade.
Hela Playwright-sviten med 150 kontroller passerade, följt av nio riktade
kontroller för artikelrader, nya registerartiklar, meny och migration.
Produktionsbygge och Expo-typkontroll passerade; popupen granskades visuellt.

## Nytt i 0.7.1 – kompakt miljökort

Miljösessionen följer automatiskt valt kontorsdemokonto och **Jobba som**.
Den extra anslutningsrutan är borttagen. Servern kontrollerar fortfarande
behörigheter, anläggningar och faktisk/utförande användare.

**Miljö & mottagning** ligger under kundgodkännandet, med kompakt sammanställning
och redigering per rad. Ursprungsadressen återanvänds från viktkortet och
kommunkoden hämtas vid en säker adressmatchning. Miljöutkast sparas gemensamt
utan lagerpåverkan. Bekräftad mottagning kan rättas med en ny spårbar version;
originalet bevaras och bara mängdskillnaden justerar lagret. Dokumentnummer är
valfritt, medan dokumentstatus skiljer på finns, undantag, saknas och ej kontrollerat.
Denna uppdatering raderar inga tidigare kort eller mottagningar.

**Releasekontroll 0.7.1:** 117 servertester inklusive PostgreSQL 18, samtliga
145 Playwright-kontroller, produktionsbygge och Expo-typkontroll passerade.
Den kompakta vyn har också granskats visuellt.

## Etapp 1 i 0.7.0 – miljö och mottagning

**Miljö & avfallsklassificering** finns på artikelkortet. **Miljö & mottagning**
finns på invägningskortet och **Miljörapportering** i vänstermenyn. Uppgifterna
lagras gemensamt i PostgreSQL på Render, eller lokal SQLite vid utveckling,
med serverkontrollerade miljösessioner och
anläggningsbehörigheter. Naturvårdsverket är ännu inte anslutet.

Gamla demoinvägningar, deras betalningar/rättelser och kundgodkännanden ersätts
en gång med nya kort **2050–2053**, utan förifylld attest eller betalning.
Kunder, användare, terminalkonton och förval bevaras. Detta nya uttryckliga
resetbeslut ersätter äldre bevarandebeskrivningar för just testkorten.
Se [etapp 1 – provflöde, lagring och återställning](integrationer/naturvardsverket/etapp-1.md).

**Releasekontroll 0.7.0:** 85 servertester passerade, inklusive faktisk
PostgreSQL 18 mot separat lokal testdatabas, samt produktionsbygge och
Expo-typkontroll. 135 olika Playwright-kontroller är verifierade: 134 i
fullsviten, därefter samtliga 16 kontroller för kortvy, arbetsköer, uppdatering
och kontorsflöde efter rättning/normalisering av ett ofullständigt låst
testkort. Miljöpanelerna har även granskats visuellt. Naturvårdsverket har
inte anropats; myndighetsleverans byggs först i en separat godkänd etapp.

## Befintliga kontorsfunktioner

Öppna https://jeroc-atervinning.onrender.com/kontor. Samma repository och Render-tjänst används. Befintligt byggkommando, `npm start` och Expo-token behålls. Mobilappen är fortsatt version 0.2.3 på `/`; Expo Go fungerar som tidigare.

[Skärmbilder från version 0.2.0](office-demo/v0.2.0/README.md)

[Kundterminaler: Render-databas, terminalkonton och test från mobil](terminal-demo.md)

## Kompakt kortvy 0.6.1

Invägningskortet följer [den godkända mockupen](mockups/kontor/13_Invagning_Kundgodkannande_Attest_Sparbarhet.png): material/priser, kund/referens/ursprung och utbetalning ligger överst. Kundgodkännande, intern attest och sammanställning har egna rutor i full bredd under. Spårbarheten behåller den lodräta händelselistan med senaste händelsen överst; hela sidan scrollas när historiken blir lång.

**Ny kund** öppnar ett grundformulär på kortet. Spara och välj kund kopplar kunden direkt och beräknar artikelpriserna. Öppna fullständigt kundformulär tar med ifyllda uppgifter och återvänder till samma invägning efter sparande. Behörigheter och kontroll mot befintliga organisations-/personnummer gäller i båda formulären.

Kundgodkännande kan startas först när kunden, priserna, betalningsuppgifterna och en **sparad ursprungsadress** finns. Referens är valfri; osparade ändringar i referens/ursprung måste sparas före kundvisningen. Den separata ID-knappen under betalning är borttagen. Fysisk legitimation bekräftas genom kundgodkännandet på den aktuella versionen.

Behörig personal kan **Attestera direkt på kortet** efter kundgodkännande. Attestgräns och egenattest kontrolleras fortsatt; terminalärenden attesteras på servern. Kundvisning och attest behåller den öppnade sidan och huvudmenyn, medan arbetsköerna uppdateras. Alla nya demokort börjar före kundgodkännande och intern attest.

Profilen och Systemadmins **Jobba som** finns längst ner i vänstermenyn. Sidhuvud, terminal-/anläggningsväljare, sökfält och arbetsköer är kompaktare. Utbetalning förblir manuell; SMS, e-post, BankID och Visma är inte anslutna. Befintlig Render-databas och miljövariabler återanvänds; inga nya inställningar behövs för denna uppdatering.

## Kundterminaler och kundgodkännanden

Systemadmin kan skapa terminalkonton under **Terminaler**. Kunden öppnar `/terminal` på mobil, iPad eller touchskärm och loggar in med ett eget terminalkonto. Kontoristen visar en fryst avräkningsversion på en ledig terminal på kortets anläggning. Kundens begäran om fysisk ID-kontroll måste bekräftas av behörig personal innan kortet går till intern attest. **Kundgodkännanden**, mellan Invägningar och Attest, samlar Aktiva/Historik och uppdateras från gemensam serverlagring. Anläggning och personligt terminalförval kan väljas i överdelen.

På Render kräver terminaldelen PostgreSQL och servervariabeln `DATABASE_URL`. Lokalt används `.data/terminal-demo.sqlite` om PostgreSQL inte konfigurerats. Ingen tillfällig disk- eller minnesreserv används för terminalärenden på Render. Efter engångsåterställningen av gamla testkort bevaras nya lokala viktkort och kopieras till terminaltjänsten vid kundvisning. Kontorets användarval är fortfarande uttrycklig demoautentisering; miljöfunktionernas cookie-session följer valt demokonto automatiskt. BankID/SMS/e-post/Visma är inte anslutna; betalning fortsätter som manuell demoregistrering. Se [terminaldokumentationen](terminal-demo.md) för installation, lagringsgränser och testflöde.

## Prova uppdateringen

- **Kajsa Nilsson:** granska viktkort, koppla kund, referens/ursprung, ID och betalningsuppgift. Läsa LME Cash, men inte ändra referenspriser eller artikelregler. Kundval räknar priset via servern. Knappen Beräkna priser uppdaterar ett redigerbart kort enligt reglerna på inlämningsdagen.
- **Anna Nilsson:** attest högst 25 000 kr, egen attest spärrad, demoutbetalningar och läsning av miljöunderlag. Kort måste först ha giltigt kundgodkännande. De nya korten 2050–2053 har ingen förifylld attest. Ingen LME-behörighet.
- **Lars Andersson (VD):** verksamhetsmoment, artikeladministration, manuella LME-priser, kundprisregler och användare. Attest högst 100 000 kr. Kan inte ändra systemadmin eller tilldela en högre attestgräns än sin egen.
- **Systemadmin:** öppna profilmenyn längst ner till vänster och välj **Jobba som**. Den valda användarens menyer, moment, maxbelopp och egenattestregel gäller. Historiken visar både inloggad och utförande användare. Avsluta Jobba som återställer systemadminläget.

Översikten har arbetsköer, snabbåtgärder, dagstatistik och en förhandsvisning när ett kort väljs. Attest och utbetalningar har egna nyckeltal och statusfilter. Användare med rapportbehörighet kan exportera den filtrerade kön som CSV; materialpriser respekterar prisbehörigheterna.

## Transportplanering

Välj **Transportplanering** i kontorsmenyn, eller öppna `/kontor#/transport`. Kajsa får läsa och planera; Anna får läsa. VD och Systemadmin har full åtkomst. **Läsa transportplanering** och **Skapa, boka och ändra transporter** är separata behörigheter; planera kräver även läsa. Äldre demokonton får dessa rättigheter en gång, så senare borttagna behörigheter återställs inte vid omladdning. Jobba som gäller även i transportvyn.

Arbetsvyn fyller skärmen med en OpenStreetMap-karta, planerare och obokade arbeten. Dagvyn har horisontell tid och veckovyn vertikal tid. Klicka på hela förar-/fordonscellen i planeraren för att välja eller välja bort förare. Flera förare kan väljas samtidigt. Andra förares nålar döljs helt på kartan; kalenderns arbeten ligger kvar. Kärlfilter, datum och Visa avslutade styr kartan och planeraren tillsammans. Ytan mellan karta och planerare kan dras, och endast karta eller endast planerare kan väljas.

Nålens kontur visar förare och fyllningen visar kärltyp. Obokade nålar har streckad kontur och en kort skakning med paus; bokade nålar är stilla. Klickytan ligger still, och reducerad rörelse stänger av skakningen. Muspekaren eller tangentbordsfokus markerar samma arbetsorder på kartan, i kön och i kalendern utan att flytta kartan. Klick öppnar samma detaljpanel med kund, adress, kärl, material, kontakt, bokning och historik. Klick på samma nål eller kalenderkort igen avmarkerar arbetsordern och återgår till kön, även om den valdes i den andra vyn. Visa på karta och Visa i planeraren flyttar fokus uttryckligen.

Skapa arbetsorder för hämtning, byte eller utställning. Ny tidsåtgång är en timme och kan ändras i steg om 15 minuter. Kundregistret kan användas, eller en kontakt anges manuellt. Adressökning använder Nominatim; platsen kan också väljas direkt på kartan. Ändrad adress kräver en ny platskontroll. Vecko-/tvåveckorsintervall skapar fyra förekomster i demot; framtida förekomster kan redigeras tillsammans utan att påbörjade eller klara uppdrag ändras.

Dra ett obokat arbete till kalendern för förhandsvisning av förare och tid. Efter släpp ligger det kvar som ett ljusrött preliminärt kort och försvinner från obokade listan. Flera arbeten kan placeras, flyttas och ändras innan **Bekräfta bokning** eller **Verkställ bokningar (antal)** verkställer hela gruppen. Preliminära kort sparas vid omladdning och kan tas bort tillbaka till kön. Formulärets nya bokningar följer samma flöde. Krockkontrollen räknar både preliminära och verkställda bokningar. Flytta en bokning genom att dra kortet; bara ett kort visar den föreslagna tiden under dragning och tidsändring. Dra högerkanten i dagvyn eller nederkanten i veckovyn för att ändra sluttid; början ligger kvar. Ändring och Ångra sparas med vem som gjorde dem. Förare och fordon får inte dubbelbokas, och fordonets tillåtna kärltyper kontrolleras. Avbokning behåller arbetsordern i kön. Påbörjade, klara och avbrutna uppdrag låser planeringen. Avbryt arbetsorder kräver orsak och behåller underlag och historik.

Närhetsförslag visar avstånd fågelvägen till en synlig bokning hos vald förare. Boka före/efter lämnar ett justerbart mellanrum på 15 minuter; körväg och verklig restid beräknas ännu inte. Transportdemot använder fiktiva platser i Norrtälje och sparas separat i webbläsarens `jeroc.transport.demo.v1`. Andra flikar uppdateras vid ändring. Andra datorer, förarappar och kundens verkliga kärlregister kopplas först när gemensam lagring byggs. Kartbakgrund och adressökning kräver internet; arbetsorder och kalender kan användas även om kartbakgrunden inte laddas.

Integrationshändelser för skapande, bokning, ombokning, avbokning, avbrott, på väg och slutfört skapas först när ändringen verkställts. Varje händelse har ett unikt ID, kund, förare, tidigare/ny plan och ansvarig faktisk/utförande användare. Ångra behåller händelsehistoriken. Händelser sparas lokalt och förbereds i serverns minnesbaserade utkorg med återförsök och samma ID. Leveransadaptern är avstängd; inga meddelanden skickas.

Arbetsorderns detaljpanel kan förbereda en bokningsförfrågan med svarstid och visa kundens Ja/Nej-vy i demon. Kundens svar har en egen status och ändrar inte bokningsstatus automatiskt. Bokningsversion och giltighetstid avvisar gamla svar; ändrad tid, kund eller bokningsuppgifter gör tidigare förfrågan inaktuell. Riktiga publika svarslänkar, databas och SMS-/e-posttjänst kopplas in senare.

Viktkort visar material, prisregel och kundvolym per artikel under senaste 12 månaderna. Kontaktuppgifter, referens och ursprungsadress ligger under kundkortet; betalning ligger i en kompakt egen del. Referens/ursprung kan användas först efter kundval. Ursprungsadress måste fyllas i och sparas innan kundgodkännandet startas; referens är valfri. Ofullständiga utkast kan sparas. Fordonsunderlaget visar infart, utfart, netto före avdrag och slutvikt.

## LME, artiklar och kundpriser

LME Cash skrivs manuellt i USD/ton tillsammans med USD/SEK och datum då priset börjar gälla. Referensen i SEK/kg är `Cash × USD/SEK / 1000`. Historiken behåller tidigare registreringar och vem som ändrade dem. Det finns separata behörigheter för att läsa och ändra LME; ändra kräver också läsa.

Artiklar & priser har kategorifilter, sökning, materialbilder, A/B/C-priser och artikelinställningar. Ny artikel och ändringar sparas på servern. Artikeln har referensbilder, ingår/ingår inte, kategori, aktivstatus, LME-metall eller manuell bas, ABC-formler och B/A-volymgränser. Prisförhandsvisningen visar formlerna innan de sparas. Ändringar får ett giltighetsdatum.

Kundpriser är en egen flik: fast kr/kg, tillägg/avdrag i kronor mot en vald ABC-lista eller eget procentavdrag från LME. Ett aktivt kundundantag går före volympriset. En prisregel kan avslutas från valt datum, så ordinarie volympris används igen.

Volym räknas per kund och artikel över rullande tolv månader. Alla rader med samma artikel på aktuell leverans räknas ihop. Den aktuella leveransen ingår i prisnivån: en ny kund som lämnar 101 kg får A när artikelns A-gräns är 100 kg. Annan artikel påverkas inte. Inlämningsdagen i svensk tid styr vilken historisk prisregel som används.

Serverns demovolym kommer från registrerade prisunderlag. De tidigare färdigställda exemplens volym ingår inte längre; nya kort börjar utan ekonomisk historik. Lokala gårdsutkast och andra telefoners vägningar kommer inte in förrän gemensam lagring och synkning byggs.

## Prisunderlag och spårbarhet

När underlaget visas för kundgodkännande sparar servern en oföränderlig prisögonblicksbild. Senare LME- eller artikeländringar ändrar inte den. Manuella ABC-val och engångspriser sparas med pris före/efter i viktkortets historik. Om ett kundgodkänt kort behöver prisändras återkallas godkännandet och kortet återgår till komplettering. En ny version måste sedan visas för kunden. Gamla versioner finns kvar och volym dubbelräknas inte.

Attest kontrollerar maxbelopp och egen attest. Låsta kort flyttas mellan **Invägningar**, **Attest** och **Utbetalningar**, med egna flikar **Aktiva** och **Historik**. Invägningarnas historik kan söka alla kort. Öppning och tillbakagång behåller rätt huvudmeny, filter och sökning.

## Kunder, betalningsval och saldo

Kundlistan söker även kundnummer och registreringsnummer, filtrerar kundtyp och visar faktisk aktivitet. Kundkortet har **Översikt**, **Vägningar**, **Priser**, **Uppgifter & betalning** samt **Rättelser & saldo**. Kontaktuppgifter, referenser, ursprungsadresser, registrerade fordon och betalningsprofil kan sparas av behörig personal. Tolvmånadersstatistiken räknar frysta inlämningar och godkända rättelser; påbörjade underlag visas som öppna kort. Artikelvolym och prisnivå hålls separata per artikel.

Betalningsrutan på invägningskortet har **Bankkonto**, **Swish**, **Kontant** och **Spara på saldo**. Det sista alternativet ersätter Kreditfaktura i tidigare mockuper. Bank- och Swish-fält valideras och kundens sparade profil kan hämtas. Manuell ID-kontroll bekräftas i kundgodkännandet på respektive version. Ett kort med Spara på saldo blir efter attest ett låst saldokort utan betalningspost. Från historiken kan beloppet senare demoutbetalas med ett faktiskt betalningssätt. Originalets val bevaras.

Ett rättelsekort innehåller originalkort, material, plus/minus kg, orsak och underlag. Efter granskning skickas det för attest. Godkännande kontrollerar beloppsgräns, egen attest och återstående materialmängd. Minus justerar saldo och kundstatistik. Plus skapar ett separat klart utbetalningskort och påverkar statistiken en gång. Volymen korrigeras vid originalets inlämningsdatum. Originalkortet redigeras aldrig.

Vid nästa demoutbetalning kvittas kvarvarande minussaldo; nettobelopp och hänvisningar till rättelser visas. Kvittningen är en informationspost och dras inte av från saldot en gång till. Godkännanden och betalningsregistreringar tål upprepade anrop utan dubbelposter.

Låsta kort har **Avräkningsnota** och betalda kort har **Utbetalningskvitto**, med en utskrivbar A4-vy. Välj Skriv ut / spara som PDF i webbläsaren. Företagsuppgifter och bokföringsunderlag är märkta demo; momsregler och konton behöver beslutas före skarp drift.

## Lagring och avgränsning

Prisregler, LME, kundundantag, serverbehörigheter, prisarkiv och transporternas demoutkorg ligger i **serverns minne**. De delas mellan kontorswebbens besökare och återställs till exempeldata när Render startar om eller publicerar en ny version. Terminaldelen lagrar däremot terminaler, sessioner, frysta avräkningar och kundgodkännanden i gemensam PostgreSQL/SQLite, enligt [terminaldokumentationen](terminal-demo.md). Miljöklassificeringar, miljösessioner, utkast, mottagningar, miljörättelser, lager och rapportunderlag lagras också beständigt, enligt [etapp 1](integrationer/naturvardsverket/etapp-1.md). Övriga viktkort, kunder, rättelsekort, betalningsjournal och lokal användarvy sparas separat i webbläsarens `jeroc.office.demo.v1`; kontorister tar också emot gemensamma terminalkort från servern. Full migration av hela ekonomiregistret är inte genomförd i denna demo.

Kontorets vanliga demokonton är valbara exempel; de befintliga demo-API:erna kontrollerar rättigheter för dessa identiteter, men användarvalet är inte en produktionsinloggning. Miljöfunktionerna använder en automatiskt etablerad cookie-session för valt demokonto; den är uttryckligt demoautentisering och kan stängas av på servern med `JEROC_DEMO_AUTO_SESSION=false`. Sparade lokala kunder kan behöva registreras i prismotorn av kontoret igen efter en serveromstart; gamla frysta prisunderlag återställs bara när de stämmer exakt med låsta originalkort. Använd enbart testuppgifter. Lokal användarkonfiguration kan behöva sparas på servern igen efter en omstart. Återställ kontorsdemo återställer bara webbläsarens kontorsdata, inte serverns gemensamma priser, miljömottagningar eller mobilens sparade kort.

Mobilens prislista är ännu inte kopplad till servern. Gårdsappens vägningar och konton synkas inte till kontoret. Ingen bank, Swish eller Visma är ansluten. Registrera demoutbetalning skickar ingen transaktion. Utskrift är ett märkt demounderlag.

## Utveckling och kontroll

`npm ci`, `npm run build`, sedan `npm run dev` startar Vite på 5173 och prismotorn på 3000. Vite skickar API-anrop till Node. Windows_Starta_JEROC.cmd och Mac_Starta_JEROC.command installerar och startar samma Node-tjänst lokalt på 4173; öppna `/kontor` för kontorsdemon. `npm start` serverar produktionsbygge och API i samma process; `npm run preview` visar bara det statiska bygget och saknar prismotorn.

Kör `npm run test:server`, `npm test -- --workers=1`, `npm run build` och `npm run expo:check`. Starta utvecklingsservern med färsk demodata före en ny full testomgång; API-testerna delar serverns minne och några ändrar hela användarregistret. Kör dem i följd för att undvika krockar mellan testkonton. Pristesterna omfattar Cash/valuta, historiska datum, volym per artikel inklusive aktuell leverans, kundundantag, oföränderliga/versionerade prisunderlag, rättelseposter och serverns demobehörigheter. Webbtesterna omfattar kontorsflödet, Jobba som och attestgräns, LME läs/ändra, sparad prissättning och fortsatt mobilflöde.

Releasekontrollen omfattar ursprungsadress före attest, preliminära gruppbokningar, flytt/tidsändring, avbruten dragning, förarurval, avmarkering, kundsvar, händelsehistorik, serverutkorg och återförsök. Verifierat för 0.5.0: 115 Playwright-kontroller (112 i hela sviten och tre tillägg), 47 servertester, produktionsbygge och Expo-typkontroll.

Verifierat för **0.6.1**: 129 olika Playwright-kontroller, 64 servertester, produktionsbygge och Expo-typkontroll. Hela Playwright-sviten gav 128 godkända kontroller; en ny geometrikontroll mätte sökfältets inre input i stället för hela kontrollen. Efter rättning passerade alla fyra arbetskötester. Sparad ursprungsadress före kundgodkännande, terminalflöde, attest på samma kort, attestgränser och prisbehörigheter ingår. Kundpopupens fokus och koppling till kortet, övergång till fullständigt formulär, avbruten kundregistrering, profilmeny och växande lodrät spårbarhet har också verifierats. Kortlayout, sidhuvud och arbetsköfält har granskats i webbläsaren vid 1440 och 2056 pixels bredd.

Verifierat för v0.3.0: 54 Playwright-tester (22 mobilflöden, 20 kontorsflöden och 12 rena modelltester), 38 servertester, produktionsbygge och Expo-typkontroll. Kundkortets fem flikar har granskats i webbläsaren utan JavaScriptfel eller sidöverflöde. Avräkningsnotan verifierades som en A4-PDF på en sida. Rättelser i båda riktningar, saldokvittning, historik, egen attest och unika rättelse-ID och komplettering av äldre rättelseutkast ingår i kontrollerna. Ett mobiltest kördes om efter en kollision i testverktygets artefaktmapp och passerade. Startfilerna har inte körts på Windows eller macOS här.
