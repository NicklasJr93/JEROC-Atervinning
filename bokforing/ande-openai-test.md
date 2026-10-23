# Ande: läsande OpenAI-test

Denna etapp kopplar den nya bokföringsdemons Ande till OpenAI via appservern.
Ekonomiflödena är fortfarande lokala demoflöden. AI-kopplingen är ett
avgränsat test med fiktiva uppgifter, inte åtkomst till ett verkligt bolags
hela redovisning. [Den fortsatta SaaS-planen](ai-ande-saas.md) beskriver
serverlagring, bolagsavgränsade läsverktyg och personligt minne som återstår.

## Konfiguration i Render

På **Render → scrapplanner-app → Environment**:

| Variabel | Användning |
| --- | --- |
| `BOKFORING_OPENAI_API_KEY` | Separat OpenAI-projektnyckel för Ande. Krävs för modellanrop och ska bara lagras som serverhemlighet. |
| `BOKFORING_ANDE_MODEL` | Valfri modellinställning. Förval är `gpt-5-mini`; nyckeln måste ha tillgång till vald modell. |

Spara och driftsätt serverändringen. Nyckeln ska inte finnas i GitHub,
frontendkod, en `VITE_`-variabel, webbläsarens lagring eller chattfältet.
Ande återanvänder inte röstmodulernas `OPENAI_API_KEY`. Att endast lägga in
nyckeln aktiverar inte äldre kod som saknar den här kopplingen.

OpenAI-projektet behöver API-fakturering och åtkomst till modellen. En
ChatGPT-prenumeration ersätter inte API-faktureringen. Testversionen har
ingen egen dygnskvot eller beloppsspärr. Korta spamgränser begränsar takten,
men begränsar inte den totala kostnaden över tid. Följ faktisk användning
i OpenAI-projektet.

## Åtkomst och användning

1. Öppna `/bokforing/` och Ande-panelen. Statuskontrollen gör inget betalt
   modellanrop.
2. Ingen inloggning behövs. Statuskontrollen skapar en separat, kortlivad
   demosession om en sådan saknas. Om serverkonfigurationen ändrats, välj
   **Kontrollera anslutning**.
3. Kontrollera **Underlag till Ande**. Välj om aktuell demovy ska bifogas.
4. Ställ en fråga med fiktiva uppgifter. Svar och källhänvisningar visas
   i panelen; API-svaret innehåller också rapporterat tokenantal.

API:t använder en egen slumpad demosession, oberoende av ScrapPlanners
inloggning. Dess cookie är HttpOnly, SameSite Strict och begränsad till
Andes API-sökväg; i produktion är den även Secure. POST-anrop kräver samma
webbplats och giltigt sessionsskydd mot CSRF. Demosessionen ger ingen
åtkomst till kundbolag eller appens affärsdata. Ett `companyId` från
webbläsaren används inte för att ge åtkomst till bolagsdata.

Den publika ekonomidemon fungerar även när Ande saknar konfiguration
eller tillfälligt når en spamgräns. Ett nätfel ersätts inte med ett lokalt
exempelsvar som skulle kunna misstas för ett lyckat OpenAI-anrop.

## Vilket underlag skickas?

Webbläsaren bygger en uttrycklig lista med tillåtna fält. Det kan omfatta
aktuell vy, räkenskapsår, antal utkast eller omatchade poster samt en vald
fakturas nummer, status, datum, totaler och högst tolv rader. När en
verifikation är vald kan konto, debet och kredit bifogas. Alla belopp i
underlaget märks som ören. Servern validerar listan innan modellanropet.

Hela bokföringsobjektet, kundregister, mottagar-/avsändaruppgifter,
personnummer, löneprofiler, bankreferenser, bilagor och uppladdade
originalfiler bifogas inte automatiskt. Ett inskannat underlag har därför
inte blivit läst bara för att det visas bredvid fakturan. Ande kan inte
följdklicka till ytterligare poster, göra en webbsökning eller läsa ett
annat bolag.

Frågan, en begränsad tidigare samtalshistorik och de valda fälten skickas
till OpenAI. Fritext och radbenämningar kan innehålla sådant användaren
själv lagt in; en fältlista kan inte garantera anonymisering av det
innehållet. Använd endast fiktiva uppgifter i denna testversion.

