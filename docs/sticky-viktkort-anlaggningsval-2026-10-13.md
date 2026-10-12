# Kontor 0.21.0 och mobilwebb 0.8.0

Bygget genomför ÄL 096, 097 och 100. Befintliga viktkort och deras anläggningar
behålls. Inga nya Render-variabler behövs.

## Gemensamma rubrikpartier

Kontorets vanliga list- och detaljvyer använder `OfficePageHeader`. Titel,
breadcrumbs, tillbaka-knapp och huvudåtgärder ligger kvar vid scrollning. På
listvyer ingår flikar och sök/filter. Nyckeltal, tabeller och formulär scrollar
under överdelen. Höjden på toppfält och supportläge mäts så att ytorna inte
överlappar; låga och smala skärmar får en kompakt överdel.

Artikelöversiktens befintliga listscrollning och transportkalenderns särskilda
layout behålls. Utskrifter och dialoger använder sina egna scrollregler.

## Viktkortslistor

Klick på raden öppnar kortet direkt i Invägningar, Attest, Utbetalningar,
kundgodkännanden och översiktens viktkortslista. Kortnumret är en vanlig länk
som också kan öppnas i ny flik. Tangentbord stöds och separata radåtgärder,
exempelvis granskning av en äldre kundgodkännandeversion, behåller sitt beteende.

Förhandsvisningen under tabellen och den extra Visa-kolumnen har tagits bort.
Efter 400 ms hover visas en kompakt ruta med högst tre materialrader,
ursprung, referens och nästa steg. Den använder redan hämtade, behörighetsstyrda
uppgifter, håller sig inom skärmen och stängs vid lämning, Escape eller
navigering. På touch öppnar tryck kortet utan hoverruta.

Tillbaka-knappen och webbläsarens Bakåt återställer ursprunglig kö/flik,
sökning, filter och scrollposition inom samma bolag och användarsession.

## Mobilens anläggningsval

Hem och Gårdsarbete visar samma kompakta anläggningsval uppe till höger.
Anläggningarna måste vara aktiva och tillåtna både i personprofilen och det
kopplade användarkontot. Med en enda tillåten anläggning visas bara dess namn.

Valet sparas på servern per bolag och person. Om behörighet eller aktivstatus
ändras används ett giltigt val från de kvarvarande anläggningarna. Finns inga
kan ingen ny invägning startas. Byte kräver anslutning; appen visar tydligt
när ett byte inte kan sparas.

Samma effektiva anläggningsbehörighet används för tidrapportering och
tilldelade uppdrag. Redan arbetade timmar behålls om behörigheten ändras,
medan uppgifter om ett uppdrag utanför aktuell åtkomst döljs.

Nya utkast får ett explicit anläggnings-ID vid skapandet. Servern kontrollerar
behörigheten och låser kortets anläggning för efterföljande sparningar.
Påbörjade, färdiga och offline-sparade kort flyttas inte vid gårdsbyte. Äldre
utkast återanvänder den sparade serverkopplingen eller sitt redan skapade
viktkort. Saknas bevis för en äldre lokal posts anläggning bevaras den i
importarkivet för granskning i stället för att ges användarens nya gård.

Kontoret visar anläggningens registrerade namn även för nya anläggningar.
Miljö/lager och ekonomi använder viktkortets sparade ID, inte personens senare
aktiva val.

### Prova

1. Ge testpersonen Norrtälje och Rimbo på personprofilen och det kopplade
   kontots anläggningsbehörigheter under Personal. Logga in i mobilen igen.
2. Starta ett utkast i Norrtälje. Byt till Rimbo på Hem eller Gårdsarbete.
3. Fortsätt det första utkastet; dess anläggning ska vara Norrtälje. Starta
   en ny invägning; den ska tillhöra Rimbo och få samma koppling i kontoret.
4. Öppna ett viktkort långt ner i en filtrerad kontorslista och gå tillbaka.
   Listan ska behålla sökning, flik, filter och scrollposition.

Verifiering körs lokalt med isolerade data och mockade externa svar. Byggets
kontroller skickar inga NVV-rapporter, Spiris-underlag eller utbetalningar.

## Genomförd verifiering

- Produktionsbygge med TypeScript/Vite samt Expo-typkontroll passerade.
- Sju fokuserade webbläsarfall för sticky rubriker och sju för radklick,
  hover, touch, tangentbord, behörigheter och återställning av kö passerade.
  Layoutproven använder mockade tjänstesvar.
- Två mobilprov mot riktig lokal API-server med egna SQLite-register och
  privat testinloggning passerade: enkel anläggning/full invägning samt flera
  anläggningar, flera personer, omladdning, offline och misslyckat byte.
- Sju nya serverfall verifierade sparad anläggning, kundbolagets egna namn,
  lagerrörelse, återimport, äldre utkast och manipulerade ID:n. Riktade
  befintliga mobil-/kund-/pris-/arbetsorderfall passerade.
- Alla 22 befintliga tidmotorfall och riktade API-prov för återkallad eller
  motstridig anläggningsbehörighet passerade. En separat granskning provade
  och verifierade avvisning av förbjudna tid- och uppdragsåtgärder.

Detta är riktad verifiering av byggets ändringar, inte en körning av hela
projektets äldre UI-svit eller ett nytt externt NVV-/Spiris-test.
