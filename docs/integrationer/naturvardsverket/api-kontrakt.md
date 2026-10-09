# API-kontrakt för Avfallsregistret

Teknisk granskning 2026-10-09 av den uppladdade `BTFA.Anteckning.json` mot Naturvårdsverkets tidigare hämtade officiella Swagger. Dokumentet är ett underlag för senare implementation. Ingen autentisering, rapportering, makulering eller ändring av applikationskod har utförts i denna granskning.

## Vad den nya filen ändrar

Båda filer anger OpenAPI **3.0.1**, API-version **v1**, implementation **1.2.8**, build **8543.15421**, byggtid **2023-05-23**. De har samma 24 sökvägar och 34 komponentmodeller.

En rekursiv jämförelse av parsad JSON gav 200 skillnader:

| Skillnad | Antal | Betydelse |
| --- | ---: | --- |
| Återställda icke-ASCII-tecken i `description` | 175 | Svenska tecken och regex i beskrivningarna blir läsbara. |
| Återställda icke-ASCII-tecken i `summary` | 24 | Samma operationer, återställd svensk text. |
| Extra serveradress | 1 | Den uppladdade filen lägger till `http://apim.naturvardsverket.se/btfa/anteckning/v1`. Den ska inte användas. |

För samtliga 199 textskillnader är den tidigare texten exakt den nya texten med icke-ASCII-tecken borttagna. Inga ändringar finns i sökvägar, HTTP-metoder, fältnamn, datatyper, `required`, enumvärden, säkerhetsschema eller svarsmodeller. Det finns inga maskinella `pattern` som ändrats; regex ligger i löpande beskrivningar. Filen visar ingen ny TEST-specifik kontraktsversion.

SHA-256 för att identifiera granskat underlag:

- Uppladdad `BTFA.Anteckning.json`: `4b29c43f4c6b818b13aaec51488edd06779a4a35f41fb7fb3bd1fe9c3f5f74cb`.
- Tidigare `swagger_BTAVFALL_prod_WSO2.json`: `22853cbf054ca17f22af9b93864beaa5a4116ca5339487aa5b1c4858f0e716f9`.

## Miljö, autentisering och headers

Den uppladdade filen innehåller **produktionsadresser**, även om den hämtats i samband med TEST-anslutning. Miljö måste väljas uttryckligen i framtida serverkonfiguration.

| Inställning | Granskat underlag |
| --- | --- |
| TEST API-bas | `https://apimtest.naturvardsverket.se/btfa/anteckning/v1` enligt officiell API-sida. |
| TEST token | `https://apimtest.naturvardsverket.se/oauth2/token` enligt anslutningsunderlaget för TEST. |
| Tokenbegäran | `POST`, `grant_type=client_credentials`, `Authorization: Basic Base64(key:secret)`, `Content-Type: application/x-www-form-urlencoded`. Base64 är kodning, inte kryptering. |
| Produktionsbas i båda JSON-filerna | `https://apim.naturvardsverket.se/btfa/anteckning/v1`. Produktionskonfiguration måste bekräftas vid produktionsanslutning. |
| API-autentisering | Klientcertifikat/mTLS och `Authorization: Bearer …`. Organisationen måste stämma med rapporteringsrollen nedan. |
| Obligatorisk systemheader | `NV-Client-System-ID`: systemnamn och version. |
| Frivillig spårningsheader | `NV-Client-Tracking-ID`: eget spårnings-ID, annars tilldelas ett UUID. Returneras enligt API-sidan i svaret. |
| JSON | `Content-Type: application/json; charset=UTF-8`; begär JSON-svar med `Accept: application/json`. |

OpenAPI anger endast ett OAuth2-**implicit**-flöde med produktions-`authorizationUrl` och tomma scopes. Det beskriver inte den bekräftade tokenbegäran för serverintegration, mTLS eller `NV-Client-*`-headers. De granskade skrivoperationerna saknar dessutom `requestBody.required`, trots att en användbar begäran behöver body. En genererad klient behöver därför kompletteras senare.

Anslutningssidans publika tokenexempel har stavningen `/aouth2/token`; TEST-underlaget anger `/oauth2/token`. API-sidans produktionsexempel använder `/btfa/tillsyn/v1`, vilket skiljer sig från båda anteckningskontrakten. Dessa motsägelser ska inte kopieras till konfiguration.

TLS ska verifiera servercertifikat och värdnamn. Portalexempel med `-k` ska inte föras över till implementation. Ett klientcertifikat ersätter inte serververifiering. Nycklar, token, certifikatets privata nyckel och lösenord hör hemma i serverns säkra konfiguration och får inte lagras i dokumentation, mobilklient eller Git.

