# Publikt JEROC-rösttest utan inloggning

Kontor 0.30.6, ÄL 136–137. Datum: 17 oktober 2026.

Öppna **`/rosttest`** direkt i mobilens eller datorns webbläsare. Ingen
kontorsinloggning krävs. Knappen **Starta testsamtal** begär mikrofonåtkomst och
använder serverstyrd GPT-Live med låst klienthändelsekanal.

## Besökaren ser bara sitt eget aktuella samtal

- Besökaren får en slumpad, kortlivad besökscapability i en HttpOnly-cookie.
- Endast det senaste egna samtalets status och transkript kan hämtas.
- En omladdning kan visa det egna aktuella transkriptet medan sessionen gäller;
  ljudanslutningen kan inte återupptas efter en omladdning.
- Det finns ingen publik samtalslista eller åtkomst till andra besökares samtal.
- Skapare, intern sammanfattning, ärendestatus, modellsnapshot och provider-ID
  ingår inte i den publika projektionen.
- AI-inställningar och kontorets uppföljning kräver fortfarande inloggning.

Den publika besökscapabilityn är inget personal- eller administratörskonto.
Den kan inte användas för kunder, viktkort, personal, filer eller andra
verksamhets-API:er. Byte av URL-/objekt-ID ger inte tillgång till ett annat samtal.

## Fast bolag och granskad kunskap

Gatewayen väljer alltid det registrerade, aktiva JEROC-demobolaget. Besökaren
kan inte välja tenant, anläggning, instruktioner, modell eller röst genom
anropet. Servern väljer en aktiv anläggning och använder den godkända
kundkunskap och röstprofil som gäller där.

Utkast, arkiverade svar och interna HR-/bank-/kundregister ingår inte i
kundagentens underlag. Kundrösten har inga verktyg för att ändra verksamheten.
JEROC:s profil och publicerade svar administreras som tidigare under
**Integrationer → AI-kundmottagning**.

## Kontorets vy är fortsatt skyddad

**`/kontor/rosttest`** kräver aktuell VD-/Systemadminbehörighet för både verklig
och effektiv användare. Där finns det valda bolagets testhistorik och
uppföljning. **Testa samtal** och **Provlyssna i ett testsamtal** från
AI-inställningarna går till denna skyddade vy, så andra kundbolag provar sin
egen kunskap och anslutningskontext.

## Samtidiga samtal

Upp till **fem anslutande/aktiva testsamtal per bolag** tillåts samtidigt.
Olika besökssessioner har egna samtal och transkript. Samma besökssession
eller inloggade operatörspar (verklig + effektiv användare) får bara ha ett
pågående samtal. Två flikar med samma besökscookie är samma session.

Publika och privata prov delar kapacitetsgränsen. Den sista kontrollen sker
atomiskt när journalposten reserveras, så samtidiga starter inte kan ta samma
plats. Full kapacitet ger en tydlig väntetext och påverkar inte befintliga
samtal. Att avsluta ett prov avslutar inte andra besökares anslutningar.
Ett avslutande samtal håller sin plats under den begränsade väntan på
leverantörsavslut och sluttranskript, så platser inte frigörs för tidigt.

Kontorets historik kan fortsatt visa andra tillåtna samtal. Läsning av en
sådan historikpost gör den inte till operatörens eget aktiva samtal och
blockerar inte operatörens startknapp.

## Startgränser och lagring

Publik besökssession gäller i 15 minuter. Gränserna för startförsök är
beständiga och reserveras atomiskt före leverantörsanrop:

| Gräns | Högsta antal |
| --- | --- |
| Per besökssession | 2 |
| Per IP, rullande timme | 6 |
| Per IP, rullande dygn | 12 |
| Publikt totalt, rullande timme | 10 |
| Publikt totalt, rullande dygn | 30 |

Det finns även gränser för nya besökscapabilities. Att radera en cookie
återställer inte IP-/totalkvoten. Samma startförsök återanvänder sin
försöksnyckel. Befintliga gemensamma gränser gäller också: JEROC:s privata och
publika prov delar taket 30 sparade starter per Stockholmskalenderdag och
journalens 300 poster. Därför kan gränsen nås tidigare än enbart tabellen anger.
När journalen är full stoppas nya prov; automatisk journalgallring införs inte
av denna ändring.

