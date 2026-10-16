# Enhetskoppling och fordonsbyte

**Implementerade serverkommandon och webbflöden, 2026-10-16, ÄL 130.** En redan förberedd telematikpuck kan tilldelas ett bolag och kopplas eller flyttas mellan befintliga fordon. Flödena är verifierade med syntetisk telemetri. Fysisk provisionering, SIM/APN och transportskydd ska fortfarande konfigureras och provas med riktig hårdvara. Se [byggstatus och provsteg](../../fordon-telematik-bygge-2026-10-16.md).

## Ansvar och ordinarie koppling

**SaaS-/systemadmin förbereder enheten:** SIM och abonnemang aktiveras, APN, serveradress, enhetsprofil och säker transport konfigureras. Därefter tilldelas pucken ett bolag. Provisionering och anslutningsskydd hanteras av systemet; IMEI är en identifierare, inte autentisering.

**Bolaget kopplar ett fordon:** en behörig användare öppnar pucken i listan över bolagets egna tilldelade enheter och väljer ett befintligt fordon i dess rullgardin. Fordonsvalet är det enda ordinarie valet. Ingen QR-kod, kundaktivering eller kundkonfiguration av SIM/APN/server ingår.

Rullgardinen ändrar inte kopplingen på egen hand. För en ledig puck visas en kort bekräftelse; för en redan kopplad puck öppnas rutinen **Byt fordon** med tydligt Från → Till.

Första kopplingen:

1. Säkerställ att fordonets motor är avstängd och installera pucken.
2. Välj den lediga pucken och rätt fordon. Visa fordonets namn och registreringsnummer eller maskin-ID före bekräftelse.
3. Bekräfta kopplingen. Servern kontrollerar behörighet, bolag och att både pucken och fordonet är lediga, och skapar kopplingsintervallet atomiskt.

**Kopplad** och **Kontakt mottagen** är olika uppgifter. En sparad koppling får exempelvis visa *Inväntar första kontakt*. Utebliven kontakt ska ge tydlig status och felsökning, inte automatiskt byta fordon eller påstå att installationen verifierats.

## Flytta en puck till ett annat fordon

Bolaget gör bytet i två uttryckliga steg. Enheten får inte skriva nya resor på det nya fordonet innan båda stegen är klara.

| Steg | Användarens åtgärd | Serverns ändring |
| --- | --- | --- |
| **1. Påbörja byte** | Välj nytt befintligt fordon. Säkerställ att gamla fordonets resa är avslutad och motorn avstängd. Tryck **Påbörja byte**. | Stäng gamla kopplingsintervallet, sätt pucken till **Under flytt** och reservera det nya fordonet. Allt sker i samma transaktion. |
| **2. Bekräfta flytt** | Flytta pucken fysiskt. Med det nya fordonets motor avstängd, kontrollera valt fordon och tryck **Bekräfta flytt**. | Avsluta flyttläget och påbörja det nya kopplingsintervallet atomiskt. Visa första kontakt separat, exempelvis **Kopplad – inväntar första kontakt**. |

Vid aktiv resa, påslagen motor eller okänd resstatus får normalbytet inte påbörjas. Ingen kontakt betyder inte att resan är avslutad. Ett timeoutvärde får aldrig automatiskt avsluta en verklig resa eller göra bytet tillåtet.

En trasig eller försvunnen puck behöver ett separat undantagsflöde för särskilt behörig personal: uttrycklig manuell bryttid, obligatorisk orsak och spårbar granskning av osäkra resor och mätvärden. Serverns betrodda undantagskommando har separat behörighetskontroll; det exponeras inte som en vanlig flyttknapp i kundvyn. Åtgärden får inte skapa ett påhittat observerat resslut eller dölja att tiden är manuellt angiven.

## Avbryt och återgå

- **Före Påbörja byte:** avbryt stänger dialogen utan att ändra kopplingen.
- **Efter Under flytt:** ett avbryt får inte automatiskt återöppna den gamla kopplingen. Systemet vet inte var pucken sitter.
- Återgång kräver ett uttryckligt val och bekräftad fysisk återinstallation i det gamla fordonet med motorn avstängd. Servern skapar då ett nytt kopplingsintervall till det gamla fordonet och frigör reservationen av det nya.
- Tidigare stängda intervall och flytthistoriken bevaras. Utan bekräftad återinstallation förblir pucken under flytt; ingen automatisk återkoppling sker.

