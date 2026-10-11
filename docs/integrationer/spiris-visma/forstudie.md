# Spiris / Visma eEkonomi – API och betalfil

Granskad 2026-10-11 inför version 0.14.0. Detta är en historisk förstudie av
offentlig dokumentation och JEROC:s dåvarande kod. Vid granskningen fanns ingen
Spiris-anslutning, fakturaöverföring, bankfil eller betalning. Ett autentiserat
prov mot Spiris-sandboxen återstår även efter bygget av testverktyget.

Uppföljning: version 0.15.0 inför ett separat sandboxverktyg med OAuth och
redigerbara API-test. [Inställningar och provflöde](sandbox-setup.md)
beskriver bygget. Denna förstudies källgranskning ersätter inte ett
autentiserat prov mot JEROC:s testföretag.

## Slutsats

Spiris API har stöd för leverantörer, inköpsutkast, bokförda leverantörsfakturor,
PDF-bilagor och registrering/återläsning av betalningsuppgifter. Det passar som
grund för JEROC:s attesterade inköpsunderlag. Självfakturering, privatinköp och
momskontering behöver dock verifieras som verksamhetsflöden i svensk sandbox.

**Att registrera en betalning i API:t bokför betalningen; det skickar inte pengar.**
Den granskade publika V2-definitionen innehåller ingen operation för att skapa
eller hämta en bankbetalningsfil eller initiera en banköverföring. Fakturorna har
betalnings- och betalfilstatusar, vilket inte i sig innebär ett publikt API för
att utföra motsvarande bankåtgärder.

En egen betalfilexport är möjlig som separat modul när bankens avtal, filformat
och mottagartyper är kända. Filen kan sedan granskas, laddas upp och godkännas i
banken. Ett alternativ är betalningsflödet i Spiris med dess bankkoppling.
Banksteget kan inte verifieras fullt ut i den vanliga Spiris-sandboxen, där
AutoPay och interna banktjänster saknas eller är mockade.

## Det som fanns i JEROC vid förstudien

- Integrationer har ett serverägt adapterregister och Spiris visas som planerad
  koppling. Organisationsbunden kontext och händelsenycklar finns förberedda;
  beständig Spiris-utkorg, OAuth och tokenlagring finns ännu inte.
- Kundgranskning, kundgodkännande och intern attest har separata versioner.
  Attest ger ett slutligt demounderlag. PDF-arkivet sparar frysta original.
- **Exportera kö** i kontoret anropar `exportOfficeCsv` och skapar en viktkorts-CSV.
  Den är inte en betalfil som kan skickas till en bank.
- Manuella betalningsregistreringar och kvitto-PDF finns. De är inte bevis på
  att en banköverföring har genomförts.

Se [integrationsgrunden](../README.md) och [PDF-arkivet](../../pdf-archive.md).

## Vad som behövs för svensk sandbox

