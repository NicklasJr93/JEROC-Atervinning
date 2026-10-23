# Leverantörsfakturor, underlagsinkorg och nästa arbetsytor

**Datum: 2026-10-23. Status: leverantörsarbetsyta och lokal underlagsinkorg är kodade och lokalt verifierade. Övriga arbetsytor nedan är förslag.**

Analysen utgår från de två skickade Fortnox-bilderna, utgångsläget vid commit `7b4b6cb` och den nya leverantörskoden. Bilderna är referens för arbetsflöden och informationsmängd, inte en granskning av alla funktioner i Fortnox. Den första bilden visar en registrerad leverantörsfaktura med kopplat dokument. Den andra visar registrering med ett valt inkommet dokument; dokumentet i exemplet är en påminnelse, vilket också visar varför ett uppladdat dokument inte automatiskt bör behandlas som en ny faktura.

## Utgångsläget före denna etapp

Inköpsdelen visade en lista och en begränsad detaljpanel. Ett nytt inköp registrerades i en dialog. Modellen hanterade leverantörsnamn, fakturanummer, datum, förfallodag, ett nettobelopp, en momssats, en momstyp, ett kostnadskonto och en valfri projektkoppling. Bokföring, delbetalning, matchning mot en befintlig demobankhändelse och helkreditering av en helt obetald faktura fanns redan.

Det fanns ingen dokumentinkorg, filuppladdning, kamerainmatning eller kopplade originaldokument. Den nya etappen omfattar därför dokumentets väg genom den lokala demon. Leverantörsregister, automatisk tolkning och verklig attest återstår.

## Leverantörsarbetsytan i denna etapp

| Del | Kodat beteende och avgränsning |
| --- | --- |
| Lista och egna adresser | Separata sidor för lista, nytt utkast, redigerbart utkast, bokförd faktura och inkorg. Adresserna börjar med `#purchases`; inkorgen ligger på `#purchases/inbox`. |
| Arbetsyta på dator | Fakturauppgifter och konteringsförslag på ena sidan, dokumentvisare på den andra. |
| Arbetsyta på mobil | Uppgifter och underlag staplas på samma sida. Kamera och bildbibliotek använder filval; kamerastödet beror på enhet och webbläsare. |
| Fakturauppgifter | Leverantör, fakturanummer, datum, belopp, moms, OCR/betalningsreferens, bankgiro, plusgiro, IBAN, referenser, projekt, kontaktuppgifter och anteckning. Bankuppgifter är sparade fält, inte verifierade betalningsinstruktioner. SEK och svenska leverantörsadresser stöds. |
| Kontering | Fortsatt en kostnadsrad per faktura med samma stödda konton och momstyper. Summeringen visar den kontering som bokföringsmodellen skapar. Flera kostnadsrader, blandade momssatser och radvisa dimensioner återstår. |
| Underlag | Flera PDF-/bildfiler kan kopplas till en faktura. Bilder kan zoomas/roteras i visningen. PDF använder webbläsarens visare. Originalet kan laddas ned och ändras inte av visningsåtgärderna. Dokumenttypen bedöms manuellt. |
| Utkast och bokförd faktura | Utkast kan ändras. Bokförda uppgifter och ursprungliga bilagemetadata fryses. Fler underlag kan läggas till som dokumenterade kompletteringar utan ny skuld, ny verifikation eller ändring av ursprunglig snapshot. |
| Historik | Fakturasidan visar verifikationslänk, betalningar och händelser. Verklig attest med identifierade användare och behörigheter återstår. |
| Lämna sidan | Osparade ändringar fångas upp vid navigering. Sparande och bokföring kontrollerar de kopplade originalfilerna. Fel rapporteras innan någon lyckad sparning visas. |

Små dialoger kan fortsatt användas för en kort bekräftelse eller ett par betalningsfält. Att registrera, kontera och granska en faktura är ett sammanhängande arbete som ska ha en egen sida.

## Underlagets väg: fil och kamera nu, e-post senare

