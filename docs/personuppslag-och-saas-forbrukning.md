# Personuppslag och SaaS-förbrukning

Nya kunder kan kompletteras med namn och folkbokföringsadress från
Roaring Person 2.0. Uppslaget används i kontorets nya kundkort, snabbvalet
för ny kund på ett vågkort, mobilens nya kund och kundens egna formulär
via SMS eller terminal. Att välja en befintlig kund använder företagets
eget register. Befintliga kundkort gör inga automatiska externa uppslag
när de redigeras.

Ett giltigt personnummer med **tolv siffror**, inklusive århundrade,
krävs för personuppslag på servern. I nya kundformulär kompletteras
ett giltigt tiosiffrigt personnummer automatiskt efter en kort paus
eller när användaren lämnar fältet. Det fullständiga numret visas och
kan ändras innan uppgifterna sparas. Samordningsnummer fylls i manuellt
tills vidare. Numrets typ styr tjänsten, även när en enskild firma
använder personnummer. Organisationsnummer hanteras fortsatt av SCB.

Kompletteringen väljer det senaste giltiga födelsedatumet som inte ligger
i framtiden, räknat med dagens datum i Stockholm. Plustecken betyder att
hundraårsåret redan inträffat eller infaller i år. Kontrollsiffran ensam
kan inte avgöra århundradet; personer över hundra år behöver ange plus
eller sitt fullständiga nummer. Skottår kontrolleras för det valda året.
Ett uttryckligt tolvsiffrigt nummer och befintliga sparade kundkort
ändras inte automatiskt.

Skriver användaren tolv siffror ska kompletteringen inte bryta in efter
den tionde. Ett tvetydigt prefix som kan vara början av YYYYMMDDNNNN
väntar därför tills fältet lämnas. Markering, pågående textinmatning
och ändringar mitt i numret får inte avbrytas av en timer. Enter/spara
kompletterar först så att validering och sparande ser samma nummer som
fältet. Roaring får endast det färdiga numret; inga extra århundraden
provas genom köpta uppslag.

SMS- och terminalformulären fyller tomma, orörda fält automatiskt.
Personalen granskar en träff i kontorets och mobilens nykundsformulär
innan uppgifterna används. Telefonnummer, e-post och bankkonto kommer
inte från Roaring. Uppslaget är ingen legitimering eller BankID-kontroll.
Skyddade eller olämpliga/ofullständiga personuppgifter lämnas inte ut av
hjälpen; formuläret kan alltid fyllas i manuellt.

## Användning och fakturaunderlag

Systemadministrationen har panelen **Förbrukning & fakturaunderlag**.
Välj kalendermånad och eventuellt bolag för antal uppslag, bekräftat
belopp och fakturarader. CSV-exporten följer samma urval. Månaden räknas
i svensk tid. Även ett bolag utan uppslag kan väljas och visas med nollor.

- Försäljningspris: **2,00 kr exklusive moms per bekräftat personuppslag**.
  Inköpskostnaden lagras separat från kundpriset.
- Bekräftade träffar och bekräftade svar utan träff räknas. Ett bekräftat
  uppslag som kräver manuell hantering kan också räknas, utan att
  personuppgifterna exponeras. Fel och osäkra utfall visas separat för
  granskning och ingår inte i bekräftade fakturarader.
- OAuth-inloggning till Roaring, ogiltiga nummer, intern kundmatchning
  och anrop som stoppas före leverantörsanropet debiteras inte.
- Varje försök har ett unikt ID. Samma försök får bara en beständig
  utskicksreservation, även vid samtidiga anrop eller efter omstart.
  Ett tappat svar ger därför ingen automatisk ny köpt slagning; fyll i
  manuellt om det tidigare svaret inte längre finns i formuläret.
- Priset sparas tillsammans med händelsen. En framtida prisändring
  ändrar inte tidigare månaders registrerade priser.
- Journalen sparar bolag, tjänst, försök, aktör, tidsstämplar, utfall och
  belopp. Personnummer, namn, adresser och råa leverantörssvar sparas inte
  i plattformens faktureringsjournal. En nycklad korrelation används för
  att upptäcka ett återanvänt försöks-ID med ett annat nummer.

En reservation görs omedelbart före leverantörsanropet. Ett avbrott i
denna gräns kan inte säkert avgöra om Roaring tog emot anropet. Sådana
försök visas för granskning och skickas inte automatiskt igen.

Panelen och exporten är fakturaunderlag för SaaS-bolagens månadsfakturor.
Ingen faktura skapas eller skickas automatiskt i denna leverans. Journalen
kan bära fler tjänster framöver; SMS och mejl får inga påhittade avgifter.
Endast plattformens systemadmin i systemadministrationen kan läsa
statistiken och exportera den. VD och stödarbete inne i ett bolag ger
inte åtkomst till andra bolags förbrukning.

## Drift

På Render-tjänsten `scrapplanner-app` används servervariablerna
`ROARING_CONSUMER_KEY` och `ROARING_CONSUMER_SECRET`. Produktionsåtkomst
till Person/Population Register behöver vara aktiverad hos Roaring.
Nycklar och OAuth-token lämnas aldrig till klienten.

Den separata användningsjournalen lagras i plattformens befintliga
PostgreSQL-databas genom `DATABASE_URL`, i tabellerna
`jeroc_platform_usage` och `jeroc_platform_usage_private`. Inga nya
driftshemligheter eller separata databaser behövs. Lokala prov använder
SQLite i samma konfigurerade katalog som plattformens register.

Uppslag kräver en aktuell kundregistreringsbehörighet, en aktiv enskild
kundlänk eller rätt parkopplad terminal. Bolag väljs från serverns
autentiserade kontext. Åtkomst och kundträff kontrolleras igen före det
betalda anropet, och åtkomst kontrolleras efter svaret. Delade gränser
per bolag och formulär begränsar upprepade köpta anrop.

## Verifiering

Server- och webbläsarprov använder syntetiska identiteter och simulerad
Roaring-transport. De gör inga skarpa personuppslag och skickar inga
verkliga SMS, mejl eller fakturor. Kontrollerna omfattar beständig
räkning, samtidighet, omstart, månadsgränser, frysta priser, behörighet,
CSV, kundmatchning, de fem nykundsvägarna och sena svar vid bolagsbyte.

Verifierat 2026-10-20 med produktionsbygge, Expo-typkontroll, 103 riktade
serverprov och 36 webbläsarfall. Journalens lagringsprov använder
isolerade SQLite-databaser, inklusive flera anslutningar och omstart.
PostgreSQL-adaptern har granskats; en separat PostgreSQL-testserver
användes inte i de lokala proven.
