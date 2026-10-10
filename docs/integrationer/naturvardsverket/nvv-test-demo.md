# NVV:s testetapp – kontorsdemo 0.12.2

Denna etapp kopplar mottagningsunderlag till en serverklient för
**BTFA.Anteckning TEST**. Mottagning, lager, kundgodkännande, intern attest
och utbetalning behåller sina egna steg. Ett myndighetssvar registrerar inte
avfallet i lagret en gång till och betyder inte att affären är attesterad.

## Lägen och avgränsning

- Utan konfiguration är anslutningen **avstängd**. Inga anrop skickas av
  installation, migration, sidvisning eller registrerad mottagning.
- `mock` är lokal **simulering**. Simulerade ID:n börjar med `SIM-` och
  visas aldrig som verkliga NVV-kvittenser.
- `test` använder endast NVV:s fasta HTTPS-adresser för TEST. Produktion
  och egna alternativa API-/tokenadresser stöds inte i denna etapp.
- Anslutningskontroll, mottagningsrapport, kvittens, återläsning i TEST och
  rättelse av en tidigare kvitterad mottagning ingår. Borttransport,
  transportörens egen rapport, makulering och produktion återstår.
- Första rapportproven avser företagsinlämningar med organisationsnummer
  och fullständig svensk adress. Hushåll/särskilda identifieringsfall ska
  få egna verifierade kontraktsprov före aktivering.

Kontorets personalinloggning är fortsatt demo. Ingen produktionssäker
personalinloggning eller produktionsrapportering införs av denna etapp.

## Det användaren behöver ordna

1. Själva server-/organisationscertifikatet som `.p12`/`.pfx` och lösenordet
   till just denna fil. Det tidigare uppladdade ZIP-paketet innehöll
   hämtningsbrev i PDF, inte ett installerbart klientcertifikat.
2. Aktuella **Key/Secret** från anslutningen **BTFA.Anteckning TEST**.
   Access-token behöver inte överlämnas: servern hämtar och förnyar den.
3. Rapporterande testorganisations namn, organisationsnummer och
   kontaktperson med e-post/telefon. Organisationen ska motsvara den
   accepterade certifikatidentiteten. Bekräfta med NVV om ett generiskt
   Expisoft-testbolag får användas med JEROC:s OAuth-anslutning.

### Uppladdat Testbolag 1-certifikat, 2026-10-10

Själva P12-filen har nu granskats **offline**, utanför repositoryt:
Testbolag1, organisationsnummer `5560000167`, utfärdare ExpiTrust Test CA v8,
giltig 2026-04-09 till 2028-04-09, RSA 2048 och både serverAuth/clientAuth.
Privat nyckel och certifikatkedja finns och Node:s TLS-klient kan öppna PFX
med lösenordet från motsvarande hämtningsbrev. Filen och lösenordet sparas
inte i GitHub. Detta verifierar formatet, inte NVV:s acceptans av certifikatet
eller testbolaget tillsammans med JEROC:s OAuth-anslutning.

Den manuella bekräftelsen i inställningsvyn dokumenterar att identiteten
kontrollerats av administratören; den är ingen automatisk verifiering av
certifikatets organisationsfält. Klienten kan kontrollera att PFX går att
öppna och att TLS fungerar, men ett sådant prov ersätter inte kontrollen av
rapporteringsorganisation/ombudsroll. Ombudsrapportering ingår inte här.

Lägg inga hemliga värden i GitHub eller chatten. Värden som tidigare delats
i chatt/skärmbild bör ersättas enligt portalens säkra förfarande inför testet.

## Serverinställningar på Render

På befintliga webbtjänstens **Environment** läggs följande:

| Namn | Värde |
| --- | --- |
| `NVV_ENVIRONMENT` | `test` för officiell TEST, `mock` för lokal simulering, annars `disabled`. |
| `NVV_CLIENT_ID` | Portalens Key, hemligt värde. |
| `NVV_CLIENT_SECRET` | Portalens Secret, hemligt värde. |
| `NVV_CLIENT_PFX_SECRET_FILE` | `/etc/secrets/nvv-client-pfx.b64` enligt filen nedan. |
| `NVV_CLIENT_PFX_PASSWORD` | Certifikatets lösenord/PIN, hemligt värde. |
| `NVV_CLIENT_SYSTEM_ID` | Systemnamn och version, exempelvis `JEROC 0.12.0`. |

Under **Secret Files** skapas `nvv-client-pfx.b64` med base64-innehållet av
hela `.p12`/`.pfx`-filen. För att kopiera detta på Mac, använd Terminal lokalt:

```sh
base64 -i '/sökväg/till/certifikat.p12' | pbcopy
```

Klistra resultatet direkt i Render Secret Files. Base64 är en representation,
inte kryptering, och filen ska hanteras som en hemlighet. Binärfilen och
lösenordet får inte placeras i repot. Certifikatet avkodas i serverns minne.
Render kan därefter bygga/starta om tjänsten med de nya inställningarna.

API-basen är låst till
`https://apimtest.naturvardsverket.se/btfa/anteckning/v1`, och tokenadressen
till `https://apimtest.naturvardsverket.se/oauth2/token`. Dessa används
automatiskt. TLS-verifiering är aktiv; portalexempel med `-k` används inte.
Klienthemligheter, token, PFX-innehåll och lösenord skickas aldrig till UI.

### Verifierad anslutning och popup i 0.12.2

