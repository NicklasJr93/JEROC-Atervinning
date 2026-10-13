# Personalens närvaro

Kontor **0.27.0**, mobilwebb **0.9.1**. Öppna **Personal → Närvaro**.
Vyn visar aktiva interna anställda i dina tillåtna anläggningar. Du kan söka
på person/team, filtrera status/anläggning och öppna ett personalkort från raden.
Med anställningsbehörighet öppnas personens tidsdetalj direkt.

## Stämpling och tider

Instämplad, på rast och utstämplad bygger på serverns sparade pass. En person
på rast räknas fortfarande bland instämplade. Personal utan aktiverad klocka
visas som **Stämpelklocka av**, med okänd närvaro om inget annat säkert underlag finns.
Aktiv arbetsorder kan visas som pågående arbete utan att personen har en klocka.

Arbetstid räknas utan raster. Ett pågående pass visar passets tid; när passet
är avslutat visas dagens sammanlagda klocktid. Ett gammalt eller osäkert pass
markeras för kontroll. Det rättas i personalkortets **Tidrapportering**.

Servern avläses var 20:e sekund när sidan är synlig. Sekunderna räknas lokalt
mellan avläsningarna. **Uppdatera** hämtar en ny status direkt. Tidpunkt för senaste
avläsningen visas; vid anslutningsfel markeras att tidigare uppgifter används.
Vid återkallad åtkomst rensas uppgifterna från vyn.

## Anläggning

Raden visar personens anläggningstillhörighet. **Instämplad på** anger den
behöriga anläggning som var vald i mobilen vid instämplingen. Servern sparar
den på passet och behåller den vid en tidsrättelse. Att välja en annan anläggning
senare flyttar inte det historiska passet. Äldre pass utan plats får ingen
påhittad plats. Detta är ingen GPS- eller liveposition.

Anläggningsfiltret avser personens tillhörighet. En person som tillhör flera
anläggningar visas bara om läsaren har åtkomst till samtliga, enligt samma
anläggningsregel som personalens tidsinställningar.

## Gemensamma statusfält

`GET /api/application/personnel-presence` ger en begränsad, skrivskyddad vy.
`siteId` kan användas för en enskild anläggning; utan parametern visas alla
behöriga anläggningar. Mobilens autentiserade översikt får sin egen rad i
`presence`, utan att få tillgång till övrig personals närvaro.

| Fält | Betydelse |
| --- | --- |
| `clockStatus` | `working`, `break`, `out`, `off` eller `disabled`. |
| `isClockedIn` | Ett öppet klockpass finns, även under rast. |
| `isOnBreak` | En rast på det öppna passet pågår. |
| `isWorkingNow` | Klockan räknar arbete eller ett verkligt arbetsorderpass är öppet. |
| `workStateSource` | Observationen kommer från `clock`, `order` eller är `unknown`. |
| `isScheduledNow` | Personen är schemalagd just nu; `null` om schema saknas. |
| `isAbsentNow` | Registrerad frånvaro gäller just nu; orsaken lämnas inte ut. |
| `isEmploymentActive` | Anställningen gäller idag enligt befintligt underlag. |
| `hasActiveOrder` | Ett arbetsorderpass pågår; bokad order räcker inte. |
| `availabilityStatus` | `available`, `on_break`, `busy`, `absent`, `not_clocked_in`, `unknown` eller `needs_review`. |
| `isAvailableNow` | Beräknad tillgänglighet: `true`, `false` eller `null` om okänd. |
| `requiresCorrection` | Klockunderlaget behöver rättas eller kontrolleras. |
| `clockSiteId` | Anläggning vid instämpling, om känd och inom läsarens åtkomst. |
| `clockedInAt`, `breakStartedAt`, `statusSince`, `lastClockEventAt` | Tidsstämplar från underlaget. |
| `workSeconds`, `breakSeconds` | Klockans arbete/rast vid serverns avläsning. |
| `reasonCodes` | Generella förklaringar, utan frånvaroorsak eller privata noteringar. |

Attributen räknas fram från klockpass, tidskälla, aktuell frånvaro och verkliga
arbetsorderpass. Separata sparade booleans används inte, så statusen inte kan
glida isär från underlaget. En instämplad person utanför sitt schema kan fortfarande
vara tillgänglig; schemat och observationen visas som separata fakta.

För framtida bokningar och behörighetsvillkor ska status kontrolleras på servern
vid själva åtgärden. `isWorkingNow` är en observation, inte ensam ett tillstånd
att arbeta: väg även in rättelsebehov, konto, frånvaro och ordinarie behörigheter.
Denna version lägger inte till nya spärrar eller ändrar användarens rättigheter
automatiskt när personen stämplar in eller ut.

## Åtkomst och lagring

**Se personalens närvaro och stämpelstatus** (`personnelPresenceRead`) är en
egen läsrätt under **Personal → Konton**, med personalregistrets läsrätt som
förutsättning. Systemadmin ärver den; andra roller får den uttryckligen.
Både faktisk och effektiv användares rättigheter/anläggningar kontrolleras.
Den egna mobilstatusen kräver bara en giltig medarbetarsession.

Översikten innehåller inte lön, telefon, e-post, medicinska frånvaroskäl,
rå klockhistorik eller arbetsorderdetaljer. Ett eventuellt arbetsorder-ID kräver
även transportläsrätt och säker anläggningsåtkomst. Bolagets befintliga privata
PostgreSQL-domäner är fortsatt källan. Inga nya Render-variabler behövs.

## Verifiering

69 riktade serverkontroller passerar: närvaroprojektion, tids-/klockregler,
mobilinloggning och faktisk HTTP med lokal SQLite. Kontrollerna verifierar bland
annat dubbel behörighetskontroll, anläggningsfilter, oförändrade lässnapshots,
privata fält och instämplingsplats genom senare rättelse.

Tre browsertester passerar för status, filter, lokala räknare utan extra anrop,
personlänkar och rensning vid återkallad åtkomst. Produktionsbygget och Expos
typkontroll passerar. Vyn är även visuellt granskad. Ingen levande personaldata
har ändrats av provkörningarna.
