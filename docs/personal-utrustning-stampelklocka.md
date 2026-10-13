# Utrustning och stämpelklocka

Kontor 0.26.0 och mobilwebb 0.9.0. Inga nya Render-variabler behövs.

## Stämpelklockan

Öppna **Personal → en anställd → Tidrapportering**. Välj **Stämpelklocka**
som tidskälla och spara. Befintliga personer behåller arbetsorder och manuell
tid tills inställningen ändras. Läsning och ändring kräver respektive
anställningsbehörighet för båda användaridentiteterna och personens anläggningar.
Uppdatera eller öppna mobilappen på nytt efter ändringen.

Om det redan finns registrerad tid under dagen börjar ett byte av tidskälla
tidigast följande dag. Tidigare dagar behåller sin källa och sina timkrav.
Ett öppet stämpelpass måste hanteras innan klockan kopplas bort.

- Hem visar ett kort för **Stämpla in**, **Ta rast**, **Återuppta arbete**
  och **Stämpla ut** för personer med klockan aktiverad.
- Den smala statusraden följer med mellan mobilens sidor. Grönt betyder arbete,
  orange rast och rött utstämplad. Dagar utan schemalagd tid använder grått.
  Tryck på raden för att öppna Tid.
- Tiderna sparas på servern. Appen behöver inte vara öppen för att passet ska
  fortsätta. Sekundvisningen sker lokalt och gör inga anrop varje sekund.
- Arbetsorder och manuell tid beskriver hur närvarotiden fördelas. De läggs
  inte ovanpå stämpeltiden. Tid som inte fördelats visas separat.
- Under Tid visas dagens pass och raster. Missad stämpling rättas med verkliga
  datum/klockslag, raster och anledning; tidigare värden finns kvar i historiken.
  Ansvarig kan rätta ett pass på personalkortets Tidrapportering med rätt behörighet.
- Spärren för en ofullständig tidigare arbetsdag använder den dagens tidskälla.
  Tid och Profil samt avslut/rättelse av klockan fungerar även när spärren visas.

Svensk tidszon används. Framtida och överlappande pass avvisas. Revisioner och
anrops-ID gör att dubbla tryck eller samma återförsök inte skapar extra pass.
Detta är tidsregistrering; löneberäkning och tidrapportattest är separata senare steg.

## Utrustningen

**Utrustning** i vänstermenyn visar registrerade prylar. Personalkortets
**Utrustning** visar personens utlämnade saker och historik.

1. Registrera en fysisk pryl med unikt inventarienummer, namn, kategori och
   anläggning. Serienummer och beskrivning är valfria.
2. Lämna ut den till en aktiv anställd på samma anläggning. Tid, ansvarig och
   eventuell notering sparas. Samma pryl kan bara vara utlämnad en gång.
3. Registrera återlämning och välj om prylen kan lämnas ut igen eller behöver
   service/kontroll. Utlämningen och återlämningen finns kvar i historiken.
4. Den anställde öppnar **Profil → Min utrustning** i mobilen för att se sina
   saker och sin lånehistorik. Mobilvyn registrerar inga utlämningar eller returer.

Kategorierna är telefon, verktyg, skyddsutrustning, nyckel och övrigt.
Läsning kräver **Läsa utrustning och utlämningshistorik**. Utlämning, retur och
redigering kräver även **Registrera, lämna ut och återlämna utrustning**.
Systemadmin ärver rättigheterna; övriga konton får dem uttryckligen under Konton.

Tilldelad utrustning måste återlämnas före flytt till en annan anläggning.
Historiken behåller tilldelningens ursprungliga anläggning. En senare innehavares
uppgifter visas inte i den tidigare innehavarens mobilhistorik.

## Lagring

Klocka, timkrav och rättelser sparas i bolagets `employeeTime`-domän;
utrustningen i en separat `equipment`-domän. De använder befintlig
PostgreSQL-lagring och ingår i en databasdump. Privat utrustnings- och klockdata
läggs inte i de generella kontors-, mobil- eller transportplaneringspaketen.
De nya funktionerna skickar inga uppgifter till Spiris, NVV eller externa tjänster.

## Verifiering

33 tidsdomäntester, 12 utrustningsdomäntester och 6 HTTP-/databastester passerar.
44 befintliga regressionsfall för personal, mobilinloggning och bolagsisolering
passerar. Den befintliga PostgreSQL-schemajämförelsen är villkorligt hoppad
eftersom en isolerad testdatabas saknas; HTTP-flödena är körda med lokal SQLite.
11 riktade browsertester verifierar mobilklocka, timinställningar, utrustning och
återkallad åtkomst med kontrollerade API-svar. Produktionens bygge och
Expo-typkontrollen passerar. Inga befintliga personers verkliga timmar eller
utrustning har ändrats genom provkörningarna.
