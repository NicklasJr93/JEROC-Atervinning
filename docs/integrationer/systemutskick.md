# Systemutskick – mejl och planerade SMS

Systemutskick hanteras på plattformsnivå. Det första verkliga utskicket är ett manuellt testmejl via Resend från **ScrapPlanner <noreply@scrapplanner.com>**. Testet ligger i systemadministrationen och använder inga uppgifter eller mallar från ett SaaS-bolag.

## Prova ett mejlutskick

1. Logga in med plattformens eget systemadminkonto och öppna **Systemadmin**. Knappen återgår till den egna systemadminvyn och avslutar eventuellt **Jobba som**-sammanhang för systemadministrationen.
2. Öppna **Systemutskick → Testa mejlutskick**.
3. Ange en mottagares e-postadress och välj **Skicka testmejl**.
4. Kontrollera mottagarens inkorg och skräppost. Vid behov kan systemägaren även kontrollera mejlets status i Resend.

Testet har en fast svensk ämnesrad och text som identifierar ScrapPlanner och EndorGroup. Mottagaren är den enda adress som kan anges; avsändare, meddelandetext, bilagor och bolagsuppgifter kan inte ändras genom testet. Ett mejl skickas bara efter ett uttryckligt knapptryck.

Ett lyckat svar betyder att **Resend har accepterat mejlet**. Det bekräftar inte att mottagarens mejlserver har levererat det till inkorgen. Leveransstatus, studsar och klagomål behöver senare kopplas till verifierade leverantörswebhooks innan de kan visas som leveransbesked i portalen.

## Konfiguration i Resend och Render

Domänen `scrapplanner.com` måste vara verifierad för utskick i Resend. Lägg in de DNS-poster Resend anger hos domänleverantören och kontrollera domänens status i Resend. Resends mottagning av mejl behöver inte aktiveras för detta utskickstest.

Skapa en API-nyckel för utskick i Resend och spara den privat i **Render → scrapplanner-app → Environment**:

| Key | Value |
| --- | --- |
| `RESEND_API_KEY` | API-nyckeln från Resend, inskriven privat i Render. |

Använd inga extra citattecken, frågetecken eller `VITE_`-prefix. Nyckeln får inte läggas i Git, chatt, klientkod eller loggar. Det finns ingen separat avsändarvariabel för testet: avsändaren är låst till **ScrapPlanner <noreply@scrapplanner.com>**.

Deploya appen efter konfigurationsändringen. Appens automatiska deployment är avstängd: använd **Manual Deploy → Deploy latest commit** i Render. Att gränssnittet visar att en nyckel finns bevisar inte att domänen, nyckelns rättigheter eller leverantörskvoten fungerar; gör testutskicket efter deployment. Ett saknat eller nekat leverantörskonto ska ge ett begripligt fel, inte ett simulerat leveransbesked.

## API och skydd

- `GET /api/platform/communications` visar om mejlleverantören är konfigurerad, den fasta avsändaren och SMS-status `{ "configured": false, "useCases": [...] }`. De förberedda SMS-ändamålen är `customer_approval` och `transport_notification`. Nyckeln lämnas aldrig ut.
- `POST /api/platform/communications/test-email`, JSON `{ "requestId": "<uuid>", "to": "mottagare@example.com" }`, begär ett testmejl till en enda giltig e-postadress.
- `POST /api/platform/open-administration` återgår till det egna plattformssammanhanget. **Systemadmin**-knappen använder denna väg innan systemadministrationen visas.

Åtkomst kräver plattformens verkliga systemadministratör i den egna systemadminvyn. Bolagets VD, en vanlig bolagsadministratör eller en systemadmin som arbetar inne hos ett bolag får inte använda testet. Kontrollerna sker på servern; att dölja knappen är inte åtkomstskyddet. Skrivande anrop omfattas av befintligt skydd för session, aktuellt administratörssammanhang, samma ursprung och CSRF.

Utskick reserveras atomärt i plattformsregistret innan leverantören anropas. Samma begäran har ett stabilt `requestId` och en stabil idempotensnyckel hos leverantören, så dubbelklick eller osäkra nätverkssvar inte ska ge en ny fristående sändning. UUID normaliseras till gemener, så olika bokstavsstorlek inte skapar ett nytt test. En avsiktlig ny sändning efter ett lyckat test får ett nytt ID. Testflödet gör inga automatiska omförsök.

Testfunktionen tillåter högst **10 leverantörsförsök per aktör och timme**, **3 per mottagare och timme** och **50 totalt per timme**. Begränsningarna och reservationerna ligger i det gemensamma plattformsregistret och delas därmed mellan appinstanser som använder samma register. Pågående försök reserveras i 30 sekunder. Försöksräknare gäller en timme och begäransdetaljer behålls i 48 timmar; städning sker när ett nytt test begärs.

