# Årsgräns för arbetsgivaravgifter 2026

Den individuella lönemotorn har nu en uttrycklig årsbedömning i löneprofilen och en kumulativ kontroll av 1 000-kronorsgränsen per anställds registerpost och kalenderår. Kontant lön och skattepliktiga förmåner ingår. Granskade skattefria utlägg ingår inte.

## Två olika regler

- **Arbetsgivaravgift:** SAL 2 kap. 14 § undantar ersättning som under året understiger 1 000 kr. Exakt 1 000 kr passerar gränsen. SAL 2 kap. 24 § tar tidigare avgiftsfri ersättning i avgiftsunderlaget för månaden då den blir avgiftspliktig.
- **Skatteavdrag:** SFL 10 kap. 4 § skiljer bland annat på ersättning under 100 kr och en bedömning att årets ersättning kan antas understiga 1 000 kr. Profilens prognos används här; den får inte likställas med den faktiska avgiftsackumulatorn.

Under 100 kr är inte en generell obligatorisk AGI-gräns. SFL 15 kap. 8 § innehåller ett undantag från kontrolluppgift, medan 26 kap. 19 a–d §§ reglerar AGI och valet att redovisa vissa ersättningar där. Granska uppgiftsskyldigheten. Programmet lämnar inte in uppgifter automatiskt.

## Arbetsgång

1. Öppna **Lön → Individuell lönehantering**. Granska eller uppdatera löneprofilen. Ange bedömd årsersättning och underlagsreferens. Äldre sparade profiler utan dessa fält har sina ursprungliga beräkningsregler kvar tills profilen uppdateras; bokförda löneoriginal skrivs inte om.
2. Beräkna och granska. Bokför och registrera utbetalningen när lönen ger bokföringsposter; ett rent förmånsunderlag utan sådana poster registreras och bekräftas utan bankutbetalning. Årsunderlaget följer den anställde och betalningsåret. Tidigare löner i årsunderlaget måste betalas före senare löner som bygger på dem.
3. Under årsgränsen klassas nya betalningar som avgiftsfria. När gränsen nås räknas även tidigare ännu inte avgiftsbelagda belopp med. Avgiftssatsen följer månaden då beloppen blir avgiftspliktiga, även för ungdomsnedsättningen.
4. En separat årsavstämning följer utbetalningen. I normalfallet är differensen noll och ingen nollverifikation skapas. Vid rättelser kan en separat, spårbar verifikation justera konto 7510/2731. Det ursprungliga lönebeskedet och dess verifikation bevaras.
5. Vid bruttolöneåterkrav korrigeras kontant ersättning i ursprunglig AGI-period. Avdragen skatt minskas inte. Årsavstämningen visar ändrad avgiftsklassning och eventuella avgiftsdifferenser. Redan skapade deklarationsfiler blir inaktuella om deras underlag ändras.
6. Reglera en avgiftsdifferens först när motsvarande betalning eller kreditering finns på skattekontot. Samma differens kan inte regleras två gånger.
7. Äldre löner kan granskas via **Årsgräns och arbetsgivaravgifter**. Ett uttryckligt slutligt under-1 000-besked kan korrigera äldre avgifter utan ändrade löneoriginal. Ny löneberäkning och betalning av redan bokförd lön efter ett sådant slutbesked kräver en uttrycklig ny årsavstämning. Betalningsspärren gäller både den nya och äldre lönemodulen, även när nettolönen är noll.

Ett rent skattepliktigt förmånsunderlag kan sakna verifikation när kontantlön, skatteavdrag, arbetsgivaravgift, utlägg och nettolön är noll. Det kräver positivt förmånsvärde och får inte innehålla semesteruttag. Underlaget, bekräftelsen och ett eventuellt återtag bevaras spårbart; ingen tom verifikation skapas. Förmånen finns kvar i AGI-underlaget. Kostnader som hör till förmånen måste vara bokförda genom relevanta underlag. Detta innebär ingen automatisk myndighetsinlämning.

## AGI-fält

| Fall | Fält |
| --- | --- |
| Avgiftsfri kontant ersättning | 131 |
| Avgiftsfria övriga skattepliktiga förmåner | 132 |
| Avgiftspliktig kontant ersättning | 011 |
| Avgiftspliktiga övriga skattepliktiga förmåner | 012 |
| Tidigare perioders avgiftsfria ersättning som nu tas upp | 010 |

Skatteverkets exempel är ett automatiskt testfacit: 100 kr i period 1, 100 kr i period 2 och 1 000 kr i period 3 ger 131=100 i de två första perioderna, därefter 011=1 200 och 010=200. Den verkliga kontantlönen i period 3 är fortfarande 1 000 kr. Vid passage inom samma månad används inget 010 för belopp inom den månaden.

Noll arbetsgivaravgift på grund av födelseår får inte i sig ge fält 131/132. Fält 010 har BELOPP7 i AGI:s XSD; 131/132 har BELOPP10. Exporten kontrollerar dessa gränser och balansen mellan verklig ersättning, tidigare perioders avräkning och avgiftsklassning.

## Testat och kvarstående avgränsning

Modellprov omfattar gränsen i ören, flera perioder, passage samma månad, förmåner, utlägg, två personer, ungdomsregel över mars/april, ålder med noll avgift, separata skatteprognoser, återkrav under gränsen, ny passage, historiska löner, oförändrade original, inaktuella AGI-filer och reglering av skattekontokredit. XML jämförs med Skatteverkets XSD.

Stödet gäller 2026 och den vanliga svenska anställning som profilen intygar. En registerpost ska avse en person; identiteten och att samma person inte ligger dubbelt behöver granskas. Ingen extern identitetskontroll görs. Årsregeln löser inte internationell socialförsäkring, idrottsföreningars särskilda gränser, särskilda avgiftsnedsättningar, alla kollektivavtal eller alla förmåns- och sjukfall. Frivilligt extra skatteavdrag på små ersättningar har inget särskilt flöde. Verklig AGI-inlämning och myndighetsbeslut ligger utanför demon.

## Källor

- [Socialavgiftslag (2000:980), särskilt 2 kap. 14 och 24 §§](https://data.riksdagen.se/dokument/sfs-2000-980.html)
- [Skatteförfarandelag (2011:1244), särskilt 10 kap. 4 §, 15 kap. 8 § och 26 kap. 19 a–d §§](https://data.riksdagen.se/dokument/sfs-2011-1244.html)
- [Skatteverket: AGI ruta för ruta, särskilt 010, 131 och 132](https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/safyllerduiarbetsgivardeklarationen.4.2cf1b5cd163796a5c8b66a8.html)
- [Skatteverket: rätta en arbetsgivardeklaration och bruttolöneåterkrav](https://www.skatteverket.se/foretag/arbetsgivare/lamnaarbetsgivardeklaration/rattaenarbetsgivardeklaration.4.2cf1b5cd163796a5c8b6698.html)

Källorna kontrollerades 2026-10-23. Reglerna och XML-fälten ska versionsgranskas inför andra inkomstår.
