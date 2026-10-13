# ScrapPilot – hemskärmen i mobilwebb 0.11.0

Hem bygger vidare på den [godkända bildmockupen](mockups/mobil-hemskarm/README.md).
Mobilwebben och Expo Go visar samma hemskärm.

## Dagens överblick

Hälsningen följer tiden i Stockholm. Anläggningsväljaren ligger kvar och
Skrotis kikar fram vid sidhuvudet. Bilden är en optimerad transparent WebP
på cirka 25 kB, härledd från den befintliga maskoten. En kort introduktion
respekterar inställningen för minskad rörelse.

Din dag visar personens arbetspass och egna uppdrag för idag. Nästa uppdrag
är ett av dagens ofärdiga, tilldelade uppdrag; avbokade uppdrag tas inte med.
Utan bokade uppdrag eller arbetspass visas ett tydligt tomt läge.

Personer som har stämpelklockan aktiverad får klockan i dagskortet. Samma
serverkommandon, rättigheter, felhantering och skydd mot dubbla tryck används
som under Tid. Rast och arbetstid hålls åtskilda. Tidsindikatorn använder
dagens verkliga krav när sådant finns; ett åttatimmarsmål förutsätts inte.
Den befintliga klockraden och genvägen till Tid finns kvar.

## Egna invägningar

Din insats idag visar antalet egna färdiginsända mobilvägningar och deras
sammanlagda nettovikt för vald anläggning. Texten är **Invägt**, eftersom
detta inte är en summering av bekräftade miljömottagningar.

Den lilla sammanfattningen `homeActivity` beräknas på servern och innehåller
bara `date`, `siteId`, `completedWeighings` och `weighedKg`. Serverns
privata kvittensindex `metadata.mobileSubmissionReceipts` sparar faktisk
användare, serverdatum, anläggning och fryst nettovikt vid vanlig inlämning.
Browserns användarval, namn, kortets redigerbara audittext eller egen
tidsstämpel kan inte skapa en sådan kvittens.

Sammanfattningen gäller vanliga färdiginsända mobilvägningar. Utkast,
rättelsekort och arbetsorderutkast utan verifierad mobilmottagning ingår inte.
Olika kort som hänvisar till samma mobilkälla räknas en gång. Historiska
källor utan serverkvittens lämnas utanför; befintliga äldre viktkort fylls
inte automatiskt tillbaka. Dagens statistik börjar därför räknas för nya
inskickade vägningar efter denna uppdatering. Om originalet eller dess
mobilkälla tas bort ogiltigförklaras kvittensen. En klientimport kan inte
återaktivera den.

Anläggningen måste ingå i både personens och användarkontots aktuella
åtkomst. Kunduppgifter, priser, andra personers siffror och rå historik följer
inte med. Saknad eller inaktuell sammanfattning visas inte som dagens värden.
Vald anläggning anges vid siffrorna. En begäran om prisändring från kunden
tar inte bort en redan utförd invägning från denna historiska summering.

## Genvägar och fortsatt snabb start

Väg in öppnar det befintliga valet av material- eller fordonsvåg. Gårdsarbete
och Mina uppdrag visas efter samma behörigheter som tidigare. Pågående
arbete och vägningar kan fortsatt återupptas. Tidsspärren och skyddet för
låsta vägningar gäller även när man går via en genväg.

Bottenmenyn är fortsatt Hem, Schema, Tid och Profil. Hem använder den
befintliga lätta dagsvyn; månadsdata hämtas först i Schema och Tid.
Sekundräknaren uppdateras lokalt och gör inte nätverksanrop varje sekund.
En återkomst till Hem uppdaterar den lilla dagsvyn. När en färdig vägning
bekräftas av servern uppdateras siffrorna även om användaren hunnit återvända
innan sparningen slutförts. Bekräftelsen binds till samma bolag och person.
Inga nya integrationer, paketberoenden eller Render-variabler behövs.