När en begäransdetalj städas bort behålls ett kompakt SHA-256-avtryck av dess UUID permanent. Avtrycket innehåller ingen mottagare. Ett utgånget UUID ger därför fortsatt HTTP 409 och kan inte återanvändas som ett nytt utskick efter 48 timmar. Aktiva och utgångna begärans-ID har tillsammans ett tak på **10 000**. När taket nås stoppas nya tester; systemet raderar inte gamla ID för att frigöra plats och riskera en upprepad sändning. Det är en begränsad lagringsmodell för testfunktionen, inte ett obegränsat produktionsarkiv.

Revisionsspåret innehåller aktör, tid, begärans-ID och resultat. Mottagaradressen lagras som ett SHA-256-hashvärde i det varaktiga spåret och inte som klartext. Hashvärdet är pseudonym information, inte anonym information. Revisionsspåret följer plattformens befintliga lagringsregler; gränsen 48 timmar ovan gäller begäransdetaljer och innebär inte att det separata revisionsspåret raderas då. Nycklar, meddelandetext och råa leverantörsfel lagras inte där. Leverantören får själva mottagaradressen för att kunna leverera mejlet.

Ett avbrott eller timeout kan inträffa efter att leverantören accepterat mejlet. Gränssnittet får då inte lova att ingen sändning skett. Ett uttryckligt omförsök använder samma UUID och identiska leverantörsuppgifter inom 23 timmar; Resends idempotensnyckel gäller i 24 timmar. Äldre osäkra försök stoppas med instruktion att kontrollera Resend innan en ny sändning görs. Ett redan accepterat försök kan återlämnas från registret utan nytt leverantörsanrop. Testflödet startar aldrig omförsök automatiskt.

Gränssnittet behåller omförsökets ID medan samma formulär är öppet. Efter omladdning kan ett nytt avsiktligt test få ett nytt ID. Om det tidigare resultatet var osäkert ska administratören kontrollera Resends utskickslogg innan ett nytt test startas; serverns idempotens för ett visst UUID slår inte ihop två olika begärans-ID.

Felkoder har prefixet `system_email_` och fasta, säkra texter för bland annat saknad konfiguration, nekad leverans, frekvensgräns och osäkert resultat. Ett rått leverantörsfel lämnas inte vidare till webbläsaren.

## Kommande mejlflöden

Den gemensamma leverantörskopplingen kan senare användas för exempelvis kontoinbjudningar, återställningslänkar, avräkningar och transportaviseringar. De flödena behöver egna rättighetskontroller, mottagarregler, mallar och verksamhetshändelser innan de aktiveras. Testknappen aktiverar dem inte.

Bolagets sparade aviseringsmottagare under **Företagsinställningar** är fortfarande mottagarinställningar. De skapar inga automatiska utskick genom denna leverans.

Befintlig Microsoft 365-integration används för att läsa mejl. Gmail är planerat. En ansluten inkorg betyder inte att portalen redan kan skicka som den användaren. Framtida utskick från Outlook eller Gmail behöver separat sändningsimplementation och leverantörens sändningsbehörighet. Önskat framtida flöde är bolagets egen anslutna avsändare när den stöds; annars tydlig sändning via ScrapPlanner med bolagets mall och logga.

## Förberedda SMS-flöden

Användaren har valt **kundgodkännande och transportaviseringar** som de två första SMS-flödena och har skapat ett **46elks-konto**. SMS är ännu inte aktiverat: någon sändningsadapter eller automatiska verksamhetsutskick är inte inkopplade genom denna förberedelse.

46elks är en svensk leverantör med SMS-API, leveransbesked och betalning efter förbrukning. En alfanumerisk SMS-avsändare får ha högst 11 tecken. `ScrapPlanner` har 12 tecken; exempelvis **ScrapPlan** kan användas som avsändarnamn och hela varumärket skrivas i meddelandet när leverantörskopplingen byggs. Någon sådan avsändare är ännu inte registrerad eller satt i drift.

Följande variabelnamn är överenskomna och reserverade för den kommande kopplingen. Spara värdena privat under **Render → scrapplanner-app → Environment**:

| Key | Value |
| --- | --- |
| `ELKS_API_USERNAME` | API-användarnamnet från 46elks. |
| `ELKS_API_PASSWORD` | API-lösenordet från 46elks, inte kontots vanliga inloggningslösenord. |

