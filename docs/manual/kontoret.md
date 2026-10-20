# Kontoret och företagets inställningar

[Till manualens startsida](README.md)

## Ställ in företaget

Öppna **Företagsinställningar** i vänstermenyn. VD och systemadmin kan
administrera inställningarna. Andra användare behöver tilldelad läs- eller
ändringsbehörighet. Sparande kräver även åtkomst till hela bolaget, inklusive
alla dess anläggningar.

| Flik | Vad du kan ange |
| --- | --- |
| **Företaget** | Företagsnamn, postadress, telefon, kundmejl, fakturamejl, kontaktperson och webbplats. Organisationsnumret är företagets låsta juridiska identitet. |
| **Logga & dokument** | Företagets logga och dokumentens sidfot. Granska förhandsvisningen och välj **Spara ändringar**. |
| **Standardval** | Betalningsdagar som föreslås för nya kunder. Tomt värde använder integrationens standard. |
| **Aviseringar** | Kontorets PDF-kopia av vägt underlag och mottagarlistor för andra aviseringskategorier. En sparad mottagarlista innebär inte i sig att alla aviseringsflöden är anslutna. |

Företagsloggan visas i vänstermenyn efter sparandet. Systemadmin behåller
ScrapPlanner-loggan i sin egen översta rad. Ett äldre låst dokument behåller
den företagsprofil och loggversion som hör till just det underlaget.

Öppettider hör till platsen: öppna **Anläggningar**, välj anläggning och ange
lokal telefon, mejl och öppettider. Varje dag kan vara **Ej angivet**, **Stängt**
eller ha öppna perioder. Lägg in datumavvikelser för särskilda dagar.
Tiderna publiceras inte automatiskt till Google eller andra externa tjänster.

Fördjupning: [företagsinställningar och öppettider](../foretagsinstallningar.md).

## Lägg till personal och inloggning

1. Öppna **Personal → Lägg till person**. Ange namn, egen e-postadress och
   övriga uppgifter. Välj relevanta anläggningar.
2. Låt **Skapa inloggning** vara markerad om personen ska kunna logga in.
   Valet visas för den som får administrera konton.
3. Behåll **Skicka lösenordslänk via mejl**, eller välj **Ange tillfälligt
   lösenord**. E-postadressen används som användarnamn för den personliga
   inloggningen.
4. Spara. Vid mejlalternativet får personen en aktiveringslänk och väljer
   själv lösenord. Länken gäller i 24 timmar och kan användas en gång.
5. Öppna personkortets **Inloggning & behörigheter**. Tilldela de rättigheter,
   anläggningar och den attestgräns personen behöver, och spara.

Ett konto med tillfälligt lösenord behöver först logga in på kontoret och
byta lösenord innan mobilappen används. Ett utskicksfel tar inte bort den
sparade personalposten; kontrollera status och välj **Skicka ny inbjudan**.

För att delegera kontohantering markerar VD eller systemadmin **Hantera
användare** på personkortet. Även personalbehörigheterna behöver stämma.
Den delegerade administratören kan hantera vanliga konton inom sin egen
åtkomst, men kan inte höja rättigheter utanför den eller delegera vidare.

Vid stavfel: rätta personens uppgifter under **Översikt → Kontakt &
organisation → Redigera**. Kontots namn är ett separat fält under
**Inloggning & behörigheter**. För en väntande inbjudan kan uppgifterna rättas
och en ny inbjudan skickas. Behåll den befintliga personen och kontot så att
historik och kopplingar finns kvar. Se [inbjudningar och rättningar](../personal-inbjudningar.md)
och [delegerad användarhantering](../delegerad-anvandarhantering.md).

## Skapa en kund

Öppna **Kunder → Skapa kund**, eller välj ny kund direkt på ett viktkort.
Mobilens motsvarande knapp heter **Skapa ny kund**.

1. Börja i **Organisations-/personnummer**. Ett giltigt nummer föreslår kundtyp;
   typen kan ändras, exempelvis till **Företag** för en enskild firma eller **BRF**.
2. Ett organisationsnummer ger ett automatiskt SCB-uppslag. Granska träffen och
   välj **Använd företagsuppgifter** för att fylla namn, postadress och känd
   momsstatus. Tillgänglig telefon och e-post fyller tomma kontaktfält.
3. Ett personnummer kan hämta namn och folkbokföringsadress från Roaring.
   Granska och välj **Använd personuppgifter**. Telefon, mejl och bankkonto
   kommer inte från personuppslaget.
4. Kontrollera adress, kontaktuppgifter, betalningsuppgifter och villkor.
   Välj **Spara kunduppgifter** i kontorets fullständiga kundformulär.

Tio giltiga siffror i ett personnummer kompletteras till tolv efter en kort
skrivpaus eller när fältet lämnas. Det föreslagna födelseåret kan ändras.
Personer som fyllt 100 behöver ange `+` eller det fullständiga numret för att
undvika fel århundrade. Samordningsnummer fylls i manuellt tills vidare.

Att välja en befintlig kund använder företagets eget register. Nyregistrering
kontrolleras också mot befintliga kunder innan ett köpt personuppslag görs.
Undvik att skapa en extra kund för samma organisations- eller personnummer.
F-skatt och momsregistrering visas separat; F-skatt bestämmer inte momsvalet.
Granska alltid hur kunden och materialet ska hanteras.

I formulär med adresshjälp skriver du direkt i **Postadress/Gatuadress**.
Välj komplett adress för att fylla gata, postnummer och ort. Väljer du bara en
gata fortsätter du med husnummer i samma fält. En gata kan omfatta flera
postnummer, så ett saknat postnummer fylls inte med ett gissat värde.
Granska och spara formuläret som vanligt.

Fördjupning: [SCB](../integrationer/scb-foretagsregister.md),
[personuppslag](../personuppslag-och-saas-forbrukning.md) och
[adresshjälp](../integrationer/google-adresser.md).

## Artiklar och priser

Under **Artiklar & priser** hanteras artiklar, priser, instruktioner och
bilder. Fliken **Artikelgrupper** styr materialmenyns huvudgrupper och
undergrupper i mobilappen. Öppna en artikel för att ange grupp, presentation
och bilder, granska mobilförhandsvisningen och spara.

Gruppbild och artikelbilder är separata val. Inaktiva grupper döljs i
mobilens materialval. En artikel utan grupp visas under **Övrigt**.
Kontrollera prisnivåer, enhet, giltighetsdatum och momsregel innan artikeln
används. Se [artikelregistret och bilderna](../article-catalog.md).
