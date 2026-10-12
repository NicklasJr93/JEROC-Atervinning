# JEROC – personal i mobilappen 0.5.0

Mobilappen och Expo Go använder samma vyer och serverdata. Kontorets version är
fortsatt **0.17.0**. De [statiska mockuperna](mockups/mobil-huvudvyer/README.md)
är designreferensen; chefens granskning och saldoregler byggs i en senare etapp.

## Fyra gemensamma flikar

- **Hem:** dagens arbetspass och jobb, Gårdsarbete, Mina uppdrag och Schema & tid.
  Pågående arbete kan återupptas. Ingångarna styrs av personens behörigheter.
- **Schema:** dag, vecka och månad. Vald dags arbetspass, registrerad frånvaro
  och tilldelade jobb visas under kalendern. Ett jobb öppnar samma arbetsorder.
- **Tid:** månadskalender med faktiskt registrerade timmar. Välj en dag för att
  se tid per arbetsorder eller aktivitet, registrera manuellt eller ansöka om ledighet.
- **Profil:** kontaktuppgifter, lösenordsbyte och utloggning. Behöriga ansvariga
  kan även hantera personalkonton och timkrav.

Inloggade vyer har sidrubrik och nödvändiga tillbaka-knappar. Logga,
aviseringsklocka och extra profilgenväg har tagits bort från sidhuvudet.
Inloggningssidan behåller loggan. Gårdsarbete öppnar det befintliga material-,
fordonsvåg-, kund- och vägningsflödet; färdiga vägningar delas fortsatt med kontoret.

## Inloggning och timkrav

Appen kräver personligt användarnamn och lösenord. Servern kopplar sessionen
till en aktiv anställd och personens befintliga användarkonto, förarprofil och
anläggningar. Lösenord hashas och sessionen ligger i en HttpOnly-cookie.
Spärrade eller ändrade konton avslutar åtkomst; browserns tidigare demoval ger
inte en annan identitet när en personalsession används.

Lägg upp personen och det kopplade användarkontot under **Personal** på kontoret.
Systemadmin eller VD kan därefter skapa mobilens lösenordsinloggning under
**Profil → Personalkonton**. VD kan inte ändra en systemadministratörs konto.
Kontorets valbara demoinloggning är fortfarande separat.

**Profil → Timkrav för personal** erbjuder krav enligt arbetsschema eller ett
fast antal timmar per arbetsdag. Systemadmin kan administrera personal inom
sin anläggningsåtkomst. Övriga ansvariga behöver uttrycklig `employmentWrite`
och ansvar för personen; VD med denna rättighet har bredare åtkomst inom sina
anläggningar. En ansvarig kan inte ändra sitt eget timkrav utan Systemadmin-nivå.

Standardkravet börjar vid första lyckade mobilinloggningen, inte vid ett äldre
anställningsdatum. Om en ansvarig aktiverar ett krav tidigare gäller det från
aktiveringen. Scheman och anställningsunderlag versionssparas för kravet:
ändringar idag skriver inte om tidigare dagars krav. Deltid räknas från faktisk
veckoarbetstid, och registrerad frånvaro minskar dagens krav utan att bli arbetad tid.

## Faktisk arbetstid och saknade timmar

**Starta arbetstid / Avsluta arbetstid** på Mina uppdrag registrerar verkliga
serverklockslag. Körningens start- och avslutsåtgärder kopplas också till denna
uppdragstid. Ett planerat eller redan avslutat jobb skapar inga timmar utan
verklig start och stopp. Tiden ligger kvar på den som arbetade även om uppdraget
senare tilldelas någon annan. Bara avslutad uppdragstid räknas i totalsumman.

Dötid, gårdsarbete och andra luckor fylls under **Tid → Registrera tid** med
datum, start/slut, obetald rast, aktivitet, anläggning och eventuell arbetsorder.
Egna manuella poster kan ändras eller tas bort med bevarad historik. Servern
avvisar framtida och överlappande tid, andra personers poster och otillåtna
arbetsordrar eller anläggningar. Rast dras av från arbetad tid. Stoppa och
starta uppdragstiden runt faktisk rast; nattpass med rast behöver delas så att
timmarna hamnar på rätt kalenderdag.

Alla datum beräknas i **Europe/Stockholm**. Vid nästa dags användning kontrolleras
den äldsta ofullständiga arbetsdagen sedan kravets aktivering; helger utan
arbetskrav ger ingen spärr. En popup visar krav, registrerat och saknat samt
öppnar rätt dags registrering. Tid och Profil är tillgängliga, inklusive stopp
av pågående uppdragstid. Gårdsarbete och nya uppdragsåtgärder blockeras även på
servern med HTTP **423 / EMPLOYEE_TIME_REQUIRED** tills tillräcklig tid sparats.
Omladdning, lokal cache och offlinearbete kan inte häva spärren.

Ledighetsansökningar sparas som **väntande** och kan återtas. Ansökan skapar
ingen frånvaro eller saldoändring och befriar inte från timkravet. Kontorets
ansökningsgranskning, tidrapportattest, semester-/flex-/kompberäkning och lön
återstår; appen visar inget påhittat saldo.

## Prova i demot

Öppna mobilappen på samma JEROC-server som kontoret, i webbläsare eller Expo Go.
Följande förvalda konton är **endast fiktiva DEMO-konton**:

| Konto | Lösenord | Användning |
| --- | --- | --- |
| `niklas` | `Demo123!` | Gårdsarbete, eget schema och tid |
| `admin` | `JerocDemo2026!` | Personalkonton och timkrav |

1. Logga in som Niklas och prova de fyra flikarna. Öppna Gårdsarbete och skapa
   en vanlig vägning; kontrollera därefter samma färdiga kort på kontoret.
2. Välj en redan passerad tid idag under Tid, spara en manuell post, ändra den
   och ladda om. Kontrollera dagens timmar och aktivitet. En framtida eller
   överlappande post ska avvisas.
3. Logga in som admin i ett separat webbläsarsammanhang. Öppna Timkrav för
   personal och välj Niklas. Välj schema eller ett fast krav och spara.
4. På nästa arbetsdag: om den tidigare dagen har för lite registrerad tid ska
   popupen visas. Fyll luckan och spara; spärren släpper först efter serversvar.
   Ett nytt konto utan tidigare aktivering ska inte låsas för historiska dagar.
5. För en person med förarprofil och tilldelat jobb: starta och stoppa faktisk
   uppdragstid, kontrollera posten under Tid och komplettera en separat lucka
   manuellt. Att bara boka jobbet ger ingen arbetad tid.
6. Skicka en ledighetsansökan under Tid och kontrollera att den är väntande,
   går att återta och inte ändrar timkrav eller semester-/flex-/kompsaldo.

Inga nya Render-variabler behövs. Befintlig **DATABASE_URL** används.
`personnel`, `personnelAuth` och den nya domänen `employeeTime` sparas i samma
PostgreSQL-aggregat med tidsposter, uppdragspass, kravhistorik och händelselogg.
Lagringen tar med hela domänen utan en separat lista över nya attribut; en
fullständig databasdump omfattar därför också dessa uppgifter. En komplett
backup- och återställningsfunktion med tidsbestämt återställningsmål är fortfarande
en separat planerad uppdatering.