Värdena ska inte skickas i chatt eller läggas i Git/klientkod. Dessa namn är en förberedd konvention; den aktuella SMS-hjälpen läser dem inte och enbart sparade värden aktiverar ingen SMS-sändning. Statusen är därför fortfarande `configured: false` även om uppgifterna har lagts in i Render.

| Flöde | Exempel | Kanalval |
| --- | --- | --- |
| Kundgodkännande | En kund får en länk till sitt aktuella viktunderlag när terminalen inte används. | Valt; SMS-underlag förberett. |
| Transportavisering | Bekräftad hämtning, ändrad tid eller besked om att chauffören är på väg. | Valt; SMS-underlag förberett för `booked`, `time_changed` och `on_the_way`. |
| Chaufförsuppdrag | Nytt, ändrat eller återkallat uppdrag som kräver snabb uppmärksamhet. | Framtida förslag. Appavisering i första hand; SMS vid uttryckligt behov. |
| Påminnelse | Ett kundgodkännande väntar fortfarande på svar. | Framtida förslag. Schemalagd och begränsad påminnelse efter verksamhetsbeslut. |
| Viktiga driftfel | Ett brådskande integrationsfel meddelas till utsedd ansvarig. | Framtida förslag. SMS för särskilt valda fel; vanlig driftinformation via mejl. |

Vanliga dokument, inbjudningar och systembesked passar normalt som mejl. Allmän marknadsföring ingår inte i de föreslagna SMS-flödena.

`server/system-sms.mjs` innehåller katalogen `SYSTEM_SMS_USE_CASES` och serverhjälpen `prepareSystemSms`. Hjälpen skapar ett inaktivt SMS-underlag med `deliveryEnabled: false` och `deliveryStatus: 'not_configured'`. Den normaliserar telefonnummer och binder underlaget till bolag, mottagare, ändamål, händelse-ID och aktuell objektsversion. En stabil idempotensnyckel skiljer även de olika transportbeskeden åt. Ingen ny kö, sändningshook eller publik SMS-endpoint skapas.

Anroparen måste först behörighetskontrollera verksamhetsobjektet och tillhandahålla en redan utfärdad och kontrollerad kundportallänk. Hjälpen kontrollerar att denna betrodda kontext stämmer med bolag, mottagare, ändamål, händelse och version, samt att HTTPS-länken hör till rätt kundportal och inte har gått ut. Hjälpen utfärdar inga länkar eller åtkomsttoken och autentiserar inte tokeninnehållet. Ett klientpåstående om att länken är godkänd är inte en betrodd kontext.

En framtida kanaladapter kan använda dessa underlag och samma modell för spårning och leverantörsresultat som mejlen. En bolagsadministratör ska aldrig kunna välja ett annat bolags avsändare, mottagarregister eller underlag.

SMS ska innehålla kort information och vid behov en skyddad länk. Personuppgifter från HR, lön, sjukfrånvaro eller bankkonton ska inte skrivas i meddelandet. Innan svarslänkar aktiveras behöver deras behörighet, giltighetstid, återkallning och koppling till rätt underlagsversion vara implementerade och testade. Utgångna eller ersatta godkännanden får inte godkännas via en gammal länk.

En verklig SMS-leverans kräver leverantörskoppling, kontrollerad avsändaridentitet, koppling till behörighetskontrollerade verksamhetshändelser, begränsning av kostnad/utskicksfrekvens samt verifierad hantering av leveransbesked. Inga SMS skickas genom mejltestet eller SMS-hjälpen.

## Verifiering

```sh
node scripts/build-domain-models.mjs
node --test server/system-email.test.mjs server/platform-communications.test.mjs server/system-sms.test.mjs
npx playwright test tests/platform-communications.spec.ts --workers=1
npm run build
```

Automatiska prov använder syntetiska leverantörssvar och skickar inga verkliga mejl eller SMS. Ett lyckat lokalt prov bevisar inte att Resend-nyckel, DNS, domänrättigheter eller leverans fungerar i Render. Testknappen används för det separata driftsatta mejlprovet.

Leveranskontroll 20 oktober 2026: **54 serverfall och 11 skilda browserfall passerar**, och produktionsbygget passerar. Testresultaten gäller ovanstående testflöden; något skarpt mejl- eller SMS-utskick har inte genomförts av de automatiska proven.

## Källor

- [Resend: verifiera domän](https://resend.com/docs/dashboard/domains/introduction)
- [Resend: skicka mejl](https://resend.com/docs/api-reference/emails/send-email)
- [Resend: idempotensnycklar](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [46elks: SMS-API och avsändarformat](https://46elks.com/docs/send-sms)
