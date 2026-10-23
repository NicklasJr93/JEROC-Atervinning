# Moms och ROT: utbyggnad 2026-10-23

Detta är implementerade, browserlokala demoflöden med explicit granskning. Inga uppgifter skickas till bank, Skatteverket eller en AI-tjänst. Belopp lagras i ören och underlagen stäms av mot samma huvudbok som resten av demon.

## Moms

Arbetsytan **Moms & ROT**, `#tax-v2`, kan bokföra redan betalda affärer som ännu inte finns i reskontran: vanliga svenska inköp/försäljningar, svenska omvända inköp, EU-varuinköp, tjänsteinköp enligt huvudregeln inom/utanför EU, EU-försäljning, export och tjänsteförsäljning utomlands. Landskod, villkorsbekräftelse och i relevanta försäljningsfall köparens VAT-nummer krävs. VAT-numret kontrolleras inte mot VIES.

Importmoms använder ett separat tullunderlag. Själva varuinköpet bokförs inte en andra gång. Tullvärde, avgifter och bikostnader måste först ha sammanställts till det beskattningsunderlag användaren anger.

Avdragsrätt anges som en granskad procentsats. Den del av momsen som inte får dras av ingår i kostnaden. Programmet fattar inte beslut om representation, personbilar, blandad verksamhet eller andra särskilda begränsningar.

Deklarationsunderlaget visar de vanliga svenska deklarationsfälten. Beloppen räknas från befintliga fakturor, leverantörsrader, exakta kreditnotor och de nya momsaffärerna. Okända momsverifikationer eller skillnad mot huvudboken ger en avvikelse. CSV-filen är granskningsmaterial, inte en färdig myndighetsfil. Uttag, VMB, frivillig hyresbeskattning, trepartshandel och andra särskilda fall behöver fortsatt klassificering. Periodisk sammanställning är inte implementerad.

En bokförd momsaffär ändras genom länkad återföring. Originalet finns kvar. En retur av den riktiga betalningen måste motsvara den simulerade bankrörelsen; detta är inte ett bankuppdrag.

Källa och regelversion: [Skatteverket: Fylla i momsdeklarationen](https://www.skatteverket.se/foretag/moms/deklareramoms/fyllaimomsdeklarationen.4.3a2a542410ab40a421c80004214.html), kontrollerad 2026-10-23. De använda fälten och skillnaden mellan inköp, import och försäljning har egen metadata; kontonummer ensamma avgör inte klassificeringen.

## ROT

En utfärdad ROT-fakturas befintliga avdrag kan fördelas mellan 1–10 personer. Varje person får en uttrycklig andel och ett användargranskat årsutrymme. Dubbelregistrering av samma person och överskridet lokalt årsutrymme stoppas. Den ursprungliga fakturan och dess bokning skrivs inte om.

Nästa delbegäran grundas på redan registrerade elektroniska kundbetalningar. Den betalda andelen proportioneras mellan arbete och material och mellan personerna; tidigare begärda andelar dras av. Avrundningen summerar till hela kronor utan att samma betalda andel används två gånger.

Beslut anges per person. Avslag ökar den kvarvarande kundandelen. Utbetalning kräver ett föregående beslut och bokförs som bank mot kundfordran. Ett faktiskt återbetalat belopp efter återkrav har en egen verifikation, bankhändelse och originalkoppling; kundfordran återöppnas med samma belopp.

Regelversionen avser kundbetalningar 2026. Begäran kan förberedas till och med 2027-01-31. Betalningar under 2027, RUT, ändring av redan registrerade beslut och ökning av den utfärdade fakturans totala avdrag ingår inte. Den äldre fakturaeditorns 50 000-kronorsgräns kvarstår för fakturans ursprungliga avdrag; att fördela den på flera personer höjer inte gränsen. F-skatt, rätt till avdrag, ägande och externa personutrymmen är inte automatiskt verifierade.

Källor: [Skatteverkets anvisning om delbetalning och årsskifte](https://www.skatteverket.se/foretagorganisationer/sjalvservice/svarpavanligafragor/rotochrutarbete/foretagrotochrutarbetefaq/narskajagsomutforareansokaomutbetalningdakundenbetalatbaraendelavfakturabeloppetexempelvisviddelfaktureringochvadhanderombetalningargorspabadasidornaavettarsskifte.5.71004e4c133e23bf6db800013003.html) och [ROT för företag](https://www.skatteverket.se/foretag/skatterochavdrag/rotochrut/safungerarrotavdraget.4.2ef18e6a125660db8b080002709.html), kontrollerade 2026-10-23.

## Verifiering

Modellprov finns i `server/bokforing-tax-rot-extended.test.mjs`; browserprov i `tests/bokforing-tax-rot.spec.ts`. Proven omfattar olika momssatser, avdragsandel, import utan dubbelt inköp, krediter, återföring, dubbletter, periodlås, manipulerade uppgifter, två ROT-personer, proportionell delbegäran, avslag, utbetalning, återkrav och tidsfrist. Teknisk verifiering ersätter inte redovisningsmässig granskning.
