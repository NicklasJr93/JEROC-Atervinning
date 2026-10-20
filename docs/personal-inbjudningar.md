# Personliga inloggningar för personal

I **Personal → Lägg till person** är **Skapa inloggning** förkryssad för
behöriga administratörer. Ange personens egen e-postadress och välj
inloggningssätt. E-postadressen blir användarnamn för det personliga kontot.

## Lösenordslänk via mejl

Förvalt alternativ är **Skicka lösenordslänk via mejl**. Först sparas
personprofilen och dess kopplade behörighetskonto. Därefter skickar ScrapPlanner
ett mejl från `noreply@scrapplanner.com` med en personlig aktiveringslänk.
Länken gäller i 24 timmar och kan bara användas en gång. Personen väljer och
bekräftar sitt eget lösenord innan kontot kan användas.

Ett fel vid utskicket raderar inte den sparade personen. Öppna personkortets
**Inloggning & behörigheter** för att kontrollera status och skicka igen.
En ny inbjudan ersätter äldre länkar.

## Rätta stavfel före aktivering

Behåll den befintliga personalposten och kontot så att deras kopplingar finns
kvar. För ett konto som fortfarande visar **Inbjudan skickad**:

1. Öppna personens **Översikt → Kontakt & organisation → Redigera** och rätta
   namn samt e-postadress om även adressen är fel.
2. Öppna **Inloggning & behörigheter**, rätta kontots separata namnfält och
   välj **Spara behörigheter**. Personnamnet och kontonamnet är separata fält.
3. Under **Aktivera konto**, välj **Skicka ny inbjudan**. Den väntande
   plattformsinloggningen uppdateras från personkortet med samma konto- och
   personidentifierare. Den gamla länken ersätts av en ny länk.

Om e-postadressen ändrades använder personen därefter den korrekta adressen
som inloggning och väljer sitt lösenord via den nya länken. Ett redan aktiverat
konto omfattas inte av denna rutin för väntande inbjudningar.

## Tillfälligt lösenord

Alternativet **Ange tillfälligt lösenord** låter administratören ange ett
privat lösenord med 12–200 tecken. Lösenordet skickas inte via mejl och visas
inte igen. Lämna det till personen separat.

Personen loggar först in på kontorets inloggningssida, `/kontor/`, och måste
byta lösenord innan arbetsytan kan öppnas. Efter bytet fungerar samma egna
lösenord i mobilappen. Ett tillfälligt lösenord kan inte användas direkt i
mobilappen för att kringgå det obligatoriska bytet.

## Behörigheter och skydd

- Inbjudan använder det aktuella bolaget från serverns session och mottagarens
  sparade personkort. Webbläsaren kan inte välja ett annat bolag eller annan
  mottagare i utskicket.
- Både faktiskt och valt användarkonto måste få administrera personalens konton
  och omfattas av personens anläggningsåtkomst.
- Inbjudan ger inga ytterligare behörigheter. Kontots aktuella rättigheter och
  anläggningsval styr åtkomsten efter inloggning.
- Ändrad e-post, anläggningsåtkomst, avaktiverad person eller förändrade
  inloggningsuppgifter gör en tidigare aktiveringslänk ogiltig.
- Ett redan aktiverat konto använder **Glömt lösenord?**. Inbjudningsfunktionen
  får inte ersätta lösenordet på ett sådant konto.
- Servern sparar hashvärden för lösenord och aktiveringskoder. Varken
  klartextlösenord eller fullständiga aktiveringslänkar sparas i registret.

Funktionen använder den befintliga Resend-konfigurationen. Inga nya
miljövariabler behövs när systemutskick redan fungerar. `APP_URL` bestämmer
den betrodda HTTPS-adressen till aktiveringssidan.
