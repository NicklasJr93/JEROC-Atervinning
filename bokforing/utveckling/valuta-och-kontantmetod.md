# Valuta och kontantmetod: konkret fortsatt implementation

**Datum: 2026-10-23. Status: genomförandeplan, inte implementerad funktionalitet.**

Denna plan beskriver hur valutafakturor och kontantmetoden kan läggas till utan att befintliga SEK-belopp byter betydelse. Nuvarande bokföringskärna använder heltalsbelopp i ören och har SEK/faktureringsmetoden som avgränsning. Ett valutafält eller ett val i företagsinställningarna gör inte i sig dessa flöden färdiga.

## Rekommenderad minsta valutaleverans

Behåll **SEK som redovisningsvaluta**. Stöd först fakturor i **EUR och USD**, mottagna/betalda via ett SEK-bankkonto. Valet av fakturavaluta avgör inte om en affär är svensk försäljning, EU-handel, export eller import: momsfallet väljs och valideras separat.

Denna första leverans behöver omfatta hela kedjan för kund- och leverantörsfakturor: utkast, utfärdande/bokföring, betalning och delbetalning, kredit/återbetalning, periodrapportering, öppna poster vid bokslut och fortsatt hantering nästa år. ROT i annan valuta samt bankkonton med saldo i utländsk valuta lämnas uttryckligen spärrade tills de har egna regler och tester. Det är en användbar och avgränsad valutamodul utan att påstå att alla valutafall stöds.

### Data och beräkningar

- `company.currency` förblir `SEK`; lägg till separat `invoice.currency`/`bill.currency` och valutans antal decimaler. Befintliga `*Cents` för bokförings- och rapportvärden behåller betydelsen **SEK-ören**.
- Spara fakturans ursprungliga valutabelopp separat: radpris, netto, fakturerad moms och brutto i valutans minsta enhet. Använd explicita namn som `foreignNetMinor`, inte fält som ibland betyder eurocent och ibland SEK-ören.
- Frys en valutakurs med riktning **SEK per 1 enhet fakturavaluta**, kursdatum, källa, källreferens och registrerad tid. Spara kursen som decimalsträng eller rationellt heltalspar; undvik flyttalsräkning för bokföringsbelopp.
- Spara redovisningsdatum och tillämpligt moms-/kursdatum separat. Fakturadatum får inte utan granskning antas vara rätt skattedatum för alla affärsfall.
- För valutor med två decimaler blir `SEK-ören = avrunda(valutans minsta enheter × kurstäljare / kursnämnare)`. För valutor med annat antal decimaler krävs även enhetsomräkning. Avvisa ännu inte stödda valutor, exempelvis JPY i första leveransen.
- Räkna och avrunda enligt en dokumenterad ordning per momsgrupp. Skillnaden mellan avrundat totalbelopp och summerade komponenter ska få en uttrycklig avrundningspost; ändra inte godtyckligt momsbeloppet för att få balans.
- Bevara både frysta belopp i fakturavaluta och bokföringsvaluta i snapshot, utskrift, kreditunderlag och granskningspaket. Gamla SEK-snapshots ska förbli läsbara och oförändrade.

### Betalning och kursdifferens

En betalning behöver innehålla vilket valutabelopp som regleras, faktiskt bankbelopp i SEK, datum, eventuell separat bankavgift och koppling till ursprungsfakturan. En betalning av 100 EUR är inte samma sak som en betalning av 100 SEK. Beloppskontrollen ska omfatta **båda** valutorna.

För varje öppen post hålls kvarvarande valutabelopp och kvarvarande bokfört SEK-värde. En delbetalning tar bort sin uttryckliga andel av den öppna postens bokförda värde. Sista regleringen tar exakt återstående belopp, så att inga öresrester eller negativa valutaposter uppstår. Efter en bokslutsvärdering används det då aktuella bokförda värdet, inte ursprungsfakturans gamla SEK-belopp.

Exempel för en svensk kundfaktura med 25 procent moms:

| Händelse | Bokföring i SEK |
| --- | --- |
| Faktura 100 EUR inklusive moms, kurs 11,00 | Debet 1510: 1 100; kredit intäkt: 880; kredit moms: 220. |
| Kunden betalar 100 EUR; banken växlar till 1 120 SEK | Debet 1930: 1 120; kredit 1510: 1 100; kredit valutakursvinst: 20. |
| Samma betalning, men banken tar 5 SEK separat | Debet 1930: 1 115 och bankkostnad: 5; kredit 1510: 1 100 och valutakursvinst: 20. |
| Leverantörsskuld bokförd till 1 100 SEK regleras med 1 130 SEK | Debet 2440: 1 100 och valutakursförlust: 30; kredit 1930: 1 130. |

Konton för operativa kursvinster/-förluster, exempelvis 3960/7960, ska ingå i den granskade kontomappningen. Bankavgiften får inte döljas som kursförlust. Betalningskursdifferensen ändrar inte automatiskt den ursprungliga fakturans moms.

Kreditnotan refererar till originalet och korrigerar de ursprungliga valutabeloppen och berörda skattebeloppen. Själva skuld-/fordringsregleringen kan ge separat kursdifferens. Återbetalning måste ha en egen bankhändelse och egen koppling; den får inte skriva om den tidigare betalningen.

### Utskrift, reskontra och bokslut

Fakturan visar tydligt vilken valuta kunden ska betala, samtliga belopp i denna valuta och betalningsuppgifter. När svensk moms ska betalas till staten och företagets redovisningsvaluta är SEK ska momsbeloppet även anges i SEK. Den uppgiften och dess omräkningsgrund ska frysas vid utfärdande, inte räknas om med dagens kurs vid utskrift.

