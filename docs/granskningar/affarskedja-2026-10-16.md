# Test av affärskedjan: invägning → utleverans → avräkning

Granskad kod: `9d847cf`, 2026-10-16. Syftet är att identifiera verksamhetsluckor utifrån ett konkret materialflöde. Inga produktionsfunktioner har ändrats i denna granskning.

## Provkörning

En egen tillfällig SQLite-databas och en lokal HTTP-server körde de riktiga applikations-/logistikkommandona med fiktiva uppgifter. Inga externa bank-, Spiris- eller myndighetsanrop gjordes. Ekonomisk attest och inköpsbetalning ingick inte i denna nya provkörning; fysisk mottagning och ekonomisk status hålls isär.

| Steg | Observerat resultat |
| --- | --- |
| Skapa inkommande arbetsorder och färdigställ faktisk invägning på 1 000 kg koppar | Ett permanent viktkort och 1 000 kg fysiskt lager. |
| Upprepa färdigställningen | Samma kort återlämnas. Inga dubbla kort eller extra mängder. |
| Skapa utleverans med 800 kg | 1 000 kg på gården, 800 kg reserverat, 200 kg disponibelt. |
| Begär ytterligare utleverans på 300 kg | Nekas med HTTP 422 eftersom endast 200 kg är disponibelt. |
| Registrera verklig last på 800 kg och försök avgå utan kontorets klartecken | Nekas med HTTP 422. |
| Ge aktuellt klartecken och bekräfta avfärd | Lagret minskar till 200 kg och reservationen släpps. |
| Upprepa avfärden | Fortfarande ett lageravdrag för order/material. |
| Bekräfta leverans | Arbetsordern blir `done`/`delivered`; kvarvarande lager är 200 kg. |

Ett separat anrop med en föreslagen avräkningsåtgärd medan ordern fortfarande var redigerbar avvisades som okänd åtgärd utan att ändra data. Att ett påhittat kommando saknas bevisar inte att alla alternativ saknas; slutsatserna nedan bygger även på granskning av befintliga scheman, kommandohanterare, integrationsflöden och vyer.

## Verifierat fel: artikelinaktivering kan minska lagret

**Prioritet 1 – rätta före vidare lagerutbyggnad.**

Två separata fiktiva reproduktioner använde den riktiga `createPricingStore.saveArticle` med `active:false`, följt av `synchronizeLogisticsIncomingStock`:

| Före | Åtgärd | Efter |
| --- | --- | --- |
| Invägt 100 kg koppar; lager +100 kg | Inaktivera artikeln. Ingen ändring av viktkortet. | Lagersynken skapar −100 kg och saldot blir 0 kg. Viktkortet har fortfarande 100 kg. |

