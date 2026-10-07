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
| Build Command | `npm ci --include=dev --no-audit --no-fund && npm run build` |
| Start Command | `npm start` |
| Compute | `Free` för demon |
| Environment Variable | `NODE_VERSION=24.19.0` |
| Health Check Path | `/healthz` |

Klicka **Deploy Web Service** när inställningarna är klara. Node-servern lyssnar på den `PORT` som Render ger den och serverar det färdiga webbbygget. Web Service gör det möjligt att senare lägga webbappen och kontorets API i samma tjänst. Databasen blir en separat ansluten tjänst när gemensam lagring byggs. Den ingår ännu inte i demon.

Free-tjänsten kan gå i vila när den inte används; första öppningen kan då ta längre tid. Appen använder adresser med `#`, så sidornas navigering behöver ingen separat serverregel. Expo-projektet och en Expo Go-testversion publiceras inte av denna konfiguration.

Om en Static Site redan finns skapar du en ny Web Service och behåller den gamla tills den nya fungerar. En befintlig Render-tjänst byter inte typ automatiskt när `render.yaml` ändras. Den nya adressen får egen lokal webbläsarlagring.

Demo-inloggningen är en del av den lokala prototypen och skyddar inte en publicerad sida. Använd fiktiva testuppgifter. Utkast ligger kvar i mobilens webbläsarlagring och synkas inte med andra enheter eller tidigare datoradresser. Inget skickas till kontoret.

GitHub innehåller konfigurationen. Själva kopplingen till Render och tjänstens adress blir klara först efter att publiceringen genomförts på ditt konto. Inga Render-lösenord eller API-nycklar behövs i repositoryt.
