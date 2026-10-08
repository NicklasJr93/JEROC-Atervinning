# JEROC kundterminaldemo 0.6.0

Terminalerna använder samma webbdomän och Node-tjänst som kontorsappen. Öppna `/kontor` på kassadatorn och `/terminal` på mobilen, iPaden eller touchskärmen. Ingen native-app eller separat terminalinstallation behövs. En framtida `.se`-domän kan kopplas till samma tjänst; sökvägen förblir `/terminal`.

Det här är en demo med fungerande terminalkonton och gemensamma kundgodkännanden. Kontorets valbara användare och **Jobba som** är fortfarande demoinloggning, inte riktig personalautentisering. Använd testkunder och testuppgifter. BankID, SMS, e-post och Visma är inte anslutna. Utbetalning registreras fortfarande manuellt i kontorsdemon och skickar inga pengar.

## Render: anslut gemensam lagring

Terminaler, sessioner, förval, avräkningsversioner, kundsvar och deras historik behöver finnas kvar mellan publiceringar och serveromstarter. På Render kräver terminaltjänsten PostgreSQL. Den använder inte serverns RAM eller den vanliga, tillfälliga Render-disken som reservlösning. Utan databas visas ett tydligt konfigurationsmeddelande; övriga demovyer fungerar som tidigare.

1. Skapa en PostgreSQL-databas i Render, i samma workspace och region som JEROC:s webbtjänst. Den nuvarande konfigurationen anger Frankfurt; kontrollera även webbtjänstens faktiska region i Render.
2. Välj en tillgänglig plan. Om Render erbjuder en gratis provdatabas, kontrollera slutdatum och villkor innan du använder den. En gratis provplan innebär inte permanent, kostnadsfri lagring. Välj en betald databas om demon behöver leva vidare utan provperiodens begränsningar. Planera för säkerhetskopiering av data ni vill behålla.
3. Kopiera databasens **Internal Database URL**. Öppna JEROC-webbtjänstens **Environment** och skapa `DATABASE_URL` med den interna anslutningssträngen som värde.
4. Spara och publicera om webbtjänsten. Den befintliga byggprocessen och `npm start` används. Schemat i `server/migrations/terminal-demo-001.sql` skapas automatiskt vid terminaltjänstens första databasanslutning.
5. Öppna `/kontor`, välj **Systemadmin** och öppna **Terminaler**. Om meddelandet om `DATABASE_URL` fortfarande visas, kontrollera att variabeln ligger på rätt webbtjänst och att databas och webbtjänst finns i samma region.

Anslutningssträngen innehåller ett lösenord. Spara den endast som servervariabel i Render. Lägg den aldrig i Git, en publik webbläsarvariabel, en skärmbild eller ett testunderlag. Mobilen behöver ingen databasadress och ingen databasbehörighet.

Gratis webbtjänster kan somna efter inaktivitet. Öppna `/kontor` eller `/terminal` och låt tjänsten starta innan testet; detta kan göra det första besöket långsammare. Terminalen visar anslutningsstatus och döljer kundvisningen när anslutningen saknas.

## Lokalt: SQLite eller PostgreSQL

Med befintlig Node.js, version 24 enligt Render-konfigurationen:

```sh
npm ci
npm run build
npm run dev
```

Öppna `http://localhost:5173/kontor` och `http://localhost:5173/terminal`. Vite vidarebefordrar terminal-API:t till Node. `npm start` serverar i stället produktionsbygget och API:t i samma process. `npm run preview` visar bara det statiska bygget och räcker inte för terminaltestet.

Utan `DATABASE_URL` sparas lokala terminaldata i `.data/terminal-demo.sqlite`, med SQLite-journalfiler i samma katalog. Katalogen är Git-ignorerad. Serveromstart återanvänder filen. Variabeln `JEROC_TERMINAL_DB_PATH` kan ange en annan lokal filplats. Säkerhetskopiera även SQLite-journalfiler tillsammans med databasen, eller stoppa tjänsten och använd en SQLite-säkerhetskopia. Radera inte filen om du vill behålla terminalerna och kundgodkännandena.

