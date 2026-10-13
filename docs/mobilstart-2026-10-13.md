# Mobilstart och Expo Go

Mobilwebb **0.10.0**. Befintliga Render-variabler räcker.

## Lätt startvy

Mobilen begär `/api/employee/session?view=bootstrap` och använder samma lätta
vy vid inloggning. Den innehåller egen identitet, behörigheter, anläggningar,
dagens schema/tid/uppdrag, klocka, närvaro och befintlig tidsspärr. Full
månadsberäkning, stämplingshistorik och ledighetslista följer inte med.

`monthLoaded: false` märker dagsvyn. Hem hämtar inte en månad igen efter den
kontrollen. Schema och Tid begär full data vid inträde; månadsfält visas med
laddningsstatus tills rätt svar kommit. `monthLoaded: true` gäller fullvy.
Den äldre API-formen utan `view=bootstrap` ger fortsatt full egenöversikt.

Läsningar avbryts efter 15 sekunder och visar ett begripligt anslutningsfel
i stället för en obegränsad startskärm. Utloggning, nytt konto och bolagsbyte
spärrar äldre svar med sessionsgeneration och bundet bolagsval. Starten häver
inte inloggningskontroll, anläggningsrättigheter eller krav på färdig tidrapport.

## Förberedda nativepaket

Render startar Metro och förbereder de exakta iOS- och Android-paket som
Expo Go använder. Förberedelsen är sekventiell och strömmar bort svaret i
webbservern; den behåller inte två paket i webbserverns minne. Befintlig
byggarbetare och standardgräns för Expos heap behålls.

`/expo/status` redovisar `starting`, `compiling`, `ready`, `error` eller
`disabled`, aktuell plattform och färdiga plattformar. QR-sidan visar länken
först när båda paketen är färdiga. Direkta Expo-anrop under förberedelsen
får ett tidsbegränsat väntesvar. Start/kompilering har deadlines och storleksgräns.
Misslyckad förberedelse avslutar bara Expo-processen. Kontoret, bank-/ekonomiköer,
webbappen och `/healthz` fortsätter fungera.

Mobilen måste fortfarande ladda ner paketet, öppna sin WebView och kontakta
webbappen. Detta är inte ett eget publicerat appbutiksbygge. Efter ny deploy
kan QR-sidan därför visa förberedelse även när Render redan visar tjänsten som Live.

## Uppmätt och verifierat

Ett lokalt verkligt Expo-prov med en byggarbetare och standardheapen tog
**26,6 sekunder** för båda plattformarna. Därefter hämtades iOS-paketet
(2 318 931 byte) på **215 ms** och Android-paketet (2 332 020 byte) på **272 ms**.
Det belägger att kompileringen flyttas före användarens öppning. Det är inte
en uppmätt förbättring på Render eller en garanti för telefonens starttid.

Tre riktade API-kontroller verifierar dagsvy, fullvy på begäran, oförändrade
läsningar och bibehållen autentisering/tidsspärr. Tre browsertester verifierar
Hem utan månadshämtning, full hämtning i Tid, tidsgräns och sena svar efter
utloggning. Nio Expo-proxy-/livscykeltester verifierar paketvägar, förberedelse,
felgränser och att endast Expo stängs vid fel.
