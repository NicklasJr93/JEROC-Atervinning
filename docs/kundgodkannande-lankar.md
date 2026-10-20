# Kundgodkännande via e-post, SMS och kundterminal

Kontoret kan visa ett vägt underlag på en kundterminal eller skicka en personlig granskningslänk via e-post eller SMS. Kunden behöver inget ScrapPlanner-konto. Samtliga tre kanaler använder samma godkännandeflöde: kunden granskar underlaget och villkoren, begär godkännande och visar därefter sin legitimation för personalen på plats. Personalen bekräftar ID-kontrollen innan underlaget blir kundgodkänt. Intern attest är ett separat steg.

Detta är manuell legitimationskontroll. Funktionen utför ingen BankID-signering och visar ingen BankID-knapp.

## Kontorets arbetsgång

1. Öppna det aktuella viktkortet och kontrollera kund, material, vikt, priser och betalningsuppgifter.
2. Välj **Visa på kundterminal**, **Skicka via e-post** eller **Skicka via SMS**. Terminalalternativet kräver en tillgänglig kundterminal. E-post och SMS fungerar utan en ansluten terminal.
3. För e-post och SMS förifylls kundens sparade kontaktuppgift när den finns. Kontrollera mottagaren; uppgiften går att ändra för det enskilda utskicket och valideras innan sändning. Välj uttryckligen **Skicka via e-post** respektive **Skicka via SMS**.
4. Följ utskickets och granskningens status på kortet. Att leverantören accepterar utskicket innebär inte att kunden har läst underlaget eller godkänt det.
5. När kunden har valt **Godkänn** visar kortet att personalens ID-kontroll inväntas.
6. Kontrollera kundens legitimation fysiskt. Välj **Bekräfta legitimation & godkännande**, markera **Jag har kontrollerat kundens legitimation på plats** och välj **Bekräfta kontroll & godkännande**.
7. Underlaget blir kundgodkänt först efter serverns bekräftelse. Attestera därefter separat med ordinarie attestbehörighet. Eventuell PDF-kopia till kontoret efter attest följer sin egen företagsinställning.

Kundgodkännanden visas även i kontorets befintliga godkännandelista med rätt kanal och mottagare. Kontorets befintliga behörighets- och bolagskontroller gäller också för utskick och ID-bekräftelse.

## Kundens arbetsgång

Kunden öppnar länken på sin mobil eller dator, granskar det frysta underlaget och accepterar villkoren. **Godkänn** skickar begäran direkt; inget extra inledande bekräftelseklick krävs. Efter ett bekräftat serversvar visas **Visa din legitimation** och **Inväntar personalens bekräftelse**. Detta är väntan på fysisk ID-kontroll, inte ett färdigt godkännande.

Kunden kan begära en ändring med en kommentar. Kontoret får då hantera rättelsen och skicka eller visa en ny version för granskning. Kunden får inte ändra belopp, material eller andra underlagsuppgifter via länken.

Sidan hämtar aktuell status medan den är öppen. Den visar färdigt godkännande först när personalens bekräftelse har sparats. En gammal begäran eller ett sent nätverkssvar får inte tillämpas på en annan kund eller underlagsversion.

## Länk, giltighet och fryst version

- En ny e-post- eller SMS-granskning får en unik, slumpad åtkomsttoken och gäller i **24 timmar från skapandet**.
- Länken har formen `https://<APP_URL:s värd>/godkann/#token=<token>`. Token ligger i URL-fragmentet, inte i en queryparameter eller vanlig HTTP-sökväg.
- Token ger åtkomst till just den granskningen. Den är en hemlig åtkomstlänk och ska inte delas. Länken identifierar inte i sig vem som håller i telefonen; därför kvarstår personalens ID-kontroll.
- Servern sparar tokenens hash. Plattformsregistret väljer rätt aktivt bolag genom denna hash, och bolagets datalager kontrollerar även granskningens ID, version, hash, status och giltighetstid. Kunden får inte välja bolag genom en URL-parameter.
- Granskningen är bunden till en fryst underlagsversion och dess innehållshash. Ändrat underlag kräver ny granskning; ett gammalt svar kan inte godkänna den ändrade versionen.
- En ersatt, återkallad eller utgången granskning kan inte fortsätta godkännas med den gamla länken. Den publika sidan visar då ett begränsat besked utan kundens underlag.
- Webbsidan tar bort tokenfragmentet ur adressfältet efter att den läst in länken och behåller token endast i sidans minne. Den sparas inte i lokal lagring. Efter omladdning behöver kunden öppna den ursprungliga länken från mejlet eller SMS:et igen.

