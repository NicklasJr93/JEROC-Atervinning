# Bokföringsuppföljning och aktivt återskapande

Bygget för ÄL 093 och 095 följer endast JEROC:s egna sparade exportförsök. Kopplingen är fortfarande begränsad till Spiris sandbox; den bokför inte utkast, godkänner fakturor eller skickar betalningar.

## Status och spårbarhet

Varje export behåller företag, sandboxmiljö, kundgodkännandets ID/version/hash, konteringen som låstes då, försöks-ID och Spiris-referenser. Händelser har beständiga ID:n. Förberedande fel, exempelvis ett ogiltigt organisationsnummer i en äldre låst version, sparas nu som stoppade exportförsök i stället för att försvinna före köläggningen.

Huvudhändelser är köad, påbörjad, fakturautkast skapat, lokal kontroll stoppade överföringen, Spiris avvisade, osäkert svar, bokförd, underlag saknas, uppföljning avslutad och aktivt återskapat. Leverantörsmatchning/skapande finns kvar i detaljjournalen. Vanliga statuskontroller lägger inte till återkommande händelser eller hela providersvar i journalen.

## Läsning från Spiris

Servern kontrollerar först att OAuth-anslutningens faktiska CompanyIdentifier fortfarande är det väntade sandboxföretaget. Generation och aktuell behörighet kontrolleras även före varje GET och före resultatet sparas. Det är korta databastransaktioner; Spiris-anrop görs efter att databaslåsen släppts.

Tillåtna läsoperationer är:

- `GET /v2/supplierinvoicedrafts/{id}`
- `GET /v2/supplierinvoices` med dokumenterad sidindelning
- `GET /v2/supplierinvoices/{id}`

Finns utkastet kvar fortsätter uppföljningen. Ett 404 är inte bokföringsbekräftelse. Efter 404 kontrolleras hela den verifierbara fakturalistan, begränsad till 100 sidor och med 45 sekunders total tidsgräns. Motsvarande faktura måste ha samma `CreatedFromDraftId`, leverantör, referens och belopp. Ett separat anrop måste därefter bekräfta `Status=1` (Normal), giltigt `VoucherId` och icke-tomt `VoucherNumber`. Resultatet sparas som bokförd med faktura- och verifikationsreferenser. Betalningsstatus ändras inte.

Om listan är ofullständig, åtkomst nekas, identiteter/belopp motsäger varandra eller en annan faktura har samma leverantör/referens får underlaget inte återskapas. En borttagen slutlig faktura utan säker bokföringsstatus kräver också manuell granskning.

## Tidsgränser och återanslutning

Indexerade uppföljningsjobb kontrolleras när deras nästa kontroll är förfallen:

- första dygnet: var femte minut;
- till och med första veckan: varje timme;
- därefter: en gång per dygn;
- efter `trackingMaxDays` (standard 30, tillåtet 1–365): automatiskt stopp.

Tillfälliga fel använder ökande väntetid. Efter åtta misslyckade kontroller krävs åtgärd. Åtkomst-/tokenfel pausar automatiska kontroller tills anslutningen förnyas eller systemadmin gör ett aktivt nytt läsförsök.

Avstängd eller bortkopplad integration pausar läsningen och behåller senaste bekräftade exportstatus. Återanslutning till samma verifierade företag återupptar förfallna kontroller, aldrig gamla POST-försök. Byts företag behåller de tidigare ärendena sin ursprungliga koppling och visas pausade. Bokförda ärenden kontrolleras inte vidare av denna funktion.

## Återskapa utkast

Knappen visas först efter två verifierade kontroller, med minst fem minuter emellan, som inte hittar vare sig utkast eller motsvarande bokförd faktura. Ett nytt utkast skapas aldrig automatiskt.

Aktiv åtgärd kräver faktisk och effektiv systemadmin med åtkomst till alla anläggningar, giltig session och CSRF. Servern kontrollerar att samma aktuella kundgodkända/attesterade källa gäller, läser Spiris igen och reserverar ett separat idempotent försök. Från samma låsta underlag skapas ett nytt utkast med nytt request-ID. Föregående referenser och historik behålls. Avsaknaden kontrolleras dessutom en gång till omedelbart före POST efter kontroll av leverantör, villkor och kontoplan.

Databaslease och försöks-ID skyddar dubbelklick och konkurrerande serverinstanser. Om ett POST-svar är osäkert stoppas automatisk återförsändning, precis som i ordinarie export. Ändrade material-, kund- eller prisuppgifter kräver ny godkänd version/rättelse och kan inte användas för ett återskapande av den gamla versionen.

## API och verifiering

- `POST /api/environment/visma/accounting/exports/{exportId}/refresh` tar `{}` och läser enbart.
- `POST /api/environment/visma/accounting/exports/{exportId}/recreate` tar `{ "requestId": "nytt UUID" }`.
- Viktkortets vanliga serverprojektion visar begränsad status, händelser, nästa/senaste kontroll och tillåtna åtgärder. Den exponerar inte fakturans konteringsrader, bankuppgifter eller OAuth-token.

Mockade provideranrop testas mot både SQLite och isolerad lokal PostgreSQL: bokföring, ofullständiga listor, fel företag, frånkoppling/återanslutning, ändrad attestkälla, tidsgränser, konkurrerande återskapande och osäkra POST-svar. Dessa tester skriver inte till Spiris eller Render. Det verkliga sandboxflödet återstår att prova efter deploy med ett JEROC-utkast som ekonomiansvarig bokför/raderar i sandbox.
