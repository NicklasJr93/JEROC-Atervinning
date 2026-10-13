# Planerat utbetalningsflöde

Godkänt flöde 2026-10-12, ÄL 098. Produktionsflödet är fortfarande planering.
ÄL 102, kontor 0.22.0, bygger Swish MSS-adaptern och efterföljande betalningsbokföring
i Spiris sandbox. Ingen skarp Swish- eller bankutbetalning är aktiverad.
Aktuellt bygge och provsteg: [Swish MSS](swish-mss-bygge-2026-10-13.md).

## Ordning och användarflöde

Efter kundgodkännande och intern attest är belopp, betalsätt och mottagaruppgifter låsta. Före attest ska systemet kontrollera att vald utbetalningsmetod har de uppgifter och den konfiguration som krävs. Ekonomiansvarig trycker Betala ut och ser en förifylld sammanställning av kund, avräkning, belopp, metod, mottagare och vårt betalningskonto. Bekräftelsen använder serverns låsta uppgifter och utbetalningsbehörighet; normalfallet kräver inga nya inmatningar.

Utbetalningsinstruktionen skickas först till banken/Swish. Bankens mottagningskvitto eller väntan på signering är ett mellanläge. Först ett verifierat genomföranderesultat ger Genomförd. Därefter bokför systemet betalningen i Spiris.

Avräkningsutkastet och fakturans bokföring kan fortfarande ske före själva utbetalningen. Det är registreringen av betalningen i Spiris som ska vänta på utförd betalning. Om fakturan ännu inte bokförts väntar den köade betalningsbokföringen på den verifierade slutliga fakturans ID. Pengastatus och bokföringsstatus är separata, så ett fel i Spiris inte får skicka pengar igen.

Planerat betalningsdatum kan bestämmas tidigare. Faktiskt betalningsdatum hämtas från leverantörens genomföranderesultat, eller kontantbekräftelsen, och översätts till företagets kalenderdatum för Spiris. Datumet för API-försöket används inte som ersättning för en tidigare faktisk betalningsdag.

## Metoder

| Metod | Pengaflöde | Efterföljande bokföring |
| --- | --- | --- |
| Bank | Tillåten bankadapter med bankens avtal och eventuell signering. Slutlig status återläses/verifieras. | Mot vårt egna registrerade Spiris-bankkonto. |
| Swish | Swish Utbetalning för mottagartyper som tjänsten stöder. Callback och återläsning kopplas till samma instruktion. | Mot det egna bankkonto där Swish-utbetalningen belastades. |
| Kontant | Behörig personal bekräftar överlämnade pengar, med person och tid. | Mot vårt registrerade Spiris-kassakonto. |
| Spara på saldo | Ett tillgodohavande behålls tills ett verkligt uttag begärs. | Ingen fiktiv betalning. Vid uttag används vald verklig betalningsmetod och fördelning till underlagen. |

Swedbank beskriver Swish Utbetalning som en separat tjänst för utbetalningar till privatpersoner med personnummer och Swish-kopplat mobilnummer. Den använder ett annat Swish-nummer än Swish Företag/Handel. Vi ska inte anta att ett avtal för att ta emot Swishbetalningar tillåter utbetalningar. Ett vanligt företags-Swishnummer som mottagare ersätter inte tjänstens krav på privat mottagare. Företagsmottagare måste använda en betalväg som stöder det.

## Verifierat Swish-kontrakt: Payouts v1

Den officiella utvecklarportalens publicerade Payouts v1 och MSS v1 har lästs. Produktionen använder `https://cpc.getswish.net` och Merchant Swish Simulator (MSS) `https://mss.cpc.getswish.net`. API:t har `POST /swish-cpcapi/api/v1/payouts/` och `GET /swish-cpcapi/api/v1/payouts/{instructionUUID}`. Kontraktet anger följande statusar:

- `CREATED`: instruktionen är skapad, utbetalningen ännu inte genomförd.
- `DEBITED`: pengar har dragits från vårt konto; det är fortfarande inte slutlig bekräftelse till mottagaren.
- `PAID`: utbetalningen lyckades. Endast verifierat PAID får starta betalningsbokföringen i Spiris.
- `ERROR`: ett fel har inträffat; felkod behöver hanteras och stämmas av.

Obligatoriska payloadfält är `payoutInstructionUUID`, `payerPaymentReference`, `signingCertificateSerialNumber`, `payerAlias`, `payeeAlias`, `payeeSSN`, `amount`, `currency`, `payoutType` och `instructionDate`. Beloppet är SEK med högst två decimaler och `payoutType` är `PAYOUT`. Requesten innehåller dessutom `payload`, HTTPS-`callbackUrl` och Base64-`signature`. Signeringscertifikat och TLS-autentisering är separata anslutningskrav som måste konfigureras enligt Swish-guiden, inte återanvändas från NVV/Spiris.

