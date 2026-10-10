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
| Fastställd demoversion av transportdokumentet, faktisk last 980 kg | [06_Transportdokument_A4.png](06_Transportdokument_A4.png) · [PDF](06_Transportdokument_A4.pdf) |
| Utkast till transportdokument, planerad last 1 000 kg | [07_Transportdokument_Utkast_A4.png](07_Transportdokument_Utkast_A4.png) · [PDF](07_Transportdokument_Utkast_A4.pdf) |

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

De första fem lagerbilderna och det klickbara lagerflödet behåller det tidigare
partiexemplet: 650 kg från INV-2050 och planerat 350 kg från INV-3010. Där kan
den faktiska vikten provas inom 650–1 000 kg, med första partiet oförändrat.
Detta är ett äldre UX-exempel, inte ett krav på manuell partifördelning.
De uppdaterade A4-dokumenten visar en sammanlagd rad för blybatterier och
avfallskod; inkommande kundkort och källpartier listas inte på dokumentet.

Inför implementation föreslås ett förenklat lager per artikel, avfallskod och
anläggning med automatiskt sparad rörelsehistorik för mottagning, reservation,
utleverans och rättelse. Personal ska inte behöva ange vilken enskild kunds
batterier som har lastats. Den förenklingen återstår att föra över till
lageröversikten och utleveranskortet. Ändrings-/inventeringsflödet är senare
implementation. Sidomenyerna utanför Lager och arbetsorderns detaljvy visar
endast befintlig struktur.

Extern transportör har önskat tidsfönster. Åkeriet bekräftar tid, förare och
fordon; en intern förare krävs inte för att skapa arbetsordern. ADR-bedömning,
underskrifter och färdig borttransportanteckning markeras uttryckligen som
simulerade i avfärdsdialogen. Inget skickas till Naturvårdsverket, någon bank,
Visma eller någon meddelandetjänst.

A4-transportdokumentets layout följer användarens bifogade avräkningsnota:
kompakt logga, mörkblå rubrik/tabell, ljusblå och ljusgröna informationsrutor.
Transportinnehållet omfattar lämnare, mottagare, transportör, förare, fordon,
vikt/avfallskod och två versionsanknutna underskriftsrutor med metod, version
och tid. Alla tre juridiska parter har fiktiva demo-organisationsnummer och
adresser. Adresserna anges i respektive partkort; separata upprepningar av
Från/Till-adresser och avsnittet Kopplade lagerpartier har tagits bort.
**Visa underlag → Öppna A4-förhandsvisning** visar planerade 1 000 kg utan
underskrifter före avfärd, eller 980 kg med simulerade underskrifter efteråt.
Utkastet och den fastställda demoversionen har var sin bild och ensidiga A4-PDF.
Varje dokument har en QR-kod märkt **Öppna mockup**, som öppnar just den
dokumentbilden i GitHub. QR-koden länkar inte till ett produktionsarkiv eller
en verifieringstjänst. PDF-filerna är designunderlag som delas i GitHub;
inget verksamhetsarkiv, verklig underskrift eller serverlagrat PDF-original
har införts. Den fastställda demoversionen visar simulerade underskrifter,
inte ett giltigt dokumentbevis. Inga ekonomifält, priser eller bankuppgifter
följer med transportdokumentet.
De tidigare godkända mockuperna i `../farligt-avfall/` är bevarade.

Bildserien omfattar sju PNG-bilder, två ensidiga A4-PDF:er och ZIP-prototypen.
De två nya A4-versionerna är renderade och granskade: rätt utkast-/vikt-/
underskriftsstatus, laddade QR-bilder, versionsriktiga länkar och en A4-sida var.
Lagerprototypens reservation, kontroll av demoförutsättningar, engångsavfärd,
lager-/partifördelning, händelser och sökning är sedan tidigare provade i
webbläsare. Båda huvudvyerna är kontrollerade på smal skärm utan horisontellt
sidöverflöde. Prototypen gör inga backendanrop.

För att återskapa bilderna i utvecklingsmiljön:

```bash
node docs/mockups/lager-utleverans/render-mockups.mjs
```

För att bara uppdatera de två A4-bilderna och PDF-filerna:

```bash
node docs/mockups/lager-utleverans/render-mockups.mjs --a4-only
```

Det kräver repots befintliga Playwright och Chromium. Bilder och prototyp är
designunderlag; verksamhetsfunktionerna i kontorsappen är oförändrade.
