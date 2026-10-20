# ScrapPlanner – dokumentation

Här börjar du när du ska använda, drifta eller vidareutveckla ScrapPlanner.
Granskad 20 oktober 2026. Äldre filer och bildlänkar behåller sina sökvägar.

## Välj ingång

| Jag vill … | Börja här |
| --- | --- |
| Lära mig kontoret, mobilappen och arbetsflödet | [Användarmanual](manual/README.md) |
| Ställa in bolaget, lägga upp personal eller hjälpa en kund | [Användarmanual](manual/README.md), sedan ämnesguiden nedan |
| Uppdatera eller felsöka en installation | [Driftguide](drift/README.md) |
| Köra projektet lokalt och ändra koden | [Utvecklarguide](utveckling.md) |
| Förstå moduler, bolagsgränser och datagarantier | [Arkitektur](arkitektur.md) |
| Se beslut, leveranser och kvarstående arbete | [Ändringslistan, ÄL](Andringslistan.txt) |
| Granska ett förslag på gränssnitt | [Mockuper](mockups/README.md) |

Manualen beskriver arbetsgången för användaren. Ämnesguiderna innehåller
fördjupning, behörighetsregler och tekniska begränsningar. Driftguiden är ingången
till installation, konfiguration och felsökning. ÄL beskriver ändringarna över tid.

## Aktuella ämnesguider

### Bolag, personal och inloggning

| Ämne | Guide |
| --- | --- |
| Företagsuppgifter, logga och anläggningarnas öppettider | [Företagsinställningar](foretagsinstallningar.md) |
| Personalkonto, inbjudan och rättning av uppgifter | [Personliga inloggningar för personal](personal-inbjudningar.md) |
| Ge en medarbetare rätt att hantera vanliga konton | [Delegerad användarhantering](delegerad-anvandarhantering.md) |
| Glömt lösenord för kontor och systemadmin | [Lösenordsåterställning](losenordsaterstallning.md) |
| Systemadmin som arbetar i mobilappen | [Mobil systemadmin](mobil-systemadmin.md) |
| Schema och tid i mobilen | [Appens schema och tid](employee-mobile.md) |
| Närvaro och månadsgranskning | [Närvaro](personal-narvaro.md) · [Månadsgranskning](personal-manadsgranskning.md) |

### Kund, vägning och underlag

| Ämne | Guide |
| --- | --- |
| Artikelgrupper, bilder och presentation i mobilappen | [Artikelkatalog](article-catalog.md) |
| Kunden fyller i uppgifter via SMS eller terminal | [Kunduppgifter via terminal eller SMS](kunduppgifter-terminal-sms.md) |
| Företagsuppslag, registeruppgifter och momsstatus | [SCB:s företagsregister](integrationer/scb-foretagsregister.md) |
| Personuppslag, tiosiffrigt nummer och debiteringsunderlag | [Personuppslag och SaaS-förbrukning](personuppslag-och-saas-forbrukning.md) |
| Adressförslag och automatisk ifyllnad av postnummer/ort | [Google-adresser](integrationer/google-adresser.md) |
| Kundgodkännande och personalens kontroll av legitimation | [Kundgodkännande via länkar och terminal](kundgodkannande-lankar.md) |
| Kontorets mejlkopia efter attest | [Vägt underlag via e-post](integrationer/vagt-underlag-epost.md) |
| Frysta dokument och PDF-lagring | [PDF-arkiv](pdf-archive.md) |

### Drift och anslutningar

| Ämne | Guide |
| --- | --- |
| Samlad drift och felsökning | [Driftguide](drift/README.md) |
| ScrapPlanners Render-resurser och domäner | [Render-installation](deployment/scrapplanner-render.md) |
| Öppna den befintliga mobilappen utan appbutik | [Expo Go för livepiloten](expo-go-live.md) |
| Testa systemets e-post och SMS | [Systemutskick](integrationer/systemutskick.md) |
| Databas, sparande och import | [Gemensam databas](shared-postgres.md) |
| Spiris: miljö, anslutning och ekonomiflöde | [Spiris sandbox](integrationer/spiris-visma/sandbox-setup.md) · [Bokföringsuppföljning](integrationer/spiris-visma/bokforingsuppfoljning.md) |
| Naturvårdsverkets API och testunderlag | [Naturvårdsverket](integrationer/naturvardsverket/README.md) |
| Microsoft 365/Outlook | [Mejlintegration](integrationer/microsoft365-mejl.md) |
| GPS, fordon och enhetskoppling | [Telematik](integrationer/telematik/README.md) |

