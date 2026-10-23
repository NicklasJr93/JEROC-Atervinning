# Ande: personlig redovisningsassistent per kundbolag

Status 2026-10-23: en första läsande OpenAI-koppling finns för den lokala
bokföringsdemon. Resten av dokumentet beskriver även den större, ännu
planerade SaaS-arkitekturen. [Testversion, driftsättning och kontrollpunkter](ande-openai-test.md)
beskriver exakt vad som är anslutet och hur det verifieras.

## Implementerat: läsande AI-test i bokföringsdemon

Ande anropar OpenAI Responses API via servern. Nyckeln
`BOKFORING_OPENAI_API_KEY` ligger endast på servern; den skickas aldrig till
webbläsaren. Modellen väljs på servern med `BOKFORING_ANDE_MODEL`, med
`gpt-5-mini` som förval. AI-testet och ekonomidemon är publika och kräver
ingen ScrapPlanner-inloggning. AI-anrop har en separat, kortlivad demosession
med cookie och CSRF-skydd; den ger ingen åtkomst till kundbolag.

Vid en fråga skickas samtalets begränsade historik och, när användaren valt
det, utvalda strukturerade demofält för den aktuella sidan. Hela bokföringen,
uppladdade original, personnummer och bankuppgifter hämtas inte automatiskt.
Servern hämtar inga produktionsuppgifter från kundbolag och behandlar inte
browserkontext som verifierade registerdata. En användare kan själv skriva
känsliga uppgifter i en fråga; fiktiva uppgifter ska därför användas i testet.

Servern lägger till ett versionsmärkt kunskapspaket om stödda demoflöden och
deras begränsningar. Källhänvisningar länkar till fördefinierade wikiartiklar
och myndighetsvägvisare. Ingen aktuell webbsökning eller automatisk inläsning
av lagtext sker. Paketet är inte ett fullständigt, expertgodkänt regelverk.

Svaren är förklaringar och förslag. Modellen har inga verktyg för att ändra
bokföringen, betala, deklarera, låsa upp perioder eller radera. Det finns ännu
ingen knapp som verkställer ett konteringsförslag. Programkontrollerna måste
fortfarande passeras när användaren själv registrerar en åtgärd.

Anropen har korta spamgränser och begränsningar för indata och svar. Det finns
ingen dygnskvot eller beloppsgräns för denna publika testversion.
Vår server sparar användningsmetadata, inte frågor, svar eller kontext.
Konversationen hålls i den öppna webbläsarfliken. `store: false` skickas till
OpenAI men innebär inte en garanti om noll lagring hos leverantören; dess
aktuella villkor och organisationens eventuella lagringsavtal gäller.

Den anslutna testversionen innehåller inte beständigt personligt minne,
kundbolagsavgränsad redovisningsdatabas eller kontinuerlig övervakning av
alla transaktioner. Det är den fortsatta produktplanen nedan.

## Planerad SaaS: modellåtkomst och kunskap

SaaS-tjänsten använder en modellleverantör via ett server-API. Leverantörens
API-nyckel förvaras som serverhemlighet, med separat nyckel och budget för
utveckling och produktion. Slutanvändaren behöver normalt ingen egen nyckel.
En API-nyckel ger åtkomst; tokens är de textenheter som används och debiteras
för frågor, inhämtad kontext och svar. För testversionens modellval, se ovan.
Produktionsmodell, exakta priser och budget behöver fastställas för den
avsedda användningen.

Vi behöver inte träna en separat grundmodell för varje kund. Samma modell kan
användas med tre avgränsade informationslager:

1. **Gemensam regelkunskap:** versionsstyrda, daterade källor från BFN,
   Skatteverket och relevant lagstiftning; granskade tillämpningsexempel och
   hänvisningar. Vilket regelverk, beskattningsår och vilken bolagsform som
   stöds ska framgå. Det som källorna inte avgör blir en öppen bedömningsfråga.
2. **Bolagets kontext:** bolagsform, räkenskapsår, kontoplan, momsmetod,
   anställningar och behörigt tillgängliga fakturor, underlag och saldon.
   Uppgifterna hämtas med läsverktyg från bolagets databas vid frågetillfället.
3. **Personlig arbetsstil och godkänt minne:** assistentens namn, språk,
   förklaringsnivå och uttryckligen sparade arbetssätt. En instruktion om
   exempelvis vanligt kostnadskonto är ett förslag, inte ett undantag från
   redovisningsregler eller periodlåsning.

## Planerad SaaS: servern upprätthåller bolagsgränsen

Föreslaget flöde:

```text
Inloggad användare
    → eget server-API: verifierad medlemskap/roll i aktivt bolag
    → bolagsfiltrerade läsverktyg + versionsstyrda regelkällor
    → modell: förklaring, hänvisningar och strukturerat förslag
    → bokföringsmotorn: belopp, period, konton, moms och dubblettkontroll
    → förhandsgranskning och användarens godkännande
    → vanlig bokföringstransaktion med revisionsspår
```

