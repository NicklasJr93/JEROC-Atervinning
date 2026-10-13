# Månadsgranskning och tidattest

Kontor **0.28.0**, mobilwebb **0.10.0**. Inga nya Render-variabler behövs.

## Medarbetaren

Öppna **Tid → Min månadsrapport**. Välj en avslutad månad, kontrollera arbetade
timmar, frånvaro, raster och fördelning och välj **Skicka till chef**.
Pågående månad kan förhandsvisas. Den kan lämnas in först när hela månaden är slut
enligt svensk tid; kommande stämplingar låses därmed inte av en för tidig attest.

Inlämning sparar en fryst version och låser månadens tidsändringar. En inskickad
rapport kan återkallas för egna rättelser. Om chefen återlämnar den visas
kommentaren i mobilen. Gå till rätt dag, komplettera verkliga timmar och lämna
in igen. Godkänd rapport visar den version som faktiskt godkändes, inte senare
registerändringar. Månadsrapporten går att läsa även när tidsspärren visas.

## Chefen

Öppna **Personal → Månadsgranskning**. Välj månad/anläggning och öppna en person
för att se dagar, stämplingar och tidens fördelning. Pågående månad är markerad.
Det framgår om uppgifterna är aktuella, inskickade eller godkända och sparade.

**Godkänn månad** öppnar en sammanfattning. Om timmar saknas eller är ofördelade
krävs en motivering. Detta ändrar inte de faktiskt registrerade timmarna.
En godkänd avvikelse gör att tidsspärren inte fastnar på den redan behandlade
månaden. **Återlämna** kräver en kommentar till medarbetaren.

Pågående arbetsorder-/klockpass som berör månaden och pass som kräver rättelse
måste avslutas eller rättas före inlämning och attest. Attest tillåts bara på
den inskickade versionen om underlaget fortfarande stämmer. Ändrat underlag
kräver återlämning och ny inlämning.

## Rättelser och historik

En godkänd månad återöppnas med anledning. Tidigare godkänd version, timmar,
kontrollsumma, datum och ansvariga bevaras. Medarbetaren rättar den aktuella
tiden och lämnar in en ny version, som behöver godkännas på nytt.

Redigeringslåset gäller både ursprungs- och destinationsdatum när tid flyttas,
samtliga berörda månader vid klockrättelser och ändringar i frånvaro/regler som
påverkar låsta historiska timmar. Framtida schema- och anställningsändringar
går igenom när gamla timmar förblir oförändrade. Ordinarie in-/utstämpling i
aktuell månad fungerar även när föregående månad är godkänd.

## Löneunderlag i CSV

**Exportera godkända** hämtar månadens godkända rapporter inom din åtkomst.
**Godkänd CSV** gäller en person. Äldre godkända versioner har egna exportknappar,
även efter återöppning. En återöppnad eller nyinlämnad aktuell rapport kommer
inte med som ett nytt godkänt underlag.

CSV använder UTF-8, semikolon och svenska decimaltimmar för Excel. Exakta minuter
för arbete, timkrav efter frånvaro, frånvaro, rast och fördelning följer med,
liksom period, person, anställningsnummer, version, attestdatum och kontrollsumma.
Namn/identifierare skyddas mot att tolkas som kalkylbladsformler.

Vid stämpelklocka är närvarotiden källan till arbetade timmar. Arbetsorder och
manuell tid fördelar dessa timmar och läggs inte ovanpå. Exporten räknar inte
ut lön, OB eller övertidsersättning och skickar inga lönebetalningar.

## Behörighet och lagring

**Granska personalens månadsrapporter** (`personnelTimeReviewRead`) kräver
personalregistrets läsrätt. **Attestera och återöppna månadsrapporter**
(`personnelTimeApprove`) kräver även granskningsrätten. De tilldelas uttryckligen
under **Personal → Konton**; systemadmin ärver dem.

Ingen får attestera sin egen rapport, även med systemadminrollen eller genom
att arbeta som en annan användare. Både faktisk och effektiv identitet samt
rapportens frysta ägare kontrolleras. Åtkomst till anläggningar kontrolleras
på servern även för historiska exporter och sena återförsök. Inaktiv personal
med sparad rapport kan fortfarande få sitt historiska underlag granskat.

Versionsdata, anrops-ID:n och granskningshändelser sparas i bolagets privata
`employeeTime`-domän i befintlig PostgreSQL. Det ingår i databasdumpen och lämnas
inte ut i allmänna personal-/mobil-/kontorspaket. Medarbetaren läser sin egen
rapport med sin verifierade session. Medicinska frånvaroskäl och lönebelopp
ingår inte i den nya granskningen.

## Verifiering

113 riktade serverkontroller passerar för tidsregler, närvaro, autentisering,
månadsflöde, immutabla versioner, verklig HTTP med lokal SQLite, CSV och Expo.
Tio riktade browsertester verifierar chefsvy, mobilens månadsrapport, låsta dagar,
start/tidsgräns, återkallad åtkomst och befintlig stämpelklocka. Vyerna är även
visuellt granskade. Produktionsbygget och Expo-typkontrollen passerar.

Ett verkligt lokalt Expo-prov verifierar förberedda paket för båda plattformarna.
Provkörningarna ändrar ingen levande personaldata, skickar inga betalningar och
är inte en uppmätt tidsförbättring på användarens Render-tjänst eller telefon.
