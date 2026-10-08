# Kontorswebben – mockuper

Designbilder med fiktiva exempeldata, framtagna 2026-10-07. Uppladdning av
mockuper ändrar inte appen och aktiverar inga betalningar eller integrationer.

## Betalningsuppgifter på invägningskortet

[Öppna mockup](01_Invagning_Betalningssatt.png)

Godkänd design för ÄL 023: Bankkonto, Swish, Kontant och Kreditfaktura som
kompakta val med metodens inmatningsfält direkt under. Gemensam manuell
ID-kontroll ligger kvar. Rutan används när invägningskortet kompletteras före
attest.

## Kundlista – godkänd mockup

[Öppna kundlistan](02_Kundlista.png)

- Sök namn, organisationsnummer, kundnummer eller registreringsnummer.
- Filtrera kundtyp och öppna viktkort; sortera efter senaste aktivitet.
- Visa senaste inlämning, vikt under rullande 12 månader, öppna viktkort,
  saldo och antal kundanpassade prisregler.
- Hela kundraden öppnar kundkortet. Kunden får ingen gemensam A/B/C-nivå;
  prisnivå beräknas separat för varje artikel.

![Kundlista](02_Kundlista.png)

## Kundkort, Översikt – godkänd mockup

[Öppna kundkortet](03_Kundkort_Oversikt.png)

- Flikar: Översikt, Vägningar, Priser, Uppgifter & betalning samt Rättelser & saldo.
- Översikt med rullande tolvmånadersperiod, nettovikt, antal inlämningar,
  avräknat värde efter rättelser, utbetalt och månadsgraf över invägd vikt.
- Per artikel: volym under perioden, A/B/C-nivå, faktiskt kundpris och
  nästa volymgräns. Kundanpassade regler går före ordinarie volympris.
- Senaste viktkort med länk och aktuell status; kontakt, betalningsprofil,
  sparade referenser, ursprungsadresser och registrerade fordon i sidokolumnen.
- Saldo och rättelse med länk till originalvägningen. I exemplet är rättelsen
  redan inkluderad: 91 927,20 kr avräknat minus 83 527,20 kr utbetalt ger
  +8 400,00 kr kvar att betala. Rättelsen ska inte dras av en gång till.

![Kundkort](03_Kundkort_Oversikt.png)

## Kundkortets fem flikar

Samma kund och exempeldata används genom hela serien. **Kunder** är markerad
i huvudmenyn, och kundens fem flikar ligger kvar när innehållet byts.

| Flik | Mockup | Designstatus |
| --- | --- | --- |
| Översikt | [03_Kundkort_Oversikt.png](03_Kundkort_Oversikt.png) | Godkänd |
| Vägningar | [04_Kundkort_Vagningar.png](04_Kundkort_Vagningar.png) | För granskning |
| Priser | [05_Kundkort_Priser.png](05_Kundkort_Priser.png) | För granskning |
| Uppgifter & betalning | [06_Kundkort_Uppgifter_Betalning.png](06_Kundkort_Uppgifter_Betalning.png) | För granskning |
| Rättelser & saldo | [07_Kundkort_Rattelser_Saldo.png](07_Kundkort_Rattelser_Saldo.png) | För granskning |

### Vägningar

[Öppna Vägningar](04_Kundkort_Vagningar.png)

Kundens viktkort med sökning, material- och statusfilter, datum, vikt,
referens, materialvärde och betalning. Vald vägning visar även kvittat belopp
och länkar till underlag. Originalkortet behåller sin historik och märks med
länk till rättelsen; en rättelse skriver inte över den ursprungliga vägningen.

![Kundkort – Vägningar](04_Kundkort_Vagningar.png)

### Priser

[Öppna Priser](05_Kundkort_Priser.png)

Volym under rullande 12 månader och A/B/C-nivå visas per artikel, med
jämförelse mellan ordinarie pris och kundens faktiska pris. Kundregler kan
vara fastpris, tillägg eller avdrag mot en prislista, eller eget avdrag från
LME. Kundregeln gäller före volympriset. Pristrend och regelhistorik visar
prisernas utveckling; ändrade regler räknar inte om låsta underlag.
Den streckade linjen visar dagens kundpris som jämförelse, inte kundens
historiska prisutveckling.

![Kundkort – Priser](05_Kundkort_Priser.png)

### Uppgifter & betalning

[Öppna Uppgifter & betalning](06_Kundkort_Uppgifter_Betalning.png)

Kund- och kontaktuppgifter, förvalt betalningssätt och metodens fält enligt
ÄL 023: Bankkonto, Swish, Kontant eller Kreditfaktura. Sparade referenser,
ursprungsadresser och fordon kan hanteras direkt på kundkortet. Profilen
kan hämtas när kunden väljs på en kommande vägning; tidigare låsta kort
behåller sina uppgifter. Manuell ID-kontroll görs på respektive viktkort.

![Kundkort – Uppgifter & betalning](06_Kundkort_Uppgifter_Betalning.png)

### Rättelser & saldo

[Öppna Rättelser & saldo](07_Kundkort_Rattelser_Saldo.png)

