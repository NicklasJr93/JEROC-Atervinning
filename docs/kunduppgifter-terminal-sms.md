# Kunduppgifter via terminal eller SMS

Från **Välj kund** på ett pågående mobilvågkort väljer personalen
**Låt kunden fylla i** och sedan en ansluten kundterminal eller ett
mobilnummer för en SMS-länk. Vågkortet sparas först. Personalen kan
fortsätta med material och vikter medan kunden fyller i formuläret.

Samma formulär på terminal och i SMS-länken visar fyra steg med en
numrerad progressrad:

1. Organisations-/personnummer, namn och postadress.
2. Telefon och e-post. Kontaktuppgifterna kan hoppas över.
3. Valfria bankuppgifter, med möjlighet att hoppa över.
4. Valfri referens och materialets ursprungsadress. Postadressen kopieras
   som förslag tills kunden anger en annan ursprungsadress. Steget kan
   hoppas över utan att ändra personalens befintliga val på vågkortet.

Tillbaka behåller inmatningen. Formuläret förklarar att e-post används
för kvitton och information om inlämningen, utan reklam, och att ett
sparat bankkonto kan återanvändas vid kommande utbetalningar.
Swish visas utgråat med **Kommer snart** och kan inte väljas.

Organisations-/personnummerfältet får fokus direkt när ett nytt formulär
öppnas, även när terminalen byter kund. Vid Tillbaka till första steget
markeras det befintliga numret. Mobilens webbläsare kan kräva ett tryck
för att öppna skärmtangentbordet.

När sista siffran ger ett komplett och giltigt organisationsnummer
hämtas företagsnamn, postadress och tillgängliga kontaktuppgifter från
SCB automatiskt. Manuellt ändrade fält behålls; sena svar för ett annat
nummer används inte. Saknad träff eller driftfel tillåter manuell
inmatning. Person- och samordningsnummer skickas inte till SCB.

När uppgifterna kommit fram granskar personalen dem och kopplar kunden
till vågkortet. En unik identifierarträff återanvänder kundkortet.
Befintliga kontakt- och bankuppgifter visas aldrig för den som öppnar
formuläret. Ett sparat bankkonto ersätts inte av den publika inmatningen.
Nya bankuppgifter kräver personalens behörighet för betalningsuppgifter.
Referens och ursprungsadress visas också för personalens granskning.
De angivna valen sparas på vågkortet och på kundkortets listor för
återanvändning när personalen väljer **Använd kunduppgifterna**.

Förfrågan behöver granskas eller avbrytas före färdigställande av
vågkortet. Byte av kund avslutar den tidigare förfrågan. Redan sparade
vikter påverkas inte när uppgifterna kopplas till kortet.

Det här är insamling av kunduppgifter. Kundens senare godkännande av
avräkningen, kontroll av fysisk legitimation och kontorets attest följer
det befintliga flödet.

## Drift

- Befintlig 46elks-konfiguration används. Inga nya miljövariabler behövs.
- Befintlig `SCB_API_KEY` används för företagsuppslaget. Den lämnas aldrig
  till kundens webbläsare. Ett aktivt kundformulär krävs och kontrolleras
  igen efter uppslaget; samma SCB-begränsning delas med kontorets uppslag.
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
- Efter ett avbrott skapas en ny förfrågan och en ny SMS-länk. Den gamla
  länken och gamla avbrott kan inte påverka det nya formuläret. Detta
  gäller även om ett serversvar tappas eller bolagets tjänst startas om.

## Verifiering

Isolerade server- och webbläsarprov använder testbolag och simulerad
SMS-leverantör. Kontrollerna omfattar separata bolag, engångsinlämning,
upprepade anrop, behörigheter, terminalreservation och att samtidiga
viktändringar bevaras.

Den ursprungliga leveransen verifierades med 73 serverprov och 12
browserfall. ÄL 151 utökar kontrollerna för stegen, företagsuppslaget,
referens/ursprung och nya länkar efter avbrott.

ÄL 151 verifierad 2026-10-20: produktionsbygge och Expo-typkontroll,
91 riktade serverprov och åtta browserfall. Positiva SCB-anrop genom
gatewayen kontrolleras för både SMS och parkopplad terminal. Browserproven
täcker automatisk ifyllning, sena svar, manuellt reservflöde, stegen,
överhoppade fält, nätfelsomförsök och nya SMS-länkar i samma flik.
All verifiering använder syntetiska uppgifter och simulerade leverantörer.
