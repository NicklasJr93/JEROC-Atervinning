# Systemutskick – mejltest, SMS-test och planerade aviseringar

Systemutskick hanteras på plattformsnivå. Det första verkliga utskicket är ett manuellt testmejl via Resend från **ScrapPlanner <noreply@scrapplanner.com>**. Testet ligger i systemadministrationen och använder inga uppgifter eller mallar från ett SaaS-bolag.

Samma panel har nu ett separat **SMS-test via 46elks**, med fast avsändare **ScrapPlan**. SMS-testet skickar först efter administratörens knapptryck. Kundgodkännande och transportaviseringar är fortfarande förberedda underlag utan automatiska utskick.

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

- `GET /api/platform/communications` visar mejlkonfigurationen och SMS-status `{ "configured": true|false, "provider": "46elks", "from": "ScrapPlan", "useCases": [...] }`. `sms.configured` anger om båda SMS-variablerna finns, inte om kontot, saldot eller leveransen har verifierats. De förberedda verksamhetsändamålen är `customer_approval` och `transport_notification`. Nycklar och lösenord lämnas aldrig ut.
- `POST /api/platform/communications/test-email`, JSON `{ "requestId": "<uuid>", "to": "mottagare@example.com" }`, begär ett testmejl till en enda giltig e-postadress.
- `POST /api/platform/communications/test-sms`, JSON `{ "requestId": "<uuid>", "to": "+46701234567" }`, begär ett test-SMS till ett giltigt telefonnummer.
- `POST /api/platform/communications/review-sms`, med samma JSON-fält, bekräftar administratörens manuella logggranskning för mottagarnumret. Åtgärden skickar inget SMS.
- `POST /api/platform/open-administration` återgår till det egna plattformssammanhanget. **Systemadmin**-knappen använder denna väg innan systemadministrationen visas.

Åtkomst kräver plattformens verkliga systemadministratör i den egna systemadminvyn. Bolagets VD, en vanlig bolagsadministratör eller en systemadmin som arbetar inne hos ett bolag får inte använda testet. Kontrollerna sker på servern; att dölja knappen är inte åtkomstskyddet. Skrivande anrop omfattas av befintligt skydd för session, aktuellt administratörssammanhang, samma ursprung och CSRF.

För mejltestet reserveras utskicket atomärt i plattformsregistret innan leverantören anropas. Samma begäran har ett stabilt `requestId` och en stabil idempotensnyckel hos Resend, så dubbelklick eller osäkra nätverkssvar inte ska ge en ny fristående sändning. UUID normaliseras till gemener, så olika bokstavsstorlek inte skapar ett nytt test. En avsiktlig ny sändning efter ett lyckat test får ett nytt ID. Testflödet gör inga automatiska omförsök. SMS har ett separat skydd utan antagen leverantörsidempotens, beskrivet nedan.

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

## Prova ett SMS-utskick

Ett **46elks-konto** finns. Spara dess API-uppgifter privat under **Render → scrapplanner-app → Environment**:

| Key | Value |
| --- | --- |
| `ELKS_API_USERNAME` | API-användarnamnet från 46elks. |
| `ELKS_API_PASSWORD` | API-lösenordet från 46elks, inte kontots vanliga inloggningslösenord. |

Värdena ska inte skickas i chatt eller läggas i Git/klientkod. SMS-testets serveradapter läser nu båda variablerna. Den separata hjälpen för kund-/transportunderlag använder inga leverantörsuppgifter.

1. Deploya senaste commit manuellt på **scrapplanner-app** efter att API-uppgifterna sparats.
2. Öppna **Systemadmin → Systemutskick → Testa SMS-utskick** utanför bolagets arbetsyta.
3. Ange mottagarnumret, exempelvis ett svenskt `07…`-nummer eller internationellt `+46…`, och välj **Skicka test-SMS**.
4. Kontrollera telefonen och vid behov utskicksloggen hos 46elks. Om kontot nekar utskick visas ett säkert fel om exempelvis API-uppgifter, saldo eller utskicksregler.

SMS:et har fast avsändare **ScrapPlan** och fast text:

> Test från ScrapPlanner. En systemadministratör har begärt detta test-SMS till ditt nummer. Du behöver inte svara.

Texten är 113 tecken och använder GSM-7. Den innehåller inga kunduppgifter, länkar eller uppgifter från bolaget. 46elks tillåter högst 11 tecken i en alfanumerisk avsändare; `ScrapPlanner` har 12 tecken, så **ScrapPlan** används medan hela varumärket står i meddelandet.

Leverantörskvittot kontrolleras på servern. `created` och `sent` visas som accepterat för utskick; de bekräftar inte leverans till telefonen. Endast om 46elks uttryckligen rapporterar `delivered` visas levererat. Ett negativt kvitto behandlas som fel. Portalen gör inga bakgrundsuppslag eller tar emot senare leveranswebhooks i detta testflöde.

