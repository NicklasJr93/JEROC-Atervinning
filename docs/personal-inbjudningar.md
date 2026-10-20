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
