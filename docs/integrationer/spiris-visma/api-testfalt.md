# Spiris / Visma eEkonomi – kontrakt för sandboxens testfält

Kontrollerat mot offentlig dokumentation och levande OpenAPI **2026-10-11**.
Exemplen är fiktiva och har inte körts mot ett autentiserat sandboxföretag.
API-definitionen beskriver datamodellen; fler verksamhetsregler kan ge fel från
Spiris och ska visas på testsidan med faktisk HTTP-status och svarskropp.

## Anslutning och företagskontroll

Sandbox använder samma adresser som produktion:

| Funktion | Adress |
| --- | --- |
| API-bas | `https://eaccountingapi.vismaonline.com/v2` |
| Inloggning | `https://identity.vismaonline.com/connect/authorize` |
| Token | `https://identity.vismaonline.com/connect/token` |
| Återkallning | `https://identity.vismaonline.com/connect/revocation` |

En sandboxklient får inte ansluta till produktionsföretag. En produktionsklient
kan däremot ansluta till sandbox. Företagstyp kan därför inte härledas från
API-domänen. Använd en svensk sandboxklient och jämför det anslutna företagets
`CompanyIdentifier` med ett förkonfigurerat förväntat värde innan testanrop
tillåts. `GET /companysettings` ger också `Name`, `CountryCode`,
`CorporateIdentityNumber` och `CurrencyCode`. Schemat saknar en uttrycklig
`IsSandbox`-flagga; namn och organisationsnummer bevisar inte testmiljö.

Användarens onboardingmejl anger följande beviljade scopes för sandboxklienten:

```text
ea:api ea:sales ea:purchase ea:accounting vls:api offline_access
```

Den byggda anslutningen begär de fem som behövs här och utelämnar payroll-scopet
`vls:api`:

```text
ea:api offline_access ea:purchase ea:accounting ea:sales
```

`ea:sales` och `ea:accounting` omfattar de aktuella läsoperationerna enligt
OpenAPI. De ger också skrivbehörigheter hos Spiris, men vår server begränsar
användningen till operationerna nedan. Readonly-varianterna
`ea:sales_readonly` och `ea:accounting_readonly` skulle räcka för läsningarna,
men finns inte i mejlets klientbeviljande och behöver först beviljas separat
av Spiris innan vi ändrar anslutningens scopebegäran.

Authorization-anropet använder `client_id`, exakt registrerad `redirect_uri`,
`response_type=code`, dessa scopes och sessionsbunden engångs-`state`.
`prompt=select_account` gör att användaren väljer företag. Rekommenderad
`acr_values` är `service:44643EB1-3F76-4C1C-A672-402AE8085934`.
Callbacken är en riktig serveradress utan `#`-fragment. Koden är dokumenterad
som engångskod med fem minuters giltighet.

