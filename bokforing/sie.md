# SIE 4: import och export

Arbetsytan **SIE · flytta din bokföring** importerar riktiga huvudboksverifikationer och hämtar en standardfil för ett valt, registrerat räkenskapsår. Funktionen använder samma transaktion, periodlåsning, nummerserie, sparande och återläsningskontroller som den övriga bokföringen.

## Format och oberoende kontroll

Implementationen utgår från [SIE-gruppens filformat 4C, daterat 2025-08-06](https://sie.se/wp-content/uploads/2026/02/SIE_filformat_ver_4C_2025-08-06.pdf). Exporten använder `#SIETYP 4`, `#FORMAT PC8`, **IBM CP437** och CR/LF. Den innehåller företagsnamn, organisationsnummer om det har numeriskt format, räkenskapsår, berörda konton, IB, UB, resultatkontons saldon och verifikationernas debet/kredit. Ingående balans ingår inte dessutom som en vanlig verifikation.

En fil från den fiktiva demobokföringen testades den 23 oktober 2026 i [SIE-gruppens publika testtjänst](https://sietest.sie.se/), jobb 43003. Tjänsten rapporterade:

- Inga fel och inga radfel.
- Rätt CP437-kodning och enhetliga CR/LF-radbrytningar.
- Korrekt syntax, samtliga obligatoriska poster och balanserade verifikationer.
- Upplysningen att jämförelseår `#RAR -1` saknas. Exporten omfattar det år användaren väljer.

Det är kontroll av den testade filen, **inte certifiering eller medlemskap i SIE-gruppen**. Testerna i `server/bokforing-sie.test.mjs` kontrollerar även oberoende handskrivna indata, öresbelopp, negativa scenarier och återläsning av importens original.

## Så gör användaren

1. Kontrollera företagets organisationsnummer och aktiva räkenskapsår. En fil från ett annat företag eller år stoppas. För att prova en fullständig inflyttning kan du välja **Nytt tomt övningsbolag** under Företaget. Det ersätter den lokala demoboken efter uttrycklig bekräftelse; exportera det du vill behålla först.
2. Öppna SIE, välj fil och teckenkodning. PC8 är standard. UTF-8 kräver ett uttryckligt val; det är en importanpassning, inte standardexporten.
3. Koppla vid behov okända konton till befintliga konton med kontomappningen, exempelvis `{"3010":"3000"}`. Bedöm redovisningsbetydelsen innan mappningen godkänns.
4. Klicka **Granska import**. Kontrollera företag, år, nya verifikationer, kända dubbletter, ingående balans och varningar.
5. Bekräfta granskningen och importera. Ingen bokföring ändras av filvalet eller förhandsgranskningen.
6. Hämta vid behov en kvittensfil med `#FLAGGA 1`. Den valda källfilen raderas eller skrivs aldrig över.

## Vad som kontrolleras

Importen kontrollerar syntax, datum, kontoformat, öresbelopp, maxbelopp, balans i varje verifikation, balanserad IB samt deklarerade UB/RES mot IB och transaktionerna. Samtliga nya bokningar kontrolleras mot periodlås innan den gemensamma transaktionen börjar. Ett fel ger ingen halv import.

IB läggs endast till när motsvarande ingående balans saknas. Om IB redan finns måste den stämma exakt. IB kan inte mappas till resultatkonton. Verifikationernas ursprungliga rader bevaras även när flera har samma konto eller tar ut varandra.

Originaltext, SHA-256, kontomappning, importtidpunkt, utförare och kopplingen till journalen sparas i importhistoriken. Samma fil stoppas. Samma källserie och nummer för samma bolag/år i en ny export hoppas över när innehållet är oförändrat; ändrat innehåll stoppas och behöver en spårbar rättelse. Källans serie och nummer visas i beskrivningen, medan programmets ordinarie serie numrerar journalposten. Återläsning verifierar journalen mot det sparade originalet och upptäcker borttagna eller ändrade importkopplingar.

Saknas serie eller nummer används fil och radordning för identifiering. Det kräver en extra bekräftelse eftersom samma affär kan förekomma i en annan fil. En fil utan organisationsnummer ger också en tydlig kontrolluppmaning.

## Vad filen inte flyttar

SIE är huvudbok. Importen skapar därför inte påhittade kund- eller leverantörsfakturor, betalningsuppdrag, inventariekort, lönespecifikationer, ROT-ansökningar, projektregister eller bilagor. Ett importerat saldo på exempelvis 1510 eller 2440 framgår i huvudboken men behöver kompletterande reskontraposter för individuell uppföljning och betalning.

Import av redan resultatbokförda år stoppas när verifikationerna innehåller konto **8999**. Rapportmotorn behöver särskild normalisering innan sådana färdigbokslut kan importeras säkert. Välj en export före resultatbokningen eller för över nästa års ingående balans. Balanserad IB på **2098/2099** fungerar; den räknas som ingående balans och inte som årets intäkt eller kostnad. Kontomappning får inte användas för att kringgå spärren.

Den befintliga kontoplanen används. Konton utanför den kräver uttrycklig mappning; andra konton läggs inte automatiskt till. Objektdimensioner och transaktionsdatum som avviker från verifikationens datum stoppas, liksom filer med `KSUMMA` som denna version inte verifierar. BTRANS/RTRANS bevaras i originalet och ignoreras enligt specifikationens regler för program som arbetar med aktiva TRANS-rader. Budget, periodsaldo, kvantiteter och jämförelseår behålls i originalfilen men överförs inte som separata register.

Import som ändrar 1460 stoppas efter att en lagerregistervärdering har bokförts. Den behöver först stämmas av mot lagrets specifikation. Importerad huvudbok ska alltid stämmas av innan vidare arbete i underregistren.

Demons webbläsarlagring innebär att historik och kontroller inte är ett manipulationssäkert serverarkiv. Produktionslagring, behörigheter och långsiktig arkivering är separata återstående arbeten.

## Tekniska ingångar

- `sie.js`: PC8-kodning, parser, granskning, transaktion, återläsningskontroll och export.
- `sie-workspace.js`: formulär, filval, förhandsgranskning, importhistorik och binära nedladdningar.
- `validateSieImports(state)` ger `claimedEntryIds` och importerade nettobelopp per konto till den gemensamma valideringen. Vanliga native-IB-poster räknas inte en andra gång i dessa nettobelopp.
- Hela originalet bevaras lokalt. Max filstorlek är 2 MB, 5 000 verifikationer per fil och 1 000 rader per verifikation.
