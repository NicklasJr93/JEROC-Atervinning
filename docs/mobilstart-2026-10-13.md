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

`npm run build:render` kör nu också `npm run expo:prebuild`. När Expo Go är
aktiverat och den publika appadressen finns under bygget startar förbygget
en tillfällig Metro i offline-läge och förbereder samma paketvägar och
transformeringsinställningar som driftens proxy använder. Expo-token används
inte för kontoanrop i förbygget. Den vanliga iOS-/Android-exporten har en annan
paketprofil och ersätter inte denna kontroll.

Moduler och filindex cachas i projektets `expo/.expo/metro-cache`, så det
aktuella byggets cache kan återanvändas vid driftstart. Det är byggcache,
inte kunddata eller en ny beständig Render-disk. Ett nytt bygge förbereder
sin cache. Förbygget hoppas över om Expo Go inte är aktiverat eller offentlig
adress saknas i byggmiljön. Andra förbyggesfel ger en varning med felkod men
hindrar inte webbappens publicering; driftens förberedelse och återförsök finns
kvar. Webbbygget och Expo-typkontrollen måste fortfarande lyckas. Förbygget
har separata gränser på en minut för Metro-start och fem minuter per paket.

Metro förbereder de exakta iOS- och Android-paket som Expo Go använder.
Driftens förberedelse är sekventiell, med en byggarbetare och oförändrad
standardgräns för Expos heap. Svaret strömmar bort i webbservern; den behåller
inte två paket i webbserverns minne.

`/expo/status` redovisar `starting`, `compiling`, `retrying`, `ready`, `error`
eller `disabled`, aktuell plattform och färdiga plattformar i `warmedPlatforms`.
`ready: true` betyder att båda nativepaketen har förberetts, inte bara att
Metro-processen har startat. Det bevisar inte att Expo-kontot eller telefonens
inloggning fungerar.

Varje färdig plattform kan användas direkt. På iPhone visas öppningsknappen
när iOS-paketet är klart, även om Android fortfarande förbereds; motsvarande
gäller på Android. Datorns QR-sida talar om vilka plattformar som är klara.
Direkta Expo-anrop för ett paket som ännu inte är färdigt får HTTP 503 med
ett kort väntesvar. Det startar inte flera samtidiga kompileringar.

## Återhämtning efter lång kompilering

Den tidigare driftsversionen gav `EXPO_COMPILE_TIMEOUT` för iOS på Render:
förberedelsen överskred två minuter och avslutade Metro. Det var ett fel i
Expo-paketens förberedelse; det var inte ett fel i mobilens inloggning.

Varje paket får nu högst tio minuter per förberedelseförsök. Övergående
kompileringsfel tillåter högst tre försök totalt: det första och två automatiska
återförsök, med 30 sekunders paus mellan försöken.
En fungerande Metro-process behålls och redan färdiga plattformar byggs inte
om i samma förberedelse. Om försöken tar slut visar QR-sidan **Försök förbereda
igen** efter pausen. Knappen använder `POST /expo/retry` från tjänstens egen
webbadress; upprepade tryck sammanförs till ett försök och kan inte starta en
extra Metro-process. Direkta nativeanrop kan också begära återhämtning efter
samma paus. Tiominutersgränsen gäller den interna förberedelsen; den vanliga
proxyn för färdiga paket behåller sin tvåminutersgräns för inaktiv överföring.

Ett verkligt processfel, utebliven processstart eller ogiltig Expo-konfiguration
redovisas som Expo-fel. Kontoret, bank-/ekonomiköerna, webbappen och `/healthz`
fortsätter fungera. Återhämtningsknappen startar inte om en död process;
sådana fel behöver kontrolleras i Render-loggen och tjänsten startas om efter
att orsaken åtgärdats.

Mobilen måste fortfarande ladda ner paketet, öppna sin WebView och kontakta
webbappen. Detta är inte ett eget publicerat appbutiksbygge. Efter ny deploy
kan QR-sidan därför visa förberedelse även när Render redan visar tjänsten som Live.

## Uppmätt och verifierat

Den nya byggcachen provades med en **helt tom, separat cachedirectory** och
verklig Expo CLI, en byggarbetare och 256 MB standardheap. Samma publika
webbadress och exakta driftprofil användes i två separata Metro-processer:

| Kontroll | iOS | Android | Totalt inklusive Metrostart |
| --- | ---: | ---: | ---: |
| Kall förberedelse | 11,97 s | 10,35 s | 23,35 s |
| Ny process med projektcachen | 0,75 s | 0,68 s | 2,44 s |

Båda paketen gav HTTP 200 och innehöll rätt publik appadress. Det visar lokal
återanvändning av byggcachen, inte garanterade Render- eller telefonstider.
SDK-versionens Metro levererade JavaScript för dessa nativeanrop; parametern
`transform.bytecode=1` är inte i sig ett bevis för ett Hermes-bytecodepaket.
Sex riktade kontroller verifierar även förbyggesprofil, cache, streaming,
avstängning, uteblivna hemligheter i loggen och att optionalfel inte blockerar
webbdeploy. Tre nya browsertester verifierar plattformsval, statusåterhämtning
och en enda manuell begäran efter återförsökspausen.

Ett lokalt verkligt Expo-prov med en byggarbetare och standardheapen tog
**26,6 sekunder** för båda plattformarna. Därefter hämtades iOS-paketet
(2 318 931 byte) på **215 ms** och Android-paketet (2 332 020 byte) på **272 ms**.
Provet rensade inte Metros dåvarande temporära cache; en befintlig cache kan
ha bidragit. Det är därför inte en mätning av helt kall Render-start eller en
garanti för telefonens starttid. Tiderna avser den tidigare lokala kontrollen,
inte en verifiering av denna återhämtningsfix på Render.

Tre riktade API-kontroller verifierar dagsvy, fullvy på begäran, oförändrade
läsningar och bibehållen autentisering/tidsspärr. Tre browsertester verifierar
Hem utan månadshämtning, full hämtning i Tid, tidsgräns och sena svar efter
utloggning. Expo-proxy-/livscykelkontroller omfattar paketvägar, sekventiell
förberedelse, tidsgränser, återförsök, färdig iPhone före Android, oförändrad
webbdrift och skyddet på återhämtningsknappen. Uppdateringen behöver inga nya
Render-variabler och ändrar inte mobilens eller kontorets versionsnummer.
