# ScrapPlanner – användarmanual

För kontoret, gårdspersonalen och företagets administratör. Genomgången mot
kod och funktionsbeskrivningar är daterad **20 oktober 2026**. Menyval och
knappar visas efter kontots behörigheter och företagets aktiverade funktioner.

| Jag vill… | Läs här |
| --- | --- |
| Lägga upp företaget, personal eller en ny kund | [Kontoret och företagets inställningar](kontoret.md) |
| Väga material eller fordon och låta kunden fylla i sina uppgifter | [Vägning och kunduppgifter](vagning-och-kunduppgifter.md) |
| Skicka avräkning för godkännande och få PDF efter attest | [Vägning och kunduppgifter](vagning-och-kunduppgifter.md#kundgodkännande-och-attest) |
| Arbeta som systemadmin och följa tjänsteförbrukning | [Systemadmin](systemadmin.md) |
| Konfigurera en integration eller felsöka servern | [Teknisk dokumentation](../README.md) |
| Prova den fristående bokföringsdemon | [Bokföringsdemo](../../bokforing/README.md#klickbar-demo) |

## Prova bokföringsdemon

Efter publicering öppnas demon på
[app.scrapplanner.com/bokforing](https://app.scrapplanner.com/bokforing)
utan inloggning. Välj **Granska underlag**, kontrollera fakturan och ändra
konteringsraderna. **Godkänn och bokför** aktiveras när debet och kredit
balanserar; övriga fel förklaras vid bokföringsförsöket. Följ sedan posten i
**Bokföring**, **Moms** och **Rapporter**. I **Bank** kan du prova matchning.

**Fråga Ande** öppnar en demoassistent med exempelbaserade svar.
Ändringarna sparas i den egna webbläsaren. **Återställ demo** tar tillbaka
exempeluppgifterna efter bekräftelse. Allt avser Exempelbolaget AB och används
för att prova arbetsflödet; inga verkliga underlag eller betalningar hanteras.

## Logga in och hitta rätt

Kontoret öppnas på [app.scrapplanner.com/kontor/](https://app.scrapplanner.com/kontor/).
Använd ditt personliga användarnamn eller din registrerade e-postadress och
ditt lösenord. Ett nytt personalkonto behöver först aktiveras enligt
inbjudningsmejlet eller instruktionen från administratören.

Mobilwebben finns på [mobile.scrapplanner.com/mobil/](https://mobile.scrapplanner.com/mobil/).
Bolaget identifieras automatiskt från det personliga kontot vid inloggningen. Samma mobilvy kan öppnas
i Expo Go via [QR-sidan](https://app.scrapplanner.com/expo-go); se
[instruktionen för Expo Go](../expo-go-live.md#öppna-appen). Systemadmin har ett
separat bolagsval efter inloggning.

I kontoret finns profil och **Logga ut** längst ner i vänstermenyn. Öppna
profilmenyn för **Min profil** och din registrerade återställningsadress.
En vanlig verksamhetsanvändare har ingen extra översta systemadminrad.

Välj **Glömt lösenord?** på kontorets inloggningssida om ditt konto omfattas
av återställningen. Ett mejl med engångslänk låter dig välja och bekräfta
ett nytt lösenord; lösenord skickas inte i mejlet. Saknas registrerad adress,
eller fungerar inte återställningen för kontot, kontakta företagets administratör.
Se [återställningsflödet och vilka konton det omfattar](../losenordsaterstallning.md).

## Den vanliga arbetsgången

1. Kontrollera rätt **Anläggning** och starta invägningen.
2. Välj material och ange vikt; för fordon sparas infart och sedan utfart.
3. Koppla en befintlig kund, skapa en ny eller låt kunden fylla i uppgifter.
4. Spara färdig vägning. Kontoret granskar kund, vikter, material, priser och
   betalningsuppgifter.
5. Kunden granskar avräkningen via terminal, SMS eller mejl. Kunden väljer
   **Godkänn**, visar legitimation och personalen bekräftar kontrollen.
6. Behörig person attesterar separat. Följ dokument, eventuell Spiris-status
   och utbetalningsstatus i kontoret.

Kunduppgiftsformuläret, kundgodkännandet och intern attest är tre olika steg.
En skickad länk eller leverantörens utskicksbekräftelse är inte ett godkännande.

## Om något inte går

| Det du ser | Vad du gör |
| --- | --- |
| En knapp är grå eller en meny saknas | Läs meddelandet vid knappen. Be VD eller administratör kontrollera behörighet, anläggningsåtkomst och eventuella obligatoriska uppgifter. |
| Registeruppslag eller adressförslag saknas | Kontrollera numret/adressen och fyll i uppgifterna manuellt om tjänsten inte svarar. Uppslaget sparar inte kunden åt dig. |
| En kundlänk inte längre fungerar | Öppna den ursprungliga länken från meddelandet. Be personalen kontrollera om ärendet avslutats, ersatts eller gått ut. |
| Sparandet misslyckas eller sidan visar en versionskonflikt | Behåll inmatningen och läs felmeddelandet. Kontrollera aktuell version innan du försöker igen. |
| Ett SMS/mejl har osäker status | Be administratören kontrollera utskicket innan ett nytt meddelande skickas. |

## Funktioner som kräver separat anslutning

BankID används inte i det nuvarande kundgodkännandet; fysisk legitimation
kontrolleras av personalen. Swish i kundens uppgiftsformulär visas som
**Kommer snart**. Automatisk bank-/Swish-utbetalning och koppling till en fysisk
våg ska inte antas vara aktiverade för att det finns en mockup eller en
integrationssida. Spiris, utskick och andra externa tjänster behöver vara
anslutna och aktiverade i rätt företagsmiljö.

För beslutade ändringar och leveranshistorik, se [Ändringslistan](../Andringslistan.txt).