Saldo, rättelsekort och saldohistorik med plus- och minusposter. En rättelse
länkas till kunden, originalvägningen och rättelseunderlaget, med person,
kontor och tidpunkt. Den korrigerade volymen hör till ursprunglig
inlämningsdag. Minus kan kvittas mot senare betalning med tydlig hänvisning;
ett positivt rättelsebelopp går vidare till attest och utbetalning.

![Kundkort – Rättelser & saldo](07_Kundkort_Rattelser_Saldo.png)

### Gemensamma exempelbelopp

Exempelperioden är 8 oktober 2025–7 oktober 2026. De 36 inlämningarna ger
12 480 kg efter rättelser. Rättelser räknas separat från antalet inlämningar.

| Händelse | Saldoförändring | Saldo efter händelsen |
| --- | ---: | ---: |
| Tidigare 34 vägningar: 75 827,20 kr avräknat och lika mycket utbetalt | 0,00 kr kvar | 0,00 kr |
| R-003: −100 kg koppar klass 1 på vägning #1982 | −8 400,00 kr | −8 400,00 kr |
| Vägning #2039: 230 kg blandad koppar | +16 100,00 kr | +7 700,00 kr |
| U-2039: 7 700 kr utbetalt, efter kvittning av 8 400 kr | −7 700,00 kr | 0,00 kr |
| Vägning #2041: 100 kg koppar klass 1, klar för utbetalning | +8 400,00 kr | +8 400,00 kr |

Avräknat efter rättelser: **91 927,20 kr**. Utbetalt: **83 527,20 kr**.
Skillnaden är **+8 400,00 kr** kvar att betala. R-003 ingår redan i vikt,
avräknat värde och saldo och ska inte dras av en gång till. R-004 visas som
ett **utkast på +25 kg och +2 100 kr** och ingår ännu inte i dessa summor.

Kundlistan och kundkortets Översikt är godkända som designunderlag 2026-10-07
och dokumenterade i ÄL 024 som planerade ändringar. Flikarna har presenterats
i text och de fyra nya detaljmockuperna är framtagna på användarens begäran;
de väntar på designgodkännande. Ingen koduppdatering är beställd här. Fullständigt
kundkort, saldo-/rättelseflöde och kundadministration finns ännu inte i den
publicerade kontorsdemon. Vid genomförande ska statistik, kundpriser,
betalningsuppgifter och ändringsknappar följa användarens behörigheter.

Senaste byggbeslut: alla fem kundflikar är godkända. I appversion 0.3.0 ersätts mockupernas Kreditfaktura av **Spara på saldo**. Underlagen visar exempeldata; appen räknar statistik från sparade demokort.

## Containrar & kärl – designförslag 2026-10-08

[Öppna kartvyn](08_Containrar_Karl.png)

Karta med utställda containrar och kärl, sökning, typ- och statusfilter samt
växling till lista. Det valda kärlet visar kund, adress, kontakt, bokad åtgärd,
avtal, platsinformation och historik. Kärl kan hanteras individuellt med eget
nummer; flera kärl och adresser kan höra till samma kund.

Kartans färger visar läget för nästa åtgärd: grönt för utställd, gult för
hämtning begärd, blått för bokad och rött för försenad. En bokning flyttar
inte kärlet: C-014 står kvar hos kunden fram till genomfört byte, och C-027
är det reserverade ersättningskärlet. Fyllnadsgrad ska anges manuellt när
den behövs, inte presenteras som en automatisk sensormätning.

![Containrar & kärl](08_Containrar_Karl.png)

## Transportplanering – designförslag 2026-10-08

[Öppna kalendern](09_Transportplanering.png)

Uppdaterad layout efter användarens återkoppling 2026-10-08. Mockupen visar
dagsvyn som standard: förare och fordon på varsin rad och klockslag från
vänster till höger. Överraden har datum, Idag, Dag/Vecka, förarfilter och
Nytt uppdrag. Veckovyn planeras med dagar som kolumner och tid uppifrån
och ner.

**Behöver planeras** ligger i högerkolumnen och ersätter den tidigare
ständigt öppna arbetsordern AO-1042. Korten visar uppdragstyp, kund, ort
och uppskattad tidsåtgång. Kalenderkorten visar typ, kund och bokad tid.
Ett tryck på ett kort i kalendern eller kön öppnar arbetsorderns detaljer
i ett tillfälligt sidokort. Ett tydligt X stänger detaljerna och återgår
till kön. Då visas adress, material, kärlnummer, förare, fordon och
instruktioner vid behov. Obokade kort kan dras till kalendern för bokning.
Kalenderns egen statusförklaring visar Planerad, På väg och Klar.

Planeringen ska omfatta både hämtning, byte och utställning. En hämtning av
en batterilåda behöver exempelvis inte vara ett containerbyte. Återkommande
avtal och extra beställningar skapar arbetsordrar i samma planering.

![Transportplanering](09_Transportplanering.png)

### Gemensamt exempel i de två transportmockuperna

