# JEROC – arbetsorder och kundportal för kärl

Designförslag 2026-10-10 i befintlig JEROC-design. Arbetsorder är den gemensamma
grunden för hämtning, byte, utställning och utleverans. Kundens beställning,
kontorets lista och transportplaneringen ska använda samma ordernummer.

De tre huvudvyerna:

| Vy | Bild |
| --- | --- |
| Arbetsorder – översikt med egna och externa uppdrag | [01_Arbetsorder_Oversikt.png](01_Arbetsorder_Oversikt.png) |
| Skapa arbetsorder – uppdragstyp och dynamiska uppgifter | [02_Skapa_Arbetsorder.png](02_Skapa_Arbetsorder.png) |
| Kundportal – egna kärl, containrar, avtal och hämtningar | [03_Kundportal_Karl.png](03_Kundportal_Karl.png) |

Kompletterande bilder:

| Vy | Bild |
| --- | --- |
| Kundinloggning | [04_Kundportal_Inloggning.png](04_Kundportal_Inloggning.png) |
| Kundens önskemål om byte | [05_Kund_Bestall_Byte.png](05_Kund_Bestall_Byte.png) |
| Kundportal på mobil | [06_Kundportal_Mobil.png](06_Kundportal_Mobil.png) |
| Boka utleverans från lager – förifylld arbetsorder | [07_Utleverans_Fran_Lager.png](07_Utleverans_Fran_Lager.png) |
| Kundens beställning i kontorets lista | [08_Kundbestallning_Pa_Kontoret.png](08_Kundbestallning_Pa_Kontoret.png) |

[Ladda ned den klickbara prototypen](JEROC_Arbetsorder_Kundportal_Mockuper.zip).
Packa upp och öppna `index.html`. Allt körs lokalt utan installation eller
externa resurser. GitHub visar bilderna och källfilerna; prototypen körs efter
nedladdning. De godkända [åkeri- och chaufförsvyerna](../externa-arbetsordrar/README.md)
behålls som underlag för nästa steg.

## Kontorets flöde

- Menyn **Lager** visar material och mängder. **Boka utleverans** öppnar en
  ny arbetsorder med utleverans, lastande anläggning och valt material förifyllt.
- Menyn **Arbetsorder** samlar alla uppdrag. Typ, status, anläggning, utförare
  och källa går att skilja åt i listan. Aktiva och historik är separata flikar.
- **Ny arbetsorder** erbjuder Hämtning, Byte, Utställning och Utleverans.
  Fälten anpassas efter uppdraget. Byte har både hämtat fullt och levererat
  tomt kärl; utleverans har lastningsplats, mottagare, material och mängd.
- Egna chaufförer är förvalt. Förare och fordon kan tilldelas senare. En
  önskad tid blir inte bokad av att arbetsordern skapas. Standardtid är 60 min.
- Vid externt åkeri skapas en förfrågan. Åkeriets ja/nej och valfria tidsförslag
  följer det redan granskade externa flödet. Dokumentunderskrift är ett eget steg.

## Kundens flöde

Exempelkunden Elektriska AB har två konkreta utställda tillgångar:

- **K-0660:** 660-liters kabelkärl på fyra hjul, med rullande bytesavtal.
  Kunden trycker Beställ byte och kan ange önskad dag samt valfri kommentar.
  Det skapar en arbetsorder med status Att planera på kontoret.
- **C-1042:** hyrd skrotcontainer på 10 m³ med bokad hämtning 19 oktober.
  Önska tidigare hämtning kopplas till befintliga **AO-1052**. Bokad tid står
  kvar och det nya önskemålet visas separat tills en ändring bekräftats.

Kärlkorten visar ID, storlek, material, kundplats, avtal och nästa åtgärd.
Kunden väljer ingen chaufför eller transportör. Åtgärder styrs av avtal och
befintlig beställning. En aktiv förfrågan visar Visa önskemål i stället för
att låta kunden skapa en dublett. Extra önskemål ändrar inte ett återkommande
avtalsschema. Tillgångens placering ändras först när uppdraget verkligen utförts.

## Vad prototypen gör

Klicka mellan vyerna i nederkanten. Du kan filtrera arbetsorder, byta uppdragstyp,
prova utleverans från lager, skapa ett exempeluppdrag och skicka kundens önskemål.
Kundens nya order dyker upp i kontorets lista. Alla uppgifter finns bara i minnet
i samma öppna sida; Återställ eller omladdning återgår till grundexemplet.

Inloggningen är uttryckligen en demo. Ingen riktig autentisering, avtalshantering,
databaslagring, mejlleverans, lagerändring eller NVV-rapportering aktiveras.
Bildserien är underlag för granskning, inte en ny version av produktionsappen.

## Koppling till befintliga moduler inför implementation

| Modul | Koppling som behöver byggas |
| --- | --- |
| Arbetsorder / planerare | Gemensamt order-ID; kundförfrågan och bokad tid hålls isär |
| Lager | Utleverans är uppdragstyp; reservation skild från faktiskt lageravdrag |
| Kärl / containrar | Tillgångs-ID, kundplacering och historik skilda från kärltypen |
| Kund / avtal | Tillåtna åtgärder, kundplatser, hyresperiod och återkommande schema |
| Personal / åkeri | Egna förare som förval; separat externt åkerisvar och bemanning |
| Kundportal | Serverkontrollerad åtkomst till det egna företagets platser och uppdrag |
| Dokument / miljö | Versionsbundna transportdokument; farligt avfall hanteras separat |

Nuvarande transportmodeller har hämtning, byte och utställning. Utleverans samt
ett beständigt kärl-/avtalsregister och kundportal är planerade utökningar.
Allmänt materiallager ska hållas separat från NVV:s flöde för farligt avfall.
Ändringar i godkända uppdrag ska hanteras med spårbara revisioner.

## Rendering och kontroll

Från repots rot, med dess befintliga Playwright-installation:

```sh
node docs/mockups/arbetsorder-kundportal/render-mockups.mjs
```

Kontrollen gäller endast den fristående mockupen. Den provar filter, uppdragstyper,
förifyllning från lager, egna/externa uppdrag, kopplingen kundönskemål → arbetsorder,
dubblettskydd samt tidigare hämtning utan att skriva över den bokade ordern.
Den kontrollerar också smal skärm och att alla resurser hämtas lokalt.
De åtta bildexporterna granskas visuellt. Inga produktionssviter behöver köras
för detta designunderlag.
