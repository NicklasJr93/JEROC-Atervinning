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
utan inloggning. Den utökade versionen använder fiktiva uppgifter för
**Åkes Hantverk AB**. Börja i **Kundfakturor**, välj ROT-utkastet och granska
raderna. Utfärda fakturan och registrera kundens del av betalningen. Därefter
kan du förbereda en ROT-demobegäran, registrera ett demobeslut och en
simulerad skatteutbetalning. Se [hela ROT-övningen](../../bokforing/README.md#prova-ett-sammanhängande-rot-flöde).

En faktura öppnas nu på en egen sida. **Ny kundfaktura** och **Redigera**
öppnar en stor arbetsyta med kund- och leveransuppgifter, betalningsvillkor,
referenser, fakturarader och summering. Ange radrabatt eller fakturarabatt,
pris inklusive/exklusive moms och eventuella avgifter där. På ROT-fakturor
markerar du vilka arbetsrader som ger underlag; material och avgifter ingår inte.
**Spara utkast** tar dig till fakturans sida. Där finns utfärdande, kopiering,
betalningar och **Skriv ut / spara PDF**. Lämnar du ett osparat utkast visas
en varning. Se [faktureringens omfattning och återstående delar](../../bokforing/fakturering-jamforelse.md).

I **Projekt & offerter** kan du registrera tid/material och skapa offert.
**Inköp** hanterar leverantörsfakturor. Välj en befintlig kontohändelse i
betalningsformuläret om betalningen redan finns i **Bank & kassa**.
**Lön**, **Inventarier**, **Materiallager** och **Periodisering** har egna
granskningssteg. **Bokföring**, **Moms & ROT** och **Rapporter** följer samma
verifikationer. **Bokslut** visar återstående avstämningar och periodlåsning.

**Fråga Ande** öppnar en demoassistent med exempelbaserade svar.
Ändringarna sparas i den egna webbläsaren. **Återställ demo** tar tillbaka
exempeluppgifterna efter bekräftelse. Inga verkliga betalningar, fakturor,
ROT-begäranden eller deklarationer skickas. Löne- och skattebelopp bygger på
angivna demoantaganden. Läs [omfattning och avgränsning](../../bokforing/README.md#den-här-versionens-gränser)
före en genomgång med redovisningskunnig.

I den uppdaterade demon stoppas sparandet vid konflikt mellan flikar eller
lagringsfel. Läs bannern och välj **Läs in senaste** för att fortsätta;
osparade konteringsändringar återställs. En osäker sparningskvittens kan betyda
att bokningen redan finns, så läs in innan du försöker igen. Ogiltiga äldre
demouppgifter ersätts först efter uttrycklig återställning. Stäng och öppna gamla
demoflikar när en ny version publicerats. Utan stöd för samordning mellan flikar
är demon i läsläge.

Den tidigare inköpsdemon finns efter publicering på
`/bokforing/klassisk.html`. Dess sparade exempel påverkas inte av den nya
ekonomidemon eller dess resetknapp.

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
