# JEROC · Mobilappen

**Mobilwebb 0.5.1, Expo-skal 0.3.0 och kontor 0.18.0** delar verksamhetsdata i PostgreSQL. Utkast, kunder, färdiga mobilvägningar, kontorskort, prisregister, artikelgrupper, egna artikelbilder, planering och integrationsutkorg sparas beständigt. Kontoret styr mobilens materialmeny, bilder och instruktioner. Färdiga mobilvägningar visas på kontoret. Kontoret har även personal, schema, kompetenser och bemanning samt extern chaufförsvy på `/chauffor`. Personal och konton hanteras tillsammans; en ny person kan få ett kopplat konto vid samma sparning.

Detta är fortfarande en demo. Mobilappen använder personlig serverinloggning; kontoret har valbara exempelkonton. Använd testuppgifter. NVV:s testmiljö och Spiris sandbox kan anslutas med serverns integrationsinställningar. Utbetalningar registreras manuellt; bankbetalning, SMS, e-post och BankID är ännu inte aktiverade.

[Gemensam databas och säker import](docs/shared-postgres.md) · [Kontorsversionen](docs/office-demo.md) · [Artikelgrupper och bilder](docs/article-catalog.md) · [Personal](docs/personnel-demo.md) · [Appens schema och tid](docs/employee-mobile.md) · [Terminaler](docs/terminal-demo.md) · [Planerade framtida uppdateringar](docs/planerade-uppdateringar.md). Backup och återställning är planerade enligt ÄL 045, inte byggda här.

[Prova svensk AI-kundmottagning i webbläsaren](docs/integrationer/openai-rosttest.md): publik JEROC-demo på `/rosttest`, med mikrofon och endast besökarens eget transkript. Kontorets samtalshistorik och bolagens egna testvyer kräver inloggning på `/kontor/rosttest`. Ingen riktig telefoni eller externa utskick.

[Återanvändbar SaaS-blueprint](docs/saas-blueprint/README.md): byggrecept för
gemensam kärna, bolagsisolering, systemadmin, säkerhet, menyer och valbara
HR-/tid-/dispatchmoduler. Skiljer befintlig kod från föreslagen extraktion och
krav före en säker produktionsstarter.

[Live ScrapPilot – setup för separat installation](LIVE_SCRAPPILOT_SETUP.md):
överlämning till nytt Codex-projekt med ny server/databas, katalogöverföring
och kontroller inför första riktiga piloten.

## Starta på Windows eller Mac

