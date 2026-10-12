# Planerat utbetalningsflöde

Godkänt flöde 2026-10-12, ÄL 098. Dokumentet är planering. JEROC har ännu ingen ansluten bank-/Swish-utbetalningsadapter eller automatisk betalningsbokföring i Spiris.

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

## Förutsättningar och källor

- Swish officiella API-kontrakt: <https://developer.swish.nu/api/payouts/v1>.
- Swish officiella simulatorguide: <https://developer.swish.nu/api/mss/v1>.
- Swish utvecklarportal: <https://developer.swish.nu/>. Certifikat-, signerings- och anslutningskonfiguration ska verifieras i ett faktiskt simulatorprov innan adaptern aktiveras.
- Swedbanks tjänstebeskrivning: <https://www.swedbank.se/foretag/betala-och-ta-betalt/swish/swish-utbetalning.html>.
- Spiris aktuell OpenAPI: <https://eaccountingapi.vismaonline.com/openapi/v2.json>.
- Spiris betalningsguide: <https://developer.vismaonline.com/docs/invoice-payments>.

Skarp drift kräver rätt bank-/Swish-avtal, leverantörens produktionsanslutning och riktiga personliga serversessioner. Sandbox och produktion måste vara separata, uttryckligt aktiverade kopplingar. API-kontrakten för Spiris och Swish Payouts v1, simulatorguiden MSS v1 samt Swedbanks offentliga tjänstebeskrivning har granskats; inga betalningsanrop eller pengaöverföringar har provats.