`companyId` i frågans JSON ger aldrig behörighet. Servern kontrollerar bolaget
mot den autentiserade sessionen för varje läsning, sökning, minnesuppdatering
och förslag. Sökindex, dokumentobjekt, cache, konversationer och bakgrundsjobb
avgränsas med samma bolagsidentitet. En redovisningsbyrå får växla mellan de
kundbolag där dess användare har delegerad behörighet; minne från ett bolag
följer inte med till ett annat.

Dokument och hämtad text behandlas som underlag, inte som instruktioner till
assistenten. En faktura får exempelvis inte kunna begära åtkomst till ett annat
bolags filer eller ändra assistentens behörighet. Regleringen sker i servern
och datalagret, inte bara i modellens instruktioner.

## Fortsatt utbyggnad: läsverktyg och granskbara förslag

- Förklara den aktuella sidan och följa en rapportsiffra till underliggande
  verifikationer och underlag inom användarens behörighet.
- Föreslå kontering med konto, belopp, momsbedömning, källhänvisning och
  motivering. Visa osäkerheter och vilka uppgifter som saknas.
- Markera tänkbara dubbletter, orimliga avvikelser och öppna avstämningar som
  granskningspunkter. Den avgör inte att en verklig affär är fel bara för att
  beloppet avviker från historiken.
- Förbereda frågor och granskningsunderlag till redovisningskonsulten.

Den nuvarande testversionen har inga skrivverktyg. När ett strukturerat
godkännandeflöde byggs ska ett godkänt förslag skickas genom samma kontroller
och transaktionsgräns som en manuellt registrerad post. En rättad bedömning
ska ändra framtida förslag, inte tidigare bokförda original.

## Kunskap, kvalitet och ansvar

Målet är kvalificerat redovisningsstöd, inte en teknisk titel som
"auktoriserad revisor". En språkmodell blir inte auktoriserad genom träning.
Redovisningsrådgivning, en användares attest och en oberoende revisors
granskning är olika uppgifter. Ande kan hjälpa till med förberedelserna och
göra regelkunskap tillgänglig utan att ge sken av att ha lämnat ett
revisionsuttalande.

Ett framtida produktionspaket ska definiera en avgränsad målgrupp, exempelvis svenskt
mindre aktiebolag med K2, faktureringsmetod och SEK. Regler uppdateras med
giltighetsdatum och granskarens ändringshistorik. Svar ska ange vilket år och
vilka källor som använts. Finjustering kan senare förbättra språk och format,
men är inte ett substitut för aktuella regelkällor och kontrollerbar matematik.

Inför skarp rådgivningsanvändning behövs en uppsättning expertgranskade fall med förväntad
bedömning och acceptabla alternativa konteringar. Fallen omfattar vanliga
affärer, felaktiga underlag, ofullständiga frågor, regeländringar och försök
att komma åt ett annat bolag. Vi mäter källstöd, beräkningsriktighet, andelen
osäkra fall som lämnas för granskning samt otillåtna verktygsanrop.

## Planerad SaaS: kostnad och spårbarhet

Varje anrop registrerar bolag, användare, modell/version, regelpaket,
kontextreferenser, förslagets ID och tokenanvändning. Begränsa innehållet i
loggarna så att fullständiga löneunderlag eller personuppgifter inte kopieras
i onödan. Bolagets månadsbudget och användarens hastighetsgräns kontrolleras
före modellåtkomst. När budgeten är slut ska det framgå; bokföringens vanliga
funktioner ska fortsätta fungera.

Före produktionsanslutning bestäms leverantörens personuppgiftshantering,
lagringsvillkor, eventuella underleverantörer och vilka dokumentfält som får
skickas. Företagsminne får inte återanvändas som ett annat bolags kontext eller
som gemensamma träningsexempel utan ett separat, tydligt beslut och lämplig
hantering av uppgifterna.

## Fortsatt leveransordning för kundbolag

1. Beständig bolagsavgränsad serverlagring, autentisering och roller.
2. Gemensamt granskat regelpaket samt läsverktyg med bolagskontroll.
3. Läsande assistent med källhänvisningar och kostnadsgränser.
4. Konteringsförslag med förhandsgranskning, validering och mänskligt beslut.
5. Godkänt bolagsminne och avvikelsebevakning som kan följas och återkallas.

## Föreslaget API-kontrakt

```text
POST /api/accounting/companies/:companyId/ande/conversations
POST /api/accounting/companies/:companyId/ande/conversations/:id/messages
GET  /api/accounting/companies/:companyId/ande/proposals/:id
POST /api/accounting/companies/:companyId/ande/proposals/:id/accept
GET  /api/accounting/companies/:companyId/ande/memory
PUT  /api/accounting/companies/:companyId/ande/memory/:id
```

Detta är planerade gränssnitt, inte tillgängliga produktionsrutter. Accept
kräver aktuell verifikationsversion, rätt roll och transaktionskontroller;
ett tidigare modellförslag kan vara inaktuellt när underlaget ändrats.