En funktion kan vara byggd i koden utan att leverantörens produktionsanslutning
är aktiverad. ÄL:s leveransstatus och ett lyckat lokalt prov är inte ett
driftkvitto. Kontrollera rätt miljö och den faktiska anslutningsstatusen i
applikationen innan ett externt flöde används. Ämnesguiden anger dess begränsningar.

## Förslag, äldre versioner och historik

| Material | Hur det ska läsas |
| --- | --- |
| [Mockuper](mockups/README.md) | Gränssnittsförslag med bilder och status på respektive sida. En mockup betyder inte att funktionen är byggd. |
| [Vågkoppling](integrationer/vagar.md) | UI-förslag och tekniska alternativ; ingen direkt anslutning till en fysisk våg är byggd av förslaget. |
| [SaaS-blueprint](saas-blueprint/README.md) | Arkitektur och byggrecept för återanvändning i andra produkter. Befintlig implementation och föreslagna delar skiljs åt där. |
| [Planerade uppdateringar](planerade-uppdateringar.md) | Äldre och löpande planeringsanteckningar. Kontrollera senare ÄL-poster och aktuell ämnesguide innan en punkt behandlas som kvarstående. |
| [Kontorsversioner](office-demo.md), [personal](personnel-demo.md), [terminal](terminal-demo.md) och [logistik](logistics-demo.md) | Ämnesbeskrivningar och tidigare leveranser. Versionsrubriker, demoadresser och gamla begränsningar är historiska; använd manualen för dagens arbetsgång. |
| [Tidigare kontorsbilder](office-demo/) och [mobilbilder](mobile-demo/README.md) | Referensbilder från angivna versioner. |
| [Äldre liveöverlämning](../LIVE_SCRAPPILOT_SETUP.md) | Ursprungligt uppdrag för den separata pilotinstallationen. Läs driftguiden för fortsatt arbete i en redan skapad installation. |
| [Äldre Render-guide](render.md) och [återanvända Expo-lösningen](expo-go-ateranvandning.md) | Ursprunglig demodrift respektive recept för ett annat projekt. Ska inte ersätta den befintliga installationens driftguide. |
| [Granskningar](granskningar/affarskedja-2026-10-16.md), [lanseringsgranskning](security/launch-readiness-2026-10-14.md) och daterade bygg-/provrapporter | Beslut och observationer från det angivna tillfället. Bevara som underlag; de intygar inte en senare version. |
| [ScrapPlanner-original](branding/scrapplanner/README.md) och [tidigare varumärkesmaterial](branding/README.md) | Bildoriginal och designhistorik. Produktnamnet är ScrapPlanner; äldre ScrapPilot-namn i tekniska nycklar och historiska dokument kan finnas kvar. |

Ett filnamn som slutar på `-demo` gör inte hela innehållet oanvändbart.
Aktuella ämnesguider länkar vidare till äldre dokument när en detalj fortfarande
gäller. Daterade byggplaner och provrapporter används som historik, inte som en
andra manual.

## Så underhåller vi dokumentationen

1. **Uppdatera där uppgiften hör hemma.** Arbetsgång i manualen, konfiguration
   och felsökning i drift-/ämnesguiden, utvecklingskommandon i utvecklarguiden.
   Länka till samma uppgift från andra dokument i stället för att kopiera den.
2. **Dokumentera ändringen i samma leverans som koden.** Uppdatera befintlig
   guide och ÄL-posten när beteendet ändras. En ny guide behövs först när ett
   nytt ämne saknar en naturlig plats; skapa inte en ny dagsrapport för en
   vanlig justering.
3. **Ange vad status betyder.** Skilj på förslag, implementerat, lokalt
   verifierat och verifierat i drift. Ange datum och relevant kodversion för
   ett provresultat. Leverantörsmiljö anges separat, till exempel sandbox.
4. **Bevara spårbarheten.** Flytta eller radera inte äldre underlag bara för
   att de är gamla. Länka till ersättaren och märk en inaktuell instruktion
   när den upptäcks. Befintliga GitHub-länkar ska fortsätta fungera.
5. **Håll privata uppgifter utanför dokumenten.** Visa variabelnamn och
   fiktiva exempel. Förvara inte nycklar, lösenord, kundregister eller verkliga
   personnummer i instruktioner, skärmbilder och provdata.

Vid en motsägelse: kontrollera aktuell implementation och miljö, rätta den
ansvariga guiden och länka den från den äldre texten. Behåll ÄL och gamla
provprotokoll som historik i stället för att skriva om vad som gällde då.
