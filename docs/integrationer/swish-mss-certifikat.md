# Swish MSS: testcertifikat och transport

Denna build stöder endast Swish Merchant Swish Simulator (MSS). Inga riktiga pengar skickas. Bankutbetalning, Swish produktion och kunders skarpa certifikat stöds inte av denna transport.

## Render

Lägg till följande på webbserverns Environment och spara/deploya:

| Variabel | Värde |
| --- | --- |
| `SWISH_ENVIRONMENT` | `mss` |
| `SWISH_MSS_PUBLIC_TEST_CERTIFICATES` | `true` |

Bolagets testkoppling aktiveras separat i ScrapPilot. Miljövariablerna möjliggör endast simulatortransporten; de ger inte betalbehörighet åt användare.

Vid första anslutningskontrollen hämtar servern Swishs **offentliga MSS-testpaket**, kontrollerar dess SHA-256 och läser endast fem tillåtna certifikat-/nyckelfiler. Paketets signeringscertifikat, TLS-certifikat och rotcertifikat kontrolleras mot fasta fingeravtryck. Nyckelparen, giltighetstider och simulatorns Swish-nummer verifieras också. Servern sparar filerna med begränsade filrättigheter under `.data/swish-mss/`, som redan är Git-ignorerad. Inga kundnycklar ska läggas i GitHub.

Det offentliga testnumret är `1234679304`. Separata testcertifikat används för TLS och signering. Nuvarande publicerade certifikat löper ut den **11 september 2027**. En ändrad eller förnyad Swish-version kräver att paketets hash och certifikatsfingeravtryck uppdateras efter granskning; servern accepterar inte ett nytt paket automatiskt.

En första hämtning kan ta upp till 12 sekunder. Senare kontroller läser de verifierade lokala filerna. Om Render ersätter sin tillfälliga disk hämtas paketet igen. Filernas försvinnande påverkar inte betalningsjournalen i PostgreSQL.

Valfri lokal förberedelse: `node scripts/setup-swish-mss.mjs`. Detta hämtar endast publika testcertifikat och gör ingen betalning.

Alternativt kan samma offentliga, pinnade MSS-filer tillhandahållas via `SWISH_TLS_CERT_FILE`, `SWISH_TLS_KEY_FILE`, `SWISH_SIGNING_CERT_FILE`, `SWISH_SIGNING_KEY_FILE` och `SWISH_TLS_CA_FILE`, med automatisk hämtning avstängd. Skarpa certifikat avvisas även i det läget.

## Protokoll och resultat

- Endast `POST https://mss.cpc.getswish.net/swish-cpcapi/api/v1/payouts` och `GET` med samma 32-siffriga hexadecimala instruktions-ID är tillåtna. Omdirigeringar följs inte. Produktionsadresser kan inte väljas.
- TLS verifierar serverns certifikat, använder TLS 1.2 eller senare och simulatorns separata klientcertifikat. Certifikatkontroll får inte stängas av.
- Signeringen följer Swishs exempel: UTF-8-serialiserad payload → SHA-512 → SHA512withRSA på hashvärdet → Base64. Samma JSON-bytes placeras i den skickade requesten.
- HTTP 201 betyder skapad instruktion. `CREATED` och `DEBITED` betyder inte genomförd utbetalning. Endast verifierad `PAID` kan användas för betalningsbokföringen.
- Timeout, bruten anslutning, oväntat svar, serverfel eller redan upptagen UUID får aldrig starta ett automatiskt nytt POST. Samma instruktion kontrolleras via GET. Ett senare 404 får inte innebära att pengar säkert aldrig har skickats: MSS-cache kan försvinna.
- Fel och transportdiagnostik maskerar personnummer, telefonnummer, certifikat, nycklar och signaturer. Den interna återläsningen innehåller mottagaruppgifterna så att betalningsmotorn kan jämföra dem mot den sparade instruktionen. Den behörighetsskyddade betalningsjournalen visar de mottagaruppgifter som behövs för granskning; privata nycklar och signaturer skickas aldrig till webbläsaren.

Swishs offentliga dokumentationsexempel använder `payeeAlias=46711111132` och `payeeSSN=197709306828`. Dessa är simulatorreferenser, inte uppgifter som ska skrivas över på en riktig kund. MSS bevisar inte att ett riktigt telefonnummer hör till ett visst personnummer.

## Verifiering

`node --test server/swish-client.test.mjs` kontrollerar signering, låsta miljöer/URL:er, TLS-inställningar, dubblett-/timeoutbeteende, statussvar, konfigurationsändring och maskering med lokala transportstubbar. Testerna skickar inga externa utbetalningar. Swishs publicerade ZIP har också extraherats och dess certifikat/nyckelpar verifierats separat.

Ett faktiskt POST/GET-prov från Render behövs innan en extern simulatorutbetalning räknas som verifierad. Den hanterade utvecklingsmiljön använder en HTTP-proxy som inte ger transporten samma direkta mTLS-förutsättningar som Render; TLS ska inte sänkas för att kringgå detta.

Källor: [Swish miljöer och testcertifikat](https://developer.swish.nu/documentation/environments), [Payout-signering](https://developer.swish.nu/documentation/getting-started/swish-payout-api), [MSS-kontrakt](https://developer.swish.nu/api/mss/v1), [Payouts v1](https://developer.swish.nu/api/payouts/v1).
