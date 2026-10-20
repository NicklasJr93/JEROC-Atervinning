# Integrationer

Översikt granskad **20 oktober 2026**. [Manual](../manual/README.md) ·
[Drift och konfiguration](../drift/README.md) · [Alla ämnesguider](../README.md).

**Integrationer** i kontorets vänstermeny samlar bolagets anslutningar.
Plattformens mejl-/SMS-test och förbrukningsunderlag ligger i systemadminvyn.
En funktion kan vara byggd utan att en viss installation eller ett bolag har
anslutit leverantören. **Registrerad/Konfigurerad** är inte ett leveransbevis.

## Hitta rätt anslutning

| Område | Byggt stöd och avgränsning | Guide |
| --- | --- | --- |
| Systemmejl · Resend | Testmejl, kontoinbjudningar, återställning, kundgodkännande och valbar PDF-kopia efter attest | [Systemutskick](systemutskick.md) · [PDF-kopia](vagt-underlag-epost.md) |
| SMS · 46elks | Test-SMS, kunduppgiftslänk och kundgodkännande. Automatiska transportaviseringar återstår. | [Systemutskick](systemutskick.md) · [Kunduppgifter](../kunduppgifter-terminal-sms.md) |
| Företagsuppslag · SCB | Exakt organisationsnummer, förslag på företagsuppgifter, känd momsstatus och tillgängliga kontakter | [SCB](scb-foretagsregister.md) |
| Personuppslag · Roaring | Nya kunder, intern matchning före köpt uppslag, journal per bolag och månadsunderlag | [Personuppslag och förbrukning](../personuppslag-och-saas-forbrukning.md) |
| Google-adresser | Places-förslag direkt i adressfältet, postnummer/ort från komplett träff och valfri separat servervalidering | [Google-adresser](google-adresser.md) |
| Microsoft 365 / Outlook | Första läsversion för anslutna inkorgar; OAuth, åtkomst och verkligt anslutningsprov hanteras separat | [Microsoft 365](microsoft365-mejl.md) |
| Spiris / Visma eEkonomi | Sandbox för inköps-/bokföringsflöde och uppföljning. Produktionsanslutning återstår. | [Sandbox](spiris-visma/sandbox-setup.md) · [Bokföringsuppföljning](spiris-visma/bokforingsuppfoljning.md) |
| Naturvårdsverket | TEST-adapter och rapportflöde; faktisk produktionsanslutning återstår | [NVV-underlag](naturvardsverket/README.md) · [Testflöde](naturvardsverket/nvv-test-demo.md) |
| Swish Utbetalning | MSS-simulator, inte skarp utbetalning. Kundens uppgiftsformulär visar Swish som Kommer snart. | [Swish-test](swish-mss-bygge-2026-10-13.md) |
| Bank · Open Payments | Sandbox för betalning och kontoinformation. Produktionsbank och utbetalningsbuntar kräver fortsatt arbete. | [Bankmotor](openpayments-bygge-2026-10-13.md) · [Utbetalningsplan](utbetalningar-plan.md) |
| GPS och telematik | Mottagargrund, digitala prov och enhetskoppling; fysisk tracker och skarp drift verifieras separat | [Telematik](telematik/README.md) |
| Fysisk våg | UI-förslag och tekniska alternativ; ännu ingen direkt viktanslutning | [Vågkoppling](vagar.md) |

BankID, Fortnox, Gmail och extern LME-prisleverantör är fortsatt planerade.
Det aktuella kundgodkännandet använder kundens **Godkänn** och personalens
fysiska legitimationskontroll, se [godkännandeflödet](../kundgodkannande-lankar.md).

NVV:s anslutning hanteras under **Integrationer → Naturvårdsverket**.
Rapporter, rättelser och kvittenser hanteras under **Miljörapportering**.
Tekniska testverktyg ska läsas med den miljö som anges i respektive guide;
en sandbox eller simulator ska inte behandlas som skarp anslutning.

## Bolag och behörighet

Pilotinstallationen använder plattforms- och personalsessioner med servervalt
bolag. **Jobba som** kan öppna ett bolag för behörig systemadmin, men klientens
bolags-ID eller användarheaders väljer inte serverns behörighet.
Integrationsmodulerna kontrollerar bolag, faktisk/utförande användare och
relevanta rättigheter. En gammal adapterbeskrivning för `jeroc-demo` är inte
ett påstående att dess inställningar automatiskt kan delas med andra bolag.

Läsning av integrationskatalogen ansluter inte automatiskt en leverantör eller
skickar ett meddelande. Varje verksamhetsflöde har egen sändnings-, versions-
och felhantering. Samma journal eller omförsöksregel gäller inte automatiskt
för både mejl, SMS, bokföring och betalning.

API-nycklar, lösenord, privata certifikat och OAuth-token hålls på servern.
Google-webbläsarnyckeln är ett särskilt undantag som begränsas till avsedda
webbplatser/API:er. Se [driftguiden](../drift/README.md) för variabelnamn och
skillnaden mellan sparad konfiguration och verifierad funktion.

## Historiska testunderlag

Daterade byggplaner, API-test och supportprotokoll behåller sina sökvägar.
De beskriver angiven version och miljö och ersätter inte respektive aktuell
ämnesguide. [Dokumentationsöversikten](../README.md) skiljer manual, drift,
planer och historik åt. För leveranser och kvarstående beställningar, se
[Ändringslistan](../Andringslistan.txt).
