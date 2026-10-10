# Granskning av Expisofts testcertifikatpaket

## Uppföljning 2026-10-10

Användaren har nu lämnat ett faktiskt P12-certifikat för **Testbolag1**.
Offlinegranskningen verifierade organisation `5560000167`, ExpiTrust Test CA v8,
giltighet 2026-04-09 till 2028-04-09, RSA 2048, serverAuth och clientAuth,
privat nyckel och medföljande CA-kedja. Certifikatets signatur och CA:s
självsignatur verifierades. Node TLS kan öppna filen med hämtningsbrevets
lösenord. Inga certifikatbyte eller lösenord finns i repot.
NVV:s acceptans och kopplingen till JEROC:s OAuth-anslutning måste ännu provas.
Se [aktuell TEST-etapp](nvv-test-demo.md).

Det uppladdade klientcertifikatets offentliga SHA-256-fingeravtryck är
`71:0F:90:58:33:AA:17:60:90:89:48:AC:2A:DD:87:F3:B0:12:64:4E:88:6C:84:B5:FB:AB:13:A7:E5:5D:72:27`.
Kontorsdemo 0.13.1 läser samma slags metadata direkt ur serverns aktuella
TLS-certifikat. Jämförelsen verifierar vilken fil servern laddar, men inte vilket
organisationsnummer NVV:s gateway använder. Det senare måste utredas vid
fortsatt fel 1023 trots matchande verksamhetsutövare och certifikat.

Den ursprungliga ZIP-granskningen nedan avser endast leveransbreven.

Granskat 2026-10-09. Underlag: den uppladdade filen `Testcertifikat-server-och-stämpellegitimationer-2026.zip`, dess PDF-handlingar och Expisofts offentliga produkt- och CA-information. Inga certifikat har installerats och inga API-anrop eller hämtningar med leveranskoder har gjorts.

## Resultat

ZIP-filen innehåller **17 PDF-filer**, inga `.p12`, `.pfx`, `.pem` eller `.cer` och inga inbäddade PDF-bilagor. Sexton PDF-filer är leveransbrev med hämtningsuppgifter. Den sjuttonde, `Testcertifikat organisation server stämpel.pdf`, beskriver identiteter, roller och status. Leveransbreven anger att den hämtade `.p12`-filen skyddas med PIN/lösenord.

Det faktiska klientcertifikatets issuer, fullständiga subject, keyUsage, extendedKeyUsage, certifikatkedja och tillhörande privata nyckel har därför **inte kunnat granskas**. PDF:ernas uppgifter om CN och giltighet är leverantörens beskrivning, inte avlästa X.509-fält. Ingen godkänd anslutning till NVV är bekräftad.

## Identiteter i PDF-översikten

Tabellen återger översiktens status; spärrstatus har inte kontrollerats mot CRL/OCSP. Datumstatus stämmer med granskningsdagen. Nummer återges exakt som PDF:ens fält ”Org. nr”.

| PDF:ens CN | Roll | Org. nr i PDF | Angiven giltighet | Status i översikten |
| --- | --- | --- | --- | --- |
| Bolag A | Server/organisation | 165560000167 | 2025-01-08–2027-01-08 | Giltig |
| Bolag D | Server/organisation | 190211108220 | 2025-01-08–2027-01-08 | Giltig |
| Kommun A | Server/organisation | 162021004748 | 2025-01-08–2027-01-08 | Giltig |
| Kommun B | Server/organisation | 162021003898 | 2025-01-08–2027-01-08 | Giltig |
| Testbolag 1 | Server/organisation | 165560000167 | 2026-04-09–2028-04-09 | Giltig |
| Testbolag 2 | Server/organisation | 165560065087 | 2026-04-09–2028-04-09 | Giltig |
| Testbolag 3 | Server/organisation | 165560069618 | 2026-04-09–2028-04-09 | Giltig |
| Bolag B; Kommun C | Server/organisation | 165560000282; 162021002080 | 2025-01-08–2027-01-08 | Spärrade |
| Bolag C | Server/organisation | 165560001124 | 2025-01-08–2025-01-09 | Utgånget |
| Bolag E | Server/organisation | 194801301872 | 2027-01-07–2027-01-08 | Har inte börjat gälla |
| Bolag A Stämpel; Bolag D Stämpel | Stämpel | 165560000167; 190211108220 | 2025-01-08–2027-01-08 | Giltiga |
| Bolag B Stämpel | Stämpel | 165560000282 | 2025-01-08–2027-01-08 | Spärrat |
| Bolag C Stämpel | Stämpel | 165560001124 | 2025-01-08–2025-01-09 | Utgånget |
| Bolag E Stämpel | Stämpel | 194801301872 | 2027-01-07–2027-01-08 | Har inte börjat gälla |

Detta är generiska testidentiteter. De visar inte JEROC:s identitet eller vilket organisationsnummer NVV godtar för den aktuella testanslutningen. Certifikatets identitetsfält, exempelvis `organisationIdentifier` med `16`-prefix, måste hållas isär från API-schemats tiosiffriga organisationsnummer och från OAuth-anslutningens behörighet. Det faktiska subject-fältet är ännu inte tillgängligt. PDF:ens `19`-prefix för Bolag D/E bör också stämmas av innan identiteten används som organisationsidentitet.

## Möjlig kandidat och hämtning

