# Telematikenheter – bildmockuper

**[Samlad bildöversikt för fordon, app, körjournal och GPS-enheter](../fordon-telematik/README.md).**

Tre statiska bildmockuper framtagna 2026-10-16. Antal, enhetsuppgifter och fordonskopplingar är exempeldata. JEROC Återvinning AB används som bolagsexempel; övriga bolag är fiktiva. Vyerna beskriver ett förslag och är inte implementerad funktion; denna leverans innehåller ingen ny appkod.

1. [Systemadmins enhetslager](01_Systemadmin_Enhetslager.png) – centralt förberedda puckar, import, enhetsprofiler och bolagstilldelning av flera enheter samtidigt.
2. [Bolagets GPS-enheter](02_Bolag_GPS_enheter.png) – bolaget ser bara sina tilldelade enheter, uppdelade i kopplade och okopplade, samt QR-aktivering.
3. [Koppla puck till fordon](03_Koppla_puck_till_fordon.png) – sökbart val av ett befintligt fordon med registreringsnummer och tydlig bekräftelse av kopplingen.

## Navigation och prioritering

Förtydligat med användaren 2026-10-16: **Fordon & maskiner öppnar alltid den vanliga fordonsöversikten**, enligt [fordonsmockuperna](../fordonsadministration/README.md). Fordon, maskiner och den dagliga verksamheten är huvudfokus.

**GPS-enheter är en sekundär flik** i samma arbetsyta, tillsammans med befintliga flikar för service/besiktning, felanmälningar och dokument. Den ska inte vara en egen huvudpost i bolagets vänstermeny eller ersätta fordonslistan. Bild 2 och 3 visar innehållet efter att denna flik har öppnats; fliknavigationen behöver läggas till vid implementation.

Enhetslager, aktivering och koppla/byta puck används vid behov av personer med behörighet, exempelvis VD eller administratör. Relevant position och anslutningsstatus kan visas på det vanliga fordonskortet utan att användaren behöver gå till enhetsadministrationen. Systemadmins centrala lager ligger fortsatt under plattformens Telematik och är separat från bolagets dagliga fordonsvy.

Bolagstilldelning sker före kundaktivering med QR-engångskod. IMEI är en identifierare och används inte som autentisering. Livscykelstatus, exempelvis förberedd eller levererad, visas separat från anslutningsstatus och senaste kontakt. Vid fordonsbyte flyttas inga tidigare resor till det nya fordonet.

Mockuperna är separata från den redan byggda digitala testbilen och dess mottagare. Se [telematikens integrationsdokumentation](../../integrationer/telematik/README.md) för den befintliga lösningen.

Modellnamnen är exempel i gränssnittet; fordonskompatibilitet avgörs separat vid val av hårdvara.

## Systemadmins enhetslager

![Systemadmins enhetslager](01_Systemadmin_Enhetslager.png)

## Bolagets egna GPS-enheter

![Bolagets GPS-enheter](02_Bolag_GPS_enheter.png)

## Koppla en ledig puck till fordon

![Koppla puck till fordon](03_Koppla_puck_till_fordon.png)