Om `DATABASE_URL` anges lokalt används PostgreSQL även där. På Render tillåts inte en tyst övergång till SQLite om databasanslutningen saknas eller misslyckas.

## Prova från kassadator och mobil

1. Öppna `https://jeroc-atervinning.onrender.com/kontor` på datorn. Välj **Systemadmin → Terminaler → Skapa terminal**.
2. Ange exempelvis **Kassa 1**, inloggningsnamn **kassa1**, ett eget testlösenord på minst åtta tecken och rätt anläggning. Spara lösenordet separat; appen visar inte ett skapat lösenord i efterhand.
3. Öppna `https://jeroc-atervinning.onrender.com/terminal` i mobilens eller iPadens webbläsare. Logga in med terminalkontot. Skärmen visar **Välkommen till JEROC – invänta personal**.
4. Välj kontoristen på datorn och öppna ett redigerbart invägningskort. Koppla kund och komplettera ursprungsadress, material och betalningsuppgifter. För kundgranskningen krävs inte att ID redan har verifierats.
5. Välj **Visa för kund**, välj den lediga terminalen på kortets anläggning och tryck **Visa på terminal**. Kontoret fryser och sparar den version kunden ska granska. Den visas automatiskt på mobilen; terminalen blir upptagen.
6. På mobilen: granska rader, belopp och säljarens intygande. Kryssa uttryckligen i att avräkningen granskats. Välj **Godkänn med legitimation → Okej**.
7. Terminalen väntar nu på personalen. På datorn: kontrollera testflödet och välj **Bekräfta legitimation & godkännande**. Den extra dialogen bekräftar att personalen gjort kontrollen på plats. Mobilens Okej-knapp är inte ett kundgodkännande i sig.
8. Kontoret visar **Godkänd av kund** och kortet blir tillgängligt för separat intern attest enligt attestbehörighet, beloppsgräns och egenattestregel. Terminalen återgår till välkomstläget utan att lämna kunduppgifter till nästa besökare.

Vid ett skarpt införande ska personalen faktiskt kontrollera legitimationen. Det här testflödet skickar inget BankID-anrop och registreras som personalbekräftad demokontroll, inte BankID-verifierad identitet.

Menyn **Kundgodkännanden** finns mellan **Invägningar** och **Attest**, med **Aktiva** och **Historik**. Den visar gemensamma serverlagrade ärenden för användarens tillåtna anläggningar. Öppna ett kort därifrån för att återgå till dess vanliga detaljvy. Anläggningsväljaren filtrerar arbetsköerna. Terminalväljaren sparar personligt terminalförval per anläggning; ett kort kan bara skickas till en terminal på samma anläggning.

## Fler kontroller

- **Två terminaler:** skapa Kassa 2 med eget inloggningsnamn. Logga in från en annan enhet eller separat webbläsarprofil. Skicka två olika kort och kontrollera att rätt kund visas på rätt terminal.
- **Upptagen terminal:** försök visa ett annat kort på en redan upptagen terminal. Det andra utskicket ska avvisas; det befintliga kortet ska ligga kvar.
- **En aktiv enhet:** försök logga in med samma terminalkonto från en annan webbläsarprofil. Inloggningen ska nekas. Systemadmin kan välja **Avsluta terminalinloggning** innan en ny enhet används. En återöppnad flik med samma sessionscookie räknas inte som ett nytt terminalkonto.
- **Begär ändring:** välj ett fel och skriv en kommentar på mobilen. Kortet ska återgå till komplettering och inte kunna attesteras. Kontoret ändrar kortet och visar en ny avräkningsversion. Den tidigare versionen och dess svar finns kvar i historiken men kan inte godkännas på nytt.
- **Avsluta visning:** kontoristen väljer **Avsluta kundvisning**. Terminalen rensas; avslutet finns kvar i historiken.
- **Omstart:** starta om Node eller publicera om Render utan att byta databas. Terminalkonton, förval, historik och frysta avräkningar ska finnas kvar. Terminalens cookie återanvänds för återanslutning om sessionen fortfarande gäller.
- **Avbrott:** bryt terminalens nätanslutning. Den ska dölja avräkningen och återansluta från aktuellt servertillstånd när nätet är tillbaka. Ett äldre ärende får inte ersätta en ny aktiv kundvisning.
- **Lösenord/avaktivering:** Systemadmin kan byta namn, återställa lösenord och avaktivera terminalen. Lösenordsbyte, avaktivering och sessionsavslut kopplar från den gamla enheten och avslutar dess aktiva kundvisning.
- **BankID:** knappen öppnar ett tydligt demomeddelande. Ingen signering eller identitetsverifiering sker. SMS och e-post är märkta framtida funktioner och skickar inga meddelanden.