`payoutInstructionUUID` är 32 hexadecimala tecken. Swish dokumenterar uttryckligen att detta ID garanterar instruktionens unikhet och förebygger oavsiktliga dubbelbetalningar. ID, instruktionstid och exakt payload ska därför sparas före sändning och bevaras när samma instruktion kontrolleras. Vid okänt resultat görs GET på samma ID; en ny UUID får inte skapas som automatisk ersättning.

`payeeSSN` ska vara ett tolvsiffrigt personnummer, YYYYMMDDnnnn, och kontrolleras mot mottagarens Swish-anslutning. Ett äldre tiosiffrigt nummer behöver kompletteras före attest utan gissning av födelseårhundrade. `payeeAlias` ska innehålla landskod och 8–15 siffror utan plus eller inledande nollor. Databasens gemensamma E.164-värde, exempelvis +467…, behålls; adaptern tar bort plus endast när Swish-payloaden byggs.

Ett separat slumpmässigt `callbackIdentifier` per instruktion rekommenderas av Swish. Värdet skickas tillbaka i callbackens header och ska kontrolleras utan att loggas eller exponeras i klienten. Callbacken utlöser återläsning av samma instruktion. Mottagare, belopp, referens, status och `datePaid` verifieras innan pengastatus och bokföringskö uppdateras. HTTP 201 från POST är bara skapad instruktion och får inte behandlas som PAID.

MSS-guiden beskriver ett simulerat POST/GET-flöde med testcertifikat, signering och testmottagare. Detta möjliggör ett isolerat prov av callback, slutstatus och dubbletter utan riktiga utbetalningar. Inget MSS-anrop har körts i denna granskning.

## Journal, samtidighet och fel

Varje registrering får ett stabilt serverägt betalnings-ID och koppling till organisation, anslutet företag, avräkningsversion/hash, belopp, mottagare och betalningskonto. Pengainstruktionen och Spiris-registreringen har separata försöks-ID:n och statusar. Registrering och utkorg sparas i samma PostgreSQL-transaktion. Dubbletter och samtidiga klick återanvänder samma avsedda registrering.

En ansvarig sändväg utses per betalning. JEROC:s bankadapter och en parallell automatisk bankbetalning från Spiris får inte initiera samma betalning. Varje adapter behöver följa leverantörens dokumenterade identitets-, signerings- och återförsöksregler. Tekniskt accepterad eller skickad instruktion är inte bevis på att pengarna betalats.

Återkoppling tas emot enligt leverantörens autentiseringsmodell och stäms av mot rätt betalnings-ID, mottagare, belopp, organisation och aktuell leverantörsstatus. Callback är idempotent: dubbla, gamla och försenade meddelanden lägger inte till en ny ekonomisk åtgärd eller flyttar ett slutligt resultat tillbaka till ett tidigare mellanläge.

Vid timeout eller serverkrasch efter sändningsstart blir resultatet oklart. Systemet ska kontrollera samma instruktion innan en ny sändning kan övervägas. Detta gäller separat för pengaöverföring och Spiris-bokföring. För Spiris är referensfältet inte dokumenterat som en unik idempotensnyckel, så osäkra POST-svar får inte automatiskt återförsändas. Ett nollställt restbelopp ensamt bevisar inte vilken betalning som gjorts; transaktion/faktura/referens behöver stämmas av.

Efter bekräftad pengaöverföring får fel i Spiris enbart påverka bokföringsuppföljningen. Kortet kan visa Utbetald · bokföringsöverföring behöver åtgärdas. Avvisade/återförda betalningar kräver en egen spårbar avstämning, inte omskrivning av originalet. Vid backupåterställning och bytt/bortkopplad anslutning pausas externa sändningar tills rätt journal och leverantörskoppling har verifierats. Gamla demoregistreringar ska inte utlösa riktiga betalningar.

## Spiris-kontrakt

Den dokumenterade operationen är `POST /v2/supplierinvoices/{invoiceId}/payments`. Den bokför betalningen i huvudboken och flyttar inga pengar. `invoiceId` avser den bokförda fakturan, inte utkastet eller verifikationsnumret. Begärd scope är enligt aktuell V2-definition `ea:sales`.

Obligatoriska fält är `CompanyBankAccountId`, `PaymentDate`, `PaymentAmount`, `PaymentCurrency` och `PaymentType`. `CompanyBankAccountId` är vårt egna konto-ID från `GET /v2/bankaccounts`. `PaymentType=2` betyder helbetalning och `1` delbetalning; det anger inte bank/Swish/kontant. Datum ska vara företagets kalenderdag och får inte vara framtida. Valfri `Reference` kan bära vår betalningsreferens, men ger ingen dokumenterad idempotensgaranti.

