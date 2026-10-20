# Gemensam adresshjälp – Google

Implementerad 20 oktober 2026 enligt ÄL 087. Adressförslag och serverkontroll används som hjälp i redigerbara formulär. Inget sparas automatiskt.

## Flödet

1. Välj **Sök och komplettera adress** bredvid de vanliga adressfälten.
2. Skriv minst tre tecken. Efter 350 ms söker webbläsaren svenska adresser med Places API (New), högst fem förslag åt gången.
3. Välj en träff. Bara adresskomponenter och formaterad adress hämtas; inga koordinater, omdömen eller andra företagsuppgifter importeras.
4. Servern kontrollerar den strukturerade adressen med Address Validation API.
5. Granska gata/husnummer, postnummer och ort. **Adressen stämmer – använd adressen** för över den uttryckligen bekräftade adressen till utkastet. Spara formuläret separat.

Google-förslaget ersätter inte manuella fält. Saknad nyckel, kvot, nätfel eller ofullständig träff stoppar inte manuell inmatning. Användaren kan ange exempelvis en hämtplats bakom en lada. Om man ändrar adressfält, konto, bolag eller aktuellt utkast förkastas sena förslag.

Kundens SCB-postadress blir inte automatiskt materialets ursprung. Kopiering till ursprung kräver fortfarande ett aktivt val. Googles ort är inte NVV:s fyrsiffriga kommunkod; befintlig kommunmatchning och manuell bekräftelse används separat. Låsta underlag får inga nya redigeringsmöjligheter.

## Nycklar och Render

Båda variablerna läggs i **Render → scrapplanner-app → Environment**, utan citattecken eller extra frågetecken. Deploya appen efter ändring.

| Variabel | Google-begränsning | Tillåtna API:er |
| --- | --- | --- |
| `GOOGLE_MAPS_BROWSER_API_KEY` | Websites: `https://app.scrapplanner.com/*` och `https://mobile.scrapplanner.com/*` | Maps JavaScript API och Places API (New) |
| `GOOGLE_ADDRESS_VALIDATION_API_KEY` | IP addresses: appens aktuella utgående IP-intervall | Endast Address Validation API |

Hämta serverns IP-intervall i **scrapplanner-app → Connect → Outbound**. Kopiera samtliga intervall inklusive `/24` eller annat CIDR-suffix. De är delade Render-intervall, inte dedikerade IP-adresser; uppdatera begränsningarna om Render ändrar dem. Använd aldrig webbplatsens DNS/A-post som serverns utgående IP.

Webbläsarnyckeln är avsedd att kunna skickas till Google-biblioteket i en inloggad webbläsare och skyddas av domän-/API-begränsningarna. Valideringsnyckeln hålls endast på backend. Inga verkliga nycklar ska läggas i Git, chatt eller loggar. `VITE_`-variabler används inte.

Google Cloud-projektet behöver aktiverad fakturering och dessa API:er. Sätt faktiska kvoter och budgetlarm. Ett budgetlarm stänger inte av debitering. Webbläsarens Google-anrop begränsas av Googles kvoter, inte av serverns valideringsbegränsning.

**Integrationer → Google adresser** visar om respektive nyckel finns och innehåller ett adressprov utan kundsparande. **Konfigurerad** betyder att nycklarna finns; det är inte ett påstående att Google har godkänt nycklar, fakturering eller begränsningar. Prova en verklig adress efter deployment.

## API och behörighet

- `POST /api/address-assistance/config`, JSON `{}`: autentiserad konfiguration med närvaroflaggor; endast den avsiktligt offentliga webbläsarnyckeln kan lämnas ut när båda kopplingarna är konfigurerade.
- `POST /api/address-assistance/validate`, JSON `{ "address": { "address": "Testgatan 12", "postalCode": "76141", "city": "Norrtälje", "countryCode": "SE" } }`: svensk adresskontroll. Svaret innehåller ett adressförslag och begränsade kvalitetsflaggor. Alla förslag kräver användarens bekräftelse; inte en garanti om att post kan levereras.