En kundvisning har i denna demo 15 minuters giltighet. Terminalen betraktas som online när den nyligen hört av sig. Vid ett längre anslutningsavbrott kan en aktiv kundvisning avslutas; kontoret skickar då en ny version. Terminalsessionen har en begränsad giltighet och kan återkallas av Systemadmin. iPadens Guidad åtkomst eller annat kioskläge ställs in på enheten, inte genom webappen.

## Vad lagras gemensamt?

PostgreSQL/SQLite lagrar terminalkonton med hashade lösenord, hashade sessionstoken, personliga terminalförval, godkännandesessioner, idempotensnycklar och spårbar händelsehistorik. Varje avräkningsversion innehåller en fryst kopia av kortet, kunden, materialraderna, betalningsmetoden, referens/ursprung, villkorsversion, kvittning och belopp samt en SHA-256-hash. Den kopian skrivs inte över när en ny version skickas. Sessionens status får däremot ändras genom testade övergångar; ändringarna får egna historikhändelser.

Terminalen får endast den aktuella kundavräkningens begränsade uppgifter, inte kontorets arbetskö, personnummer eller fullständiga bankuppgifter. Gemensamma databastransaktioner skyddar terminalreservationen och hindrar dubbla aktiva godkännanden. Bekräftat kundgodkännande och den separata interna attesthändelsen sparas server-side för terminalärenden.

Befintliga viktkort och testkunder i `jeroc.office.demo.v1` raderas inte. Ett lokalt kort kopieras till terminaltjänstens gemensamma lager först när det visas för kunden. Kontoret tar sedan emot det gemensamma kortets status, även från en annan dator. Övriga lokala utkast, betalningsjournal, rättelser och transportdemo blir inte automatiskt ett gemensamt produktionsregister genom den här ändringen. Äldre testkort som aldrig skickats till terminalen kan fortsatt provas genom det befintliga attestflödet; terminalgranskade kort måste ha giltigt kundgodkännande före attest.

Prisregler och andra befintliga pris-/transport-API-delar är fortfarande minnesbaserad demo. De nya frysta kundavräkningarna i databasen överlever en serveromstart även om dessa andra exempeldata återställs. Kontorets vanliga dokumentutskrift är fortfarande klientbaserad demo, inte ett arkiverat, servergenererat PDF-original eller en bokförd självfaktura.

Vid manuell demoutbetalning jämförs belopp och kvittning med den kundgodkända versionen. Har det lokala rättelsesaldot ändrats, eller saknar den datorn samma saldojournal, blockeras registreringen så att ett annat belopp inte betalas ut tyst. Full gemensam betalnings- och rättelsejournal behöver byggas före skarp drift.

## Automatiska kontroller

Kör server-, webb-, bygg- och Expo-kontroller enligt [kontorsdokumentationen](office-demo.md). För terminaldelen kan de riktade kontrollerna köras separat:

```sh
node --test server/terminal-demo.test.mjs
npx playwright test tests/terminal.spec.ts --workers=1
```

Använd en separat lokal databas för testdata och håll tester mot gemensam demoprismotor i följd. Terminaltester ska täcka reservation, dubbla anrop, behörigheter/anläggning, nya versioner, ändringsbegäran, manuell ID-kontroll, intern attest, återanslutning och beständig lagring. Kör därefter befintliga mobil-/kontors-/transporttester för regressioner. Ange faktiska testresultat i releasebeskrivningen; en lyckad lokal SQLite-kontroll verifierar inte i sig anslutningen till en ännu okonfigurerad Render-databas.