**`Testbolag 1.pdf` är en möjlig kandidat för nästa certifikatgranskning**, eftersom översikten placerar den under serverlegitimation/organisationslegitimation och anger giltighet till 2028-04-09. Det är inte ett besked om NVV:s acceptans. `Bolag A.pdf` är en motsvarande äldre kandidat med kortare återstående giltighet. Använd den testidentitet NVV uttryckligen godkänner.

NVV:s anslutningssida efterfrågar klientcertifikat/serverlegitimation/organisationslegitimation. Expisoft beskriver denna produkt som identifiering av en server eller anslutande klient. Stämpellegitimation avser organisationens elektroniska stämpel/signatur och är därför inte förstahandsvalet för klientautentisering. Faktisk `clientAuthentication` måste ändå kontrolleras i det hämtade certifikatet.

För att hämta granskningskandidaten enligt leveransbrevet:

1. Öppna `Testbolag 1.pdf`. Sida 1 innehåller hämtningsuppgifterna; sida 2 innehåller nedladdningsinstruktionen.
2. Gå till [Expisofts beställningsportal](https://eid.expisoft.se/) och välj **”Ladda ner”**, vilket öppnar [Hämta e-legitimation](https://eid.expisoft.se/hamta-e-legitimation/). Det aktuella menyvalet stämmer med leveransbrevet. Den äldre PDF-översikten kallar valet ”Hämta E-legitimation/certifikat”.
3. Ange den unika identifieraren och PIN-koden från samma leveransbrev direkt i portalen. Dela eller kopiera inte dessa värden till GitHub, dokumentation eller chatt.
4. Behåll den hämtade `.p12`-filen och dess PIN/lösenord utanför Git. Nästa granskning behöver offentliga certifikatmetadata; privata nycklar och lösenord ska inte publiceras.

PDF-översikten har en felaktigt skriven portaladress med `@`; använd länken ovan. Hämtningsuppgifterna har inte återgetts här och ingen hämtning har genomförts.

## Offentligt CA-certifikat

Den separat publicerade [ExpiTrust Test CA v8.cer](https://eid.expisoft.se/wp-content/uploads/2023/02/ExpiTrust-Test-CA-v8.cer) har granskats som offentlig utfärdarinformation:

| X.509-fält | Avläst värde |
| --- | --- |
| Format | DER |
| Subject och issuer | `C=SE, O=Expisoft AB, CN=ExpiTrust Test CA v8` |
| Giltighet, UTC | 2020-02-12 15:20:45–2032-02-12 15:16:58 |
| Publik nyckel | RSA 4096 bitar |
| Basic constraints | `CA:TRUE` |
| Key usage | Kritisk: `certificateSign`, `cRLSign` |
| Extended key usage | Ingen EKU-extension |
| SHA-256-fingeravtryck | `DD:43:BB:65:B3:46:8C:B2:6A:DE:68:1F:18:BF:7B:0B:EA:23:A4:BE:84:EF:66:A2:F3:3F:93:94:F3:ED:3F:DF` |

Självsignaturen verifierades med en tillfällig explicit CA-fil. Certifikatet installerades inte i systemets förtroendelager. Detta är ett CA-certifikat, **inte klientidentiteten**, och dess keyUsage/EKU säger inget om klientcertifikatets användbarhet.

## Kvarstående kompatibilitetsfrågor

NVV:s [generella anslutningssida](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/) anger **ExpiTrust Test CA v8u** för test. Expisofts testnedladdningssida, paketets översikt och det granskade offentliga CA-certifikatet anger **v8**. Likvärdighet eller accepterad kedja är inte visad. Den [Avfallsregistret-specifika sidan](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/) använder dessutom den äldre benämningen **Steria AB EID CA v2**. Uppgifterna behöver därför bekräftas av NVV för just Avfallsregistrets testmiljö.

Före ett besked om användbarhet behövs det faktiska klientcertifikatets issuer/kedja, subject och organisationsidentitet, giltighet, keyUsage samt kontroll av EKU, inklusive om `clientAuthentication` (`1.3.6.1.5.5.7.3.2`) finns. Det behövs också besked om vilken av paketets testidentiteter NVV tillåter för anslutningen. Inget av detta kan härledas från ett offentligt CA-certifikat eller från tillgång till OAuth-uppgifter.

## Källor

- Uppladdad ZIP och `Testcertifikat organisation server stämpel.pdf`, särskilt sidorna 3–5; leveransbrev `Testbolag 1.pdf`, sidorna 1–2.
- [Expisoft: ExpiTrust testcertifikat](https://eid.expisoft.se/expitrust-test-certifikat/).
- [Expisoft: testprodukter](https://eid.expisoft.se/products/certificates/?product_id=8).
- [Expisoft: serverlegitimation/organisationslegitimation](https://eid.expisoft.se/products/certificates/16).
- [Expisoft: stämpellegitimation](https://eid.expisoft.se/products/certificates/15).
- NVV:s två anslutningssidor och det offentliga CA-certifikatet, länkade ovan.

Den offentliga nedladdningssidan länkar vid granskningen ett paket daterat juni 2026. Innehållet i den uppladdade ZIP-filen har granskats självständigt; identitet med en senare webbversion är inte bekräftad. PIN-brev, ZIP-filer, certifikatbehållare, privata nycklar och lösenord ska hållas utanför Git.
