# Individuell semester och rättelse av utbetald lön

Implementerat i `public/bokforing/suite/payroll-engine.js` och lönearbetsytan. Detta dokument beskriver faktiskt stöd, beräkningsunderlag och gränser. Ett valt löneunderlag ersätter inte kontroll av anställningsavtal, kollektivavtal eller individuella skattebeslut.

## Semesterkonto per anställd

Arbetsytan kan fastställa ett avslutat intjänandeår, visa ett individuellt saldo och koppla uttag till riktiga lönekörningar.

1. Granska personens semesterregel, frånvarovärde, skattetabell och anställningsvillkor.
2. Ange intjänandeperiod, anställningsperiod, icke semesterlönegrundande kalenderdagar, årlig semesterrätt och underlagsreferens. Frånvaro måste redan vara bedömd; programmet gissar inte vilka sjuk- eller föräldraledighetsdagar som är semesterlönegrundande.
3. Fastställ semesterkontot. Underlaget och beräkningen får en fryst ögonblicksbild; samma person kan inte få två konton för samma uttagsår.
4. Välj kontot och antal betalda dagar på löneraden. Ett utkast reserverar dagar. Att ta bort ett obokfört utkast eller återföra en obetald lönekörning frigör dem. En senare körning som använder samma saldo måste återföras först.

Intjänade dagar beräknas enligt det uttryckliga underlaget:

`avrunda uppåt((anställningsdagar inom intjänandeåret − icke grundande dagar) × årlig semesterrätt / intjänandeårets kalenderdagar)`.

Intjänandeåret ska omfatta 365 eller 366 dagar. Uttagsperioden är följande år. Registreringsdatum kan inte ligga före intjänandeårets slut och måste vara i en öppen bokföringsperiod.

### Två stödda beräkningssätt

| Regel | Beräkning och kontroll |
| --- | --- |
| Sammalöneregeln för den granskade månadslönen | Ordinarie månadslön finns kvar. Semestertillägget beräknas från månadslön, granskad procentsats och uttagna dagar. Standardvärdet är 0,43 procent per dag. |
| Procentregeln | Granskat semesterlöneunderlag multipliceras med uttryckligt vald procentsats. Kontots minimum är 12 procent vid 25 dagars semesterrätt och ökar 0,48 procentenheter per ytterligare dag. Beloppet fördelas över kontots dagar med deterministisk öresavrundning. Sista uttaget tar återstående ören. |

Vid uttag enligt procentregeln måste de schemalagda semestertimmarna anges. De dras av från ordinarie lön så att samma timmar inte får både arbetslön och semesterlön. Kontot kan inte övertrasseras i dagar eller pengar.

Granskade ingående sparade dagar kan anges med ett gemensamt dokumenterat ursprungsår inom fem år. Procentregeln kräver också granskat ingående semesterbelopp. Detta är import av ett redan granskat saldo, inte en automatisk prövning av rätten att spara dagar eller en automatisk årsförflyttning av gamla saldon. Skilda årgångar, förfall, uttagsordning och kollektivavtalsregler måste hanteras separat.

### Slutlig semesterersättning

Löneraden kan väljas som slutlig semesterersättning utan ordinarie månadslön. Den kräver konto, antal dagar, uttrycklig granskning och granskat årsinkomstunderlag för engångsskatt. För sammalöneregeln krävs ett granskat ersättningsbelopp per dag; programmet antar inte en kollektivavtalsspecifik slutlöneformel. Procentregeln använder kontots återstående proportionella belopp. Högst 31 dagar kan registreras på en lönerad; fler dagar fördelas över flera körningar.

Semesterkontot ger ett operativt saldo. Det bokför inte automatiskt en semesterlöneskuld eller en bokslutsavsättning med sociala avgifter. Intjänande under pågående år, förändrad sysselsättningsgrad, rörliga lönedelar, obetalda/förskottsdagar, kollektivavtalsväxling och samtliga specialfall i semesterlagen omfattas inte av den automatiska beräkningen. Personer behöver en aktiv löneprofil i det nuvarande löneflödet.

## Bruttolöneåterkrav efter utbetalning

En utbetald lönekörning kan inte raderas eller återföras genom det obetalda rättelseflödet. I stället kan en granskad felaktig kontantlön eller semesterersättning bli ett separat bruttolöneåterkrav.

- Originalets lönebesked, utbetalning och verifikation bevaras.
- Kravet har länk till originalkörning och originalverifikation, person, felaktigt löneslag, ursprunglig månad, egen bokföringsdag, orsak och unik referens.
- Periodisk lön och engångslön hålls isär. Återkravet kan inte överstiga originalets kvarvarande belopp för löneslaget.
- Annan lön i samma månad måste vara färdigbehandlad. Kravet kan inte bakdateras före de utbetalningar som ligger till grund för beräkningen.
- Ett ytterligare krav räknar av tidigare krav. Arbetsgivaravgiftsminskningen räknas om från kvarvarande månadsunderlag, inklusive den stödda ungdomsgränsen.

### Verifikationer

| Händelse | Debet | Kredit |
| --- | --- | --- |
| Fastställt bruttokrav | 1680 Övriga kortfristiga fordringar | 7010 Lön eller 7082 Semesterlön |
| Minskad arbetsgivaravgift | 2731 Avräkning sociala avgifter | 7510 Arbetsgivaravgifter |
| Faktisk inbetalning från anställd | 1930 Bank | 1680 Fordran |
| Faktisk kreditering på skattekontot efter tidigare skattereglering | 1630 Skattekonto | 2731 Avräkning sociala avgifter |