## Rätt rapporteringsroll för JEROC

| Händelse och roll | Skapa | Korrigera | Modell under `BTAvfall.PublicModels.V1.Request.Anteckningar` |
| --- | --- | --- | --- |
| JEROC tar emot farligt avfall som insamlare, 6 kap. 3 § 1 | `POST /insamlingar` | `PUT /insamlingar/{id}` | `InsamlingsMottagning` |
| JEROC skickar insamlat avfall vidare, 6 kap. 3 § 2 | `POST /insamlingstransport` | `PUT /insamlingstransport/{id}` | `InsamlingsTransport` |
| Transportörens egen transportanteckning, 6 kap. 2 § | `POST /transporter` | `PUT /transporter/{id}` | `Transport` |

Insamlarens utgående anteckning och transportörens anteckning är skilda skyldigheter. Att ange en extern transportör i `transportor` innebär inte att JEROC rapporterar transportörens egen anteckning. Om JEROC också ska rapportera som transportör måste det bedömas utifrån den faktiska rollen och eventuella undantag.

När JEROC rapporterar för egen räkning är JEROC `verksamhetsutovare` och dess organisationsnummer ska matcha klientcertifikatet; `ombud` och samtliga ombudskontakter ska utelämnas. Vid behörig ombudsrapportering anges den anteckningsskyldiga organisationen som `verksamhetsutovare` och certifikatets organisation som `ombud`, med `ombudetsNamn`, `ombudetsKontaktpersonNamn`, `ombudetsKontaktpersonEpost` och `ombudetsKontaktpersonTelefonnummer`. Ombudsbehörighet kan inte härledas från att kunden eller transportören finns i JEROC:s register.

## Exakta obligatoriska uppgifter

Följande fält krävs i **alla tre modeller**:

| Fält | Innehåll |
| --- | --- |
| `verksamhetsutovare` | Anteckningsskyldig organisation, normalt tio siffror utan bindestreck. Beskrivningen tillåter även utländskt VAT-nummer. |
| `verksamhetensNamn` | Företagets namn, högst 250 tecken enligt beskrivningen. |
| `verksamhetensKontaktpersonNamn` | Kontaktpersonens namn, högst 250 tecken enligt beskrivningen. |
| `verksamhetensKontaktpersonEpost` | Kontaktpersonens e-post, högst 250 tecken och validerad enligt beskrivningen. |
| `verksamhetensKontaktpersonTelefonnummer` | Kontaktpersonens telefonnummer enligt beskrivet format. |
| `tidpunkt` | När verksamheten gjorde anteckningen, `date-time`. Håll isär detta och den fysiska händelsens datum. |
| `avfall` | Ett objekt med obligatoriska `kod` och `mangd`. |
| `transportsatt` | Kod för transportsätt, exempelvis `R` för vägtransport. |

Kontaktpersonens namn finns i `required` även om fältbeskrivningen säger ”Obligatoriskt om ombud är ifyllt”. Utgå från det strängare obligatoriska kravet för verksamhetskontakterna även vid egen rapportering.

Utöver de gemensamma fälten krävs:

| Modell | Ytterligare obligatoriska fält |
| --- | --- |
| `InsamlingsMottagning` | `mottagningsDatum`, `tidigareInnehavare`, `senasteHanteringsPlats`, `kommandeHanteringsPlats`. |
| `InsamlingsTransport` | `borttransportDatum`, `transportor`, `nyInnehavare`, `mottagningsplats`. |
| `Transport` | `transportStartDatum`, `tidigareInnehavare`, `nyInnehavare`, `transportStartplats`, `transportSlutplats`. |

Alla händelsedatum ovan är `date-time`. En senare implementation bör skicka entydiga ISO 8601-tider med tidszon. Identiteter för innehavare anges enligt beskrivningen som orgnr/persnr eller utländskt VAT-nummer, normalt utan bindestreck. Transportör anges med orgnr eller utländskt VAT-nummer. JSON-nycklarnas stavning och skiftläge måste bevaras, särskilt `kommandeHanteringsPlats`, `senasteHanteringsPlats` och `mottagningsplats`.

För blybatterier är avsedd EWC-kod **`160601`**, som sträng utan mellanslag eller asterisk. Kontrollera den mot den autentiserade kodlistan `GET /avfallstyper` före senare provrapportering. `mangd` är avfallsmängden i **kg**, strikt större än noll och med högst tre decimaler. API:t har ett avfallsobjekt per anteckning; flera avfallskoder behöver separata anteckningar. Pris, inköpsbelopp och antal batterier ersätter inte uppmätt kg.

