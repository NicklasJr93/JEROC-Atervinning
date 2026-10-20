# Kunduppgifter via terminal eller SMS

Från **Välj kund** på ett pågående mobilvågkort väljer personalen
**Låt kunden fylla i** och sedan en ansluten kundterminal eller ett
mobilnummer för en SMS-länk. Vågkortet sparas först. Personalen kan
fortsätta med material och vikter medan kunden fyller i formuläret.

Kunden anger organisations-/personnummer, namn, kontaktuppgifter och
adress. Bankuppgifter är valfria. Formuläret förklarar att e-post används
för kvitton och information om inlämningen, utan reklam, och att ett
sparat bankkonto kan återanvändas vid kommande utbetalningar.
Swish visas utgråat med **Kommer snart** och kan inte väljas.

När uppgifterna kommit fram granskar personalen dem och kopplar kunden
till vågkortet. En unik identifierarträff återanvänder kundkortet.
Befintliga kontakt- och bankuppgifter visas aldrig för den som öppnar
formuläret. Ett sparat bankkonto ersätts inte av den publika inmatningen.
Nya bankuppgifter kräver personalens behörighet för betalningsuppgifter.

Förfrågan behöver granskas eller avbrytas före färdigställande av
vågkortet. Byte av kund avslutar den tidigare förfrågan. Redan sparade
vikter påverkas inte när uppgifterna kopplas till kortet.

Det här är insamling av kunduppgifter. Kundens senare godkännande av
avräkningen, kontroll av fysisk legitimation och kontorets attest följer
det befintliga flödet.

## Drift

- Befintlig 46elks-konfiguration används. Inga nya miljövariabler behövs.
- SMS skickas endast när personalen begär det. Osäkra utskicksresultat
  skickas inte automatiskt igen.
- Länken öppnar `/kunduppgifter/`. Dess tillfälliga bärare ligger i
  URL-fragmentet och tas bort från adressfältet när sidan öppnas.
- Förfrågan gäller ett bestämt bolag, en anläggning och ett pågående
  vågkort, och har begränsad giltighetstid. Länken ger ingen åtkomst
  till kundregister, priser, vikter eller behörigheter.
- Samma terminal kan användas för kunduppgifter eller kundgodkännande.
  En upptagen terminal ska inte få sitt aktuella ärende ersatt.
- Insamlade uppgifter sparas först som ett förslag. Efter avslut rensas
  förslagets person- och bankuppgifter; godkända uppgifter finns på
  kundkortet.

## Verifiering

Isolerade server- och webbläsarprov använder testbolag och simulerad
SMS-leverantör. Kontrollerna omfattar separata bolag, engångsinlämning,
upprepade anrop, behörigheter, terminalreservation och att samtidiga
viktändringar bevaras.

Produktionsbygge och Expo-typkontroll passerar. Slutlig riktad körning:
73 serverprov och 12 browserfall. Den bredare körningen hittade dessutom
äldre demo-fixturer som saknar sessionsinloggning och ett transportprov
med utgången vy; samma fel reproducerades på oförändrad baslinje
`d7695e9`. De ändras inte i den här leveransen.