Återbetalning kan göras i flera delar. Varje del måste ha egen referens och får högst motsvara återstående fordran. Verifikation och avstämd bankhändelse skapas tillsammans och valideras mot varandra. Ingenting skickas till banken.

Om arbetsgivaravgiften ännu inte reglerats minskar återkravet den senare betalningen mot skattekontot. Om den redan reglerats visas en separat avgiftsfordran tills en faktisk skattekontokreditering registreras. En återbetalning från den anställde registrerar aldrig automatiskt en kreditering från Skatteverket.

## Rättat AGI-underlag

`getPayrollDeclarationPeople(state, month)` läser endast faktiskt utbetalda lönekörningar och tidigare faktiskt utbetalda körningar i det äldre registret. Obetalda och återförda körningar tas inte med. Återkrav minskar kontant bruttolön och arbetsgivaravgift i **ursprunglig utbetalningsmånad**. Avdragen skatt ligger kvar. Källkörningar, äldre körningar och återkravs-ID:n följer med.

Äldre lönekörningar deklareras enligt faktiskt registrerat utbetalningsdatum, även när löneperioden var en tidigare månad. Ett sådant manuellt underlag får inte blandas med den moderna motorns lön för samma person i den ursprungliga eller faktiska betalningsmånaden. Spärren gäller både när modern lön skapas och när en äldre betalning försöker flyttas, samt vid återläsning. Användaren hänvisas till granskning och korrigering i den moderna lönemotorn; historiska manuella belopp ändras inte automatiskt.

Att fastställa ett krav kräver en särskild bekräftelse att just detta är ett bruttolöneåterkrav som ska rättas i den ursprungliga AGI-perioden utan minskat skatteavdrag. Flödet avgör inte själv när ett arbetsrättsligt krav är giltigt eller exakt när en AGI-rättelse ska lämnas i varje särskilt fall. Detta behöver kontrolleras mot Skatteverkets aktuella regler och det faktiska återkravsunderlaget. Vid implementeringen kunde Skatteverkets fullständiga rättelsesida inte hämtas; den granskningspunkten ska därför inte betraktas som rättsligt verifierad av denna implementation.

Förmånsrättelser, nettokvittning mot senare lön, återkrav över flera beskattningsår, tvistiga/efterskänkta fordringar och omfördelning av ungdomsavgift mellan körningar när avgiftsminskningen skulle överstiga originalkörningens avgift stoppas eller kräver ett separat flöde. Skatte- och avgiftsmotorn använder uttryckligen 2026 års regler.

## Integrationskontrakt

- `createVacationYear(state, input)` skapar `payrollVacationYears`.
- `getVacationBalance(state, vacationYearId)` returnerar bland annat `usedDays`, `remainingDays`, `usedMoneyCents` och `remainingMoneyCents`. För sammalöneregeln är kvarvarande pengar `null`; månadslönen vid uttaget avgör tillägget.
- `createPayrollBatch` accepterar `vacationYearId`, `vacationHoursHundredths` och, för `kind: 'vacation-final'`, `finalDailyCents` och `finalCompensationReviewed`.
- `createPayrollRecovery`, `receivePayrollRecovery` och `receivePayrollRecoveryTaxCredit` skapar `payrollRecoveries` och kopplade bokförings- och bankhändelser.
- `getPayrollDeclarationPeople(state, month)` returnerar `{ employeeId, grossCents, benefitCents, withholdingCents, employerCents, sourceBatchIds, sourceLegacyRunIds, recoveryIds }[]`.
- `validatePayrollBatches` lämnar som tidigare `{ entryIds, accountBalances }` till systemets huvudvalidering, inklusive samtliga nya återkravsverifikationer.

Mutationsfunktionerna är transaktionella: underlaget valideras före och efter ändringen. Fel lämnar inkommande state oförändrat. Pengar beräknas i heltalsören med BigInt för multiplikation/avrundning. Bokförda ögonblicksbilder och historiska beräkningsunderlag används även efter att aktuell löneprofil ändrats.

## Verifiering och källor

`server/bokforing-payroll-completion.test.mjs` täcker bland annat dagintjäning, öresfördelning, slutlig ersättning, överuttag, överkrav, delbetalning, saknad bankhändelse, separat skattekreditering, oförändrad innehållen skatt, senare lönekörnings underlag och bevarad historik. `tests/bokforing-payroll-completion.spec.ts` provar arbetsytans semester- och återkravsflöden.

- [Semesterlag (1977:480), särskilt 7 och 16–22 §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/semesterlag-1977480_sfs-1977-480/)
- [Skatteverket: rätta en arbetsgivardeklaration](https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/rattaenarbetsgivardeklaration.4.2cf1b5cd163796a5c8b6698.html)
- [Skatteverket: engångsbelopp](https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/skatteavdrag/engangsbelopp.4.361dc8c15312eff6fd3225e.html)
- [Skatteverket: arbetsgivaravgifter](https://www.skatteverket.se/foretag/arbetsgivare/arbetsgivaravgifterochskatteavdrag/arbetsgivaravgifter.4.233f91f71260075abe8800020817.html)