Reskontran ska visa både återstående utländskt belopp och bokfört SEK-värde. Rapporter summeras i SEK; listor får aldrig summera EUR och USD som om de vore samma enhet. Vid bokslut behöver öppna valutafordringar/-skulder värderas enligt tillämpligt K-regelverk, dokumenterad balansdagskurs och separata justeringsverifikationer. Det behövs underlag före/efter värdering och fortsatt spårbarhet till betalning nästa år. Redovisning i EUR, byte av redovisningsvaluta och valuta-bankkonton är separata etapper.

## Kontantmetoden behöver en egen bokföringscykel

Lägg inte bara till `method: 'cash'` i ett formulär. Befintliga flöden förutsätter i dag bokförd kundfordran eller leverantörsskuld före betalning.

1. Registrering/utfärdande ska skapa ett låst affärsdokument och betalningsbevakning utan att alltid skapa den vanliga intäkts-/kostnadsverifikationen direkt.
2. Betalning bokför berörd intäkt/kostnad och moms enligt metoden. Delbetalningar fördelas på fakturans rader och momsgrupper, med dokumenterad avrundning och skydd mot överbetalning/dubbelregistrering.
3. Vid räkenskapsårets slut ska kvarvarande obetalda fordringar och skulder bokföras. Markera exakt vilka återstående belopp som redan har redovisats genom detta bokslut.
4. Betalning nästa år reglerar då den överförda fordran/skulden. Den får inte bokföra samma intäkt, kostnad eller moms igen.
5. Krediter, återbetalningar och kvittningar måste använda samma princip: dokumentets fakturabelopp, vad som har betalats och vad som redan har redovisats hålls isär.
6. Momsperioder, momsavstämning, årsavslut, SIE och granskningsunderlag behöver redovisa metoden. Internationella momsförvärv, förskott och andra särskilda skattetidpunkter ska vara uttryckligt stödda eller stoppas.

Använd separat `accountingState` och bokförda beloppsandelar. Ett enda `status: 'issued'` eller `status: 'paid'` räcker inte. Valet ska styras per företag/räkenskapsår, med dokumenterad bedömning av om metoden får användas. Byte med redan bokförda poster kräver ett granskat konverteringsflöde, inte en vanlig inställningsändring.

## Föreslagen arbetsordning och acceptansprov

1. **Valutabelopp och konvertering:** rena beräkningsfunktioner, kurskällor, dokumentmodell/snapshot och rapportvaluta. Prova kurs noll/negativ/fel riktning, ogiltig valuta, öresavrundning, mycket stora belopp och bakåtkompatibilitet.
2. **Kund-/leverantörsflöden:** utfärdande, bokföring, flera momsgrupper, faktiskt bankbelopp, delbetalning och slutbetalning. Prova både kursvinst och kursförlust, avgift separat och att fakturans frysta momsvärde består.
3. **Kredit och återbetalning:** delkredit före betalning, efter delbetalning och efter slutbetalning; kvittning endast med kontrollerad valuta-/partskoppling; återbetalning med annan kurs. Den sista regleringen ska tömma både valuta- och SEK-saldo exakt.
4. **Bokslut:** öppna poster före/efter omvärdering, bankavstämning, nästa års ingående balans och betalning efter årsskifte. Resultat/balans/reskontra ska stämma efter varje steg.
5. **Kontantmetoden i SEK:** full/partiell betalning samma år; obetald kund- och leverantörsfaktura över årsskifte; delbetald faktura med bokslutsrest; kredit och återbetalning; låsta/fastställda perioder.
6. **Kontantmetoden med valuta:** först när ovanstående kedjor kan kombineras utan dubbel moms eller dubbel valutakursdifferens.

Automatiska tester ska kontrollera både journaler och kvarvarande affärsbelopp, inte bara att en knapp fungerar. Browserprov ska omfatta språkformaterade belopp, kursinmatning, PDF/utskrift, omladdning och att fel inte lämnar halvskrivna betalningshändelser.

## Kontrollerade rättskällor och kvarstående regelgranskning

Följande lagtext lästes den 23 oktober 2026. Den ger ramen; redovisningsprinciper, BAS-mappning och samtliga specifika affärsfall behöver dessutom granskas mot valt K-regelverk och skatteregler före skarp användning.

- [Bokföringslag (1999:1078), 4 kap. 6 §](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/): gemensam redovisningsvaluta; särskilda förutsättningar för euro och byte av redovisningsvaluta.
- Samma lag, **5 kap. 2 §**: företag vars årliga nettoomsättning normalt uppgår till högst tre miljoner kronor får under angivna förutsättningar vänta med bokföring till betalning; obetalda fordringar och skulder ska ändå bokföras vid årets utgång.
- [Mervärdesskattelag (2023:200)](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/mervardesskattelag-2023200_sfs-2023-200/), **8 kap. 21–23 §§**: omräkning av valuta och tillämplig kurs; **17 kap. 29 §**: fakturans momsbelopp i SEK eller, när företaget har redovisning i euro, EUR; **7 kap. 28 och 42 §§**: valutabelopp vid redovisning av utgående respektive ingående skatt.

**Beslutspunkt:** börja med EUR/USD-fakturor för ett SEK-redovisande företag och granskade momstyper. Behåll nuvarande spärr för kontantmetoden tills betalnings- och årsskiftesmodellen ovan finns på plats. Planen i detta dokument är inte en funktions- eller regelefterlevnadsförsäkran.
