# JEROC · Mobilappen

**Mobil/Expo 0.3.0 och kontor 0.8.0** delar nu verksamhetsdata i PostgreSQL. Utkast, kunder, färdiga mobilvägningar, kontorskort, prisregister, planering och integrationsutkorg sparas beständigt. Färdiga mobilvägningar visas på kontoret.

Detta är fortfarande en demo med valbara exempelkonton. Använd testuppgifter. Utbetalningar är manuell demoregistrering; inga bank-, Visma-, Naturvårdsverks-, SMS-, e-post- eller BankID-leveranser aktiveras.

[Gemensam databas och säker import](docs/shared-postgres.md) · [Kontorsversionen](docs/office-demo.md) · [Terminaler](docs/terminal-demo.md). Backup och återställning är planerade enligt ÄL 045, inte byggda här.

## Starta på Windows eller Mac

1. Ha **Node.js 22.12 eller senare** installerat. Node.js 24 LTS fungerar. npm ska följa med Node.js.
2. [Ladda ner hela projektet som ZIP](https://github.com/NicklasJr93/JEROC-Atervinning/archive/refs/heads/main.zip) och packa upp det. Startfilerna behöver ligga kvar med övriga projektfiler.
3. Dubbelklicka på **Windows_Starta_JEROC.cmd** på Windows eller **Mac_Starta_JEROC.command** på Mac.
4. Startfilen installerar de låsta beroendena, bygger appen, startar den och öppnar webbläsaren. Internet behövs vid installationen. Låt terminalfönstret vara öppet medan du testar; Ctrl+C stoppar servern.
5. Klicka **Öppna demokontot**, eller logga in med **niklas / Demo123!**.

Om Mac inte tillåter att `.command`-filen körs: öppna Terminal i den uppackade projektmappen och kör `bash Mac_Starta_JEROC.command`. Startfilerna installerar inte eller ändrar Node.js.

### Testa på din mobil

För att testa utan att datorn är igång kan webbappen publiceras som en **Web Service på Render**. Projektets `render.yaml` innehåller inställningarna. [Koppla GitHub och publicera på Render](docs/render.md).

Du kan även testa i **Expo Go** med en QR-kod: använd `Windows_Starta_JEROC_Expo.cmd` eller `Mac_Starta_JEROC_Expo.command`. [Expo-instruktioner](expo/README.md).

För **Expo Go utan datorn igång**, använd [Render-instruktionerna för Expo-token och QR-kod](docs/render.md#öppna-i-expo-go-utan-datorn). Expo-servern kan köras i samma Web Service. Den startas först när Expo-inloggningen har konfigurerats i Render.

Datorn och mobilen ska vara på samma wifi. Startfönstret skriver ut datorns nätverksadress, exempelvis `http://192.168.1.10:4173`. Öppna den adress som visas i mobilens webbläsare. Tillåt åtkomst på det privata nätverket om datorns brandvägg frågar. Appen använder inga externa API:er eller kontorsanslutningar.

Utkast finns i **den webbläsare och på den enhet där du skapade dem**. De synkas inte mellan mobil och dator. Behåll samma adress och port när du fortsätter ett test; webbläsarlagring är knuten till adressen. Rensar du webbplatsdata försvinner utkasten.

## Flöden att prova

- **Materialvägning:** starta invägning → välj kategori/artikel → jämför de fyra referensbilderna → ange vikt → lägg till fler material → sammanställning → spara färdig vägning. Kortet låses och visas under Vägningar → Historik / inskickade.
- **Fordonsvåg:** välj fordonsvåg → registreringsnummer/material/infartsvikt → spara infart → öppna under Pågående vägningar → utfartsvikt → eventuellt viktavdrag med orsak → sammanställning.
- **Separat vikt på samma kort:** ta av exempelvis koppar före första fordonsvägningen. Lägg till kopparn med vanliga materialvalet. `2 004 − 1 880 = 124 kg` järnskrot och `12 kg` separat koppar ger `136 kg` totalt.
- **Viktavdrag:** öppna exempelbilen ABC123. `12 450 − 11 600 = 850 kg`; avdrag `20 kg`, orsak `Betongrester`, ger `830 kg` material. Vågens originalvärden finns kvar i Vågunderlag.
- **Kund:** välj en befintlig demokund eller skapa en ny. Referens och ursprungsadress blir tillgängliga först när en kund är vald. Sparade uppgifter kan väljas eller egna skrivas in; byte av kund rensar tidigare referens/ursprung.
- **Utkast:** spara en materialrad med Nästa material eller Färdigvägt, stäng appen och fortsätt från utkastet. Preliminär inmatning sparas också separat efter en kort paus; tillbaka eller X lägger inte till den som materialrad. Ofullständiga kort kan inte markeras färdiga. Profil → Återställ demodata återställer exemplen efter en bekräftelse.
- **Prislista:** sök och läs allmänna A/B/C-priser. Inga prisnivåer eller priser hanteras i vägningsflödet.
- **Lösenord:** efter varje demoinloggning visas lösenordsbyte innan hemskärmen. Byte finns även under Profil. Ändringen gäller bara medan appen är öppen; omladdning återställer `Demo123!`.

Det finns ingen bottenmeny i vägningsflödet och inga kundbilder/bilagor eller Övrigt-material i denna demo. Referensbilderna är genererade exempelbilder för prototypen; inför riktig drift ska artikelregler och bilder fastställas av JEROC.

## Utveckling

```sh
npm ci
npm run build
npm run dev
```

Appen körs på port 5173 under utveckling. `npm run dev` startar även Node-serverns prismotor på port 3000; Vite skickar `/api` dit. Produktionsbygget kan testas med `npm run build` och `npm start` på port 3000 (preview är enbart statisk och saknar API). Verksamhetsdata lagras på servern; webbläsaren behåller återhämtningscache och UI-inställningar. Produktionsinloggning återstår. Strukturer för artikelrader, fordonsunderlag och kunder finns i `src/model.ts` och `src/data.ts` inför den framtida gemensamma backenddelen.

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
