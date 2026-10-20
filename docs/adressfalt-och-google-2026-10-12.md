# Adressfält och Google-förslag

Inventerat 12 oktober 2026. Adresshjälp enligt ÄL 087 implementerad 20 oktober 2026.
Se [drift, nycklar och verifierat flöde](integrationer/google-adresser.md).
Inventeringen nedan behålls som underlag; pris-/planeringsavsnitten är historiska.

## Adressfält som finns idag

Listan omfattar verkliga geografiska adressinputs. E-post, server-URL:er,
OAuth-returadresser, mockuper och rena adressvisningar räknas inte som inputs.

| Vy | Adressfält | Kod |
| --- | --- | --- |
| Kontor, invägningskort | Ursprungsadress; sparade ursprung som snabbval | [OfficeApp.tsx](../src/office/OfficeApp.tsx#L2581) |
| Kontor, snabbskapa kund på viktkortet | Gatuadress, postnummer, ort | [QuickCustomerModal.tsx](../src/office/QuickCustomerModal.tsx#L149) |
| Kontor, skapa/redigera kund | Adress, postnummer, ort; gemensamt formulär | [CustomerWorkspace.tsx](../src/office/CustomerWorkspace.tsx#L1405) |
| Kontor, kundens sparade ursprung | Ny/redigerad ursprungsadress | [CustomerWorkspace.tsx](../src/office/CustomerWorkspace.tsx#L1257) |
| Kontor, skapa/redigera anläggning | Gatuadress, postnummer, ort, kommunkod | [FacilitiesWorkspace.tsx](../src/office/FacilitiesWorkspace.tsx#L51) |
| Kontor, skapa/redigera arbetsorder | Hämtningsplats eller leveransplats: gata, postnummer, ort | [WorkOrderForm.tsx](../src/office/logistics/WorkOrderForm.tsx#L71) |
| Kontor, transportplaneringens bokningsformulär | Hämtningsadress och ort; inget eget postnummerfält | [TransportOrderEditor.tsx](../src/office/transport/TransportOrderEditor.tsx#L306) |
| Kontor, arbetsorderns förberedda vägning | Ursprungsadress innan färdigställande | [WorkOrderWeighing.tsx](../src/office/logistics/WorkOrderWeighing.tsx#L102) |
| Kontor, nytt kärl med befintlig kundplacering | Placeringens gata, postnummer, ort | [VesselsWorkspace.tsx](../src/office/logistics/VesselsWorkspace.tsx#L92) |
| Kontor, skapa/redigera person | Adress för anställd eller extern chaufför | [PersonalWorkspace.tsx](../src/office/personnel/PersonalWorkspace.tsx#L191) |
| Kontor, miljömottagning/miljörättelse | Samma ursprungsadress som viktkortet | [EnvironmentReceiptPanel.tsx](../src/office/EnvironmentReceiptPanel.tsx#L328) |
| Kontor, transportdokument | Avsändare, mottagare och transportör: gata, postnummer, ort | [TransportDocumentPanel.tsx](../src/office/documents/TransportDocumentPanel.tsx#L105) |
| NVV:s systemadminstest | Senaste/kommande hanteringsplats: adressrad, postnummer, kommunkod | [NvvSandboxWorkspace.tsx](../src/office/NvvSandboxWorkspace.tsx#L203) |
| Visma sandbox, testleverantör | Adress, postnummer, ort och landkod | [VismaSandboxWorkspace.tsx](../src/office/VismaSandboxWorkspace.tsx#L541) |
| Mobil, ny kund | Kundadress som en sammanhängande rad | [Customer.tsx](../src/pages/Customer.tsx#L302) |
| Mobil, Referens & ursprung | Ursprungsadress; sparade ursprung som snabbval | [Customer.tsx](../src/pages/Customer.tsx#L398) |
| Mobil, fordonsutvägning | Ursprungsadress för vald kund | [Vehicle.tsx](../src/pages/Vehicle.tsx#L229) |

Arbetsorderns anläggningsadress hämtas från anläggningsregistret. Miljöunderlagets
senaste hanteringsplats härleds från ursprunget och kommande plats från vald
anläggning; dessa ska inte bli nya dubbla adressregister.

Transportdokumentets adressblock går att redigera i fristående/äldre utkast;
arbetsorderstyrda dokument är låsta. Befintliga kärl flyttas genom utförd
arbetsorder, inte genom att skriva om placeringsadressen direkt.

Kund-, chaufförs-, åkeri- och personalportaler visar uppdrags-/kärladresser men
har inga egna geografiska adressinputs i de inventerade flödena. Terminalen
har inte heller sådana inputs.

## Vad adressförslaget behöver göra

- Fyll gatuadress inklusive husnummer, postnummer och ort från valt förslag.
  Visa exempelvis `Storgatan 12, 761 41 Norrtälje`; håll uppgifterna strukturerade
  där modellen har separata fält. Postnummer kan normaliseras till `76141` vid
  API-anrop. Ett redan komplett äldre textfält ska inte dubblera ort/postnummer.
- Använd samma komponent för fristående adressrader och grupper av adressfält.
  Ändra inga låsta kundgodkännanden, mottagningar eller transportdokument.
- Gör Sverige till standard för sökning och behåll manuell inmatning vid
  uteblivet förslag, nätfel eller nådd kvot. Saknade husnummer/postnummer ska
  kunna kompletteras, inte antas vara korrekta bara för att Google gav en träff.
- Låt miljöflödet fortsatt matcha kommunen säkert. Googles adresskomponenter
  är inte SCB/NVV:s fyrsiffriga kommunkod; postnummer är inte en kommunkod.
- Begränsa anrop med en kort skrivfördröjning, minsta inmatningslängd,
  sessionsidentifiering, autentiserade endpoints och användningsgränser.
  Skicka endast adressökningen, inte kundens övriga person-/betalningsuppgifter.

## Googles prislista och setup

Kontrollerat mot Googles officiella dokumentation 12 oktober 2026:

| Tjänst/SKU | Fri användning per månad | Första betalda intervallet, USD per 1 000 händelser |
| --- | ---: | ---: |
| Autocomplete Requests | 10 000 | 2,83 |
| Place Details Essentials | 10 000 | 5,00 |
| Places UI Kit Query | 10 000 | 1,00 |
| Places UI Kit – Autocomplete Per Session | 10 000 | 10,00 |

Det är gratiskvoter per SKU, inte en garanti om 10 000 färdiga adresser gratis.
Flera sökanrop kan göras medan användaren skriver. För vanlig Autocomplete
(New) med session som avslutas med Place Details Essentials debiteras de första
12 autocomplete-anropen enligt Autocomplete Requests; efterföljande anrop i
samma session har en separat kostnadsfri sessions-SKU. Valet av adress utlöser
dessutom detaljanropet. Andra tjänster/uppgiftsfält kan ha andra priser.

Det behövs:

1. Google Cloud-projekt kopplat till ett aktiverat faktureringskonto.
2. Places API (New). Om vald widget använder Maps JavaScript/Places UI Kit
   behövs dess dokumenterade JavaScript-setup och API-aktivering också.
3. API-nyckel begränsad till rätt API. Webbläsarnyckel begränsas till rätt
   webbdomäner; separat servernyckel används bara på servern och begränsas
   även till tillåtna utgående IP-adresser när dessa är kända/stabila.
4. Budgetlarm, kvoter och en faktisk användningsgräns. Budgetlarm i sig
   stänger inte av anrop eller debitering.
5. Leverantörsattribution och villkor/integritetsinformation enligt vald tjänst.

Inga nycklar behöver skickas i chatten. Google-inställningar läggs senare i
kopplingens säkra konfiguration. Inga Google-tjänster eller kostnader har
aktiverats av denna granskning.

## EES-villkor som påverkar valet av komponent

Google tillåter adressökning och autocomplete som ett användningsfall för
Places API i EES. Samtidigt har EES Service Specific Terms särskilda villkor:
vanligt Places-innehåll får, med angivna undantag för koordinater/place ID,
inte användas tillsammans med någon karta. Places UI Kit är undantaget från
de angivna begränsningarna i avsnitt 15.1 och 15.2, och har egna pris-SKU:er.

Det berör transportplaneraren, som redan använder Leaflet/OpenStreetMap.
För en vy där Google-förslag visas tillsammans med kartan ska vi därför välja
en komponent/licens som stöder detta, exempelvis bedöma Places UI Kit, i stället
för att anta att ett vanligt Places-svar får visas på den befintliga kartan.

Places-policyerna begränsar också förhämtning och lagring av API-innehåll;
place ID kan sparas utan tidsgräns och koordinater har särskilda regler.
Viktkort, kundregister och miljöunderlag behöver beständiga adresser. Före
implementation ska vi fastställa ett tillåtet upplägg för de adresser användaren
bekräftar och sparar, alternativt välja adress-/valideringstjänst med rätt
lagringsvillkor. Att döpa om ett rått Places-svar till kunddata är inte en lösning.

## Stöd från 20 oktober 2026

Google adresser har ett konfigurationskort och ett adressprov under Integrationer. Gemensam adresshjälp finns i de redigerbara formulären ovan, med separat servervalidering och aktiv bekräftelse. Kartanknutna transportformulär har fortsatt manuell adressinmatning enligt EES-avgränsningen.

Transportplanerarens
**Hitta adress** söker manuellt efter koordinater via Nominatim. Miljöunderlagets
resolver söker efter adress/kommun via Nominatim efter en medveten kontroll.
Den publika Nominatim-tjänsten är inte en tjänst för autocomplete och ska inte
anropas vid varje tangenttryck. Webbläsarens `autoComplete="street-address"`
i snabbkundformuläret är vanlig webbläsarautofyllnad, inte Google Places.

## Officiella källor

- [Google Maps Platform-prislista](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Autocomplete-sessioners prissättning](https://developers.google.com/maps/documentation/places/web-service/session-pricing)
- [Place Autocomplete Widget och setup](https://developers.google.com/maps/documentation/javascript/place-autocomplete-new)
- [Places API-policyer](https://developers.google.com/maps/documentation/places/web-service/policies)
- [EES Service Specific Terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
- [Tillåtna användningsfall för Places API i EES](https://cloud.google.com/terms/maps-platform/eea-places-api-permitted-uses)
- [Google EES FAQ](https://developers.google.com/maps/comms/eea/faq)