Svaret kan innehålla `BankTransactionId`. Fakturans betalningsstatus/restbelopp återläses och transaktionen kan hämtas med `GET /v2/banktransactions/{bankAccountId}/{bankTransactionId}`. Transaktionsrader har betalningsverifikationsreferenser som måste knytas till rätt faktura. Fakturans ursprungliga verifikation, exempelvis A28, behålls separat från betalningens verifikation.

## SaaS och anslutning av kundföretag

Swish har ett formaliserat upplägg för tekniska leverantörer. En godkänd leverantör tecknar avtal med Swish, får ett 987-nummer och ett särskilt certifikat. Kundföretagets bank kopplar kundens eget 123-nummer till leverantörens 987-nummer. Swish kontrollerar att relationen är tillåten. Varje kund har sitt eget Swish-avtal och betalningar belastar kundens eget bankkonto.

Ansökan görs enligt partnerguiden via `technicalsupplier@getswish.se`. Leverantören behöver en Certificate Point Of Contact (CPOC) med svenskt BankID. Swish återkommer med offert och avtal; ett 987-nummer utfärdas efter godkänt avtal. Partnerguiden beskriver främst Swish Handel. Payout-guiden kräver TLS-certifikat och ett separat signeringscertifikat och nämner ett undantag för technical-supplier-upplägget. Att leverantörens avtal omfattar Payouts och hur signeringen för varje kund får ske måste därför uttryckligen bekräftas av Swish och banken innan vi lovar kundanslutning utan egen certifikathantering.

Utveckling kan börja med offentliga testcertifikat i MSS före ett produktionsavtal. MSS är en simulator och ska inte blandas ihop med den separata mobila sandboxen, som har egna registreringskrav. Att en simulering fungerar bevisar inte att produktionens kund-/leverantörsrelation eller signeringsbehörighet är aktiverad.

Planerat kundflöde under Integrationer -> Swish:

1. Kundföretaget beställer Swish Utbetalning från sin bank och ansluts till vår tekniska leverantör enligt det bekräftade avtalsupplägget.
2. Företagsadmin anger/verifierar organisation och sitt eget utbetalningsnummer. Vi får inte behandla ett inmatat nummer som bevis på tillåten bankanslutning.
3. Certifikat/signering kopplas enligt den godkända modellen. Eventuellt kundspecifikt nyckelmaterial lagras skyddat på servern; inga privata nycklar i webbläsarens beständiga lagring eller publika projektioner.
4. Admin väljer det egna Spiris-bankkonto där utbetalningarna ska bokföras och vilka användare som får betala ut.
5. Systemet verifierar konfiguration och anslutning, visar giltighet/utgångsdatum och låter admin uttryckligen aktivera rätt miljö. Ett anslutningstest initierar inte automatiskt en riktig utbetalning.

Bolagsgrunden i ÄL 099 använder servervalda bolagsbundna databasscheman och
personliga sessioner. MSS-inställningar och betalningsjournaler är bolagsbundna;
varje bolag måste själv aktivera sitt test. Kundens produktionsbetalningar, nummer,
signeringsbehörighet, Spiris-företag, konto, journal och roller måste fortsatt
bindas till organisationen på servern. En central teknisk TLS-identitet ersätter
inte kundens egna utbetalningsbehörigheter. Avstängning eller certifikatsbyte ska
stoppa nya sändningar och bevara journal/status för redan skickade instruktioner.

## Förutsättningar och källor

- Swish officiella API-kontrakt: <https://developer.swish.nu/api/payouts/v1>.
- Swish officiella simulatorguide: <https://developer.swish.nu/api/mss/v1>.
- Swish partnerguide: <https://developer.swish.nu/documentation/technical-supplier>.
- Swish anslutning och signering för Payouts: <https://developer.swish.nu/documentation/getting-started/swish-payout-api>.
- Swish miljöer och testcertifikat: <https://developer.swish.nu/documentation/environments>.
- Swish utvecklarportal: <https://developer.swish.nu/>. Certifikat-, signerings- och anslutningskonfiguration ska verifieras i ett faktiskt simulatorprov innan adaptern aktiveras.
- Swedbanks tjänstebeskrivning: <https://www.swedbank.se/foretag/betala-och-ta-betalt/swish/swish-utbetalning.html>.
- Spiris aktuell OpenAPI: <https://eaccountingapi.vismaonline.com/openapi/v2.json>.
- Spiris betalningsguide: <https://developer.vismaonline.com/docs/invoice-payments>.

Skarp drift kräver rätt bank-/Swish-avtal, leverantörens produktionsanslutning och riktiga personliga serversessioner. Sandbox och produktion måste vara separata, uttryckligt aktiverade kopplingar. API-kontrakten för Spiris och Swish Payouts v1, simulatorguiden MSS v1, guiderna för teknisk leverantör/anslutning/miljöer samt Swedbanks offentliga tjänstebeskrivning har granskats; inga betalningsanrop eller pengaöverföringar har provats.