Kundterminalen behåller sina befintliga sessions- och giltighetsregler. Den publika länkens 24-timmarsregel ändrar inte terminalens tidsgränser.

## Leveransstatus och omförsök

Utskicket reserveras beständigt före leverantörsanropet. Ett dubbelklick eller samma tidigare begäran ska inte skapa ett fristående andra utskick. Status för själva leveransen hålls åtskild från kundens godkännande:

| Leveransstatus | Betydelse och hantering |
| --- | --- |
| `reserved` | Sändningen är reserverad men leverantörsanropet har ännu inte startats. |
| `sending` | Ett leverantörsanrop pågår. Starta inget nytt försök under tiden. |
| `sent` | Leverantören har accepterat utskicket. Det bevisar inte leverans till inkorg/telefon, läsning eller kundgodkännande. |
| `failed` | Sändningen startade inte eller leverantören avvisade den. Kontrollera felet och avsluta den gamla granskningen före ett uttryckligt nytt utskick. |
| `unknown` | Utfallet kunde inte säkerställas, exempelvis efter timeout eller avbrott. Meddelandet kan redan ha skickats. Kontrollera leverantörens utskickslogg innan ett nytt utskick övervägs. |

**Inga automatiska omsändningar görs**, inte heller vid osäkert resultat. Sidan får läsa status igen utan att det skickar ett nytt mejl eller SMS. Ett nytt avsiktligt utskick sker från kontoret; avsluta eller ersätt föregående granskning så dess länk inte längre kan användas. Transportaviseringar och schemalagda påminnelser aktiveras inte genom denna funktion.

Kundens status följer separat `waiting` → `id_requested` → `approved` → `attested`. Ändringsbegäran, återkallning och utgång hanteras som egna tillstånd. Kundens knapptryck kan endast nå `id_requested`; personalens bekräftelse kräver uttryckligt `idChecked: true` och låser godkännandet till samma frysta underlag. Attest kräver fortfarande godkänt aktuellt underlag och ordinarie attestbehörighet.

## Befintlig konfiguration

Funktionen använder redan överenskomna servervariabler. Inga nya miljövariabler behövs för länkflödet.

| Variabel | Användning |
| --- | --- |
| `APP_URL` | Appens kanoniska publika HTTPS-adress, exempelvis `https://app.scrapplanner.com`. Länkar byggs på dess ursprung med sökvägen `/godkann/`. |
| `RESEND_API_KEY` | Utskick via Resend från `ScrapPlanner <noreply@scrapplanner.com>`. Domänen måste vara verifierad för utskick. |
| `ELKS_API_USERNAME` | 46elks API-användarnamn. |
| `ELKS_API_PASSWORD` | 46elks API-lösenord. SMS använder den fasta avsändaren `ScrapPlan`. |

Hemligheter sparas privat i Render, inte i Git, klientkod eller chatt. Konfigurerad status bekräftar att uppgifterna finns; verklig leverantörsbehörighet och leverans kontrolleras genom ett uttryckligt driftsatt prov. Se även [Systemutskick](integrationer/systemutskick.md) för plattformens separata testknappar och deras testregister.

## Publikt API och avgränsning

Den publika sidan använder följande två endpoints med `Authorization: Bearer <token>`:

- `GET /api/public/customer-approval` hämtar det tillåtna underlaget och aktuell status.
- `POST /api/public/customer-approval/respond` tar emot `{ action: 'id_requested' | 'change_requested', termsAccepted: boolean, comment?: string }`.

Ingen inloggad kundsession, bolagsväljare eller terminalcookie krävs. Endpoints ger inte tillgång till historik, andra kunders uppgifter eller ett allmänt utskicks-API. Token i queryparametrar accepteras inte. Otillgänglig länk ger HTTP 410 utan underlag. Publika anrop har gränser för anropsfrekvens och meddelandestorlek; servern återkontrollerar åtkomsten för varje läsning och svar.

## Verifiering

De riktade automatiska proven finns i `server/customer-approval-gateway.test.mjs`, `server/customer-approval-remote.test.mjs`, `server/public-customer-approval.test.mjs`, `server/system-email.test.mjs`, `server/system-sms-provider.test.mjs`, `tests/customer-approval-links.spec.ts`, `tests/terminal.spec.ts` och `tests/terminal-popup-scroll.spec.ts`.

Proven täcker bland annat bolagsisolering, felaktiga/utgångna/ersatta länkar, frysta versioner, leverantörsfel och osäkra svar, kundens väntan på ID-kontroll, obligatorisk personalbekräftelse samt skydd mot sena svar och dubbla knapptryck. Automatiska prov använder syntetiska leverantörssvar och skickar inga verkliga mejl eller SMS. Exakta kontrollresultat redovisas med leveransen.