1. **Ta emot ett dokument.** Filväljare och drag och släpp för PDF, JPEG, PNG och WebP. På mobil finns kameraval där webbläsaren stöder det. Filändelse, deklarerad typ, filsignatur, storlek och antal kontrolleras. Gränserna är 15 MB per fil, 10 filer per import, 100 MB totalt och 20 underlag per faktura.
2. **Lägg det i inkorgen.** Behåll originalfilen och visa filnamn, mottagningstid, källa och om dokumentet ännu är okopplat. Skapa inte en bokföringspost bara för att en fil har kommit in.
3. **Granska dokumenttypen.** Är det en faktura, kreditnota, påminnelse eller bilaga? Koppla till en befintlig faktura när det är rätt. Samma filinnehåll återanvänder befintligt underlag via SHA-256 och skapar ingen andra fil. Foto och PDF av samma faktura har olika filinnehåll, så även leverantör/fakturanummer och belopp behöver granskas.
4. **Skapa eller komplettera en faktura.** Öppna dokumentet bredvid utkastet och fyll uppgifterna manuellt. En påminnelse kan kopplas till en befintlig faktura, även efter bokföring, utan att bli en ny skuld.
5. **Tolka som förslag när en tolkningstjänst finns.** OCR/AI kan föreslå leverantör, nummer, datum, belopp, moms, referens och kontering. Visa vad som kommer från tolkningen och vad användaren har bekräftat. Osäker eller ofullständig tolkning ska lämna fakturan för granskning.
6. **Granska och bokför.** Kontrollera fakturans belopp, momshantering, kontering och dubbletter innan bokföring. Bokföring och betalning är skilda åtgärder.
7. **Följ fakturan.** På fakturasidan finns underlag, historik och länk till verifikationen. Betalning, kredit och kompletterande dokument kan följas där. Direkt öppning av samma underlag från verifikationssidan är en föreslagen nästa etapp.

### Lagring, bortkoppling och reset

Filerna sparas i IndexedDB-databasen `scrapplanner-bokforing-documents-v1`. Bokföringen sparar metadata och länkar till filerna, inte filernas byteinnehåll. Ett original kontrolleras mot sina metadata och sin kontrollsumma inför sparande och bokföring. Saknat eller förändrat original stoppar den åtgärden.

Ett utkast kan få underlag bortkopplade. Kopplade filer kan inte raderas via inkorgen; okopplade filer kan tas bort med bekräftelse. **Återställ demo återställer bokföringens kopplingar men behåller uppladdade filer i inkorgen.** De kan sedan kopplas på nytt eller tas bort när de är okopplade. Detta är en lokal provmiljö: browserdata kan rensas och lagringen är varken ett delat serverarkiv eller en garanti för långsiktigt bevarande.

### Lokal demo och riktig tjänst är olika leveranser

| Kan provas som lokal demo | Kräver en riktig tjänst |
| --- | --- |
| Välja egna filer eller kamerabilder, visa dem, lägga dem i en lokal inkorg och koppla dem till fakturautkast. | Gemensam serverlagring som fungerar mellan användare och enheter. |
| Spara dokument i webbläsarens databas med filmetadata och koppling till fakturan. Visa när ett original inte längre finns tillgängligt. | Dokumentarkiv med behörigheter, säkerhetskopiering, återläsning och hantering av lagringstid. Lokal browserlagring är inte detta arkiv. |
| Manuell registrering bredvid underlaget och lokala kontroller mot dubbletter. | Faktisk OCR-/AI-tjänst med resultat, felhantering och granskningsflöde. Ett exempelvärde eller förifyllt formulär är inte dokumenttolkning. |
| Demonstrera vilka källor inkorgen ska kunna ha. | Verklig e-postmottagning med adress per företag, mottagningstjänst, behandling av bilagor, företagskoppling, säker filhantering, leveransfel och skydd mot att samma meddelande skapar flera poster. |
| Visa användarens aktiva granskningssteg. | Fleranvändarattest med namngivna roller, beloppsgränser, ersättare, återremiss och låsta beslut. |

En framtida e-postadress ska vara en faktisk mottagningsadress. En adress som bara visas i gränssnittet ska inte ge intryck av att e-post redan tas emot. E-post och filuppladdning ska mynna ut i samma inkorg och samma fakturaflöde, så vi slipper separata vägar med olika bokföringskontroller.

## Andra delar som behöver mer arbetsdjup

Prioriteringen nedan gäller efter leverantörsarbetsytan. Den bygger på vad som faktiskt finns i demon, inte på en ambition att göra varje vy stor.

