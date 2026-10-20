# ScrapPlanner

System för återvinningens kundregister, material, vägning, kundgodkännande,
attest, dokument, personal och transporter. Kontoret och mobilappen delar
backend och bolagsdata. Den publika hemsidan byggs separat i `website/`.

## Hitta rätt

| Jag vill … | Läs här |
| --- | --- |
| Använda systemet, ställa in bolaget eller introducera personal | [Användarmanual](docs/manual/README.md) |
| Hitta en funktionsguide eller tidigare beslut | [Dokumentationsöversikt](docs/README.md) |
| Drifta, uppdatera eller felsöka | [Driftguide](docs/drift/README.md) |
| Köra lokalt och utveckla | [Utvecklarguide](docs/utveckling.md) |
| Se beställda ändringar och leveranser | [Ändringslistan, ÄL](docs/Andringslistan.txt) |
| Se granskbara designförslag | [Mockuper](docs/mockups/README.md) |
| Arbeta med den publika hemsidan | [Hemsidans projektguide](website/README.md) |

## Ingångar till pilotinstallationen

- [Hemsidan](https://scrapplanner.com)
- [Kontoret](https://app.scrapplanner.com/kontor/)
- [Mobilappen](https://mobile.scrapplanner.com/mobil/)
- [QR-kod för Expo Go](https://app.scrapplanner.com/expo-go)

Använd ditt personliga konto. Vilka funktioner och anläggningar som visas styrs
av kontot och bolaget. Systemadmin kan välja bolag genom **Jobba som**.

Mejl via Resend, SMS via 46elks, SCB, Roaring och Google-adresshjälp har egna
konfigurationer. Bokföring, betalningar, BankID och myndighetsanslutningar har
separata miljöer och aktiveringssteg; se [integrationsöversikten](docs/integrationer/README.md).
En byggd funktion eller registrerad nyckel betyder inte att dess skarpa
leverantörsflöde är verifierat.

## Bidra och underhålla

Uppdatera manualen när arbetsgången ändras, ämnes-/driftguiden när tekniken
ändras och ÄL när en beställd ändring levereras. Länka till samma instruktion
i stället för att skapa parallella kopior. [Dokumentationsregler](docs/README.md#så-underhåller-vi-dokumentationen).

Äldre demo- och byggguider behåller sina sökvägar och finns samlade under
[historik och referenser](docs/README.md#förslag-äldre-versioner-och-historik).
Den äldre [Live ScrapPlanner-överlämningen](LIVE_SCRAPPILOT_SETUP.md) är underlag
för den ursprungliga installationen; använd driftguiden för fortsatt drift.