1. Ha **Node.js 22.12 eller senare** installerat. Node.js 24 LTS fungerar. npm ska följa med Node.js.
2. [Ladda ner hela projektet som ZIP](https://github.com/NicklasJr93/JEROC-Atervinning/archive/refs/heads/main.zip) och packa upp det. Startfilerna behöver ligga kvar med övriga projektfiler.
3. Dubbelklicka på **Windows_Starta_JEROC.cmd** på Windows eller **Mac_Starta_JEROC.command** på Mac.
4. Startfilen installerar de låsta beroendena, bygger appen, startar den och öppnar webbläsaren. Internet behövs vid installationen. Låt terminalfönstret vara öppet medan du testar; Ctrl+C stoppar servern.
5. Logga in med **niklas / Demo123!** i det fiktiva mobildemot. För personalkonton och timkrav används det fiktiva **admin / JerocDemo2026!**; befintliga personliga lösenord skrivs inte över.

Om Mac inte tillåter att `.command`-filen körs: öppna Terminal i den uppackade projektmappen och kör `bash Mac_Starta_JEROC.command`. Startfilerna installerar inte eller ändrar Node.js.

### Testa på din mobil

För att testa utan att datorn är igång kan webbappen publiceras som en **Web Service på Render**. Projektets `render.yaml` innehåller inställningarna. [Koppla GitHub och publicera på Render](docs/render.md).

Du kan även testa i **Expo Go** med en QR-kod: använd `Windows_Starta_JEROC_Expo.cmd` eller `Mac_Starta_JEROC_Expo.command`. [Expo-instruktioner](expo/README.md).

För **Expo Go utan datorn igång**, använd [Render-instruktionerna för Expo-token och QR-kod](docs/render.md#öppna-i-expo-go-utan-datorn). Expo-servern kan köras i samma Web Service. Den startas först när Expo-inloggningen har konfigurerats i Render.

[Bygg samma Expo Go- och QR-lösning i ett annat projekt](docs/expo-go-ateranvandning.md):
återanvändbart recept med filer, konfiguration och instruktion till Codex.

Datorn och mobilen ska vara på samma wifi vid lokal testning. Startfönstret skriver ut datorns nätverksadress, exempelvis `http://192.168.1.10:4173`. Öppna den adress som visas i mobilens webbläsare. Tillåt åtkomst på det privata nätverket om datorns brandvägg frågar. Mobil och kontor delar uppgifter när de använder samma JEROC-server.

Utkast sparas på den gemensamma servern. Webbläsaren har dessutom en återhämtningscache för arbete som ännu inte skickats. Använd samma serveradress i mobil och kontor för att dela uppgifter.

## Flöden att prova

- **Schema och tid:** Hem → Schema visar egna arbetspass och uppdrag; Tid visar registrerade timmar och manuella kompletteringar. Behörig chef/admin anger krav under Profil → Timkrav. Saknas tid för en tidigare arbetsdag kräver appen komplettering innan arbete kan fortsätta. [Detaljer och provflöde](docs/employee-mobile.md).

- **Materialvägning:** starta invägning → välj artikelgrupp/undergrupp/artikel → jämför artikelns referensbilder → ange vikt → lägg till fler material → sammanställning → spara färdig vägning. Kortet låses och visas under Vägningar → Historik / inskickade.
- **Artikelregister:** kontoret → Artiklar & priser → Artikelgrupper. Skapa en grupp eller undergrupp. Öppna en artikel, välj grupp och lägg till bilder under Visning i gårdsappen. Mobilförhandsvisningen visar ändringarna; spara för att uppdatera appen. Ingen grupp placerar artikeln under Övrigt.
- **Fordonsvåg:** välj fordonsvåg → registreringsnummer/material/infartsvikt → spara infart → öppna under Pågående vägningar → utfartsvikt → eventuellt viktavdrag med orsak → sammanställning.
- **Separat vikt på samma kort:** ta av exempelvis koppar före första fordonsvägningen. Lägg till kopparn med vanliga materialvalet. `2 004 − 1 880 = 124 kg` järnskrot och `12 kg` separat koppar ger `136 kg` totalt.
- **Viktavdrag:** öppna exempelbilen ABC123. `12 450 − 11 600 = 850 kg`; avdrag `20 kg`, orsak `Betongrester`, ger `830 kg` material. Vågens originalvärden finns kvar i Vågunderlag.
- **Kund:** välj en befintlig demokund eller skapa en ny. Referens och ursprungsadress blir tillgängliga först när en kund är vald. Sparade uppgifter kan väljas eller egna skrivas in; byte av kund rensar tidigare referens/ursprung.
- **Utkast:** spara en materialrad med Nästa material eller Färdigvägt, stäng appen och fortsätt från utkastet. Preliminär inmatning sparas också separat efter en kort paus; tillbaka eller X lägger inte till den som materialrad. Ofullständiga kort kan inte markeras färdiga. Profil → Återställ demodata återställer exemplen efter en bekräftelse.
- **Prislista:** sök och läs allmänna A/B/C-priser. Inga prisnivåer eller priser hanteras i vägningsflödet.
- **Lösenord:** efter varje demoinloggning visas lösenordsbyte innan hemskärmen. Byte finns även under Profil. Ändringen gäller bara medan appen är öppen; omladdning återställer `Demo123!`.

Det finns ingen bottenmeny i vägningsflödet. Artikelbilder kan väljas från demobiblioteket eller laddas upp av kontoret. Demobibliotekets referensbilder är genererade exempelbilder för prototypen; inför riktig drift ska artikelregler och bilder fastställas av JEROC.

## Utveckling

```sh
npm ci
npm run build
npm run dev
```

Appen körs på port 5173 under utveckling. `npm run dev` startar även Node-servern på port 3000; Vite skickar `/api` dit. Produktionsbygget kan testas med `npm run build` och `npm start` på port 3000 (preview är enbart statisk och saknar API). Verksamhetsdata lagras på servern; webbläsaren behåller återhämtningscache och UI-inställningar. Produktionsinloggning återstår. Strukturer för artikelrader, fordonsunderlag och kunder finns i `src/model.ts` och `src/data.ts`.

För Render och annan serverdrift: kör `npm run build` och sedan `npm start`. Node-servern i `server/index.mjs` serverar webbbygget från `dist` på `0.0.0.0` och den port som miljövariabeln `PORT` anger (lokalt 3000). `/healthz` används för hälsokontroll. Kontorets prismotor finns nu på `/api/pricing/` i samma tjänst. Render behöver `DATABASE_URL` till PostgreSQL; migrationer körs automatiskt. Lokal utveckling använder annars beständig SQLite.

### Kontrollera flöden

```sh
npx playwright install chromium
npm test
npm run build
npm run test:server
```

Playwright använder systemets Chromium om `/usr/bin/chromium` finns, annars Playwrights Chromium. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` kan ange en egen webbläsare. Testerna provar flöden, viktberäkningar, sparning efter omladdning, kundbyte, lagringsfel och att inga externa anrop sker.

Bygget, de 15 flödestesterna och den gemensamma startfunktionen har körts i Linux-miljön. Windows- och Mac-startfilerna har inte körts på respektive operativsystem här.

[Bilder från den körbara mobilappen](docs/mobile-demo/README.md)

[Tidigare fordonsmockuper och PDF-exempel](docs/mockups/fordonsvag/README.md)

## Uppdatering till version 0.2.0

Alla godkända ändringar och deras status finns i [ÄL](docs/Andringslistan.txt).
Klartvyn, låst historik och fordonsflödets kundkoppling ingår också.
Tidigare utkast och kunder kan läsas med samma lagringsnyckel; befintliga
färdiga kort visas nu som låsta. Återställ inte demodata för att uppdatera.

På Render: låt automatisk publicering av main bli Live. Om automatisk
publicering är avstängd, välj Manual Deploy → Deploy latest commit.
Behåll befintligt byggkommando, npm start och Expo-token.
Stäng JEROC-vyn i Expo Go och öppna samma QR-länk igen. Om gammal layout
visas, ladda om appen. Profil visar Demokonto · v0.2.0. Logga ut och in
för att prova det nya lösenordssteget. Datorn behöver inte vara igång.

## Kontorswebben

Kontorsdemo **0.6.1** finns på `/kontor`, med kompakt kortvy, kundgodkännande, inlineattest, Jobba som, manuella LME Cash-priser och en serverbaserad prismotor. Ingen extra Render-webbtjänst behövs; terminaldelen använder den redan anslutna PostgreSQL-databasen.
[Demokonton, flöden och avgränsningar](docs/office-demo.md). Mobilappen ligger kvar på sin befintliga adress.