1. Registrera ett utvecklarkonto på
   [Spiris sandboxregistrering](https://selfservice.developer.vismaonline.com/),
   välj Sverige och invänta klient-ID, klienthemlighet och ett sandboxföretag.
   [Kom igång](https://developer.vismaonline.com/docs/spiris-eaccounting-api-documentation)
   beskriver registrering som partner. Produktion kräver separat kontakt med
   API-support.
2. Registrera vår HTTPS-callback hos Spiris. Förslag när adaptern byggs:
   `/api/integrations/visma/oauth/callback` på aktuell webbdomän. Callbacken är
   en riktig serveradress och får inte innehålla kontorets `#`-routing.
3. Bygg serverns OAuth authorization-code-flöde med sessionsbunden engångs-
   `state`, `prompt=select_account` och kontroll av valt företags identitet.
   Användaren väljer och godkänner sandboxföretaget i Spiris.
4. Lägg klienthemligheten i Render. Spara företagets token på servern med
   kryptering och anslutningsjournal; inga token i GitHub, webbläsarens
   lokaldata eller publika statusprojektioner. Samtidiga tokenförnyelser ska
   samordnas och den senaste tokenuppsättningen sparas atomiskt.

Sandbox och produktion använder **samma adresser**, men sandbox-klient och
sandboxkonto begränsar åtkomsten till testföretag. Vi ska inte hitta på en egen
`api-sandbox`-domän:

| Del | Officiell adress |
| --- | --- |
| API | `https://eaccountingapi.vismaonline.com/v2/` |
| OAuth-inloggning | `https://identity.vismaonline.com/connect/authorize` |
| OAuth-token | `https://identity.vismaonline.com/connect/token` |

Minsta scopes väljs per etapp. `ea:api` och `offline_access` behövs enligt
OAuth-guiden. `ea:purchase` ger inköpsoperationer; `ea:accounting_readonly` kan
behövas för kontoplan/verifikationer och `ea:sales_readonly` för
`GET /companysettings` enligt aktuell OpenAPI. En första läskontroll kan använda
`ea:purchase_readonly` i stället för inköpsskrivrättighet. Utöka inte till alla
scopes rutinmässigt.

Access-token anges ha 60 minuters livslängd. Refresh-token anges vara giltig i
två år men kan ogiltigförklaras vid lösenordsbyte. Anslutningsfel ska därför ge
ett tydligt krav på återanslutning.

Källor: [Sandbox FAQ](https://developer.vismaonline.com/docs/sandbox-faq),
[miljöer](https://developer.vismaonline.com/docs/environments),
[OAuth](https://developer.vismaonline.com/docs/authentication).

## Verifierade API-operationer

Alla sökvägar nedan ligger under `/v2`. Välj den granskade
[API-referensen](https://eaccountingapi.vismaonline.com/scalar/v2) eller den
[publika OpenAPI-definitionen](https://eaccountingapi.vismaonline.com/openapi/v2.json)
för aktuella obligatoriska fält.

| Behov | API-stöd | Betydelse för JEROC |
| --- | --- | --- |
| Kontrollera anslutet företag | `GET /companysettings` | Kontrollera `CompanyIdentifier`, namn och organisationsnummer mot den anslutning vi avser. |
| Leverantör och betalvillkor | `GET/POST /suppliers`, `GET /termsofpayments` | Den som säljer skrot till JEROC motsvarar en leverantör i ekonomisystemet, även om personen kallas kund i JEROC. |
| Kontoplan och egna bankkonton | `GET /accounts/{fiscalyearId}`, `GET /fiscalyears`, `GET /bankaccounts` | Verifiera kontering och företagets avsändarkonto innan bokföring. |
| Inköpsutkast | `POST /supplierinvoicedrafts` | Rekommenderad första överföring efter intern attest, för ekonomins granskning. |
| Spiris-attest och bokföring | `PUT /approval/supplierinvoice/{id}`, `POST /supplierinvoicedrafts/{id}/convert` | Separata steg i Spiris. Konvertering skapar en slutlig faktura och tar bort utkastet. JEROC-attest innebär inte automatiskt Spiris-bokföring. |
| Direkt bokförd faktura | `POST /supplierinvoices` | Finns, men ska inte vara standard innan kontomappning/moms är verifierade. |
| PDF-underlag | `POST /attachments`, `POST /attachmentlinks` | Länka arkiverad avräkning till rätt utkast/faktura. PDF stöds, upp till 20 MB för svensk bilaga och totalt 20 MB per dokument. |
| Återläsa faktura | `GET /supplierinvoices/{id}` | Läs externa ID:n, `VoucherId`, `VoucherNumber`, återstående belopp och betalstatus. |
| Registrera genomförd betalning | `POST /supplierinvoices/{invoiceId}/payments` | Bokför betalningen; ingen överföring av pengar. API:t tillåter inte ett framtida betalningsdatum för denna operation. |
| Läsa bankhändelser | `GET /banktransactions/{bankAccountId}/matched` och `/unmatched` | Finns för återläsning/matchning. Verifiera vilka uppgifter som faktiskt blir tillgängliga med företagets bankkoppling. |
| Kredit/rättelse | `POST /supplierinvoices` med kreditunderlag, därefter fakturans `/offset` | Bokförda fakturor kan inte behandlas som fritt redigerbara utkast; rättelser ska kopplas till originalet och verifieras i sandbox. |

Två detaljer måste kontrolleras vid implementation:

- Inköpsguiden skriver `/termsofpayment`, medan den levande OpenAPI-definitionen
  anger `/termsofpayments`. Implementation ska följa verifierad faktisk route.
- Aktuell OpenAPI anger `ea:sales` för leverantörsfakturans betalnings-POST,
  trots att fakturans inköpsoperationer använder `ea:purchase`. Detta ska
  verifieras i sandbox eller med support före den etappen.

`/paymentvoucher` är enligt API-referensen en bokföringsoperation för norska och
nederländska företag, inte en svensk bankbetalningslösning.

Ingen särskild självfaktureringsoperation hittades i den publika definitionen.
Det utesluter inte att vårt underlag kan representeras som leverantörsfaktura
med rätt PDF, referens och kontering. Avtal om självfakturering, nummerserie,
privatinköp och eventuell omvänd skattskyldighet behöver fastställas med
ekonomiansvarig. Ingen generell `0 % moms`-regel ska läggas på alla skrotinköp.

Källor: [inköpsflödet](https://developer.vismaonline.com/docs/build-smart-with-purchase-invoices),
[betalningsregistrering](https://developer.vismaonline.com/docs/invoice-payments),
OpenAPI ovan. Rate limit är dokumenterad som 600 anrop/minut per klient och
endpoint/URL; vi behöver kö, sidindelad återläsning och hantering av HTTP 429:
[rate limits](https://developer.vismaonline.com/docs/rate-limits-copy).

## Betalfil: tre möjliga vägar

| Väg | Vad vi kan bygga | Kvar att verifiera |
| --- | --- | --- |
| Spiris ansvarar för banksteget | Skapa rätt leverantörsfakturor, återläsa status; ekonomin hanterar fil/bankkoppling i Spiris. | Svensk produktnivå, aktiverad bankkoppling, bankavtal och vilka fakturor som automatiskt skickas till banken. |
| JEROC skapar en fil | Exportera valda attesterade och obetalda avräkningar till bankens accepterade format. Personal laddar upp och godkänner i banken. | Bank, tjänst, filspecifikation/version, avsändar-ID och stöd för företags- samt privatpersoners konton. |
| Direkt bankintegration | Separat adapter för en verifierad bank-/betalningstjänst. | Avtal, API, betalningsgodkännande, testmiljö och återrapportering. Detta stöds inte av den granskade eEkonomi-API-definitionen. |

ISO 20022 **pain.001** är familjen för kundinitierade kreditöverföringar. Bankens
implementationsguide avgör exakt version och svenska regler. En fil som bara
följer ett generiskt XML-schema är inte bevis på att bankens tjänst accepterar
den. [ISO:s officiella meddelandekatalog](https://www.iso20022.org/iso-20022-message-definitions)
beskriver meddelandefamiljen.

Bankgirots **Leverantörsbetalningar/LB** har också offentliga post-/filmanualer
och exempel: [Bankgirots tekniska information](https://www.bankgirot.se/tjanster/utbetalningar/leverantorsbetalningar/teknisk-information/).
Vi ska inte välja LB som standard utifrån att manualen finns; tillgänglighet
och accepterat format behöver bekräftas av JEROC:s bank för avsedd startdag.
Bankgironummer, plusgiro, inhemskt clearing/kontonummer och IBAN är olika
mottagaridentifierare och kan kräva olika regler i vald banktjänst.

Före en betalfilsetapp behövs från JEROC: **bankens namn**, tjänst/avtal för
filbetalningar, en aktuell bankformatspecifikation och vilka mottagartyper som
ska ingå. Därefter ordnas bankens test-/valideringsväg. Hemliga kontouppgifter
och bankcredentials ska inte skrivas i detta dokument eller skickas i chatten.

### Uppföljning: Roslagens Sparbank / Swedbank

Användaren anger preliminärt Roslagens Sparbank/Swedbank. JEROC:s faktiska bank,
aktiverade tjänst och avtal är ännu inte verifierade. Följande gäller den
offentliga bankinformationen granskad 2026-10-11:

- Tjänsten heter **Filöverföring via internetbanken**. Den möjliggör uppladdning
  av filer, separat behörighet för den som skickar respektive godkänner och
  återrapportering av mottagna/utförda betalningar. Banken beskriver även
  möjligheten till två godkännare. Avtal och behörighet behöver ordnas med
  bankkontoret: [Roslagens tjänstebeskrivning](https://www.roslagenssparbank.se/foretag/betala-och-ta-betalt/betala/fakturahantering/betala-via-fil.html).
- Bankens aktuella migrationsinformation säger att stöd för Bankgiroformaten
  upphörde **1 september 2026** och att filkommunikation går via banken från
  **1 juli 2026**. För ett nytt betalfilbygge mot denna bank ska vi därför välja
  ISO 20022 enligt Swedbanks MIG, inte LB. Bankgiro- och plusgironummer finns
  fortfarande kvar som mottagaridentifierare:
  [Roslagens ISO-information](https://www.roslagenssparbank.se/foretag/betala-och-ta-betalt/ny-standard-for-betalningar-i-sverige.html)
  och [Swedbanks ISO-information](https://www.swedbank.se/foretag/betala-och-ta-betalt/ny-standard-for-betalningar-i-sverige.html).
- [Swedbanks publicerade MIG](https://www.swedbank.se/foretag/betala-och-ta-betalt/betala/fakturahantering/betala-via-fil/mig.html)
  anger **pain.001.001.03** för initiering i både **MIG 1.0** (leverantörs-,
  bankgiro-/plusgiro- och internationella betalningar) och **MIG 2.0**
  (kontoöverföringar och löner). MIG-versionen är bankens regelverk; den är
  inte samma sak som XML-meddelandets versionsnummer. Betalmetod och avtal
  avgör vilken guide/regler som gäller, inte om mottagaren är privatperson
  eller företag. Banken ska bekräfta detta för våra skrotutbetalningar.
- Mottagarens **namn är obligatoriskt** för kontoöverföring, bankgiro och
  plusgiro. Bankens MIG innehåller dessutom regler för konton/referenser och
  rätt betaltyp. En generisk XML-export räcker därför inte.
- Banken erbjuder **Validex** för filprov: pain.001 valideras och pain.002
  genereras, med syntax- och affärskontroller. MIG-sidan länkar testmiljö,
  instruktioner och testkonton. Använd endast påhittade testdata där.
  Bankens faktiska utförande och vår återläsning måste fortfarande verifieras
  separat innan riktiga utbetalningar aktiveras.

En lämplig fråga till bankkontoret är: *”Vi vill skapa ISO 20022-betalfiler i
vårt eget system för skrotinköp, med betalning både till företags bankgiro och
till privatpersoners clearing-/kontonummer. Har vårt företag Filöverföring via
internetbanken och rätt betalningsavtal? Vilken Swedbank MIG ska vi följa för
respektive betaltyp och vilken återrapportering kan vi hämta?”* Inga
banklösenord eller token behövs för denna avstämning. Vår nuvarande
viktkorts-CSV blir inte en bankfil genom att byta filändelse.

## Koppling till vårt arbetsflöde

1. Kunden godkänner den frysta avräkningsversionen. För farligt avfall bekräftas
   mottagningen före intern attest enligt vårt aktuella arbetsflöde.
2. Intern attest gör inköpsversionen exportklar. En beständig integrationsjournal
   binds till organisation, fakturamål, kort-ID, version och underlagets hash.
3. Överför leverantör, fakturautkast och PDF och spara varje faktiskt extern-ID.
   Ett timeout efter POST ger osäkert utfall; skapa inte blint en dublett. Läs
   tillbaka eller låt operatören kontrollera innan nytt försök.
4. Inköpets bokföringsstatus hålls separat från betalning. En skapad betalfil
   innebär **exporterad för betalning**, inte **betald**. Filbatch, varje rad,
   belopp, referens, version och kontrollsumma sparas med spårbarhet.
5. Banken godkänner/utför betalningen. Bankens verifierade återrapportering eller
   avstämning registrerar betald/avvisad/avbruten; hantera delbetalning och
   rättelser. Betalfilen ska inte återskapas med nya identiteter på ett sätt
   som riskerar samma utbetalning igen.
6. Betalningsregistrering i Spiris sker bara om den inte redan bokförts genom
   Spiris bankkoppling eller annan matchning. Exportstatus och bankstatus ska
   aldrig ensamma utlösa en andra bokföringsregistrering. Använd
   `SkipSendToBank` där aktuell faktura annars riskerar både egen filbetalning
   och Spiris automatiska bankflöde; verifiera beteendet innan aktivering.

`Spara på saldo`, kontant och Swish ska inte automatiskt inkluderas i en
bankfil. Bokföringshändelser kan fortfarande behövas för dem, med egen
kontomappning och verifierad betalningskälla. Återställning av databasen får
inte automatiskt återsända fakturor eller betalningsbatcher.

## Föreslagen nästa testetapp

Först: svensk sandbox, OAuth och läskontroll av valt företag, kontoplan,
betalvillkor och bankkonton. Därefter ett fiktivt attesterat företagsinköp och
ett privatinköp som **utkast med PDF**, med verifierad kontering. Prova
bokföring, kredit/rättelse och återläsning av referenser i sandbox innan
produktionsåtkomst begärs. Bankfilexport är ett eget avtalsspecifikt steg;
fullständiga bankbetalningar kan inte godkännas genom sandboxprovet ensamt.