Onboardingmejlets registrerade callback är platshållaren
`https://localhost:44300/callback`. Den behöver ersättas av Spiris med
`https://jeroc-atervinning.onrender.com/api/integrations/visma/oauth/callback`
för denna Render-anslutning. Användaren kontaktar `api@spiris.se` för ändringen;
Render-adressen måste vara registrerad för automatisk retur. Det tillfälliga
localhostläget och manuell vidarebefordran beskrivs i [sandbox-setup.md](sandbox-setup.md#tillfälligt-test-med-befintlig-localhostadress).
Ingen klienthemlighet behöver stå i dokumentationen eller i den frågan.

Tokenanrop är `POST` med `Content-Type:
application/x-www-form-urlencoded;charset=UTF-8` och serverns
`Authorization: Basic base64(client_id:client_secret)`:

| Flöde | Formulärfält |
| --- | --- |
| Byt kod mot token | `grant_type=authorization_code`, `code`, `redirect_uri` |
| Förnya token | `grant_type=refresh_token`, `refresh_token` |
| Återkalla refresh-token | `token`, valfritt `token_type_hint=refresh_token` |

IdentityServers aktuella OIDC-discovery annonserar `client_secret_basic`,
`client_secret_post` och PKCE med `S256` samt `plain`. Använd dokumenterad Basic-
autentisering och PKCE `S256`: `code_challenge` +
`code_challenge_method=S256` vid inloggning och `code_verifier` vid kodbytet.
Klientens faktiska PKCE-beteende måste verifieras vid första inloggningen.

Tokensvaret innehåller `access_token`, `refresh_token`, `token_type` och
`expires_in` (exemplet anger 3600 sekunder). Refresh-token anges gälla två år
och kan sluta gälla när användaren ändrar lösenord. Dokumentationen fastställer
inte om tidigare refresh-token omedelbart ogiltigförklaras vid förnyelse.
Spara alltid det senast returnerade paret atomiskt och samordna samtidiga
förnyelser. Token och klienthemlighet ska stanna på servern och utelämnas från
testsvar, requestvisning och loggar.

## Begränsade testoperationer

Alla routes nedan ligger under `/v2`. Servern väljer en fast API-värd och
kontrollerar både HTTP-metod och route.

| Operation | Begärt verksamhetsscope för denna klient | Användning |
| --- | --- | --- |
| `GET /companysettings` | `ea:sales` | Verifiera rätt företag |
| `GET /fiscalyears` | `ea:sales` eller `ea:accounting` | Hämta bokföringsår och låsstatus |
| `GET /accounts/{fiscalyearId}` | `ea:accounting` | Hämta årets aktiva konton; path-ID är UUID |
| `GET /termsofpayments` | `ea:purchase` | Välj betalvillkor för inköp |
| `GET /suppliers` | `ea:purchase` | Hämta leverantörer och deras UUID |
| `GET /suppliers/{id}` | `ea:purchase` | Återläs en viss leverantör |
| `GET /supplierinvoicedrafts/{id}` | `ea:purchase` | Återläs ett visst fakturautkast |
| `GET /vatcodes` | `ea:accounting` | Välj företagets verkliga momskoder |
| `GET /costcenters` | `ea:accounting` | Hämta resultatenheter och deras faktiska poster |
| `GET /projects` | `ea:accounting` | Välj pågående projekt |
| `POST /suppliers` | `ea:purchase` | Skapa fiktiv testleverantör |
| `POST /supplierinvoicedrafts` | `ea:purchase` | Skapa redigerbart testutkast |

Listläsning av `GET /supplierinvoicedrafts` kan läggas till senare med samma
inköpsscope. Godkännande, konvertering till bokförd faktura,
betalningsregistrering och bankoperationer ingår inte i denna testetapp.

Listor returnerar `{ "Meta": {...}, "Data": [...] }`. Sidparametrar är
`$page` och `$pagesize`; standard är 50 objekt, maximalt 1000 per sida.
Följ `Meta.TotalNumberOfPages` och visa när bara en sida hämtats.

## Hanterad ekonomi och överföring i 0.16.0

Integrationskortets ekonomiinställningar väljer verkliga provider-ID:n,
konton och momskoder. Artikelns `taxCategory` är separat från dess
avfallsklassificering. Kundens `vatRegistered` och eventuella
`paymentTermDays` kombineras med artikelregeln **före** kundgodkännande.
Privatinköp, omvänd moms, vanlig moms 25 procent och uttryckligt fastställda
momsbefriade företagsinköp är olika regler. Okända historiska uppgifter
upphöjs inte till verifierade genom en export.

Materialpriser är exklusive eventuell debiterad moms. Materialbelopp och
moms låses tillsammans med kundens avräkning. Fryst ekonomi sparar
inställningsrevision, företag, konton, dimensioner, momskoder, belopp i
hela ören, betalvillkor och artikelns dåvarande klassificering. Vanlig moms
ökar invoicegross och kundens utbetalningsunderlag. Beräknad omvänd moms
ökar inte säljarens utbetalning. Datum och förfallodag räknas i svensk tid.

Hanterad export använder `useDefaultVatCodes=false` och
`calculateVatOnCostAccounts=false` tillsammans med de uttryckligt byggda
konteringsraderna, så att Spiris inte också beräknar samma moms automatiskt.
Draftfält `Rows[].CostCenterItemId1` är en faktisk post i första
resultatenheten; det är inte anläggningens JEROC-ID. `ProjectId` är
valfritt när kontot tillåter det. Kontoplan och låsstatus verifieras för
räkenskapsåret som täcker den frysta avräkningens fakturadatum.

Leverantörs-ID sparas per företag och JEROC-kund. Exakt kundnummer matchas
först; ett känt organisationsnummer får inte motsäga vald leverantör.
Personnummer används inte för deduplicering eller organisationsnummerfält.
Flera möjliga organisationsnummerträffar kräver ett entydigt val.

Exportkön reserverar leverantörs- och utkaststeg beständigt före POST.
Oklar nätverkseffekt återsänds inte. En mottagen resurs-ID kan återhämtas
från den sparade anropsjournalen efter omstart. Provideranrop sker efter
att den korta databasreservationen har committats och släppt låset.
Poster är kopplade till en exakt attestversion och dess kontrollsumma.
Kvittningskort spärras tills motsvarande kreditunderlag kan stämmas av
i Spiris. Ett fakturautkast bokför eller betalar ingen faktura.

## Fritt testformulär: förifyllning från attestversionen

Version 0.15.2 hämtar förifyllningen från terminalens frysta snapshot med
kundgodkännandets matchande kontrollsumma och intern attest. En äldre
attesterad version väljs inte om en nyare granskning finns. Rättelsekort
ingår inte i urvalet. Uppgifterna är redigerbara testförslag.

| Uppgift på viktkortet | Spiris-fält / beteende |
| --- | --- |
| Fryst kundnamn och kundnummer | `Name`, `SupplierNumber` |
| Företagets organisationsnummer | `CorporateIdentityNumber`, siffror utan bindestreck |
| Privatpersonens personnummer | Överförs inte till organisationsnummerfältet |
| Kundadress, kontaktperson, telefon, e-post | Leverantörens motsvarande adress- och kontaktfält |
| Ursprung och kundreferens | Sammanställning och `Note`; ursprung ersätter inte kundens adress |
| Frysta bankuppgifter, om bankkonto är betalningssätt | `Clearing`, `BankAccountNumber`, `BankName` |
| Avräkningsnummer | `InvoiceNumber`: samma `AV-{kortnummer}-V{version}` som dokumentet |
| Attesttidpunkt | `InvoiceDate`: kalenderdatum i Europe/Stockholm |
| Materialbelopp före kvittning | `TotalAmount`; materialrader i debet och skuld i kredit |
| Material, vikt, pris | Konteringsradens `TransactionText`, även fullständig källsammanställning |
| Kvittning och att betala | Visas separat; kvittning bokförs inte av detta test |

Konton väljs från verklig läst kontoplan. 4000 och 2440 är redigerbara
testförslag endast när kontona är aktiva och inte kräver extra dimensioner.
Ett entydigt leverantörsnummer matchas först, annars organisationsnummer.
Betalvillkor hämtas från Spiris och ger föreslaget förfallodatum. När en
testleverantör skapas används dess svar-ID direkt i fakturautkastet.

Viktkortet fastställer ännu inte företagsinköpets moms. Företagstestet
behöver därför ett uttryckligt `Vat` och granskad kontering. Privatinköp
förifylls med `Vat: 0`. Vanlig moms kräver även att konteringsraderna ändras;
ett ändrat momsbelopp skapar inte automatiskt en momsrad.

Varje källkopplat skrivtest lagrar `source` (kortnummer, attest-ID, version,
kontrollsumma) i JEROC-journalen. Servern kontrollerar aktuellt attestbevis
före Spiris-POST. Källmetadata ingår inte i provider-payloaden och
kortval/förifyllning utför inga externa skrivningar. Utkastet behåller
`SkipSendToBank: true`. PDF-bilaga ingår inte ännu.

## `POST /suppliers`

Testservern tillåter en begränsad del av Spiris datamodell och avvisar okända
fält. Dess aktuella fältlista finns i
[visma-client.mjs](../../../server/visma-client.mjs). Automatiskt godkännande
och automatisk bokföring får endast anges som `false` och får detta värde
också när de utelämnas. API-dokumenterade fält kan därför kräva en separat
utökning innan testsidan accepterar dem.

OpenAPI anger exakt två obligatoriska fält:

| Fält | Typ / regel | Värdet hämtas från |
| --- | --- | --- |
| `Name` | sträng, högst 50 tecken | Fiktivt namn |
| `TermsOfPaymentId` | UUID | `GET /termsofpayments`; välj `AvailableForPurchase=true` |

`SupplierNumber` är valfritt och får högst 16 tecken; Spiris genererar ett om
det utelämnas. Användbara frivilliga fält är `CountryCode` (två tecken),
`CurrencyCode` (tre tecken), `IsActive` (boolean), `CorporateIdentityNumber`
(högst 20 tecken), `Address1`/`Address2`/`City` (50), `PostalCode` (10),
`EmailAddress` (255), `Note` (4000) och `VatNumber` (20).

Det finns inget `IsPrivatePerson`, `Type` eller separat privatpersonsschema.
Ett test av privatinköp använder samma leverantörsmodell med ett fiktivt
personnamn och kan utelämna `CorporateIdentityNumber` och `VatNumber`.
Det beskriver API-fälten; affärsreglerna för privatinköp och självfakturering
måste fortfarande verifieras med ekonomiansvarig och i sandbox.

Inhemska betaluppgifter är frivilliga: `BankAccountNumber` (högst 50),
`Clearing` (5), `BankgiroNumber` (10) och `PlusgiroNumber` (10). Utkaststestet
behöver inga verkliga bank- eller personuppgifter. I fritt test kan
betaluppgifter lämnas tomma; kortval förifyller de frysta bankuppgifterna.

Ett redigerbart startvärde, där UUID:t måste ersättas:

```json
{
  "Name": "JEROC Sandbox Leverantör AB",
  "TermsOfPaymentId": "00000000-0000-0000-0000-000000000000",
  "CountryCode": "SE",
  "CurrencyCode": "SEK",
  "IsActive": true,
  "UsesAutomaticSupplierInvoiceApproval": false,
  "UsesAutomaticInvoicePostToLedger": false
}
```

Privatpersonstestet kan använda `Name: "JEROC Sandbox Privatperson"` med samma
övriga fält. `Id`, `CreatedUtc`, `ModifiedUtc`, `IsDraft` och andra
`readOnly`-fält ska inte skickas. Lyckad POST returnerar HTTP 201 med skapad
leverantör, inklusive `Id`.

## `POST /supplierinvoicedrafts`

OpenAPI anger exakt tre obligatoriska fält:

| Fält | Typ / regel |
| --- | --- |
| `SupplierId` | UUID från skapad eller återläst leverantör |
| `IsCreditInvoice` | boolean, `false` för vanligt inköp |
| `Rows` | array med `SupplierInvoiceDraftRowApi` |

För ett begripligt testunderlag fylls också dessa frivilliga fält i:

| Fält | Regel |
| --- | --- |
| `InvoiceDate` | Beskrivningen anger `YYYY-MM-DD`; standard är dagens datum |
| `DueDate` | Beskrivningen anger `YYYY-MM-DD`; standard räknas från betalvillkor |
| `InvoiceNumber` | högst 50 tecken; använd unik testreferens |
| `TotalAmount` | tal med högst två decimaler, inklusive moms |
| `Vat` | tal med högst två decimaler, sammanlagd moms |
| `CurrencyCode` | högst tre tecken, exempelvis `SEK` |
| `Message` | högst 25 tecken |
| `OcrNumber` | högst 25 tecken; utelämna när testet inte gäller OCR |
| `SkipSendToBank` | boolean; `true` i dessa testutkast |

Datumens schema säger `date-time` medan fältbeskrivningen säger `YYYY-MM-DD`.
Använd det dokumenterade datumformatet i startvärdet och visa API:ts faktiska
valideringssvar. Skicka inte `PaymentDate` för ett obetalt testinköp.

`Rows` är **konteringsrader**, inte artikelrader. Schemat har ingen separat
`required`-lista för radobjekt, men dessa är de relevanta testfälten:

| Radfält | Typ / regel |
| --- | --- |
| `AccountNumber` | heltal 1–9999999999; kontots nummer, inte UUID |
| `DebitAmount` | tal, högst två decimaler |
| `CreditAmount` | tal, högst två decimaler |
| `TransactionText` | valfri sträng, högst 100 tecken |
| `LineNumber` | heltal; standard 1 |
| `VatCodeId` | valfri UUID för momskod |
| `ProjectId`, `CostCenterItemId1/2/3` | valfria UUID; kan krävas av valt konto |

`GET /accounts/{fiscalyearId}` ger `Number` som sträng. Konvertera ett
verifierat numeriskt kontonummer till heltal för `Rows[].AccountNumber` och
kontrollera `IsActive`, `IsFirstCostCenterMandatory` och övriga kontovillkor.
Testservern kräver `AccountNumber` på varje rad samt 1–100 rader, och tillåter
inte `PaymentDate`, `BankAccountId`, bilagor eller attestfält. Den kräver
`SkipSendToBank: true` och lägger till värdet när fältet utelämnas.
Fälten `Quantity` och `Weight` är för nederländska jordbruksföretag och ska
inte användas för svenska skrotvikter.

Följande är ett **förslag till fiktivt test utan moms**, inte ett verifierat
bokföringsunderlag. Ersätt UUID:t, datum/referens och konton med värden från
sandboxens kontoplan. Radernas debet/kredit balanserar 100 kr. Konton 4000
och 2440 illustrerar kostnad respektive leverantörsskuld; de kan ha andra
regler i det anslutna företaget.

```json
{
  "SupplierId": "00000000-0000-0000-0000-000000000000",
  "IsCreditInvoice": false,
  "InvoiceDate": "2026-10-11",
  "DueDate": "2026-11-10",
  "InvoiceNumber": "JEROC-TEST-001",
  "CurrencyCode": "SEK",
  "TotalAmount": 100,
  "Vat": 0,
  "SkipSendToBank": true,
  "Rows": [
    { "AccountNumber": 4000, "DebitAmount": 100, "CreditAmount": 0, "LineNumber": 1 },
    { "AccountNumber": 2440, "DebitAmount": 0, "CreditAmount": 100, "LineNumber": 2 }
  ]
}
```

En generell nollmomsregel ska inte användas för skrotinköp. Företagsinköp,
privatinköp, vanlig moms och omvänd skattskyldighet är olika testfall med
verifierad kontering. OpenAPI dokumenterar inte fullständigt vilka rader
servern fyller i eller kräver i varje läge; återläs det skapade utkastet.
Lyckad POST returnerar HTTP 201 med skapad draft inklusive `Id`.

Spiris dokumenterar dessa frivilliga POST-queryfält som boolean. Den nuvarande
testservern skickar inga queryparametrar och använder därför API-standarderna;
redigering av dessa fält kräver en senare utökning:

| Fält | OpenAPI-standard |
| --- | --- |
| `useDefaultVatCodes` | `true` |
| `calculateVatOnCostAccounts` | `false` |
| `batchProcessExtendedValidation` | `false` |
| `duplicateCheckExtendedValidation` | `false` |

Vid en sådan utökning visas använda värden i testsidan. Dubblettkontrollen kan
vara användbar men ersätter inte spårning av osäkra POST-utfall. Ett timeout efter POST kan betyda
att objektet redan skapats; upprepa inte automatiskt.

## Bilagor och användbara felsvar

Bilaga är inte ett obligatoriskt draftfält och kan vara en senare etapp.
`POST /attachments` använder JSON med `ContentType`, `FileName` och antingen
base64-`Data` eller publik `Url`. PDF stöds; svensk fil får vara högst 20 MB,
och bilagornas sammanlagda storlek per dokument får vara högst 20 MB.
`POST /attachmentlinks` binder skapade `AttachmentIds` till draftens
`DocumentId` och `DocumentType: 4`. Dessa två skrivoperationer behöver en egen
utökning av testserverns tillåtna operationslista.

Vanliga API-fel returnerar `ErrorCode`, `DeveloperErrorMessage`, `ErrorId`
och ibland `Errors[]` med `Field`, `ErrorCode`, `Message`, `Key`. Visa dessa
uppgifter samt status, tidsåtgång och själva requestens metod, route och JSON.
Exempel ur Spiris felkatalog är 2000 (modellvalidering), 3000 (objekt saknas),
3002 (konto saknas), 4032 (leverantörsfakturans rader balanserar inte) och 4034
(sandboxklient riktad till produktion). HTTP 429 kan innehålla felkod 4010.
Rate limit är 600 anrop/minut per klient och endpoint/URL.

## Källor

- [Levande OpenAPI V2](https://eaccountingapi.vismaonline.com/openapi/v2.json)
- [OAuth-guiden](https://developer.vismaonline.com/docs/authentication)
- [IdentityServer discovery](https://identity.vismaonline.com/.well-known/openid-configuration)
- [Miljöer](https://developer.vismaonline.com/docs/environments)
- [Sandbox FAQ](https://developer.vismaonline.com/docs/sandbox-faq)
- [Inköpsflödet](https://developer.vismaonline.com/docs/build-smart-with-purchase-invoices)
- [API-felkoder](https://developer.vismaonline.com/docs/error-codes-copy-1)
- [Sidindelning](https://developer.vismaonline.com/docs/pagination-copy)
- [Rate limits](https://developer.vismaonline.com/docs/rate-limits-copy)

Se också [förstudien](forstudie.md) för bokföring, betalningar och bankfil.
