# Publicera mobilappens demo på Render

[Öppna Render med projektet](https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2FNicklasJr93%2FJEROC-Atervinning)

1. Logga in på ditt Render-konto via länken ovan.
2. Om Render ber om GitHub-åtkomst, koppla ditt GitHub-konto och ge tillgång till **NicklasJr93/JEROC-Atervinning**. För ett privat projekt måste Render kunna läsa just detta repository.
3. Skapa en Blueprint från `main`. Konfigurationen i `render.yaml` skapar **jeroc-gardsapp-demo** som en **Node Web Service**, med Free-plan och Frankfurt som region. Anslut PostgreSQL med `DATABASE_URL` enligt [terminalinstruktionerna](terminal-demo.md#render-anslut-gemensam-lagring); kontor, mobil, terminaler, miljö, personal, lager och portaler behöver gemensam beständig lagring.
4. Starta publiceringen och vänta tills bygget är klart. Render visar då tjänstens faktiska `https://….onrender.com`-adress.
5. Öppna den adressen i mobilens webbläsare. Tryck **Öppna demokontot**, eller logga in med **niklas / Demo123!**. Datorn behöver inte vara igång.

Om länken inte förväljer projektet: välj **New → Blueprint** i Render och välj repositoryt. Du kan även fortsätta på sidan **New → Web Service** med följande inställningar:

| Inställning | Värde |
| --- | --- |
| Repository | `NicklasJr93/JEROC-Atervinning` |
| Branch | `main` |
| Language | `Node` |
| Region | `Frankfurt` |
| Root Directory | Lämna tomt |
| Build Command | `npm ci --include=dev --no-audit --no-fund && npm run build:render` |
| Start Command | `npm start` |
| Compute | `Free` för demon |
| Environment Variable | `NODE_VERSION=24.19.0` |
| Health Check Path | `/healthz` |

Klicka **Deploy Web Service** när inställningarna är klara. Node-servern lyssnar på den `PORT` som Render ger den och serverar det färdiga webbbygget. Kontoret, mobilen, `/terminal`, `/kund`, `/akeri` och `/chauffor` använder samma tjänst och befintlig PostgreSQL genom `DATABASE_URL`. Det kräver inget nytt GitHub-repository. Befintliga installationer med fungerande `DATABASE_URL` behöver ingen ny inställning för 0.11.0.

Free-tjänsten kan gå i vila när den inte används; första öppningen kan då ta längre tid. Appen använder adresser med `#`, så sidornas navigering behöver ingen separat serverregel.

## Öppna i Expo Go utan datorn

Expo Go-stödet körs i samma Render-tjänst. Det aktiveras när du lägger till en personlig **EXPO_TOKEN** i Render; utan den körs webbdemon som vanligt. Ingen token finns i GitHub eller i mobilpaketet.

1. Använd den nya **Build Command** från tabellen ovan och `npm start` som **Start Command**.
2. Logga in på ditt personliga Expo-konto på expo.dev. Gå till kontots **Settings → Access tokens** och skapa en personlig token, exempelvis med namnet `JEROC Render`. Använd inte en robotanvändare för iPhone-testet.
3. Gå till **Render → JEROC-Atervinning → Environment**. Lägg till **KEY: EXPO_TOKEN**, med token som **VALUE**. Lägg den bara i Render, inte i GitHub eller chatten. Välj **Save, rebuild, and deploy** efter att byggkommandot uppdaterats.
4. Logga in i senaste **Expo Go** på mobilen med samma personliga Expo-konto som token tillhör. På fysisk iPhone måste CLI/servern och Expo Go använda samma konto.
5. När Render visar Live, öppna [Expo Go-sidan](https://jeroc-atervinning.onrender.com/expo-go). Tryck **Öppna i Expo Go** på mobilen, eller skanna QR-koden på datorns skärm. Själva länken är `exps://jeroc-atervinning.onrender.com/expo`.

Datorn kan sedan vara avstängd. Render kör både webbdemon och Expo-servern. Expo Go visar appen i sin egen WebView utan Safari/Chrome-adressfält. Inuti JEROC används fortfarande demokontot **niklas / Demo123!**; det är separat från Expo-inloggningen.

Det befintliga `npm run build:render` förbereder nu också de paket som Expo Go
begär, med samma inställningar som driftens proxy. Förbygget kör offline utan
Expo-kontoanrop. Metros cache ligger i `expo/.expo/metro-cache` och följer det
aktuella projektbygget, så driften kan återanvända arbetet. Ingen ny miljövariabel
eller beständig disk behövs. Om Expo inte är aktiverat eller publik appadress
saknas under bygget hoppas förbygget över. Andra förbyggesfel ger en varning
i loggen och hindrar inte webbappens publicering; driftens förberedelse finns
kvar. Webbbygget och Expo-typkontrollen måste fortfarande lyckas.

Servern förbereder iOS- och Android-paketen sekventiellt. Expo-sidan visar start,
kompilering och eventuella återförsök. Vänta tills öppningsknappen visas för din
mobil, även om Render redan anger Live. En färdig iPhone behöver inte vänta på
Android och vice versa; datorns QR-sida anger vilka plattformar som är klara.
Mobilen behöver därefter ladda ner paketet och kontakta webbappen. Expo använder
en enda byggarbetare i driften och som standard en JavaScript-heap på högst
256 MB; processens totala minne är större.

En långsam intern förberedelse får högst tio minuter per paket och försök.
Övergående fel tillåter högst tre försök totalt med 30 sekunders paus. Metro behålls
vid sådana fel, liksom redan färdiga paket. Efter uttömda försök kan knappen
**Försök förbereda igen** starta ett nytt försök efter pausen. Den använder
tjänstens egen `POST /expo/retry` och sammanför upprepade tryck. Vid verkligt
process-/konfigurationsfel behöver Render-loggen kontrolleras. Kontoret,
webbappens API och `/healthz` fortsätter fungera även om Expo inte är klart.
Fixen behöver inga nya Render-variabler. [Startflöde, felorsak och lokala
mätvärden](mobilstart-2026-10-13.md).

`/expo/status` visar även vilka nativepaket som faktiskt har förberetts:
`ready: true` betyder att både iOS och Android är klara, medan `warmedPlatforms`
anger varje färdig plattform. Tillståndet kan vara `starting`, `compiling`,
`retrying`, `ready`, `error` eller `disabled`; `retryable` och `retryAt` anger
om och när ett nytt försök kan begäras. Statusen verifierar inte Expo-kontots
inloggning eller start i telefonen. Det mobiltestet måste slutföras på din
telefon med rätt Expo-konto.

För att stänga av Expo Go men behålla webbdemon, ta bort `EXPO_TOKEN` från Render eller sätt `EXPO_GO_ENABLED=false` och starta om tjänsten. Expos interna port och debugger exponeras inte direkt; proxy tillåter bara manifest och projektets iOS-/Android-paket.

Om en Static Site redan finns skapar du en ny Web Service och behåller den gamla tills den nya fungerar. En befintlig Render-tjänst byter inte typ automatiskt när `render.yaml` ändras. Den nya adressen får egen lokal webbläsarlagring.

Kontorets och mobilens valbara demoinloggningar är fortsatt demo, så använd
fiktiva testuppgifter. Mobilens register sparas nu på servern; färdiginsända
vägningar blir kontorskort med samma stabila käll-ID. Osparat arbete kan ligga
kvar som lokal återhämtningscache. Terminaler, chaufförer, kunder och åkerier
har separata administrerade konton med hashade lösenord och sessionscookies.
Se [gemensam databas](shared-postgres.md) och [arbetsorder/portaler](logistics-demo.md).

GitHub innehåller konfigurationen. Själva kopplingen till Render och tjänstens adress blir klara först efter att publiceringen genomförts på ditt konto. Inga Render-lösenord eller API-nycklar behövs i repositoryt.
