# FTC134 – första telematikbackend

Datum: 2026-10-16. ÄL 127.

En separat **digital testbil med virtuell FMC003** finns enligt ÄL 128 på
`/testbil1` efter deploy. Den använder en avskild syntetisk kanal och utökar
inte pilotens rättigheter till verkliga fordon eller positionslagring.
[Användning, uppbyggnad och begränsningar](testbil.md).

**Status: fungerande, fristående pilotgrund med lokal simulator.** Mottagaren
har inte startats på Render och ingen fysisk tracker är ansluten. Kontorets
fordonsregister och appens vyer är inte kopplade till piloten ännu.

## Utan panel först, tillval senare

FTC134 kan skicka tändning, rörelse och virtuell mätarställning direkt till
vår egen mottagare. RFID-läsare och Privat/Tjänst-knappar är ett separat
tillval; de behövs inte för att ta emot telemetri eller identifiera resor.
Panelen kan vara kabelansluten. Backend kräver inte Bluetooth.

Fordonet kan ha en **standardförare** även utan panel. Ett aktuellt förarval
i appen eller ett verkligt blipp ersätter standardföraren för just den resan.
Nästa resa börjar åter med den då gällande standardföraren. Projektionen visar
`driverSource: default/app/panel/unknown` och skiljer standardtilldelning från
observerad identifiering. Även ett blipp av standardförarens eget kort märks
som observerat. Två olika faktiska förarval inom samma resa kräver granskning.
Ingen av dessa källmarkeringar bevisar i sig vem som faktiskt körde bilen.

Den betrodda resolvern kan lämna
`defaultDriver: { id, tenantId, active }`, efter kontroll mot bolagets personal.
Trackerpaketet får inte ange den uppgiften. Standardföraren sparas som en
snapshot vid första mottagning; ändrad standard och återförsök skriver inte
om historiken. Ändringshistorik för sena paket behöver tillkomma före riktig
drift så att standardförare kan bestämmas vid resans tid, inte mottagningstiden.
Väljaren för standardförare i webb/app återstår; flera personers befintliga
fordonskoppling får inte godtyckligt tolkas som en entydig standardförare.

Enheten kopplas till ett befintligt fordons-ID i ett bestämt bolag.
Inga fordon eller bolag skapas automatiskt från IMEI. Nuvarande pilot-API
kräver en betrodd resolver som bekräftar aktivt bolag och fordon vid
registrering, anslutning och inför varje datapaket. Simulatorns resolver
känner enbart till sina fiktiva testreferenser. Produktionsresolven ska
använda plattformsregistret och bolagets `state.transport.vehicles`.

`driverPanel: false` är standard. Flaggan kan beskriva planerad utrustning,
men innebär inte att RFID, knapptryck eller summer redan har implementerats.
Mottagaren tolkar ännu inga sådana händelser. Fordonsbokning, appinloggning
eller senast kända iButton-ID får inte räknas som en ny föraridentifiering.

## Det som är byggt

| Del | Beteende |
| --- | --- |
| TCP-mottagare | IMEI-handshake, delade och sammanslagna paket, storleksgräns, tidsgränser och anslutningsgräns. |
| Codec 8 Extended | Validerar längder, antal, CRC16/IBM och I/O-grupper inklusive 64-bitars/variabla värden. |
| Normalisering | Whitelist för tändning, rörelse och virtuell totalodometer i meter. |
| SQLite-pilot | Beständig radlagring, bolagsbundna referenser, unika record-ID:n, batchtransaktion och paginerad läsning. |
| Kvittens | Sänds först efter commit. Samma post i ett återförsök kvitteras utan en ny rad. |
| Resor | Tändning på/av avgränsar resor. Första på-signalen utan observerad start markeras osäker. |
| Standardförare | Används från betrodd fordonssnapshot. Aktuellt appval/blipp kan ersätta den för resan. |
| Saknade uppgifter | Utan standardförare eller aktuellt förarval är föraren okänd. Appflödet för komplettering återstår. |
| Datakvalitet | Mätargap/-återställning ger okänd sträcka; motstridiga tidsstämplar markeras för granskning. |

Reseprojektionen är en ren intern funktion som även kan ta emot betrodda
app-/panelhändelser. En uttryckligen påbörjad arbetsorderresa kan ange
tjänst och arbetsorder. Tjänst utan arbetsorder kräver manuellt syfte.
Privat tar bort arbetsorder och tjänstesyfte. Vid samtidig konflikt vinner
privat och resan flaggas. Varje resa börjar med aktuell standardförare eller
okänd förare och tomt syfte; tidigare blipp ärvs inte. Efterhandskomplettering behöver ett separat behörighetskontrollerat
kommando med rese-ID; det finns ännu inte.

Tändningssignalen ska konfigureras för verklig fordons­tändning, så att
motorstopp vid trafikljus inte avslutar en resa. Mottagaren härleder inte
tändning från rörelse, strömspänning eller enbart uteblivna paket.

## Integritet och anslutningsskydd

GPS avkodas för korrekt protokollhantering men **koordinater, råpaket, okända
I/O-värden och RFID-värden lagras inte**. Dubblettskyddet använder en hash
av den avkodade posten; även hash och tids-/fordonsdata behandlas som
skyddsvärda uppgifter. Felrapporteringen lämnar enbart generiska felkoder.
Kartor, rutter och geokodning ingår inte. En senare ruttfunktion måste
bestämma insamling, behörighet och gallring för privat/oklassificerad resa
innan positionslagring slås på.

