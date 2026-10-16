# ScrapPilot – Fordon & maskiner

Tre **statiska bildmockuper**, framtagna 16 oktober 2026 för JEROC Återvinning.
Detta är designförslag med fiktiva fordons-, person-, boknings- och kostnadsuppgifter.
Ingen interaktiv demo eller ny applikationsfunktion ingår i leveransen.

## 1. Fordonsöversikt

[Öppna bilden i full storlek](01_Fordonsoversikt.png)

![Fordonsöversikt](01_Fordonsoversikt.png)

En gemensam översikt för lastbilar, släp, transportbilar och gårdsmaskiner.
Tillgänglighet, ansvarig, anläggning och nästa åtgärd syns direkt i listan.
En kort åtgärdslista lyfter driftspärrade fordon och kommande besiktningar.
Sökning och filter för typ, status och anläggning gör samma vy användbar
även när fordonsparken växer. Hela raden öppnar fordonskortet.

## 2. Fordonskort

[Öppna bilden i full storlek](02_Fordonskort.png)

![Fordonskort](02_Fordonskort.png)

Fordonskortet samlar grunduppgifter, ansvarig, foto och manuellt rapporterad
mätarställning. Flikar ger plats för service/besiktning, felanmälningar,
kostnader, dokument och historik. Nästa besiktning lyfts överst.

Service kan bevakas efter datum, kilometer eller drifttimmar. När datum och
mätarintervall kombineras är det första gränsvärdet som nås avgörande.
En gammal eller saknad mätaravläsning behöver visas som osäker; skisserna
innebär ingen automatiskt uppkopplad mätare.

Dokument som besiktningsprotokoll, serviceunderlag, försäkringsbrev och avtal
kopplas till fordonet och får datum, version, behörighet och spårbarhet i det
gemensamma dokumentarkivet. Dokumentarkiv i extern objektlagring är separat
planering; mockupen inför ingen ny lagringstjänst.

## 3. Service, besiktning och felhantering

[Öppna bilden i full storlek](03_Service_och_besiktning.png)

![Service, besiktning och felhantering](03_Service_och_besiktning.png)

En kort, datumgrupperad planering visar vad som behöver göras och av vem.
Ett valt fel visas i en sidopanel med foton, prioritet, ansvarig, verkstad och
åtgärdsstatus. Där kan utfört arbete registreras och protokoll/kvitto bifogas.

Föreslaget samband med befintlig transportplanering:

- Bokad verkstadstid reserverar fordonet under det aktuella tidsintervallet.
- En uttrycklig driftspärr kontrolleras även på servern vid nya tilldelningar.
- Åtgärdad felanmälan innebär inte automatiskt att en driftspärr hävs;
  behörig ansvarig behöver bekräfta att fordonet får tas i bruk.
- Historiska arbetsordrar och dokument behåller sitt ursprungliga fordon.

En planerad kontrollbesiktning är inte ett godkänt besiktningsresultat.
Servicepåminnelse, daglig tillsyn, svensk kontrollbesiktning och juridiskt
körförbud är skilda uppgifter och behöver skilda statusar. Slutdatum och
besiktningsresultat registreras från faktiska uppgifter/protokoll; något
schablonintervall för alla fordonstyper föreslås inte.

## Vad som redan finns och vad bilderna föreslår

Befintligt ScrapPilot har ett gemensamt fordonsregister med registreringsnummer,
namn, typ, kapacitet, aktivstatus och koppling till personal/transportplanering.
Bilderna föreslår en utbyggnad med egen arbetsyta, underhåll, besiktningsbevakning,
felanmälningar, dokument och kostnadsuppföljning.

Fordon med registreringsnummer och maskiner utan registreringsnummer behöver
kunna ha olika identifierare vid implementation. Arbetsuppgifter och data ska
fortsätta avgränsas per bolag, anläggning och behörighet. En mobil vy för
**Mitt fordon**, felrapportering och fordonskontroll är möjlig fortsättning,
men någon separat mobilbild ingår inte bland dessa tre webbvyer.

## Undersökta system och inspirationskällor

Publika förstapartssidor granskade 16 oktober 2026. Funktionerna nedan är
inspiration till ScrapPilots egen utformning; bilderna återger inte något
annat systems skärmbilder eller varumärke.

| System och källa | Verifierade funktioner | Anpassning i bilderna |
| --- | --- | --- |
| [Infobric Fleet](https://infobric.com/se/produkter/fleet/) | Planering och påminnelser för service/besiktning; skadeanmälan med foton från föraren. | Åtgärdslista, besiktningsbevakning och fotoärenden. |
| [ABAX Fleet](https://www.abax.com/sv/smart-mobility/fleet-management/abax-fleet) | Dokument per fordon: bland annat manualer, försäkringar och leasingavtal, PDF/bilder, förhandsgranskning och behörigheter. | Dokumentflik och dokumentlista på fordonskortet. |
| [Fleetio – Service Reminders](https://help.fleetio.com/en_US/service-reminders-schedules/service-reminders-overview) | Intervall efter tid och/eller mätare, med bevakning före förfall. | Nästa service efter datum, km eller drifttimmar, första gränsen som nås. |
| [Fleetio – Issues](https://help.fleetio.com/en_US/maintenance/issues-overview) | Prioritet, ansvarig, foton/dokument och åtgärdsstatus. | Sidopanel för fel med tilldelning och historik. |
| [Fleetio – Service Entries](https://help.fleetio.com/en_US/service-entries/service-entry-overview) | Servicehistorik, arbete/delar, leverantör och bilagor. | Serviceunderlag och plats för kostnadsuppföljning. |
| [Fleetio – Inspections](https://help.fleetio.com/en_US/inspections/inspections-overview) | Anpassade fordonskontroller med resultat, kommentarer och bilder. | Underlag för framtida mobil fordonskontroll. |
| [Samsara – Connected Maintenance](https://www.samsara.com/products/telematics/fleet-maintenance) | Fordonshistorik, planerat underhåll, fel, arbetsorder och kostnader. | Sammanhållet fordonskort och arbetsflöde för åtgärder. |
| [Samsara – DVIR](https://www.samsara.com/products/telematics/dvir) | Förarkontroller, foton och uppföljning av rapporterade brister. | Inspiration till felanmälan, skilt från svensk kontrollbesiktning. |

GPS, realtidspositioner, automatiska fordonsfel och automatiska mätarvärden
kan kräva telematik/OEM-anslutning, utrustning och avtal. Ingen sådan koppling,
Transportstyrelsen-integration eller extern kostnadsimport förutsätts i bilderna.
Licensvillkor och svensk regelefterlevnad för andra systems produkter har inte
granskats. Verkstadsreservation och separat hävning av driftspärr är egna
ScrapPilot-förslag för att knyta ihop fordon och befintlig planering.
