# ROT i bokföringsdemon

Regelunderlag kontrollerat mot Skatteverket och gällande lag den **23 oktober 2026**. Detta dokument beskriver den avgränsade demomodellen, med fiktiva uppgifter och utan kontakt med Skatteverket. Beräkningen avgör inte en kunds faktiska rätt till skattereduktion.

## Regler som styr modellen

För betalningar under 2026 får ROT normalt omfatta högst **30 procent av arbetskostnaden inklusive moms**. Material, resor, maskiner och administration ingår inte i underlaget. ROT är högst **50 000 kr per person och år**, inom ett gemensamt tak på **75 000 kr för ROT och RUT**. Kundens skatteutrymme och avdrag hos andra utförare kan minska utrymmet. [Skatteverket: ROT för företag](https://www.skatteverket.se/foretag/skatterochavdrag/rotochrut/safungerarrotavdraget.4.2ef18e6a125660db8b080002709.html).

Det är **kundens betalningsdatum**, inte fakturadatumet, som avgör beskattningsår. Arbetet måste vara utfört och betalningen elektroniskt spårbar innan utföraren ansöker. Lagen kräver att begäran kommer in senast **31 januari året efter betalningsåret**. Uppgifter om belopp anges i hela kronor med öretal borttagna. [Skatteverket: betalning och ROT](https://www.skatteverket.se/privat/skatter/fastigheterbostad/rotrutarbete/villkorforattfaavdrag.4.5947400c11f47f7f9dd80004014.html), [lag 2009:194, 5 och 8 §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2009194-om-forfarandet-vid-skattereduktion_sfs-2009-194/).

Arbetets art, bostadens typ, ägande och användning behöver bedömas. Småhus, ägarlägenhet och bostadsrätt har delvis olika villkor. Nybyggnation, släktrelationer, bidrag och försäkringsersättning kan påverka rätten. Flera berättigade ägare får dela ett avdrag, men arbetskostnaden får inte användas flera gånger. Faktura och ansökan behöver specificera arbetet, faktiskt arbetade timmar, kostnader, kund och bostad. [Skatteverket: villkor för bostad och arbete](https://www.skatteverket.se/foretag/skatterochavdrag/rotochrut/safungerarrotavdraget.4.2ef18e6a125660db8b080002709.html), [lag 2009:194, 9 och 9 a §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-2009194-om-forfarandet-vid-skattereduktion_sfs-2009-194/).

## Vad demoflödet hanterar

- En fiktiv ROT-person per faktura, i SEK, med markerade arbetsrader som har 25 procent moms. På dessa rader avser antalet faktiskt arbetade timmar. En arbetsrad som inte avser berättigat ROT-arbete kan avmarkeras. Fastpris-ROT med separat timredovisning återstår. Material och övriga rader räknas aldrig in i ROT-underlaget.
- Arbetskostnaden beräknas efter radrabatt och fakturarabatt, inklusive moms. Pris inklusive/exklusive moms följer radens prisgrund. Frakt och fakturaavgift är separata övriga rader med egen momssats och bidrar inte till ROT-underlaget.
- Ett uppgivet årsutrymme före demofakturorna, där användaren redan ska ha tagit hänsyn till annan ROT/RUT och skatteutrymme. Utfärdade fakturor i demoboken reserverar utrymme för samma person och år. Detta är en lokal planeringskontroll, inte uppgifter från Skatteverket.
- Fakturering och kundbetalningar under 2026. Betalningar över årsskiftet och tidigare tillfälliga procentsatser ingår inte i denna version.
- Hela kundens del ska vara betald innan demobegäran förbereds. Reglerna tillåter även proportionella begäranden vid delbetalning, men den första demon har ett snävare flöde. Delbetalningar kan fortfarande registreras.
- Vid förberedelse måste användaren uttryckligen bekräfta att arbetet är utfört och kundbetalningen elektronisk. Bekräftelserna sparas som demouppgifter; programmet hämtar inte betalningsbevis eller arbetsintyg.
- Det planerade ROT-beloppet avrundas nedåt till hela kronor, så att fakturans avdrag och demobegäran följer samma belopp utan kvarhängande ören.
- Begäran, ett manuellt inmatat demobeslut och betalningar från kund respektive Skatteverket följs separat. Avslaget ROT-belopp ligger kvar som kundfordran, så att bokföringen inte tappar beloppet.
- ROT kombineras inte med omvänd byggmoms. Det är separata affärsfall.

Fakturan bokförs med hela beloppet inklusive moms som kundfordran. Kundens betalning och en simulerad ROT-utbetalning minskar samma fordran genom egna verifikationer. ROT-utbetalningen behandlas som en inbetalning till företagets bankkonto, inte som en intäkt till eller från skattekontot. [Skatteverket: utbetalning för ROT och RUT](https://www4.skatteverket.se/rattsligvagledning/edition/2026.2/326163.html).

## Räkneexempel

| Del | Exklusive moms | Moms | Inklusive moms |
| --- | ---: | ---: | ---: |
| Arbete, 32 timmar à 550 kr | 17 600 kr | 4 400 kr | 22 000 kr |
| Material | 8 000 kr | 2 000 kr | 10 000 kr |
| Resa | 800 kr | 200 kr | 1 000 kr |
| Totalt | 26 400 kr | 6 600 kr | 33 000 kr |

Med tillräckligt uppgivet utrymme blir preliminärt ROT **6 600 kr**, alltså 30 procent av 22 000 kr. Kunden betalar **26 400 kr**. En simulerad godkänd ROT-utbetalning på 6 600 kr reglerar resten. Blir demobeslutet i stället 5 000 kr återstår 1 600 kr att få från kunden.

Exemplet saknar rabatter och avgifter. En rabatt på det berättigade arbetet minskar både arbetskostnaden och ROT-underlaget. Tillagda frakt-/fakturaavgifter ökar fakturans belopp enligt sin momssats, men ökar inte ROT-avdraget.

## Fortsatt utveckling

Flera ROT-personer på samma faktura, proportionella delbegäranden, årsskiftesbetalningar, återkrav, ändrade beslut och särskilda bostads-/arbetstyper behöver egna granskade flöden. Personidentitet, F-skatt, ägande, faktiskt utfört arbete, betalningsbevis, kundens skatteutrymme och övriga avdrag verifieras inte automatiskt. Demobegäran skickas aldrig till en myndighet.

## Valda konton i demon

Kontoval kontrollerade mot [BAS kontoplan 2026, version 1.1](https://www.bas.se/wp-content/uploads/2026/04/BAS_kontoplan_2026_v2.pdf) den 23 oktober 2026: **4425** används för tjänsteinköp med svensk omvänd betalningsskyldighet och 25 procent moms; **3231** för försäljning inom byggsektorn med omvänd betalningsskyldighet. Kontot 4417 avser ett annat inköpsfall och används inte för dessa byggtjänster.

Lagerflödet använder **1460/4960** för handelsvaror, alltså varor avsedda för vidareförsäljning. Råvarulager och andra lagerslag behöver egna kontoval. Detta är vår valda klassificering enligt BAS; lagen föreskriver inte dessa enskilda kontonummer. Rätt momshantering förutsätter fortfarande att den aktuella affären uppfyller villkoren.

Modell: [ROT-beräkning](../public/bokforing/suite/rot.js) och [faktura-/betalningsflöde](../public/bokforing/suite/sales.js). Övrigt om demon finns i [bokföringsprojektets README](README.md).
