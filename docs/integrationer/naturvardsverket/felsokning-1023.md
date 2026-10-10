# Felsökning av NVV-fel 1023 i testmiljön

Kontrollerat 2026-10-10 med kontorsdemo 0.13.2. Detta underlag innehåller endast
tekniska spårningsuppgifter och det offentliga testcertifikatets metadata.
Inga åtkomstnycklar, token, lösenord, privata nycklar eller kunduppgifter ingår.

## Meddelande att skicka till Naturvårdsverkets API-support

**Ämne: BTFA.Anteckning TEST – fel 1023 trots matchande verksamhetsutövare och klientcertifikat**

Hej!

Vi testar egen rapportering till BTFA.Anteckning i testmiljön. Ett anrop till
`POST https://apimtest.naturvardsverket.se/btfa/anteckning/v1/insamlingar`
returnerar HTTP 400 med fel 1023, ”Verksamhetsutövare eller ombud måste matcha
rapportörens organisationsnummer”, samt följdfel om saknat ombud och
ombudets kontaktuppgifter.

Den sparade begäran har `verksamhetsutovare: "5560000167"` och
`verksamhetensNamn: "Testbolag 1"`. Inga ombudsfält skickas: verksamhetsutövaren
rapporterar själv och OpenAPI anger att ombud då ska utelämnas.

Vi har verifierat certifikatet som den faktiska HTTPS-anslutningen använder.
Det är Expisofts Testbolag 1, organisationsnummer `5560000167`, utfärdare
ExpiTrust Test CA v8, giltigt 2026-04-09–2028-04-09 och med clientAuth.
Certifikatets SHA-256-fingeravtryck är:

`71:0F:90:58:33:AA:17:60:90:89:48:AC:2A:DD:87:F3:B0:12:64:4E:88:6C:84:B5:FB:AB:13:A7:E5:5D:72:27`

Felet kvarstår även efter ett kontrollerat nytt försök med en ny TLS-anslutning
utan återanvändning av tidigare anslutning eller TLS-session.

Senaste försök:

- Tid: **2026-10-10 17:22:43.882 UTC** / **19:22:43.882 svensk sommartid**.
- TraceId: `4000a802-0000-f400-b63f-84710c7967bb`.
- NV-Client-Tracking-ID: `33334d42-c78c-4cec-8175-8bb6f4ba3808`.
- Resultat: HTTP 400, avvisad begäran, inget avfalls-id returnerat.

Kan ni hjälpa oss att kontrollera följande för detta TraceId?

1. Vilket organisationsnummer/rapportörsvärde jämförde tjänsten faktiskt med
   verksamhetsutövaren? Kom värdet från TLS-certifikatet, OAuth-anslutningen
   eller någon annan registrering?
2. Vilken X.509-egenskap och OID läser ni, och hur normaliseras värdet? Vi vill
   särskilt förstå hanteringen av `serialNumber` respektive
   `organizationIdentifier` och eventuellt svenskt `16`-prefix.
3. Krävs en särskild koppling i anslutningsportalen mellan vårt testkonto och
   Expisofts Testbolag 1-certifikat? Finns någon särskild identitets- eller
   ombudsregel för detta generella testcertifikat?
4. Accepterar BTFA.Antecknings testmiljö ExpiTrust Test CA **v8** för detta
   certifikat? Er generella anslutningssida nämner **v8u**, medan Expisofts
   aktuella testnedladdning och vårt certifikats utfärdare anger **v8**.

Vi kan komplettera med certifikatets offentliga metadata om det behövs.
Tack!

## Verifierade uppgifter och kvarstående frågor

Den senaste sparade rapportversionen och dess senaste försök har lästs tillbaka
från JEROC:s API. Miljön är `test`, metoden `POST`, resursen `/insamlingar`,
verksamhetsutövaren `5560000167`, verksamhetens namn `Testbolag 1` och ombudsfält
saknas. Den faktiska HTTPS-anslutningens certifikatorganisation och fingeravtryck
matchar det offlinegranskade certifikatet. Två sparade versioner och två försök
finns; senaste resultatet är avvisat med HTTP 400. Inget avfalls-id har sparats.

Det publicerade API-kontraktet kräver att verksamhetsutövarens eller ombudets
organisationsnummer matchar SSL-certifikatets organisationsnummer. För svensk
organisation anger kontraktet tio siffror utan bindestreck. När
verksamhetsutövaren själv är rapportör ska ombud inte anges.

De granskade officiella API-underlagen anger inte vilken X.509-egenskap tjänsten
läser, en särskild Testbolag 1-regel eller att OAuth-ansökarens organisationsnummer
ersätter certifikatets vid kontrollen av fel 1023. Det är därför frågor till
supporten, inte fastställda förklaringar. Ett lyckat OAuth- eller kodlisteanrop
visar inte vilket organisationsnummer rapporteringskontrollen använder.

Ingen ny payloadvariant med ombud eller ett tolvsiffrigt organisationsnummer har
skickats för att kringgå felet. Inget ytterligare NVV-anrop har gjorts för att
ta fram detta dokument.

## Underlag

- [Sparad OpenAPI för BTFA.Anteckning](openapi/BTFA.Anteckning.json):
  `InsamlingsMottagning.verksamhetsutovare`, `ombud` och fel 1023.
- Officiell Swagger publicerad som uppdaterad 2026-05-28: samma identitetsregel
  som den sparade OpenAPI-versionen.
- [NVV: Rapportera till avfallsregistret via API](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/):
  mTLS, OAuth och föreskrivna system-/spårningsheaders.
- [NVV: Anslutning till API-tjänst](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/):
  klientcertifikat och anslutningens två identitetsdelar; benämningen v8u.
- [Expisoft: ExpiTrust testcertifikat](https://eid.expisoft.se/expitrust-test-certifikat/):
  den aktuella publika benämningen ExpiTrust Test CA v8.
- [Certifikatgranskning](certifikatgranskning.md): offlinegranskad offentlig
  metadata och fingeravtryck för det uppladdade Testbolag 1-certifikatet.
