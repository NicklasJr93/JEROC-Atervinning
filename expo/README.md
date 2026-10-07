# JEROC · Expo Go

Expo-projektet öppnar den befintliga mobilappen i en React Native WebView på iPhone eller Android. Samma vyer och vägningslogik används som i webbdemon. Expo-delen hanterar telefonens skärmytor, laddning, anslutningsfel och Androids bakåtknapp.

## Prova på mobilen

1. Installera senaste **Expo Go** från App Store eller Google Play.
2. Använd hela, uppackade GitHub-projektet på datorn. **Node.js 24 LTS, minst 24.3**, rekommenderas. Node.js 22.13 eller senare i 22-serien fungerar också.
3. Dubbelklicka på `Windows_Starta_JEROC_Expo.cmd` eller `Mac_Starta_JEROC_Expo.command` i projektets huvudmapp. De installerar beroenden och startar både mobilappens server och Expo.
4. Ha datorn och mobilen på samma wifi. På iPhone skannar du terminalens QR-kod med Kamera; på Android använder du Expo Go.
5. I appen klickar du **Öppna demokontot**, eller använder **niklas / Demo123!**.

Låt startfönstret vara öppet medan du testar. QR-koden skapas på din dator; en LAN-kod från molnmiljön går inte att använda från ditt eget wifi. Detta startflöde använder LAN och behöver inget Expo-konto. Expo Go ska stödja SDK 57, som projektet använder.

Om Mac inte kör filen när du dubbelklickar: öppna Terminal i projektmappen och kör `bash Mac_Starta_JEROC_Expo.command`.

Om datorns brandvägg frågar, tillåt anslutning på det privata nätverket. Appdelen använder port 4173, Expo port 8081. Startfilen kan använda en redan startad JEROC-demo på 4173 och stänger då inte den när du avslutar Expo.

**Inget skickas till kontoret.** Utkast finns lokalt i Expo-appens WebView. De synkas inte med datorn eller mobilens vanliga webbläsare. Behåll samma datoradress när du fortsätter ett test, eftersom lagringen är knuten till adressen. Datorns appserver behövs även när Expo Go är öppet.

## Utveckling

Från projektets huvudmapp kan du också köra:

```sh
npm run expo
```

Startfilen installerar projektets låsta beroenden och visar QR-koden. Den använder Expos stödda offline-läge för själva LAN-servern så att uppstarten inte behöver kontakta Expo-tjänster. Beroendeinstallationerna behöver internet.

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
