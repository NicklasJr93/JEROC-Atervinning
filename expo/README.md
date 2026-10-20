# ScrapPlanner · Expo Go

Expo-projektet öppnar mobilappen **0.10.0** i en React Native WebView på iPhone eller Android. Samma vyer och vägningslogik används som i mobilwebben. De fyra gemensamma flikarna är **Hem, Schema, Tid och Profil**; Gårdsarbete och Mina uppdrag öppnas från Hem efter behörighet. Expo-delen hanterar telefonens skärmytor, laddning, anslutningsfel och Androids bakåtknapp. [Personlig inloggning, timkrav och provflöde](../docs/employee-mobile.md).

[Återanvänd lösningen i ett annat projekt](../docs/expo-go-ateranvandning.md):
arkitektur, QR-sida, Render-variabler och ett färdigt instruktionsexempel för Codex.

Den mörkblå/gröna ScrapPlanner-loggan används på anslutningsskärmen. Appikon,
Androids adaptiva ikon och startbild är konfigurerade i `app.json` för nästa
eget nativebygge. Expo Go behåller sin egen appikon. Original och exporter
finns i [brandpaketet](../docs/branding/scrapplanner/README.md).

## Prova på mobilen

### Utan datorn igång

Webbdemon finns på Render. Expo-servern kan aktiveras i samma tjänst med en personlig Expo-token och det nya byggkommandot. [Följ Render-instruktionerna](../docs/render.md#öppna-i-expo-go-utan-datorn), och öppna sedan [QR-sidan](https://jeroc-atervinning.onrender.com/expo-go). Den blir användbar när servern har byggts om och token har lagts i Render. Att bara koppla GitHub till Expo publicerar inte en fungerande Expo Go-länk.

`npm run build:render` inkluderar `expo:prebuild`, som förbereder driftens exakta
paketprofil i offline-läge utan Expo-kontoanrop. Projektcachen ligger i
`expo/.expo/metro-cache` och kan återanvändas vid serverstart. Förbygget hoppas
över om Expo Go inte är aktiverat eller den publika appadressen saknas under
bygget. Ett annat förbyggesfel ger en varning med felkod och lämnar förberedelsen
åt driftens återförsök; webbbygget och Expo-typkontrollen måste fortfarande
lyckas. Befintliga Render-variabler och byggkommandot i guiden räcker.

Servern förbereder iOS- och Android-paketen sekventiellt. Sidan visar vilket
paket som förbereds och vilka som är färdiga. På iPhone kan appen öppnas när
iOS är klart även om Android fortfarande förbereds; motsvarande gäller på
Android. Datorns QR-sida anger vilka plattformar som kan använda länken.
Därefter återstår mobilens nedladdning och webbanslutning. Mobilen hämtar
dagens egenvy vid start; full månadsdata hämtas när Schema eller Tid öppnas.

En långsam förberedelse får högst tio minuter per paket och försök. Övergående
fel tillåter högst tre försök totalt med 30 sekunders paus. Metro och redan
färdiga paket behålls. Om försöken tar slut visas **Försök förbereda igen**;
knappen kan användas efter pausen utan att starta en extra Metro-process.
Ett verkligt processfel kräver kontroll i Render-loggen. Kontoret, webbappens
API och `/healthz` fortsätter fungera vid Expo-fel. Befintliga Render-variabler
räcker. [Felorsak, startflöde och lokala mätvärden](../docs/mobilstart-2026-10-13.md).

`/expo/status` betyder mer än att processen startat: `ready: true` kräver två
färdiga nativepaket och `warmedPlatforms` listar varje färdig plattform.
Det verifierar inte Expo-inloggningen eller att appen öppnats i din telefon.

### Med utvecklingsserver på din dator

1. Installera senaste **Expo Go** från App Store eller Google Play.
2. Använd hela, uppackade GitHub-projektet på datorn med **Node.js 24 LTS, minst 24.19.0 och lägre än 25**. Samma versionskrav gäller rootprojektet, Expo och hemsidan; `.nvmrc` anger 24.19.0.
3. Dubbelklicka på `Windows_Starta_JEROC_Expo.cmd` eller `Mac_Starta_JEROC_Expo.command` i projektets huvudmapp. De installerar beroenden och startar både mobilappens server och Expo.
4. Ha datorn och mobilen på samma wifi. På iPhone skannar du terminalens QR-kod med Kamera; på Android använder du Expo Go.
5. Logga in i appen. I det förvalda fiktiva demot används **niklas / Demo123!**; för kontohantering och timkrav finns **admin / JerocDemo2026!**. Egna personalkonton kopplas till personalregistret och får egna lösenord.

Låt startfönstret vara öppet medan du testar. QR-koden skapas på din dator; en LAN-kod från molnmiljön går inte att använda från ditt eget wifi. På fysisk iPhone kräver aktuell Expo Go att Expo CLI och Expo Go är inloggade på samma konto: kör `npx expo login` i `expo`-mappen och logga in med samma konto i mobilen. Expo Go ska stödja SDK 57, som projektet använder.

Om Mac inte kör filen när du dubbelklickar: öppna Terminal i projektmappen och kör `bash Mac_Starta_JEROC_Expo.command`.

Om datorns brandvägg frågar, tillåt anslutning på det privata nätverket. Portarna 4173 och 8081 behöver vara lediga. Startfilen äger en Node-server med både webb och API på 4173 och verifierar dess `/readyz` före Expo/QR. En redan körande server återanvänds inte. Ctrl+C stänger de processer startfilen själv har skapat.

**Mobil och kontor delar serverdata.** Expo visar samma mobilwebb som webbläsaren: utkast sparas på servern och färdiga vägningar visas på kontoret. Artikelgrupper, bilder och instruktioner hämtas från kontorets register. Eget schema, faktisk arbetstid, timkrav och ledighetsansökningar använder samma PostgreSQL-databas. WebView har dessutom en lokal återhämtningscache för vägningsarbete som väntar på sparning; den häver inte serverns spärr vid saknad tidrapport. Använd samma JEROC-serveradress på mobilen och kontoret. Vid lokal testning behöver datorns appserver vara igång även när Expo Go är öppet.

## Utveckling

Från projektets huvudmapp kan du också köra:

```sh
npm run expo
```

Startfilen installerar projektets låsta beroenden och visar QR-koden. Beroendeinstallationer och Expo-inloggning behöver internet. Offline-läge används bara vid paketverifiering i molnmiljön, inte som ersättning för iPhones Expo-inloggning.

För att arbeta i Expo-projektet separat, starta först webbdemon på datorn med den vanliga startfilen. Kör sedan i `expo`:

```sh
npm ci
npm start
```

Webbadressen hämtas från Expos LAN-adress och port 4173. Vid behov kan du ange `EXPO_PUBLIC_WEB_APP_URL`, exempelvis `http://192.168.1.10:4173`, eller ändra adressen på anslutningsskärmen. Lägg inga lösenord eller hemligheter i denna publika variabel.

```sh
npm run typecheck
npx expo export --platform ios --output-dir .export-check/ios
npx expo export --platform android --output-dir .export-check/android
```

Expo Go-versionen visar den nuvarande webbdemon. Framtida egna React Native-vyer kan byggas vidare i detta Expo-projekt; fullständiga native-vyer har inte ersatt webbvyerna i denna version.

Verifierat i utvecklingsmiljön: installation från båda låsfilerna, webbbygge, Expo-typkontroll, iOS- och Android-export samt Expo Go-manifest och utvecklingspaket för båda plattformarna. Själva mobiltestet görs på din telefon; Windows- och Mac-filerna har granskats men har inte körts på dessa operativsystem här.

[Mobilappens flöden och vanliga startinstruktioner](../README.md)