| Prioritet | Område och nuläge | Förslag som gör verklig skillnad |
| --- | --- | --- |
| 1 | **Verifikationer.** Lista och detaljpanel finns. Ny manuell verifikation är en dialog med konton och belopp; det finns ingen gemensam dokumentkoppling. | Egen verifikationssida med konteringsrader, differens, underlag, ursprung och länkad rättelse. Öppna samma faktura/underlag från huvudboken. Sök och filtrera på konto, period, källa och projekt. |
| 2 | **Projekt och offerter.** Projektlista, enkel tid/materialregistrering, offert och överföring till fakturautkast finns. Projekt, tid och offert skapas i dialoger. | Egen projektsida med kund, tid/material, dokument, offerter och fakturor. En riktig offerteditor med versioner, giltighet, villkor, tydligt kundgodkännande och vad som redan har fakturerats. Koppla projektkostnader och senare lageruttag till samma projekt. |
| 3 | **Lön.** Lönekörning och enkla lönebesked finns. Skatt anges som demovärde. Skapa-dialogen lägger samma frånvaro-/semester-/förmåns-/utläggsbelopp på varje vald anställd. | Egen lönekörningssida och individuellt lönebesked där löneslag, timmar, frånvaro och utlägg granskas per person. Därefter egna regler och tester för skatteberäkning, semester och rättelser. En större sida ensam ger inte en färdig lönemotor. |
| 4 | **Bankavstämning.** Demohändelser kan matchas mot befintliga verifikationer; datum, belopp och dubbelmatchning kontrolleras. Verklig bankimport saknas. | Dedikerad avstämningsyta med bankhändelse, matchningsförslag, faktura/underlag och kvarvarande differens. Visa ingående/utgående saldo. Nästa modellsteg är fördelning av en betalning på flera fakturor samt avgifter, följt av filimport och senare bankanslutning. |
| 5 | **Rapporter och bokslut.** Resultat, balans, saldobalans, avstämningschecklista, periodlås och gransknings-JSON finns. Rapporterna är främst summeringar. | Klick från rapportsiffra till konto, verifikation och originalunderlag. Lägg till period- och jämförelseval samt bokslutsbilagor med ansvarig, status, kommentar och kvarstående differens. Separera granskning från beslutet att låsa perioden. |
| 6 | **Inventarier och periodisering.** Värden och månatliga bokningar finns men registrering sker i små formulär. | Egen objektsida/plan med anskaffningsfaktura, bedömningar, komplett avskrivnings- eller periodiseringsschema och verifikationslänkar. Starta från leverantörsfakturan för att slippa dubbel registrering. |
| 7 | **Kund- och leverantörsregister.** Kundregistret är enkelt och leverantören är ett namn på fakturan. | Egna registerkort med kontakt- och betalningsuppgifter, standardvillkor, dokument och alla relaterade fakturor. Ändringar i registret ska inte skriva om redan bokförda dokumentuppgifter. |

För ett hantverksbolag ger **leverantörsunderlag → verifikation → projektkostnad → betalning → rapport** en mer sammanhängande första utbyggnad än att börja med fler fristående inställningsrutor. Lön bör samtidigt behandlas som ett eget område med särskilda beräkningar och rättelsefall.

## Gemensamt mönster för de större sidorna

- Egen adress, tydlig rubrik, status och väg tillbaka till listan.
- Samma uppgifter används i arbetsyta, summering, verifikation och rapport.
- Underlag och kopplingar visas där arbetet sker.
- Utkast, bokförd post, betalning och rättelse har olika åtgärder och tydliga tillstånd.
- Historik visar vad som har hänt; långsiktigt behöver den bygga på identifierade användare.
- På mobil ska tabeller och dokument fungera utan att viktiga åtgärder hamnar utanför skärmen.

## Provfall före leverans av leverantörsytan

Prova ny och befintlig faktura via egna adresser, bakåt/framåt, omladdning och avbruten navigering med osparade ändringar. Prova PDF, bild, flera bilagor, kamera-/bildval på mobil, dubbla filer, olämplig filtyp, för stor fil och misslyckat sparande. Kontrollera att koppling/urkoppling av ett underlag inte bokför eller betalar något, att bokförda belopp inte ändras när fler underlag kopplas och att gamla demofakturor fortfarande går att läsa. Bekräfta separat vad som händer med både fakturadata och filer vid **Återställ demo**.

Underlagen i de skickade bilderna används inte som demodata. Nya exempel bör använda fiktiva bolag och dokument.

Slutkontrollen omfattade produktionsbygge, 211 modell-/lagringstester, ett HTTP-integrationstest och 49 browserfall mot den byggda servern. Alla passerade. Kameraflödet har provats som filval med kameraattribut, inte med fysisk telefonkamera. [Nya skärmbilder och ett fiktivt underlag för egen provning](README.md#leverantörsfakturor-och-inkomna-underlag) finns i översikten.
