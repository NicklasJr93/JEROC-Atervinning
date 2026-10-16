# Körjournal – bildmockuper

Tre statiska bildmockuper framtagna 2026-10-16 med fiktiva personer, resor och fordonsuppgifter. Leveransen innehåller ingen appkod. Beteenden och funktionella garantier nedan är designkrav, inte implementerad funktion.

## 1. Webb: körjournal med sidopanel

Körjournalen ligger under **Fordon & maskiner**, på fliken **Körjournal**. **GPS-enheter** är en sekundär flik. Vyn visar historik, filter och sammanfattningen **18 resor · 16 klara · 2 saknar uppgifter**. Den valda resan visas i en sidopanel till höger för granskning av resans uppgifter och kompletteringsstatus. PDF- och CSV-export med luckor ska tydligt märkas **Utkast – ofullständiga uppgifter**; saknade uppgifter och utkaststatus följer med i exporten. Privata resors rutt är dold.

![Webbkörjournal med historik, export och vald resa i höger sidopanel](01_Webb_Korjournal.png)

## 2. App: direkt kompletteringslås med kortstapel

Exemplet visar appen klockan **08:52 den 16 oktober 2026**. Två avslutade resor för **Niklas**, fordon **PQR678**, saknar obligatoriska uppgifter. Den senaste resan visas som ett aktivt, kompakt kort med den äldre resan bakom. **2 kvar** inkluderar både det aktiva kortet och kortet bakom. Det aktiva kortet är ännu oklassat och erbjuder **Privat / Tjänst**.

Samma två resor visas i webb och app, senaste först:

- **08:25–08:50:** Rimbo → JEROC Norrtälje, **22,4 km**. Mätarställning **124 602,4 → 124 624,8 km**.
- **07:12–07:37:** JEROC Norrtälje → Verkstad Nord, Rimbo, **22,4 km**. Mätarställning **124 580,0 → 124 602,4 km**.

![Appens direkta kompletteringslås med oklassad resa och nästa kort bakom](02_App_Resor_att_komplettera.png)

## 3. App: samma kort med tjänstesyfte

Samma aktiva kort visas efter att användaren uttryckligen valt **Tjänst**. Användaren kan antingen välja en arbetsorder eller ange ett konkret manuellt tjänstesyfte; exemplet har syftet **Återresa efter hämtning hos Verkstad Nord**. Primär åtgärd är **Spara och nästa**. **Privat** ska rensa arbetsorder och tjänstesyfte och kräver inget sådant syfte.

![Samma resekort med uttryckligt vald tjänst och ifyllt manuellt syfte](03_App_Komplettera_resa.png)

## Flödeskrav för en framtida implementation

- Kompletteringsläget öppnas direkt när appen öppnas eller åter blir aktiv, eller när en ny avslutad egen resa tas emot medan appen är säker att använda. Alla avslutade egna resor med saknade obligatoriska uppgifter omfattas, oavsett vilket datum de gjordes.
- Vanliga arbetsflöden är låsta tills kön är klar. Det finns ingen stängknapp, tillbaka till appen, **Senare**, **Hoppa över** eller vanlig appnavigation i kompletteringsläget.
- Resorna visas senaste först, men det aktiva kortet får inte bytas eller flyttas medan användaren fyller i det.
- Först efter att servern bekräftat giltig lagring tas kortet bort och nästa visas automatiskt. Låset släpper först när hela kön är klar. En fullständigt sparad resa ska aldrig efterfrågas igen.
- Vid felsvar behålls både kort och inmatning, med **Försök igen**. Ett misslyckat eller obekräftat sparande får inte minska antalet kvarvarande resor.
- Ingen interaktion framtvingas under pågående körning. Resor med okänd förare hanteras separat och får inte automatiskt tilldelas den inloggade användaren.
- Kompletteringen gäller förarens uppgifter, exempelvis klassning och syfte. Tekniska dataluckor som saknad mätarställning får separat granskning; föraren ska inte behöva hitta på sensorvärden för att komma vidare.
- Tjänst kräver ett uttryckligt arbetsorderval eller ett konkret manuellt syfte. Standardförare, arbetsplats eller andra gissningar får inte automatiskt ange tjänst eller fylla i syftet. Privat kräver inget tjänstesyfte och rensar eventuell arbetsorder och tjänsteuppgifter.
- Snabbval som Återresa, Hämtning och Leverans är skrivhjälp för ett utkast. De sparar inte resan eller låser upp appen på egen hand; föraren bekräftar det konkreta syftet innan kortet lämnar stapeln.

Se även [tidigare fordonsmockuper](../fordonsadministration/README.md), [mockuper för GPS-enheter](../telematikenheter/README.md) och [telematikens integrationsdokumentation](../../integrationer/telematik/README.md).