Efter konfigurering på Render verifierades ett verkligt TEST-anslutningsprov
med Testbolag 1-certifikatet: OAuth/TLS och läsning av 973 avfallskoder samt
sex transportsätt fungerade. Testkontakten använder uttryckliga
dummyuppgifter. Provet skickade ingen mottagningsrapport och verifierar
inte rapporteringsroll, mottagningspayload eller rättelsekedja.

Knappen **Kontrollera testanslutning** öppnar nu en animerad popup medan
servern arbetar. Den visar antal, resultat och verkliga kodlisteanrop med
HTTP-status och begränsade svarsutdrag. OAuth-fel visar tokenanropets status
utan att röja credentials eller token. Tidigare kontroller utan denna logg
går fortfarande att läsa. Simulering och saknad konfiguration genererar
inga påhittade anropsrader. **Kör i bakgrunden** döljer bara popupen.

Ett lyckat anslutningsprov gäller bara de serverinställningar och den
rapporterande organisation som kontrollerades. Efter ändrade nycklar,
certifikat, lösenord eller rapporteringsuppgifter krävs ett nytt prov.

## Provflöde

1. Öppna **Integrationer → Naturvårdsverket → NVV-inställningar** som Systemadmin, utan
   att jobba som en annan användare. Spara testorganisation/kontakt och
   dokumentera kontrollerad testidentitet.
2. Kör **Kontrollera anslutning**. Klienten hämtar token och läser
   avfallstyper/transportsätt. Blybatterier `160601` och väg `R` ska finnas.
   En token eller lyckad kodlista är inte en kvittens för en mottagning.
3. Använd ett separat testkort: till exempel 250 kg blybatterier samt
   12 kg koppar, företagskund, fullständigt ursprung och mottagningsplats.
   Följ befintligt kundgodkännande och bekräfta den faktiska mottagningen.
4. Öppna mottagningsunderlaget i Miljörapportering och skicka uttryckligen
   till TEST. Endast farliga mängder ingår. Senaste mottagningsversionen
   fryses som exakt API-payload med kontrollsumma innan sändning.
5. Kontrollera att verkligt TEST-svar/avfalls-ID sparats och återläs
   anteckningen i TEST. En simulerad kvittens är alltid märkt simulering.
6. Rätta den lokala mottagningen till 245 kg med motivering. Skicka den
   aktuella rättelsen. Den använder hela payloaden och senaste accepterade
   avfalls-ID:t; kvittensen ger ett nytt ID. Gamla underlag/ID:n bevaras.
7. Prova dubbelklick, olika kontorister, omstart och fel. Samma underlag får
   inte bli två sändningar och kvittensen får inte skapa en lagerhändelse.

## Kvittenser och osäkert utfall

Rapportversioner, försöksjournal, resultat och reservationer sparas beständigt
i befintlig miljörepository (PostgreSQL på Render, SQLite lokalt). Migration
004 lägger till separata NVV-entiteter utan att återställa gamla mottagningar.
Nätanrop sker utanför databastransaktionen. Ett reserverat försök skyddar
mot två samtidiga sändningar; en avbruten sändning blir osäker i stället för
att automatiskt skickas på nytt efter serveromstart.

Ett bekräftat svar sparar miljö, skickad payload/version/hash, aktör,
HTTP-status, svarsdata, tid, tracking-ID och avfalls-ID. Fel får begriplig
text och behåller tekniskt underlag med hemligheter maskerade.

Timeout, tappat svar, oväntat lyckat svar utan giltigt ID och tvetydigt
serverfel blir **Osäkert utfall**. Ingen blind POST/PUT-omsändning görs.
TEST-återläsning får knyta en entydigt matchande anteckning till den frysta
versionen; utebliven/tvetydig match lämnas för utredning.
`NV-Client-Tracking-ID` och `referens` är spårning, inte ett dokumenterat
dedupliceringslöfte från NVV. TEST-läsning är inte en verifierad motsvarande
återhämtningsfunktion i produktion.

NVV skickar ingen PDF via API. Kvittensen visas separat från signerade
transportdokument och avräkningar; arkiverade original skrivs inte om.
En separat kvittens-PDF kan läggas till senare.

## Behörigheter

- `environmentRead`: läsa tillåtna anläggningars underlag/historik.
- `environmentReport`: skicka mottagningsrapport och stämma av osäkert utfall.
- `environmentReportCorrect`: dessutom skicka rättelse till aktuell kvittens.
- `environmentIntegration`: inställningar/anslutningskontroll, även krav på
  både faktisk och effektiv Systemadmin. Jobba som ger inte adminåtkomst.

De nya utskicksrättigheterna är uttryckliga för VD/medarbetare och kontrolleras
på servern tillsammans med anläggningsåtkomst, aktuell version och session.
Gamla kvittenser måste gå att läsa även när konfigurationen ändras eller
integrationen stängs av. Lokal rättelse och lagerdelta hanteras fortfarande
av befintligt miljöflöde.

## Källor

- [NVV: rapportera till avfallsregistret via API](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/).
- [NVV: anslutning till API-tjänst](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/).
- [Granskat API-kontrakt](api-kontrakt.md) och [certifikatpaket](certifikatgranskning.md).

Dokumentationen innehåller äldre exempel med annan status/skiftläge än
OpenAPI:s `200`/`avfallId`. Den verkliga TEST-anslutningen behöver verifiera
det observerade svaret och rättelsekedjan före ett besked om färdig koppling.