IMEI är en identifierare, **inte autentisering**. Oskyddad TCP är därför
begränsad till `127.0.0.1`/`::1`. En publik lyssnare kräver i nuvarande kod
mTLS med betrodd klientkedja och en certifikatfingeravtryckning registrerad
för just enhetens IMEI. Anslutningsgräns och tidsgräns gäller även TLS-handshake.
Detta har provats mellan lokala Node-klienter med syntetiska certifikat.
FTC134:s dokumenterade server-TLS är inte bevis för stöd för vår mTLS-profil.
Den faktiska enhetens firmware och certifikatstöd ska verifieras; alternativt
behövs en separat autentiserad transport, exempelvis privat APN/VPN med
säker enhetsprovisionering. Publik IMEI-baserad klartext får inte öppnas.

Byte av bolag/fordon är avsiktligt spärrat för en befintlig bindning.
Avaktivering och återaktivering byter generation så att en gammal anslutning
inte återfår skrivåtkomst. Säker överlåtelse, byte av tracker och nyckelrotation
behöver egna historikbevarande kommandon senare.

## Provkörning

Från repots rot med installerade beroenden och Node enligt `package.json`:

```sh
node --test server/telematics-*.test.mjs
node scripts/telematics-demo.mjs
```

Demon öppnar en tillfällig SQLite-fil och en riktig TCP-port på loopback,
skickar syntetiska FTC134-paket och ett återförsök och visar en resa på
6 500 meter med fiktiv standardförare. Sex kvitterade poster blir tre lagrade poster och en resa.
Allt stängs och demofilen tas bort. Inga externa anrop, produktionsuppgifter,
nya miljövariabler eller kontoändringar behövs. TLS-testerna använder OpenSSL
för kortlivade, lokala testcertifikat.

Verifierat 2026-10-16: **41/41 riktade tester godkända**, inklusive officiell
Codec 8E-exempelfil, felaktiga paket, fragmentering, commit före ACK,
omstart/deduplicering, bolagsgränser, återkallad bindning, kvot/rollback,
TLS-klientkontroll, standardförar-snapshots, tillfälliga förarbyten och
privatkonflikter. Tester med lokal simulator är inte
ett lyckat prov mot fysisk FTC134 eller en produktionsplattform.

## Dokumentation som har verifierats

Det finns tillräckligt publicerat underlag för denna implementation. Vi har
inte verifierat all firmware, alla tillbehör eller varje protokollvariant.

| FTC134-uppgift | Dokumenterat AVL-ID |
| --- | --- |
| Tändning / rörelse | 239 / 240 |
| Virtuell totalodometer, meter | 16 |
| GNSS-tripodometer, meter | 199 |
| iButton, 8 byte | 78 |
| DIN 1 / 2 / 3 / 4 | 1 / 2 / 3 / 262 |
| DOUT 1 / 2 / 3 | 179 / 180 / 380 |
| Tjänst / privat | 391: 0 / 1 |
| Trip | 250: 0 stopp, 1 start, 2 tjänst, 3 privat |

Denna version normaliserar endast 239, 240 och 16. Totalodometern är virtuell,
inte ett löfte om bilens ECU-mätarställning. ID:n från andra Teltonika-plattformar
får inte återanvändas utan modellkontroll. UDP och fjärrkommandon ingår inte.

Officiella källor, lästa 2026-10-16:

- [FTC134:s AVL-parametrar och länk till Codec 8 Extended](https://wiki.teltonika-gps.com/view/FTC134_Teltonika_Data_Sending_Parameters_ID)
- [Codec 8 Extended: TCP, IMEI, CRC och ACK](https://wiki.teltonika-gps.com/view/Codec#Codec_8_Extended)
- [FTC134 Mobile network: TCP/UDP och TLS/DTLS](https://wiki.teltonika-gps.com/view/FTC134_Mobile_network)
- [Skillnader mellan FT och FMB:s AVL-ID:n](https://wiki.teltonika-gps.com/view/AVL_ID_differences_between_FMB_and_FT_platforms)
- [FTC134 funktioner: bland annat privat/tjänst och lokal I/O-logik](https://wiki.teltonika-gps.com/view/FTC134_Features)
- [FTC134 First Start och pinout](https://wiki.teltonika-gps.com/view/FTC134_First_Start)
- [Render Web Services och HTTP-port](https://render.com/docs/web-services)

## Nästa etapp före verklig drift

1. Skaffa en FTC134, SIM och faktisk firmwareversion. Prova tändningskälla,
   buffring utan täckning, tidsordning, återförsök, TLS och serveridentitetskontroll.
2. Driftsätt en separat mottagartjänst med publik TCP/TLS eller verifierad privat
   transport. Render-webbtjänstens HTTP-ingång används inte för trackerpaketen.
3. Bygg PostgreSQL-radlagring med migrationer, retention, backup, återställning,
   skrivkapacitet och larm. SQLite-versionen är en pilot med max 50 000 poster
   per enhet; full lagring avvisar hela paketet i stället för att kvittera bort det.
   En tracker har begränsat eget buffertminne: stopp ska larma innan det blir fullt.
4. Koppla registrering/läsning/komplettering till verkligt bolag, befintliga
   fordon och separata behörigheter i kontor/app. Inför spårbarhet, provisionering
   och säkra kommandon för bindningsändringar. IMEI från en klient får inte välja bolag.
5. Gör inkrementell resebearbetning och sena-händelsehantering utan att läsa om
   all historik. `projectTrips` behöver en sammanhängande historik för ett fordon;
   en enskild begränsad sida är inte en komplett körjournal.
6. Lägg till paneladapter senare: verkligt blipp, återställning per tändning,
   momentana knapphändelser, identitetsmatchning och lokal summer även offline.
   Ett konstant I/O-värde får inte tolkas som ett nytt blipp/knapptryck.

Källkod: `server/telematics/`. Kommandot som demonstrerar grunden finns i
`scripts/telematics-demo.mjs`. Inga delar startas automatiskt av `npm start`.
