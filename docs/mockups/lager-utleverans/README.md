# JEROC – lager och utleverans

Fristående mockuper för nästa etapp. Befintlig JEROC-design: aktuell logga,
vit vänstermeny, blå knappar, ljusa kort och inloggad person längst ned till vänster.
Alla uppgifter är fiktiva. Mockupen kontaktar inga API:er och sparar inga uppgifter
i appen, webbläsarens lagring eller databasen.

| Vy | Bild |
| --- | --- |
| Lageröversikt med mängd, reservationer, partier och lagringsgränser | [01_Lageroversikt.png](01_Lageroversikt.png) |
| Planerad utleverans med material, mottagare, transportör och dokumentunderlag | [02_Utleverans_Planerad.png](02_Utleverans_Planerad.png) |
| Bekräfta verklig last och avfärd | [03_Bekrafta_Lastad_Avfard.png](03_Bekrafta_Lastad_Avfard.png) |
| Registrerad utleverans och lodrät spårbarhet | [04_Utleverans_Registrerad.png](04_Utleverans_Registrerad.png) |
| Lager efter utleverans | [05_Lager_Efter_Utleverans.png](05_Lager_Efter_Utleverans.png) |
| Transportdokument A4 enligt användarens dokumentstil | [06_Transportdokument_A4.png](06_Transportdokument_A4.png) · [PDF](06_Transportdokument_A4.pdf) |

[Ladda ned den klickbara prototypen](JEROC_Lager_Utleverans_Mockuper.zip).
Packa upp ZIP-filen och öppna `index.html` i webbläsaren. Ingen installation behövs.
GitHubs vanliga HTML-förhandsvisning kör inte prototypen.

Flödet börjar i Lager. Öppna **Ny utleverans**, välj **Planera utleverans** och
sedan **Bekräfta avfärd**. Den planerade mängden är 1 000 kg, faktisk mängd
980 kg. Reservationen lämnar det registrerade lagret oförändrat. Vid avfärd
minskar blybatterilagret från 1 680 till 700 kg, den andra orderns reservation
på 300 kg ligger kvar och 400 kg blir fria. 20 kg av den egna reservationen
släpps utan lageravdrag. Lagerpartier och Händelser visar samma fördelning.
**Avbryt planering** släpper reservationen och behåller arbetsordern som utkast.

Utleveransen använder två källpartier: 650 kg från INV-2050 och planerat
350 kg från INV-3010. I detta exempel ligger första partiet fast och den
faktiska vikten kan provas inom 650–1 000 kg. En fullständig partiväljare och
ändrings-/inventeringsflöde är senare implementation. Sidomenyerna utanför
Lager och arbetsorderns detaljvy visar endast befintlig struktur.

Extern transportör har önskat tidsfönster. Åkeriet bekräftar tid, förare och
fordon; en intern förare krävs inte för att skapa arbetsordern. ADR-bedömning,
underskrifter och färdig borttransportanteckning markeras uttryckligen som
simulerade i avfärdsdialogen. Inget skickas till Naturvårdsverket, någon bank,
Visma eller någon meddelandetjänst.

A4-transportdokumentets layout följer användarens bifogade avräkningsnota:
kompakt logga, mörkblå rubrik/tabell, ljusblå och ljusgröna informationsrutor.
Transportinnehållet omfattar lämnare, mottagare, transportör, förare, fordon,
platser, vikt/avfallskod, källpartier och versionsanknutna demounderskrifter.
**Visa underlag → Öppna A4-förhandsvisning** visar planerade 1 000 kg utan
underskrifter före avfärd, eller 980 kg med simulerade underskrifter efteråt.
Den nedladdningsbara PDF-filen är det senare fiktiva designexemplet, en A4-sida.
Det är ingen giltig eller arkiverad dokumentversion; företagsidentifierare och
andra driftuppgifter är uttryckligen ofullständiga. Inga ekonomifält, priser
eller bankuppgifter följer med transportdokumentet.
De tidigare godkända mockuperna i `../farligt-avfall/` är bevarade.

Verifierat: sex skärmbilder och en ensidig A4-PDF renderade och granskade;
förhandsversion och faktisk last skiljer sig korrekt. Reservation, kontroll av
demoförutsättningar, engångsavfärd, lager-/partifördelning, händelser och sökning
provat i webbläsare. Båda huvudvyerna kontrollerade på smal skärm utan
horisontellt sidöverflöde. Prototypen gör inga backendanrop.

För att återskapa bilderna i utvecklingsmiljön:

```bash
node docs/mockups/lager-utleverans/render-mockups.mjs
```

Det kräver repots befintliga Playwright och Chromium. Bilder och prototyp är
designunderlag; verksamhetsfunktionerna i kontorsappen är oförändrade.