| Uppgift | Exempeldata |
| --- | --- |
| Arbetsorder | AO-1042, bokat extrabyte |
| Kund | Roslagens Däck & Service AB |
| Plats | Industrivägen 8, Norrtälje |
| Tid | Torsdag 8 oktober 2026, 10:00–11:00 |
| Förare / fordon | Kalle Johansson / ABC123, lastväxlare |
| Kärl | Hämta C-014, ställ ut C-027, däckcontainer 20 m³ |
| Ordinarie schema | Byte varannan onsdag, nästa byte 14 oktober |

Extrabyten ändrar inte det ordinarie schemat. Kartans detaljkort länkar till
arbetsordern, och arbetsordern länkar tillbaka till kärlet på kartan. Efter
genomfört byte flyttas C-027 till kunden och C-014 tas hem med historiken
bevarad. Senare kan transporten länkas till en vägning; materialets vikt
registreras när det faktiskt vägs.

De här två bilderna är för designgranskning. De innebär ingen ändring i
appen och har ännu inte lagts in som godkända byggpunkter i ÄL.

## Transportledning – arbetsvy med karta, designförslag 2026-10-08

[Öppna arbetsvyn](10_Transportledning_Arbetsvy.png)

Senaste layoutförslaget samlar karta, dagsplanering och obokade arbeten i
en arbetsyta som fyller skärmen. Kontorets sidomeny och globala sökrad
ersätts av en smal verktygsrad med Till kontoret, datum, Idag, Dag/Vecka,
förarfokus, visningsval och Nytt uppdrag. Kartan ligger ovanför en bred
dagsplanerare; gränsen mellan dem kan dras för att fördela ytan. Obokade
arbeten ligger i högerkolumnen och kan dras till kalendern.

Kartan följer vald period och visar både bokade uppdrag och obokade arbeten.
Efter senaste återkopplingen visar konturen förare, fyllningen kärltyp och
linjestil/rörelse bokningsstatus. Kärlfärgen behålls när ett uppdrag bokas:

| Visuell del | Betydelse i exemplet |
| --- | --- |
| Ytterkontur | Förare: Oskar röd, Kalle lila, Maria turkos |
| Grå ytterkontur | Ingen förare tilldelad |
| Blå fyllning | Container |
| Orange fyllning | Batterilåda |
| Grön fyllning | Tunna/kärl |
| Lila fyllning | Bur |
| Hel kontur, full färg och stilla nål | Bokat uppdrag |
| Streckad kontur och tonad/pulserande fyllning | Obokat uppdrag |

En vit avgränsning skiljer konturen från fyllningen. Förarfärgerna återkommer
vid kalenderns förarrader. Legendens tre delar förklarar förare, kärltyp
och bokningsstatus separat. Kartan visar arbetsordrar; konturens röda färg
betyder Oskar, inte försenat kärl. Namn, kärltyp och bokningsstatus ska också
stå i uppdragsinformationen när den öppnas. Material och kärlets storlek
visas i detaljerna. Exempelvis är AO-1045 ett skrotkärl med järnskrot som
material; dess gröna fyllning betyder kärltyp, inte material.

Planerad animation för obokade uppdrag: en mjuk cykel på cirka tre sekunder
mellan 40 och 80 procents opacitet i fyllningen. Kontur och etiketter ligger
kvar tydliga utan att pulsera; nålen ändrar inte storlek. Vid bokning stannar
pulsen, fyllningen blir helt synlig och konturen blir hel. Med minskad
rörelse används en stilla tonad fyllning och streckad kontur. PNG-mockupen
visar en stillbild av det tonade läget, omkring 60 procent, med text som
förklarar pulsen. Den innehåller ingen faktisk animation.

Förarvalet heter **Fokus: Oskar**, eftersom andra förares uppdrag syns
nedtonade medan Oskars och de otilldelade arbetena framhävs. Markering av
kort eller nål ska följa med mellan karta, kalender och kö.

I detta exempel har Oskar fordon JKL234 och arbetsorder **AO-1101**,
ett bokat byte hos Roslagens Metallservice på Verkstadsvägen 4 i Norrtälje
kl. 10:00–11:00. Obokade **AO-1043** avser en batterilåda hos Anderssons
Verkstad på Verkstadsvägen 12 och har uppskattad tidsåtgång 30 minuter.
Den tonade orange nålen ligger nära Oskars bokade stopp och har streckad
grå kontur eftersom uppdraget är obokat och ännu saknar förare. Kortet finns
kvar i kön och inte i kalendern.
**Boka efter** ska öppna ett förslag där tid, restid, förare och lämpligt
fordon kontrolleras före bekräftelse. Närhet och tidsåtgång är exempeldata
i denna mockup; automatisk ruttoptimering ingår inte i designbeslutet.

AO-1042 ligger fortfarande hos Kalle/ABC123 kl. 10:00–11:00, så de tidigare
mockupernas exempel hänger ihop. Klick på ett uppdrag öppnar detaljer vid
behov; ett tydligt X stänger dem. Kartan och kalendern kan även visas var
för sig när mer yta behövs.

![Transportledning – arbetsvy](10_Transportledning_Arbetsvy.png)

Detta är en mockup för granskning, inte en appuppdatering eller en ny
godkänd byggpunkt i ÄL.