Ett extra korttidsfilter stoppar fler än 240 publika API-anrop per IP/minut
eller 300 totalt per minut/worker innan röstmodulen läser verksamhetsdatabasen.
Det begränsar även polling och felaktiga anrop. Kostnadskvoterna ovan är
beständiga; detta trafikfilter är processlokalt och nollställs vid omstart.
IP-gränserna medger flera olika besökare från samma kontorsnät. De globala
startkvoterna och två starter per besökssession är oförändrade. Vid en race
om sista kapacitetsplatsen kan ett reserverat startförsök räknas även om
leverantörsanslutningen inte hann startas; automatisk återuppringning görs inte.

Samtalet har en lokal tidsvakt på 180 sekunder och servern begär avslut hos
leverantören. GPT-Live har ingen här verifierad hård remote-TTL vid total
server-/nätförlust. Startkvoterna är därför ingen garanti för ett exakt
kostnadstak; OpenAI-projektets budget, användning och larm behöver förvaltas.

Besökarens åtkomst upphör när dess capability löper ut. Det raderar inte den
skyddade kontorsjournalen. Text sparas för intern uppföljning; ljud skickas
till OpenAI för behandling och ingen ljudinspelning sparas av appen.
Testsidan informerar om detta och ber besökaren undvika känsliga uppgifter.

## API-gräns

`/api/public/voice-test` stöder endast bootstrap och det egna samtalets
create/read/ready/end. Det finns inga publika endpoints för historiklista,
kontorsuppföljning eller anslutningsprov. Skrivningar kräver samma ursprung,
besökscookie, korrekt CSRF-token och strikt validerad payload.

`VOICE_TEST_ENABLED=false` eller inaktiv AI-profil stoppar nya prov. Saknad
servernyckel, inaktivt bolag eller saknad aktiv plats stoppar också start.
Befintlig `OPENAI_API_KEY` används; ingen ny obligatorisk Render-variabel behövs.
Publik start är avstängd om servern använder den äldre Realtime-adaptern;
kontorets inloggade Realtime-prov fungerar fortsatt. Detta bevarar kravet på
Live-protokollets låsta klienthändelser för anonyma besökare.

Avslutat samtal kan efterhämtas under ett begränsat tidsfönster för att få med
sista transkriptfragmenten. Det innebär ingen rätt att läsa ett tidigare eller
annat samtal; varje läsning kontrollerar fortfarande besökscapability och ägare.

Kod: [publik wrapper](../../server/voice-test-public.mjs),
[gateway](../../server/tenant-gateway.mjs),
[röstlivscykel](../../server/voice-test.mjs) och
[publik sida](../../src/voice-test/PublicVoiceTestApp.tsx).

Se [huvudguiden](openai-rosttest.md) för providerinställningar och den skyddade
kontorsvyn. Separat [SaaS-blueprint](../saas-blueprint/README.md) beskriver hur
capabilitybaserade publika moduler kan hållas avgränsade från kontorsidentiteten.

## Verifiering av 0.30.5

103 riktade server-/provider-/AI-tester och fem gatewayfall passerade.
Webbläsarkontrollerna omfattade elva publika, tolv privata och nio
AI-inställningsfall. Typkontroll och produktionsbygge passerade.

Den byggda appen provades också mot en riktig isolerad lokal server:
publik mobilvy utan login, minimal egen-session-projektion, 401 på privata
API:er, 404 på publik historikväg, nekat annat ursprung, skyddad privat vy
och spärrad start när servernyckel saknas. Ingen horisontell overflow eller
sidkrasch uppstod. Inga externa eller betalda OpenAI-anrop gjordes i testerna.

## Verifiering av 0.30.6

110 riktade röst-/provider-/AI-tester och 13 privata webbläsarfall passerade.
De omfattar fem samtidiga besökare från samma IP, atomisk kapacitet över
flera runtimeinstanser, nekad dubbelstart, separata transkript, avslut av
ett samtal utan påverkan på andra och behållen plats under sluttranskript.
En separat granskare körde samma 36 core-/publicfall med godkänt resultat.
Typkontroll, produktionsbygge och prov mot byggd isolerad server passerade;
publik sida öppnades utan login och privata API:er var fortsatt spärrade.
Ingen betald leverantörstrafik användes i verifieringen.
