# Fyra prestandaetapper – 12 oktober 2026

Kontor **0.18.0**, mobilwebb **0.5.1**, Expo-skal **0.3.0**.
Bygget genomför samtliga fyra etapper från
[prestandagranskningen](prestandagranskning-2026-10-12.md).

## Vad som ändrats

| Del | Nytt beteende |
| --- | --- |
| Integrationer | Små SQL-projektioner för status och behörighet; gemensam snapshot för inställningar och val. Ingen full miljö-/pris-/logistikhämtning när sidan öppnas. |
| Kontoret | Arbetsorderräknaren hämtar antal inom rätt anläggning/behörighet. Register läses när den aktuella sidan behöver dem. Identiska samtidiga GET samordnas. |
| Läsningar | Personal, logistik och äldre portaler läser utan affärsaggregatets skrivlås. Verkliga material-/viktändringar sparar lagerhistorik i själva kommandot. |
| Reservhämtning | Med frisk SSE kontrolleras en liten revision var 60:e sekund, annars var 15:e. Fulla uppgifter hämtas vid förändring, återanslutning eller uttrycklig uppdatering. Mobilens datumskifte kontrolleras också. |
| Mobilen | Priser för vald kund, begränsad priscache och mindre kommandon med ändrade poster. Offlineåterhämtning, fältkonflikter, nummersättning och låsta färdiga vägningar behålls. |
| Laddning | Separata appfamiljer och individuella artikelbilder. Stora originalbilder finns kvar; visning använder storleksanpassade varianter. |
| Tid | Person-/dagsindex byggs per anrop och återanvänds inom samma beräkning, utan beständiga sammanställningar som kan bli gamla efter rättelser. |
| Spiris | Historik, exportjobb, val och inställningsversioner ligger i indexerade JSONB-poster. Attesthändelser köar aktuellt kort; kontroller före API-anrop hämtar bara det kortet. En full avstämning sker vid start och var femte minut. |
| Dokument | Metadata-GET renderar aldrig PDF. Låsta dokument genereras av en separat arbetare med en aktiv rendering, högst 32 väntande och 45 sekunders tidsgräns. |
| Mätning | API-svar innehåller Server-Timing för anrop, databasfrågor, pool och låsfrågor. Inga SQL-parametrar eller hemligheter ingår. |

Spiris-hämtning från leverantörens API har fortsatt separata tidsgränser och
fullständighetskontroll. Den förbättringen ska skiljas från att öppna redan
sparade inställningar, som inte kontaktar Spiris.

## Laddningsstorlek

Produktionsbyggets gemensamma startfil minskade från **906,6 till 268,5 kB**,
eller ungefär **253,3 till 85,6 kB gzip**. Den valda appen laddar dessutom sin
egen kod: uppmätt initial JavaScript var cirka **476 kB för mobilen** och
**795 kB för kontoret**, inklusive gemensamma beroenden. Startfilens minskning
är därför inte samma sak som hela sidans överföring.

UI-logotypen är cirka **63 kB**, tidigare **1 014 kB**. Artikelbilder är cirka
**11–24 kB per bild** i de nya varianterna; tidigare kunde en artikelvy ladda
ett bildark på **3,4–3,6 MB**. `scripts/optimize-demo-images.mjs` och
`public/images/optimized-manifest.json` beskriver hur varianterna återskapas.

## Lokal uppföljning

Samma separata PostgreSQL 18-miljö som i granskningen användes. Syntetisk
integrationshistorik innehöll 0, cirka 2 och cirka 10 MB offentliga teststrängar;
inga tokens, personuppgifter eller externa API-anrop. Efter migrering låg den
kompakta anslutningen i just denna fixture på 168 byte; historiken finns kvar
i de indexerade posterna.

| Historik | Oförändrad affärstransaktion före uppdelning, tidigare median | Efter uppdelning, median av tre |
| --- | ---: | ---: |
| 0 MB | 4,37 ms | 4,28 ms |
| Cirka 2 MB | 31,51 ms | 4,48 ms |
| Cirka 10 MB | 121,12 ms | 3,77 ms |

SQL-antalet var fortfarande fyra och inga skrivningar gjordes i de mätta
oförändrade transaktionerna. En liten integrationsprojektion tog cirka
2–5 ms efter uppdelningen. Detta visar att historiken inte längre belastar
varje affärstransaktion. Det är **lokala fixtureprov, inte Render-tider, P95
eller ett löfte om samma förbättring i varje arbetsflöde**.

## Datamigrering och drift

Inga nya Render-variabler behövs. Servern förbereder migrationsschemat före
trafikstart. Migreringen och alla ursprungliga journalposter sparas atomiskt;
andra verksamhetsregister nollställs inte. Nya attribut bevaras i kompletta
JSONB-poster, vilket även omfattas av en fullständig PostgreSQL-backup.

Databasens versionsspärr avvisar äldre serverkod som försöker skriva tillbaka
den gamla integrationsjournalen under överlappande deploy. Ett redan påbörjat
leverantörsanrop från före bytet behåller sin reservation och behandlas som
osäkert om svaret inte kan bekräftas. Det återspelas aldrig automatiskt.
Äldre kod får därför inte återaktiveras direkt mot det nya journalformatet;
använd en kompatibel korrigering eller återställ databas och kod tillsammans.

## Verifiering

Produktionsbygge och Expo-typkontroll samt riktade server-, PostgreSQL- och
webbläsarprov används. De täcker bland annat aktuella behörigheter, kund-/
anläggningsisolering, samtidiga sparningar, låsta materialrader, historiska
timkrav och DST, migrering/rollback/återstart, okända Spiris-svar och skydd mot
dubbla leverantörer/fakturautkast. Produktionsrapporter, fakturor och
betalningar skickas inte av verifieringen.

Drifttider följs upp separat när Render har publicerat bygget.

Verifierat före push: produktionsbygge, Expo-typkontroll, databasprojektioner,
alla berörda integrations-/dokument-/material-/mobilflöden i isolerad PostgreSQL,
timberäkning och behörighetsregressioner. Riktade webbläsarprov passerade för
Spiris-inställningar, miljömottagning, sidstyrd hämtning, mobilens sparande och
offlinepris, dynamiska bilder samt terminalens popup. Alla sex appadresser
provades mot produktionspaketet. Start och revisions-/lageranrop verifierades
även med den slutliga servern och ett helt nytt lokalt datalager.
