# Dokumentgenomgång för NVV-fel 1023

Granskat 2026-10-10: alla 17 PDF:er i det uppladdade certifikatpaketet,
den uppladdade OpenAPI-filen, NVV:s aktuella Swagger-nedladdning samt
officiella anslutningssidor och ytterligare offentliga Expisoft-dokument.
Inga nya rapporter skickades, inga Render-inställningar ändrades och inga
ytterligare klientcertifikat hämtades. PIN, hämtningskoder, lösenord och
privata certifikatfiler ingår inte här.

## Viktigaste resultatet

Ingen av PDF:erna beskriver ett ytterligare NVV-ombudsfält, en särskild
Testbolag 1-registrering eller ett annat organisationsnummer som löser 1023.
Översikten anger uttryckligen att **Bolag A och Testbolag 1 har samma
organisationsnummer** och tillhör samma kategori,
Serverlegitimation/Organisationslegitimation. Namn och giltighetsperiod skiljer.
Det finns inget dokumentbevis för att enbart ett namnbyte till Bolag A hjälper.

Den kvarstående kontrollen är hur NVV får fram rapportörens organisationsnummer
ur den autentiserade anslutningen. Vårt verkliga Testbolag 1-certifikat har
`serialNumber` i Subject, med `16`-prefix och tillsammans med CN i samma
multivärda RDN. NVV beskriver jämförelsen med certifikatets organisationsnummer
men inte vilket X.509-attribut eller vilken normalisering deras tjänst använder.

## Täckning: samtliga PDF:er i ZIP-filen

Alla **69 sidor** har gåtts igenom. De sexton leveransbreven har fyra sidor
vardera; översikten har fem. Status kommer från översikten, inte från
en ny CRL/OCSP-kontroll.

| Fil | Sidor | Kategori | Status enligt översikten |
| --- | ---: | --- | --- |
| Bolag A.pdf | 4 | Server/organisation | Giltig |
| Bolag A stämpel.pdf | 4 | Stämpel | Giltig |
| Bolag B.pdf | 4 | Server/organisation | Spärrad |
| Bolag B stämpel.pdf | 4 | Stämpel | Spärrad |
| Bolag C.pdf | 4 | Server/organisation | Utgången |
| Bolag C stämpel.pdf | 4 | Stämpel | Utgången |
| Bolag D.pdf | 4 | Server/organisation | Giltig |
| Bolag D stämpel.pdf | 4 | Stämpel | Giltig |
| Bolag E.pdf | 4 | Server/organisation | Har inte börjat gälla |
| Bolag E stämpel.pdf | 4 | Stämpel | Har inte börjat gälla |
| Kommun A.pdf | 4 | Server/organisation | Giltig |
| Kommun B.pdf | 4 | Server/organisation | Giltig |
| Kommun C.pdf | 4 | Server/organisation | Spärrad |
| Testbolag 1.pdf | 4 | Server/organisation | Giltig |
| Testbolag 2.pdf | 4 | Server/organisation | Giltig |
| Testbolag 3.pdf | 4 | Server/organisation | Giltig |
| Testcertifikat organisation server stämpel.pdf | 5 | Översikt | Identiteter, typer, status och hämtning |

Leveransbreven beskriver hämtning av ett PKCS#12-certifikat och användning
av dess PIN/lösenord. De innehåller inga X.509-OID:er, RDN-layout,
EKU-profiler eller NVV-specifika anslutningsregler. ZIP-filen innehåller
inga faktiska klientcertifikat. Hämtningsidentifieraren är inte ett
organisationsnummer att föra in i NVV:s JSON.

Översiktens olika statusar är avsiktliga testfall för giltighet och spärrning.
Stämpellegitimationerna är en separat kategori. NVV efterfrågar ett
klientcertifikat med clientAuth; vårt hämtade Testbolag 1-certifikat har
den användningen. Ett faktiskt äldre Bolag A-certifikat finns inte bland
de lokala granskningsfilerna, så deras verkliga X.509-layout har inte kunnat
jämföras.

## Vad API-dokumentationen kräver

Den officiella Swagger-fil som NVV länkar som uppdaterad 2026-05-28 anger
fortfarande build 1.2.8, byggd 2023-05-23. Jämförelsen med den uppladdade
OpenAPI-filen visar samma resurser, fält, obligatoriska fält och
autentiseringsdefinition. NVV:s senaste nedladdning saknar den äldre HTTP-serverposten
och har tappat icke-ASCII-tecken i dokumentationstexten, men identitetsregeln
är oförändrad. Filnamnets WSO2-beteckning innebär inte att den innehåller
WSO2:s konfiguration för certifikatidentitet.

