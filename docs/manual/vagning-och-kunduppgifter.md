# Vägning och kunduppgifter

[Till manualens startsida](README.md)

## Materialvåg i mobilappen

1. Öppna **Gårdsarbete** och kontrollera vald anläggning.
2. Välj **Starta invägning** och materialvåg. Välj materialgrupp och artikel.
   Läs artikelns beskrivning och jämför referensbilderna.
3. Ange vikten. Lägg till fler material eller välj **Färdigvägt** för
   sammanställningen.
4. Koppla kund och kontrollera kortets uppgifter. Välj **Spara färdig vägning**
   när vägningen är färdig. Den blir tillgänglig för kontorets fortsatta arbete.

Fortsätt ett ofärdigt kort under **Pågående vägningar**. **Vägningshistorik**
visar färdiga vägningar. Räkna inte en knapptryckning som sparad om ett fel visas.

## Fordonsvåg

Välj fordonsvåg när invägningen startas. Ange registreringsnummer, material
och infartsvikt, och välj **Spara infart**. Öppna samma kort under **Pågående
vägningar** när fordonet ska vägas ut. Ange utfartsvikten och granska nettot
innan vägningen färdigställs.

Nettovikten beräknas från infart minus utfart. Registrera eventuella
viktavdrag med orsak; kontrollera sammanställningen. En separat materialrad
kan användas för material som vägs utanför fordonsvågens vikt.

Vikter anges i det nuvarande formuläret. Ett förslag eller en mockup för
**Hämta från våg** innebär inte att den fysiska vågen redan är ansluten.

## Välj kund eller låt kunden fylla i

På **Välj kund** kan du söka i företagets kundregister, välja **Skapa ny kund**
eller välja **Låt kunden fylla i**. Vid det sista alternativet väljer du en
ledig ansluten kundterminal eller anger kundens mobilnummer för en SMS-länk.
Kortet sparas först, och du kan fortsätta med material och vikter under tiden.

Kunden får samma formulär i terminalen och SMS-länken:

| Steg | Innehåll |
| --- | --- |
| **1 · Dina uppgifter** | Organisations-/personnummer, namn och postadress. Giltigt företagsnummer hämtar SCB-uppgifter; personnummer kan hämta namn och adress från Roaring. |
| **2 · Kontaktuppgifter** | Telefon och e-post. Kan hoppas över. Formuläret anger att mejlen används för kvitton och information om inlämningen, utan reklam. |
| **3 · Utbetalning** | Valfria bankuppgifter. Kan hoppas över. Sparade bankuppgifter kan återanvändas vid senare utbetalningar. Swish kan inte väljas och visas som **Kommer snart**. |
| **4 · Referens & ursprung** | Valfri referens och materialets ursprungsadress. Postadressen är ett redigerbart förslag; steget kan hoppas över. |

Nummerfältet får fokus när formuläret öppnas. På en mobil kan kunden behöva
trycka i fältet för att tangentbordet ska öppnas. **Tillbaka** behåller
inmatningen. Personnummer med tio giltiga siffror kompletteras till tolv;
kunden kan rätta födelseåret.

Efter inskick granskar personalen uppgifterna och väljer **Använd
kunduppgifterna** för att koppla kunden till kortet. En befintlig kund med
entydigt matchande nummer återanvänds. Det publika formuläret visar inte
kundregistrets sparade kontakt- eller bankuppgifter och ersätter inte ett
befintligt bankkonto. Betalningsuppgifter kräver personalens särskilda behörighet.

En pågående kundförfrågan behöver granskas eller avbrytas innan kortet
färdigställs. Efter avbrott skapar ett nytt utskick en ny länk; den gamla
länken gäller inte. Insamlingen är inte kundens godkännande av avräkningen.
Se [hela flödet för kunduppgifter](../kunduppgifter-terminal-sms.md).

## Kundgodkännande och attest

Kontoret granskar först viktkortets kund, material, vikter, priser och
betalningsuppgifter. Under **Kundgodkännande** väljs **Visa på kundterminal**,
**Skicka via SMS** eller **Skicka via e-post**. Kontrollera mottagaren och
skicka uttryckligen. SMS och mejl fungerar utan kundterminal.

1. Kunden granskar underlaget och villkoren och väljer **Godkänn**.
2. Kunden ser **Visa din legitimation** och väntar på personalens bekräftelse.
3. Personalen kontrollerar legitimationen på plats och väljer **Bekräfta
   legitimation & godkännande**.
4. Markera **Jag har kontrollerat kundens legitimation på plats** och välj
   **Bekräfta kontroll & godkännande**. Först då är kunden registrerad som godkänd.
5. Behörig person granskar och attesterar underlaget i **Attest**. Förvalt
   alternativ heter **Attestera · skapa utkast**. Följ den anslutna
   Spiris-funktionens status innan bokföring räknas som genomförd.

Kunden kan begära ändring. Rätta då kortet och skicka en ny version för
granskning. En gammal länk kan inte godkänna den ändrade versionen.
En e-post-/SMS-länk gäller normalt 24 timmar, men kan upphöra tidigare om
granskningen avslutas eller ersätts. Dela inte personliga granskningslänkar.

Detta är fysisk legitimationskontroll. BankID-signering används inte i detta
flöde. Kundgodkännandet och intern attest är separata kontroller. Attest kan
bland annat blockeras av attestgräns, behörighet, ofärdigt prisunderlag eller
mottagningsuppgifter som behöver bekräftas.
Se [kundgodkännande via tre kanaler](../kundgodkannande-lankar.md).

## Kontorets PDF-kopia efter attest

Öppna **Företagsinställningar → Aviseringar**, markera **Skicka vägt underlag
till e-post**, ange kontorets mottagare och välj **Spara ändringar**.
Kopian skickas efter intern attest när den slutliga PDF-filen finns i
dokumentarkivet. Kundens godkännande ensamt skickar ingen kopia.

Mejlet använder den arkiverade PDF-versionen och skickas till de angivna
kontorsadresserna. Det kräver ingen Spiris-anslutning. Ett utskicksfel innebär
inte att attesten ska göras om. Aktivering skickar inte äldre underlag.
Se [PDF-kopian och leveranshantering](../integrationer/vagt-underlag-epost.md).