Orsak: [articlesOf](../../server/logistics.mjs#L73) filtrerar bort inaktiva artiklar. [Inkommande projektion](../../server/logistics.mjs#L95) hittar då inte den historiska materialraden, och [borttagningshanteringen](../../server/logistics.mjs#L116) tolkar tidigare inleverans som borttagen.

Rättningen bör skilja aktivt artikelval för nya uppdrag från historisk artikelidentitet och fysiskt lager. Inaktivering får inte skapa en fysisk lagerförändring. Regressioner bör även omfatta återaktivering, befintliga reservationer och historiska invägningar. Felet är identifierat och reproducerat, men inte rättat i denna testuppgift.

## Det som redan finns

- Fysiskt lager, reservationer och disponibel mängd per artikel och anläggning.
- Käll-ID för inleverans och arbetsorderreferens för utleverans.
- Motiverad inventeringsrättelse med behörighet, historik och återförsöksskydd. Rättelsen får inte underskrida reserverad mängd. Farligt material följer separat miljöledger.
- Utleverans med faktiskt lastad vikt, klartecken, fordons-/förarkontroll och ett lageravdrag vid lastad avfärd.
- Transportdokument med versionsarkiv. Transportens slutförande och dokumentets testunderskrifter är skilda från köparens ekonomiska avräkning.
- Inköpsunderlag, inköpsrättelser och Spiris-/utbetalningsflöde för betalningen till den som sålde skrot till oss.

## De verkliga funktionsluckorna

1. **Mottagarens avräkning mot utleveransen.** Strukturerat underlag med deras referens, mottagen vikt, materialklassning, priser, avdrag och ursprungsdokument. Matchning ska hitta differenser mot vår utleverans och hantera del-/samlingsavräkningar. Vi behöver ta emot köparens underlag, inte automatiskt skapa en egen försäljningsfaktura i detta flöde.
2. **Ekonomiskt avslut och inkommande betalning.** `deliver()` markerar transporten som klar men registrerar ingen kundfordran eller betalning från köparen. Befintliga Spiris-/bankbetalningsflöden gäller inköpssidan och ersätter inte detta.
3. **Kostnad genom lagret och faktisk marginal.** Lagerrörelserna sparar kg men ingen fördelning av inköpsvärde mellan sålt material och restlager. Förbrukade inköpskällor/kostlager, frakt och övriga direkt hänförliga kostnader behöver kopplas till försäljningen. Före genomförandet måste värderingsprincipen fastställas; ett genomsnitt eller FIFO får inte smygas in som ett oklart standardval.
4. **Sortering/bearbetning med massbalans.** Det går att göra separata inventeringsrättelser, men de är inte ett sammanhållet sorteringsjobb. En sådan händelse behöver atomiskt binda ingående material till nya fraktioner, verkligt svinn och kostnadsfördelning. Annars kan ett avbrott mellan flera rättelser lämna halvfärdig lagerbild.
5. **Köparreklamation och differensärende.** Dokumentera vikt-/kvalitetsavdrag, förväntat kontra accepterat belopp, underlag och beslut mot utleverans/avräkning. Befintlig inköpsrättelse eller fri lagerjustering är inte samma process.

Bevis: [material-/orderschema](../../server/logistics.mjs#L33), [lagersummering](../../server/logistics.mjs#L176), [avfärd och lagerrörelse](../../server/logistics.mjs#L319), [leveransslut](../../server/logistics.mjs#L329), [inventeringskommando](../../server/logistics.mjs#L490), [lagertyper](../../src/office/logistics/types.ts#L32). Fordonsservice har ett kostnadsfält, men ingen automatisk fraktfördelning till en utleverans.

## Varför luckorna spelar roll – en exempelkalkyl

Följande priser och kostnader är antaganden för att illustrera den saknade ekonomiska kedjan, inte resultat som appen beräknade:

- Inköp: 1 000 kg à 60 kr/kg. Den lastade mängdens antagna varukostnad är 800 × 60 = **48 000 kr**.
- Mottagaren väger 790 kg och ersätter 65 kr/kg: **51 350 kr**. Differens mot vår last: **−10 kg**.
- Antagen frakt: **1 500 kr**.
- Täckning före övriga kostnader: 51 350 − 48 000 − 1 500 = **1 850 kr**.

Mängdkedjan kan följas i nuvarande system. Att säkert räkna ut denna täckning automatiskt kräver avräkning och kostnadsallokering, särskilt när material från flera inköp blandas eller sorteras.

## Testresultat och rekommenderad ordning

- `logistics`, `work-order-weighing` och `accounting-price-rounding`: **29 godkända, 1 PostgreSQL-beroende överhoppat**.
- Kompletterande `logistics`, `logistics-documents` och `visma-accounting`: **37 godkända, 1 PostgreSQL-beroende överhoppat**. Testurvalen överlappar och ska inte summeras som unika tester.
- Isolerat HTTP-scenario ovan: godkänt, inklusive dubbletter, överreservation och uteblivet klartecken.
- Artikelinaktiveringsfelet: reproducerat separat. De befintliga gröna testerna täcker inte det fallet.

Rekommenderad ordning: rätta lagerfelet → välj kostnads-/spårningsprincip → bygg mottagaravräkning och differensgranskning → koppla inkommande betalning och marginal. Om sortering är ett vanligt verkligt flöde ska dess massbalans och kostnadsfördelning ingå innan marginaler presenteras som tillförlitliga.

Detta är en kod- och lokal scenariogranskning. Den verifierar inte verklig våghårdvara, produktionsdatabas, OCR på riktiga avräkningar, extern bokföring eller mottagna bankbetalningar.