### SMS-testets dubbelsändningsskydd

46elks-anropet har ingen antagen leverantörsidempotens. Servern reserverar varje test atomärt före nätanropet och lagrar utfallet i ett separat SMS-register. Ett redan accepterat UUID återlämnar tidigare resultat utan nytt SMS. Telefonnumret normaliseras innan det får en pseudonym SHA-256-identitet.

Ett osäkert svar, exempelvis efter timeout, nätavbrott eller leverantörens serverfel, kan betyda att SMS:et redan skickats. Därför spärras **mottagarnumret** för nya tester, även med nytt UUID, efter omladdning, serveromstart eller från ett annat systemadminkonto. Ingen automatisk omsändning görs. Under ett pågående tests första 30 sekunder tillåts inte heller manuell upplåsning.

Efter ett osäkert resultat behöver administratören kontrollera 46elks utskickslogg, markera **Jag har kontrollerat utskicksloggen** och välja **Tillåt ett nytt SMS-test**. Detta markerar de osäkra posterna för numret som granskade och skickar inget SMS. Först ett efterföljande uttryckligt **Skicka test-SMS** gör ett nytt försök med ett nytt UUID. En definitiv leverantörsavvisning som bekräftar att ingen sändning gjorts kan däremot provas igen uttryckligen utan sådan logggranskning.

SMS-testet har egna gränser: högst **10 leverantörsförsök per aktör och timme**, **3 per mottagarnummer och timme** och **50 totalt per timme**. Dessa räknare är separata från mejltestet. Begäransdetaljer behålls normalt i 48 timmar; osäkra och ogranskade pågående poster behålls tills administratören har granskat dem. Utgångna UUID behålls som permanenta kompakta SHA-256-avtryck utan mottagare, så gamla ID inte åter blir nya sändningar. Taket är 10 000 kända SMS-test-ID totalt; vid fullt register stoppas nya tester.

Det separata revisionsspåret innehåller aktör, tid, begärans-ID, pseudonym mottagarhash och säkra resultatkoder enligt plattformens befintliga lagringsregler. Klartextnummer, SMS-text och API-lösenord lagras inte i testregistret eller revisionsspåret. Leverantören får numret för utskicket; `dontlog=message` begär att själva meddelandetexten inte lagras i 46elks meddelandelogg.

`server/system-sms-provider.mjs` anropar endast `https://api.46elks.com/a1/sms` med HTTPS, HTTP Basic-autentisering och formulärfält enligt leverantörens API. Det finns ingen påhittad idempotensparameter eller automatisk omförsöksloop. Hela anropet, inklusive kvittot, har åtta sekunders timeout och kvittot får högst vara 16 KiB. Alla råa leverantörsfel hålls på servern; klienten får fasta feltexter och koder med prefixet `system_sms_`.

## Förberedda verksamhets-SMS

Användaren har valt **kundgodkännande och transportaviseringar** som de två första verksamhetsflödena. De är förberedda som inaktiva underlag och kopplas inte automatiskt till utskick av att SMS-testet konfigureras.

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

Automatiska verksamhetsutskick kräver fortsatt koppling till behörighetskontrollerade verksamhetshändelser, mottagarregler, begränsning av kostnad/utskicksfrekvens samt verifierad hantering av leveransbesked. Inga verksamhets-SMS skickas genom mejltestet eller underlagshjälpen. Den manuella SMS-testknappen använder den separata testadaptern.

## Verifiering

```sh
node scripts/build-domain-models.mjs
node --test server/system-email.test.mjs server/platform-communications.test.mjs server/system-sms.test.mjs server/system-sms-provider.test.mjs server/platform-sms-test.test.mjs
npx playwright test tests/platform-communications.spec.ts --workers=1
npm run build
```

Automatiska prov använder syntetiska leverantörssvar och skickar inga verkliga mejl eller SMS. Ett lyckat lokalt prov bevisar inte att nycklar, kontobehörigheter, saldo eller leverans fungerar i Render. De manuella testknapparna används för de separata driftsatta proven.

Leveranskontroll 20 oktober 2026: produktionsbygget samt **75 skilda backendfall och 15 browserfall passerar** i de relevanta körningarna. Kontrollerna omfattar både mejl och SMS, verkliga plattformssessioner, frekvensgränser, beständiga reservationer, sena kvitton efter granskning och skydd för osäkra SMS-resultat. Inget skarpt utskick görs av de automatiska proven.

## Källor

- [Resend: verifiera domän](https://resend.com/docs/dashboard/domains/introduction)
- [Resend: skicka mejl](https://resend.com/docs/api-reference/emails/send-email)
- [Resend: idempotensnycklar](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [46elks: SMS-API och avsändarformat](https://46elks.com/docs/send-sms)