Flyttläget sparas på servern. Om webbläsaren stängs eller laddas om visas pucken fortfarande som **Under flytt**, med åtgärden **Fortsätt byte**. Behörig personal kan fortsätta till bekräftelse eller välja den uttryckliga återinstallationen; en klienttimeout får inte tyst återställa kopplingen.

## Historik, sena paket och mätarställning

Varje koppling har ett eget ID, fordon, bolag, start- och sluttid samt spårbar aktör. Historiska resor och mätningar behåller sin ursprungliga fordonskoppling; de får inte flyttas när puckens aktuella fordon ändras.

Mottagaren bevarar både enhetens händelsetid och serverns mottagningstid. Sena eller buffrade poster som säkert hör till det gamla intervallet ska hänföras dit. Felställd enhetsklocka, överlappande/osäkra tider och poster runt flyttgränsen kräver granskning. En aktuell koppling får inte användas som genväg för att lägga gammal buffrad körning på det nya fordonet.

Data från tiden **Under flytt** får inte skapa nya fordonsresor. De hanteras separat som flytt-/granskningsuppgifter, inte som bevis för körning med det gamla eller nya fordonet. Ett mottaget paket eller en första kontakt avslutar inte flyttläget på egen hand.

Enhetens virtuella GPS-mätare kan innehålla körsträcka från det gamla fordonet. Dess absoluta värde får därför inte bli det nya fordonets mätarställning. Vid ny koppling fastställs en ny baseline och mätarkälla, exempelvis fordonsavläst OEM-värde, manuell avläsning eller virtuell sträcka från kopplingstillfället. Okänd baseline visas som okänd och kompletteras; den får inte fyllas med gamla bilens mil.

**Standardföraren följer fordonet.** Puckens föregående standardförare eller senaste observerade förar-ID får inte följa med till nästa fordon. Historiska föraruppgifter bevaras på sina resor och tolkas utifrån resans tid.

## Behörighet, samtidighet och säkerhet

- Servern kontrollerar aktuell behörighet och åtkomst till bolagets puck och berörda fordon vid varje steg. En rullgardin i klienten är ingen behörighetskontroll.
- En puck får ha högst en aktiv fordonskoppling och ett fordon högst en aktiv puck. En pågående flytts reservation ska också hindra konkurrerande kopplingar och byten.
- Stängning, reservation och öppning låses och sparas atomiskt. Föråldrade val avvisas utan delvis genomfört byte. Dubbeltryck och återförsök ska vara idempotenta och återge samma bekräftade resultat.
- Historiken visar vem som påbörjade, bekräftade, återförde eller manuellt bröt en koppling, när det skedde och eventuell orsak. En omstart eller ett anslutningsavbrott får inte återaktivera en gammal koppling.
- **Bolagsbyte är inte ett vanligt fordonsbyte.** Det får endast göras av systemadmin i ett separat överlåtelseflöde som hanterar anslutningsuppgifter, buffrad data och säker brytpunkt. Det nya bolaget får ingen åtkomst till gamla bolagets CRM-data, resor eller historik.

## Verifiering och fysisk pilot

Första koppling, normalt tvåstegsbyte och bekräftad återinstallation ska kunna granskas var för sig. Prova också aktiv/okänd resa, utebliven första kontakt, trasig puck med manuell bryttid, sena paket, mätarbaseline, samtidiga byten och dubbla bekräftelser. Misslyckad serverlagring ska behålla det tidigare bekräftade läget och ge ett tydligt fel; klienten får inte visa bytet som färdigt i förväg.

Serverprov täcker första koppling, tvåstegsflytt, återinstallation, reservationer, samtidiga försök, sena poster och felställd klocka. Browserprov täcker koppling och flytt utan optimistisk bekräftelse. Den [syntetiska mottagartjänsten](mottagartjanst.md) kan nu kopplas uttryckligen till ett bolags testsändare; publik testkörning är fortsatt avskild som standard. Den [fysiska TCP-grunden](README.md) behöver fortfarande verifierad transport och verkligt hårdvaruprov.