På servern tillkommer kunskapspaketet `SE-demo-2026-10-23.1`, med
beskrivningar av stödda flöden, avgränsningar och källor. Det är inte en
fullständig lagdatabas eller ett expertgodkänt regelpaket. Myndighetslänkar
är vägvisare, inte löften om att aktuell sidtext hämtats för varje fråga.
Källhänvisningar väljs ur serverns kända lista; modellen får inte infoga
godtyckliga länkar som betrodda källor.

## Förslag och ansvar

Ande får förklara, resonera och föreslå vad användaren behöver kontrollera.
Den har inga verktyg för att bokföra, ändra fakturor, överföra pengar,
deklarera, radera eller öppna låsta perioder. Inget svar fungerar som en
automatisk kontering eller ett revisionsgodkännande. Ett förslag måste
granskas och därefter registreras genom programmets vanliga kontroller.

AI:n kan ha fel även när den hänvisar till en källa. Särskilt momsbedömning,
avdragsrätt, val av period, verkliga löneförhållanden och ärenden utanför
2026-reglerna behöver kontrolleras. Att vara en användbar
redovisningsassistent innebär inte auktorisation som revisor.

## Spamgränser och lagring

De korta gränserna är tio anrop per demosession och minut, tjugo per
IP-hash och minut och trettio för tjänsten per minut. Varje demosession
kan ha en pågående fråga och tjänsten högst fem samtidigt. Även ett misslyckat modellanrop räknas under
den korta mätperioden, eftersom leverantören kan ha fått eller debiterat
det. En reservation görs atomiskt före modellanropet. Det finns ingen
daglig anropsgräns eller inbyggd beloppsgräns.

Hela anropet begränsas till 48 KiB, frågan till 2 000 tecken,
historiken till åtta meddelanden och varje historiskt meddelande till
3 000 tecken. Modellsvar begränsas till 1 000 output-tokens. Detta begränsar
användningen men är inte en budgetgaranti i kronor; priset beror på vald
modell och leverantörens aktuella debitering.

Vår server sparar endast begränsad sessions- och användningsmetadata:
slumpad sessionsidentitet, hashad cookietoken, pseudonymiserad IP-identitet,
tidsstämplar, reservationsstatus och rapporterat tokenantal. Rå IP-adress
lagras inte i Andes användningsjournal. Användningshistorik rensas efter en timme och
demosessioner efter 24 timmar vid löpande städning. Antalet lagrade
demosessioner är begränsat till 5 000.
Frågor, svar och demokontext sparas inte som samtalsarkiv på vår server.
Webbläsarens samtal hålls i minnet i aktuell flik; detta är inte ett
beständigt, personligt företagsminne.

OpenAI-anropet använder `store: false`. Det är ingen garanti om noll lagring
hos leverantören. Dess tillämpliga API-villkor, säkerhetsloggning och
eventuella särskilda lagringsavtal behöver bedömas före användning med
verkliga person- eller företagsuppgifter.

## Skilj konfiguration från verifierat modellanrop

`GET /api/bokforing/ande/status` visar om lokal serverkonfiguration medger
ett test och etablerar då den avgränsade demosessionen. Statusens
`authenticated` avser denna demosession, inte en plattformsinloggning.
`configured: true` betyder att
serverinställningarna finns och är giltigt formade. Det bevisar inte att
nyckeln har saldo, rätt modellbehörighet eller att OpenAI svarar.

Först ett lyckat `POST /api/bokforing/ande/chat` som ger text och
tokenanvändning visar att just det anropet fungerade. Ett test med en
simulerad leverantör verifierar vårt flöde, inte den driftsatta nyckeln.
Notera därför separat: kodversion, statuskontroll, simulerade tester och
eventuellt verkligt provanrop. Visa eller logga aldrig API-nyckeln för att
bevisa anslutningen.

## Praktiska prov

- En publik testare ska kunna skapa en demosession utan plattformsinloggning.
- En testare kan fråga om en vald demofaktura och jämföra svaret
  med fälten under **Underlag till Ande**.
- Avmarkerad demokontext ska inte ändå skicka fakturafälten.
- En begäran om att bokföra, radera eller läsa ett annat bolag ska inte
  ge någon sådan åtgärd eller åtkomst.
- Trasig modellanslutning, uppnådd spamgräns och avbrutet svar ska ge ett
  begripligt fel utan att ekonomidatan ändras.
- **Nytt samtal** och omladdning ska inte hämta ett gammalt serversamtal.

Tekniska prov ligger i `server/bokforing-ande*.test.mjs` och
`tests/bokforing-ande.spec.ts`. Läs de faktiska testresultaten för aktuell
kodversion; denna guide anger inte att ett specifikt liveanrop har gjorts.
