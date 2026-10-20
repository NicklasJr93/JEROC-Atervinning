# Expo Go för ScrapPlanner Live

Expo Go används som ett tillfälligt mobilskal för livepiloten. Det visar mobilappen på `https://mobile.scrapplanner.com/mobil/` och använder samma bolagsdata som kontoret. Ingen publicering i App Store eller Google Play krävs för detta test.

## Öppna appen

1. Installera aktuell Expo Go på telefonen och logga in med det Expo-konto som serverns Expo-token tillhör.
2. Öppna `https://app.scrapplanner.com/expo-go` på datorn och skanna QR-koden, eller öppna sidan på mobilen och välj **Öppna i Expo Go**.
3. Vänta tills paketet för telefonens plattform är klart.
4. Logga in med det egna aktiverade personalkontots användarnamn eller e-post och lösenord. Ingen bolagslänk eller bolagsväljare behövs.

Expo-inloggningen ger endast åtkomst till testskalet. ScrapPlanner-inloggningen kontrollerar det personliga kontot och dess bolag separat. En ny WebView har sin egen session; att vara inloggad i telefonens webbläsare loggar inte automatiskt in Expo.

## Hur bolaget hittas

Mobilinloggningen slår upp kontots normaliserade användarnamn/e-post i plattformens register och kontrollerar kopplingen till ett aktivt bolag. Därefter verifieras det aktuella personalkontot i just det bolagets datalager. Servern utfärdar bolagsbunden mobilinloggning; klienten får inte välja bolag med en egen header.

Okänt konto, fel lösenord, inaktiverat konto och oklar kontokoppling ska inte lämna ut ett annat bolags uppgifter. Ett konto med flera möjliga bolagskopplingar får inte automatiskt hamna i det första bolaget. Befintliga bolagsbundna länkar fortsätter fungera för äldre lokala konton.

Personalen behöver först aktivera sin inbjudan och välja lösenord. För konton med tillfälligt lösenord behöver det föreskrivna första lösenordsbytet slutföras innan mobilinloggning.

## Render-konfiguration

Inställningarna hör till Web Service **scrapplanner-app**, inte den statiska säljsidan:

| Variabel | Värde |
| --- | --- |
| `EXPO_GO_ENABLED` | `true` för att uttryckligen aktivera Expo i pilotmiljön. |
| `EXPO_TOKEN` | Befintlig privat token från det använda Expo-kontot. |
| `EXPO_PUBLIC_WEB_APP_URL` | `https://mobile.scrapplanner.com/mobil/` |
| `RENDER_EXTERNAL_URL` | Renders egen publika tjänsteadress; används som adress till Expo-manifest och paket. Render tillhandahåller denna. |

Mobilwebbens adress och adressen till paketen är separata. En uppdatering av mobilwebben kräver inte ett nytt App Store-bygge. Ändringar i själva Expo-skalet eller dess inbyggda adress kräver däremot ett nytt paket och att det öppnas på nytt i Expo Go.

Hemligheter läggs aldrig i Git, QR-koden eller mobilpaketet. Expo-tokenen är serverkonfiguration; den används inte som personalens inloggning.

Byggkommandot för tjänsten är `npm ci --include=dev --no-audit --no-fund && npm run build:render`. Det installerar även Expo-beroendena, bygger webben och förbereder Expo-paketen. Blueprintens grundläge behåller Expo avstängt; livetestet aktiveras uttryckligen i tjänstens Environment. Servern redovisar faktisk beredskap för iOS och Android på `/expo/status`; en plattform kan vara klar före den andra. QR-koden skapas för den konfigurerade Expo-adressen och pekar inte till den gamla JEROC-testmiljön.

## Avgränsning och kontroll

Aktiveringen öppnar Expo-skalets manifest, paket, QR-sida och status. Övriga demonstrationslaboratorier är fortsatt avstängda i pilotmiljön. Bolagsdata och mobilens verksamhetsanrop kräver personalkonto och ordinarie behörighet.

Automatiska prov kontrollerar inloggning i två isolerade bolag, inaktiva/oklara konton, cookies och felaktiga klientpåståenden samt Expo-adresser, QR-länkar och pakethantering. Telefonens faktiska mikrofon, kamera, operativsystem och Expo Go-version behöver slutligen provas på fysisk telefon.