Frivilligt `referens` får enligt beskrivningen vara högst 40 tecken och kan koppla anteckningen till en lokal händelse. Frivilligt `avfall.foregaendeAvfallId` länkar till närmast föregående verkliga avfallsanteckning för mängden. Det är en annan relation än en rättelses versionskedja.

Mottagningsmodellen har inga fält för transportör, fordonsregistrering, pris, betalning, attest, signatur eller transportdokumentnummer. Utgående insamlingsmodell har inget separat fält för avgångsplats. Sådana uppgifter får bevaras lokalt där verksamheten behöver dem; de ska inte skickas som uppfunna API-fält.

## Platsuppgifter och villkor

`Plats` beskriver fem sätt att ange en plats:

| Variant | Fält enligt beskrivningen |
| --- | --- |
| Svensk adress | `kommunkod` med fyra siffror och `adress.adressrad` samt `adress.postnummer` med fem siffror utan mellanslag. |
| Svensk koordinat | `kommunkod` och `koordinat.nposition` med sju siffror samt `koordinat.eposition` med sex siffror, heltal i **SWEREF 99 TM**. `koordinat.beskrivning` är frivillig. |
| Utländsk plats | `land`, ISO 3166-1 alpha-2. Sverige ska inte skickas som `land: "SE"` enligt felkod 1702. |
| Svenskt arbetsställe | `kommunkod` och `cfarNR` med åtta siffror, när CFAR är känt för verksamheten som lämnar eller tar emot avfallet där. |
| Särskilt ursprung | Enbart `kommunkod` om tidigare innehavare är exakt `OKÄND` eller `KOMMUN`, för okänt ursprung respektive flera hushåll i kommunen. |

Den återställda texten klargör stavningen **`OKÄND`**. Det är inte `OKAND`. Samtidigt säger kontraktet uttryckligen att godtagbara varianter beror på **anteckningstyp och platstyp**, och fältbeskrivningen för `tidigareInnehavare` anger bara orgnr/persnr/VAT. Specialvärdena är därför inte en generell reservlösning för en kund vars organisationsnummer saknas. Felkatalogen nämner även `KOMMUN` och `SAKNAS` för CFAR, medan `cfarNR` beskriver åtta siffror; dessa specialfall behöver också bekräftas.

Maskinschemat kräver alltid `kommunkod`, även för den beskrivna utlandsvarianten, medan `Adress` och `Koordinat` saknar egna `required`-listor. Många format- och villkorskrav finns bara i beskrivningar och felkatalog. Automatisk OpenAPI-validering räcker därför inte. Använd svenska adresser med komplett kommun, adressrad och postnummer som första TEST-fall; bekräfta övriga platsvarianter i rätt roll med Naturvårdsverket innan stöd byggs. WGS84-latitud/longitud från GPS kan inte skickas som SWEREF-värden utan omvandling.

## Svar, rättelse och makulering

| Operation | Dokumenterat lyckat svar | Viktig detalj |
| --- | --- | --- |
| POST och PUT för de tre rollerna | `200`, `AntecknaSvar` med `avfallId` | Fältet är tekniskt nullable i schemat. En framtida klient måste ändå kräva ett giltigt avfalls-ID för att kunna markera en rapport som säkert kvitterad. |
| `DELETE /anteckningar` | `200`, ingen svarsmodell | Begäran har JSON-body med obligatoriska `avfallsId` och `makuleringsorsak`. |
| `GET /anteckningar` | `200`, `AnteckningarContainer` | Endast AT/TEST enligt operationens text. |
| `GET /anteckningar/{avfallid}` | `200`, tomt schema `{}` | Endast AT/TEST; det exakta svarskontraktet är ofullständigt. |

API-sidans äldre exempel visar **201** och **`AvfallsId`**, medan båda JSON-filerna anger **200** och **`avfallId`**. Sidans exempel använder också äldre begäransfält som `tidpunktForAnteckningen`. Utgå från granskat schema för fältnamn och verifiera faktiskt status, skiftläge och body i TEST. En oväntad 2xx eller en body utan giltigt ID behöver utredas innan automatisk omsändning.

PUT är en rättelse med **hela modellens innehåll**, inte en PATCH. Path-`id` betyder det befintliga **avfalls-ID:t**. `AntecknaSvar` säger uttryckligen att rättelsen skapar ett **nytt `avfallId`**. Spara därför gammalt och nytt ID, oförändrade tidigare payloads samt tid och utförare för varje version. Nästa rättelse ska utgå från senaste ID:t. Felkod **3022** betyder att en nyare version redan finns; **3023** att anteckningstypen är fel.

