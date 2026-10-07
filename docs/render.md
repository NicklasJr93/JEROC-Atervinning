# Publicera mobilappens demo på Render

[Öppna Render med projektet](https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2FNicklasJr93%2FJEROC-Atervinning)

1. Logga in på ditt Render-konto via länken ovan.
2. Om Render ber om GitHub-åtkomst, koppla ditt GitHub-konto och ge tillgång till **NicklasJr93/JEROC-Atervinning**. För ett privat projekt måste Render kunna läsa just detta repository.
3. Skapa en Blueprint från `main`. Konfigurationen i `render.yaml` skapar **jeroc-gardsapp-demo** som en **Node Web Service**, med Free-plan och Frankfurt som region. Ingen databas behövs för demon.
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

Klicka **Deploy Web Service** när inställningarna är klara. Node-servern lyssnar på den `PORT` som Render ger den och serverar det färdiga webbbygget. Web Service gör det möjligt att senare lägga webbappen och kontorets API i samma tjänst. Databasen blir en separat ansluten tjänst när gemensam lagring byggs. Den ingår ännu inte i demon.

Free-tjänsten kan gå i vila när den inte används; första öppningen kan då ta längre tid. Appen använder adresser med `#`, så sidornas navigering behöver ingen separat serverregel.

## Öppna i Expo Go utan datorn

Expo Go-stödet körs i samma Render-tjänst. Det aktiveras när du lägger till en personlig **EXPO_TOKEN** i Render; utan den körs webbdemon som vanligt. Ingen token finns i GitHub eller i mobilpaketet.

1. Använd den nya **Build Command** från tabellen ovan och `npm start` som **Start Command**.
2. Logga in på ditt personliga Expo-konto på expo.dev. Gå till kontots **Settings → Access tokens** och skapa en personlig token, exempelvis med namnet `JEROC Render`. Använd inte en robotanvändare för iPhone-testet.
3. Gå till **Render → JEROC-Atervinning → Environment**. Lägg till **KEY: EXPO_TOKEN**, med token som **VALUE**. Lägg den bara i Render, inte i GitHub eller chatten. Välj **Save, rebuild, and deploy** efter att byggkommandot uppdaterats.
4. Logga in i senaste **Expo Go** på mobilen med samma personliga Expo-konto som token tillhör. På fysisk iPhone måste CLI/servern och Expo Go använda samma konto.
5. När Render visar Live, öppna [Expo Go-sidan](https://jeroc-atervinning.onrender.com/expo-go). Tryck **Öppna i Expo Go** på mobilen, eller skanna QR-koden på datorns skärm. Själva länken är `exps://jeroc-atervinning.onrender.com/expo`.

Datorn kan sedan vara avstängd. Render kör både webbdemon och Expo-servern. Expo Go visar appen i sin egen WebView utan Safari/Chrome-adressfält. Inuti JEROC används fortfarande demokontot **niklas / Demo123!**; det är separat från Expo-inloggningen.

Första öppningen kan ta längre tid när gratisservern vaknar och Expo bygger iOS- eller Android-paketet. Expo använder en enda byggarbetare och som standard en JavaScript-heap på högst 256 MB för att begränsa resursbehovet. Processens totala minne är större än heapen. Båda mobilpaketen har byggts och hämtats genom proxyn lokalt med den gränsen; körning på Renders 512 MB behöver fortfarande kontrolleras. Om Render-loggen visar minnesbrist behöver minneskapaciteten bedömas. Mer CPU med samma RAM löser inte minnesbrist.

`/expo/status` visar bara om Expo är aktiverat och om processen har startat, inte att Expo-inloggningen eller mobiltestet har lyckats. Mobiltestet och den privata kontoinloggningen måste slutföras på din telefon/Render. Miljön som förbereder koden saknar Render-/Expo-inloggning och kan inte nå deras externa tjänster för att kontrollera dem åt dig.

För att stänga av Expo Go men behålla webbdemon, ta bort `EXPO_TOKEN` från Render eller sätt `EXPO_GO_ENABLED=false` och starta om tjänsten. Expos interna port och debugger exponeras inte direkt; proxy tillåter bara manifest och projektets iOS-/Android-paket.

Om en Static Site redan finns skapar du en ny Web Service och behåller den gamla tills den nya fungerar. En befintlig Render-tjänst byter inte typ automatiskt när `render.yaml` ändras. Den nya adressen får egen lokal webbläsarlagring.

Demo-inloggningen är en del av den lokala prototypen och skyddar inte en publicerad sida. Använd fiktiva testuppgifter. Utkast ligger kvar i mobilens webbläsarlagring och synkas inte med andra enheter eller tidigare datoradresser. Inget skickas till kontoret.

GitHub innehåller konfigurationen. Själva kopplingen till Render och tjänstens adress blir klara först efter att publiceringen genomförts på ditt konto. Inga Render-lösenord eller API-nycklar behövs i repositoryt.