- Svenskt `verksamhetsutovare` anges med tio siffror utan bindestreck.
- När verksamhetsutövaren själv rapporterar ska ombud utelämnas.
- Vid ombudsrapportering ska `ombud` matcha certifikatets organisation och
  ombudets namn samt kontaktpersonens namn, e-post och telefon anges.
- Fel 1023 avser matchningen mot rapportörens organisation. Tidigare försök
  med kompletta ombudsfält gav fortfarande enbart 1023.
- mTLS, OAuth-token och `NV-Client-System-ID` krävs. Spårningsheadern
  `NV-Client-Tracking-ID` är frivillig. Vår adapter skickar båda headers.

Inget extra organisationsnummer i en HTTP-header är dokumenterat.
CFAR-nummer används inte för auktorisering enligt NVV:s FAQ. Ombud för
ansökan i anslutningsportalen och rapporteringens `ombud` är skilda roller;
Expisofts användning av ordet ombud avser också en annan tjänst/roll.

## Ny ledtråd från Expisofts certifikatpolicy

[Expisofts certifikatpolicy från 2025-08-21](https://eid.expisoft.se/wp-content/uploads/2025/10/Expisoft-Certifikatpolicy-Server-och-Stämpellegitimation-2025-08-21.pdf),
§7.2.1, sidorna 32–33, beskriver organisationsidentiteten i **Subject.SerialNumber**
som `16` följt av tio organisationsnummersiffror och ett eventuellt ytterligare
nummer. Certifikatets eget serienummer beskrivs separat och är inte företagets
identitet. Policyn beskriver produktionsprofilen **ExpiTrust EID CA v4**;
den bevisar inte vilken testprofil v8 NVV accepterar.

Vårt offlinegranskade testcertifikat har:

- Subject `serialNumber`, OID `2.5.4.5`: `165560000167`.
- CN `Testbolag 1` och serialNumber i **samma multivärda RDN**.
- Inget Subject `organizationIdentifier`, OID `2.5.4.97`.
- Normaliserat organisationsnummer `5560000167` och clientAuth.

Detta ger en precis fråga till NVV om läsning av serialNumber, multivärda
RDN:er och normalisering av prefixet. Att organizationIdentifier saknas
är inte i sig ett dokumenterat fel: NVV anger ingen offentlig regel om
den OID:n. En felaktig fälttolkning är en **hypotes**, inte en fastställd orsak.

NVV:s generella anslutningssida anger testutfärdaren **v8u**, medan Expisofts
aktuella sida, ZIP-översikt och vårt certifikat anger **v8**. Någon offentlig
förklaring att dessa benämningar är likvärdiga hittades inte. Skillnaden
ska bekräftas, men är inte bevis för att certifikatet avvisas.

De även granskade offentliga utfärdardeklarations- och FAQ-dokumenten
ger ingen specifik BTFA.Anteckning-regel som förklarar 1023.

## Följd för fortsatt felsökning

Det tolvsiffriga certifikatvärdet ska **inte** skickas som svensk
verksamhetsutövare: det har redan provats och gav dessutom fel 1022 för
felaktigt format. Fortsatta oförändrade kombinationer av JEROC/Testbolag 1
ger inte mer information om det okända rapportörsvärdet.

Be NVV slå upp ett sparat TraceId och återge det organisationsnummer de
faktiskt jämförde med, identitetskällan, stödet för denna Subject-layout
och accepterad testutfärdare. Frågorna och tidigare TEST-resultat finns i
[felsökning-1023.md](felsokning-1023.md). Ett kontrollerat byte till det äldre
Bolag A-certifikatet skulle kunna isolera en skillnad mellan de faktiska
certifikatprofilerna, men PDF:erna bevisar varken en sådan skillnad eller
att bytet löser felet.

## Källor

- Uppladdad ZIP: alla filer och sidor i täckningstabellen ovan.
- [Sparad OpenAPI](openapi/BTFA.Anteckning.json).
- [NVV: Rapportera till avfallsregistret via API](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/), inklusive aktuell Swagger och FAQ.
- [NVV: Anslutning till API-tjänst](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/).
- [Expisoft: ExpiTrust testcertifikat](https://eid.expisoft.se/expitrust-test-certifikat/).
- Expisofts certifikatpolicy, §7.2.1, länkad ovan.
- [Offlinegranskning av det uppladdade certifikatet](certifikatgranskning.md).
