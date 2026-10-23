# Kontantmetoden i övningsbolaget

**Implementerad och provad 2026-10-23.** Arbetsytan finns på
`/bokforing/#cash`. Den använder samma huvudbok, momsrapport,
periodlåsning och årsavslut som resten av programmet.

## Börja i ett nytt företag

Ett företag med redan bokförda poster byter inte metod genom en inställning.
Arbetsytan låter användaren starta ett **nytt, tomt övningsbolag** efter två
bekräftelser i formuläret och en extra återställningsfråga. Det ersätter den
lokala demoboken; exportera tidigare data först om de ska behållas.

Användaren bekräftar att företaget får använda metoden och anger förväntad
årsomsättning. Funktionen begränsas till normalt högst tre miljoner kronor.
Detta är ett inmatningskrav och en dokumenterad bedömning, inte en automatisk
kontroll av företagets verkliga förutsättningar.

`company.method` är `cash`, redovisningsvalutan är SEK. De vanliga
faktureringsmetodernas kund- och leverantörsbokningar spärras i detta bolag.
Fakturor i valuta kan inte blandas in i kontantmetodsbolaget.

## Hela den genomförda kedjan

1. Registrera en kund- eller leverantörsfaktura med motpart, adress,
   fakturareferens, datum och en eller flera rader. Raderna har eget
   kostnadskonto, svensk momssats och, för inköp, avdragsandel för ingående moms.
2. Utkast kan ändras eller tas bort. Utfärdandet fryser originalet och ger
   dokumentet ett unikt nummer. **Utfärdandet bokför inte intäkt, kostnad,
   moms, kundfordran eller leverantörsskuld.**
3. En faktisk betalning eller delbetalning bokförs mot 1930. Betalningen kan
   matchas mot en befintlig omatchad bankhändelse med samma datum och belopp.
   Annars skapas en kontohändelse i övningen; inga pengar skickas.
4. Betalningen fördelas proportionellt över kvarvarande fakturarader. Endast
   den betalda andelen av intäkt, kostnad och moms bokförs. Moms som inte får
   dras av följer inköpskostnaden.
5. Vid årets slut bokförs kvarvarande obetalda belopp. Fordran hamnar på 1510,
   leverantörsskuld på 2440. En ännu inte återbetald kundkredit redovisas på
   2490; ett tillgodo hos leverantör på 1680.
6. Årsavslut och öppning av nästa år behåller dokument, tidigare händelser
   och utestående belopp. Betalning av en redan bokslutsbokad post reglerar
   fordran eller skulden. Intäkt, kostnad och moms bokförs inte en gång till.

Exempel: en kundfaktura om 1 250 kr inklusive 250 kr moms ger ingen
verifikation vid utfärdandet. En betalning på 500 kr bokför 400 kr intäkt
och 100 kr moms. Årsskiftesbokningen redovisar resterande 600 kr intäkt,
150 kr moms och 750 kr kundfordran. När kunden betalar 750 kr nästa år
debiteras banken och kundfordran krediteras, utan någon ny moms.

## Krediter och återbetalningar

En hel- eller delkredit skapar en egen numrerad kreditnota med orsak och
koppling till originalet. Krediten fördelas proportionellt över kvarvarande
fakturarader; originalets rader skrivs inte om.

En kredit av ett obetalt, ännu inte bokfört belopp minskar betalningskravet
utan att skapa intäkt eller moms. Ett belopp som redan har bokslutsbokats
återförs mot sin fordran/skuld. Om beloppet i stället redan är kontantbetalt
återförs den andelen av intäkt/kostnad och moms vid faktisk återbetalning,
eller vid årsslut om återbetalningen då återstår.

Återbetalningar har egna bankhändelser och referenser. De kan inte överstiga
det aktuella tillgodot. Om en leverantörskostnad används för aktiv inventarie,
lagervärdering eller periodisering måste kopplingen hanteras före kredit.

## Kontroller och granskning

- Beräkningar använder hela ören och `BigInt` vid proportionell fördelning.
  Rester fördelas deterministiskt; sista betalningen tömmer beloppet exakt.
- För stora betalningar, återbetalningar och krediter stoppas. Återanvända
  händelsereferenser och dubblerade fakturareferenser för samma motpart stoppas.
- Händelsedatum får inte ligga före fakturan eller dess senaste händelse.
  Låsta månader och fastställda momsperioder skyddar bokförda belopp.
- Original, kreditnotor, betalningar och journalrader verifieras genom att
  hela händelsekedjan räknas om vid läsning och sparande. Bankkopplingar och
  kontrollkonton stäms av mot huvudboken.
- Årets sista månad kan inte låsas och året inte avslutas medan obetalda
  poster behöver bokslutsbokas eller fakturautkast behöver hanteras.
- Momsdeklarationens underlag använder de faktiska bokföringsdatumen:
  betalning, kreditering eller årsskifte. Nästa års reglering av gammal
  fordran/skuld räknar ingen ny moms. Momsfri svensk försäljning med
  dokumenterat skäl visas i fält 42.
- Faktura och kreditnota kan hämtas som HTML och skrivas till PDF i
  webbläsaren. Utfärdaren och mottagaren framgår av dokumentet.

Modellproven i `server/bokforing-cash-method.test.mjs` omfattar bland annat
delbetalningar, blandade momssatser, avdragsbegränsning, delkredit,
återbetalning, bokslut och nästa år, kund- och leverantörstillgodo,
manipulerade data, spärrade kombinationer samt 238 separata öresbetalningar.
Browserproven i `tests/bokforing-cash-method.spec.ts` täcker startbekräftelse,
utfärdande, betalning, kreditnota, omladdning, årsbyte och mobilvy.

## Avgränsning

Detta flöde omfattar svenska affärer i SEK med 0, 6, 12 eller 25 procent
moms. ROT, omvänd moms, internationella momsfall, förskott, kvittning mellan
fakturor och valuta är inte kopplade till kontantmetoden. Dessa kombinationer
måste få egna kontrollerade flöden innan de kan användas här. Ett separat
fält med momsfri motivering avgör inte själv vilken regel som gäller.

Krediter proportioneras över fakturan; val av enskilda krediterade rader
återstår i denna arbetsyta. Artikelregister, återkommande fakturor och
bilduppladdning i det vanliga fakturaflödet är inte automatiskt integrerade
med de separata kontantmetodsdokumenten.

Lagringen är fortfarande lokal i webbläsaren. Frysta data och kontrollerad
återställning ersätter inte serverarkiv, behörigheter eller en oberoende
redovisningsgranskning. Underlaget för metodens tillämpning finns i
[genomförandeplanens rättskällor](utveckling/valuta-och-kontantmetod.md).