Båda kontrollerar verklig plattforms-/personalsession och bolagskontext, samma ursprung och aktuell behörighet före svar. Plattformsanrop kräver CSRF. Förfalskade användar-/bolagsheaders ger ingen åtkomst. Läsbehörighet för integrationer räcker för konfigurationsstatus; validering kräver rätt att redigera ett relevant verksamhetsflöde.

Validering begränsas per appinstans till 30 anrop/minut per användare och bolag, 120/minut per bolag och åtta/sekund totalt. Skalning till flera instanser kräver en delad limiter. Anrop har åtta sekunders timeout även för svarskroppen, max 64 KiB leverantörssvar, fast Google-värd och inga automatiska omförsök. Begärans maxstorlek är 4 KiB. Svar använder `private, no-store`; inga råa Google-svar eller adresser loggas av dessa moduler.

## EES, kartor och beständiga adresser

Vanligt Places-innehåll får enligt Googles EES-villkor inte användas tillsammans med eller länkas till en karta, med särskilda undantag för koordinater/place ID. Därför är Google-hjälpen avstängd i det kartanknutna transportformuläret: manuell adress och befintlig kartas separata **Hitta adress** fortsätter fungera. Vi byter inte kartleverantör och matar inte in råa Places-svar i Leaflet/OpenStreetMap.

Google Address Validation-villkor §1.4 medger att vissa adressfält ersätts med användaruppgifter genom användarens uttryckliga bekräftelse eller rättelse. Därför passerar valt förslag servervalideringen och ett separat bekräftelsesteg före överföring till det egna formuläret. Endast den bekräftade adressen förs vidare; ingen generell permanent Google-cache, valideringshistorik eller koordinatimport införs. Råa Places-/Google-svar sparas inte i kundregistret.

En framtida direkt integration av Google-resultat i kartan kräver ett separat verifierat tjänste-/licensupplägg. Places UI Kit är en annan tjänst och är inte automatiskt lösningen för redigerbara, beständiga adressfält.

## Verifiering

```sh
node scripts/build-domain-models.mjs
node --test server/google-address-validation.test.mjs server/address-assistance-api.test.mjs server/company-register-gateway.test.mjs server/integrations.test.mjs
npx playwright test tests/address-assistance.spec.ts tests/customer-identity-office.spec.ts tests/company-register-entrypoints.spec.ts --workers=2
npm run build
```

Leveranskontroll 20 oktober 2026: produktionsbygget passerar, 109 backendtester
passerar och ett PostgreSQL-test är överhoppat eftersom en separat testdatabas
inte finns här. Alla 57 utvalda formulär-, adress-, SCB- och plattformsflöden
passerar i Chromium. En bredare äldre kundtestkörning stoppades i nio tester
av dess tidigare headerbaserade demoinloggning/plattformsbootstrap; de testerna
behöver migreras till dagens inloggningsfixtur. Inloggningsskyddet har inte
försvagats för att få dem att passera. De nya kontorstesterna använder isolerade,
giltiga sessionsfixturer; den verkliga gatewayens åtkomstkontroll testas separat.

Automatiska tester använder syntetiska Google-/SCB-svar. Riktiga nycklar och anrop från Renders utgående IP-adresser behöver kontrolleras i den driftsatta appen; lokala tester bevisar inte att Googles projektinställningar är aktiverade.

## Källor

- [Google: Autocomplete Data API](https://developers.google.com/maps/documentation/javascript/place-autocomplete-data)
- [Google: Address Validation REST](https://developers.google.com/maps/documentation/address-validation/reference/rest/v1/TopLevel/validateAddress)
- [Google: EES Service Specific Terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
- [Google: API security best practices](https://developers.google.com/maps/api-security-best-practices)
- [Render: outbound IP addresses](https://render.com/docs/outbound-ip-addresses)
