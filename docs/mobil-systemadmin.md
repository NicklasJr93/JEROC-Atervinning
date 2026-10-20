# Systemadmin i mobilappen och Expo Go

Systemadmin kan logga in på mobilens vanliga inloggningssida, välja ett aktivt bolag och arbeta i mobilappen med sin egen systemadminbehörighet. Samma flöde används i Expo Go och mobilwebben. Det är ett skrivbart arbetsläge, inte ett skrivskyddat visningsläge.

## Arbetsgång

1. Öppna mobilappen och logga in med systemadminkontots användarnamn eller e-post och lösenord.
2. Om kontot kräver lösenordsbyte görs det direkt i mobilappen innan verksamheten öppnas.
3. Välj bolag och öppna arbetsytan.
4. En remsa visar att systemadmin arbetar i det valda bolaget. Använd **Byt bolag** för att återgå till bolagsvalet eller **Logga ut** för att avsluta sessionen.

Vanliga personalkonton fortsätter logga in direkt till det bolag kontot tillhör. Bolagslistan visas bara för en autentiserad plattformssystemadmin.

## Behörighet och personalkoppling

Systemadmin behöver ingen egen anställning, personalsida eller mobilkontopost i varje bolag. Servern använder den befintliga systemadminidentiteten och en tillfällig mobilkontext för det valda bolaget. Att öppna appen skapar inte anställning, arbetsschema, timkrav eller stämplingar för administratören.

Operativa arbetsflöden, till exempel gårdsarbete och vägning, får skriva i det valda bolaget med ordinarie verksamhetskontroller. Personliga funktioner som egen sjukfrånvaro, eget lösenordsbyte för en anställd och egen stämpling bygger på ett verkligt personalkonto och används inte som administratörens egen personalprofil. Systemadminens lösenord hanteras av plattformens konto.

Den egna förarens körjournal och fordonsvy hör också till personalkontot. Supportläget hämtar inte dessa uppgifter och öppnar inte dialogen för att komplettera egna resor. Direkta personliga fordonslänkar återgår till startsidan. Vanliga medarbetares körjournalsspärr och kontroller vid nätfel är kvar; bolagets gemensamma fordonsadministration finns i kontorsvyn.

## Session och bolagsisolering

- Inloggningen och bolagsbytet använder plattformens befintliga privata sessioner.
- Servern kontrollerar systemadminrollen; en klientheader, personidentifierare eller bolagsparameter ger inte denna behörighet.
- Skrivningar kräver sessionsskydd och den aktuella bolagsgenerationen. Föregående bolagsvy och gamla flikar får inte skriva efter bolagsbyte eller utloggning.
- Avstängt konto, återställning av lösenord, utgången session och avstängt bolag tar bort åtkomsten.
- Mobilens återhämtningsdata och hämtade vyer hålls åtskilda per bolag och användarkontext.
- Systemadminens åtgärder ska kunna följas till det autentiserade plattformskontot och det valda bolaget. Inloggningshemligheter och råa verksamhetspayloads hör inte hemma i stödets revisionslogg.

Skrivförsök registreras i plattformens revisionslogg med faktisk användare, bolag, generation, begäransidentifierare, API-väg och utfall. Dessa särskilda mobilposter behålls i högst 90 dagar och högst 20 000 poster. Verksamhetens ordinarie historik finns kvar i bolagets datalager. Servern kontrollerar dessutom supportkontexten under databastransaktionen och före commit, så att en fördröjd begäran från ett tidigare bolag inte sparas efter ett bolagsbyte.

## Drift och prov

Inga nya Render-nycklar behövs. Stödet använder den aktiverade [Expo Go-kopplingen](expo-go-live.md), befintlig plattformsinloggning och bolagens befintliga datalager.

Automatiska prov använder två isolerade testbolag och kontrollerar systemadmininloggning, bolagsbyte, verkliga skrivningar, ordinarie personalinloggning och avvisning av gamla eller förfalskade sessioner. Inga riktiga kunduppgifter behöver ändras för att verifiera driftsatt version.