För makulering skiljer sig stavningen: begäran använder **`avfallsId`**, skapande/rättelse svarar med **`avfallId`**. Tillåtna `makuleringsorsak` är exakt `FelAvfall`, `FelAnteckningstyp`, `FelVU` och `SkickatDubbelt`. Kontraktet har inget fritextfält för motivering; lokal motivering och revisionsspår behövs separat.

Felsvar varierar per endpoint. Insamlings-POST/PUT och transport-PUT anger `Felsvar` med `title`, `statusCode`, `message`, `traceId`, `errors[].code` och `errors[].message`. Transport-POST anger däremot `InputValidationErrorDetails`; DELETE anger `ProblemDetails`. Gateway- och autentiseringsfel kan vara XML eller HTML enligt API-sidan. En gemensam felhantering får inte förutsätta att alla fel har samma JSON-form.

## TEST-läsning, spårning och osäkert utfall

`GET /anteckningar` hämtar endast organisationens egna anteckningar där verksamhetsutövare eller ombud matchar. Exakta querynamn är `DatumTidFran`, `DatumTidTom`, `MaxAntalPerSida` och `Sida`. Svaret innehåller `antalRader`, `antalPerSida`, `sida`, `antalSidor` och `anteckningar`.

I listmodellen är anteckningens `id` och `avfall.avfallId` skilda identiteter. Versionsfält finns som `ersattAv`, `foregaendeVersion`, `foregaendeAvfallsid` och `ersattAvAvfallsid`. Namnet `ersattAv` och dess beskrivning pekar inte entydigt åt samma håll; verifiera relationernas riktning med en kontrollerad TEST-rättelse. Bygg inte produktionsåterhämtning på de GET-operationer som uttryckligen är TEST-begränsade.

`NV-Client-Tracking-ID` är spårning och `referens` är felsökningshjälp. Inget av dem är dokumenterat som en idempotensnyckel eller dubbelskydd. För framtida implementation behövs en beständig lokal sändningskö, ett unikt samband mellan händelse, roll och version samt sparad kvittens. Timeout efter POST eller PUT kan betyda att myndigheten accepterat rapporten men att svaret förlorats. Markera då utfallet som osäkert och utred det; en blind omsändning kan skapa en dubblett.

## Vad som ska verifieras före implementationens godkännande

1. Bekräfta certifikatets organisation och JEROC:s avsedda roll; skilj egen rapportering från ombudsrapportering.
2. Hämta kodlistorna i TEST och verifiera `160601` samt transportsätt `R`.
3. Prova senare en godkänd mottagningsanteckning med kompletta svenska adresser och verksamhetskontakter. Kontrollera faktiskt status, exakt `avfallId` och TEST-läsning.
4. Rätta testanteckningen med full payload; kontrollera nytt ID och versionsriktning samt svaret när gammalt ID används.
5. Prova utgående insamlingsanteckning med faktisk mottagare och transportör. Pröva transportörsrollen separat om den ingår i JEROC:s skyldighet.
6. Bekräfta villkor för CFAR, koordinater, utlandsplats, `OKÄND` och `KOMMUN` för varje relevant platstyp.
7. Makulera en avsedd testanteckning och kontrollera hur detta avspeglas i TEST-läsningen.
8. Verifiera felhantering och lokalt osäkert utfall utan automatisk dubbelsändning. Spara observerade svar som maskerade kontraktsexempel.

Dessa är framtida verifieringspunkter. Inga av anropen har körts i denna granskning.

## Källor

- [Naturvårdsverket: Rapportera till avfallsregistret via API](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/) – roller, miljöer, headers, mTLS och exempel. Sidans Swagger-länk anges uppdaterad 2026-05-28; detta är inte belägg för en ny backendversion.
- [Naturvårdsverket: Anslutning till API-tjänst](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/) – anslutning, token och servercertifikatsverifiering.
- [Officiell Swagger ZIP](https://www.naturvardsverket.se/49c41c/globalassets/vagledning/avfall-och-kretslopp/farligt-avfall/avfallsregistret/api/swagger_btavfall_prod_wso2.zip) – tidigare JSON, jämförd lokalt mot uppladdad `BTFA.Anteckning.json`.
- TEST-anslutningens portalunderlag – tokenadress och grant, återgivna här utan nycklar eller andra hemliga värden.
