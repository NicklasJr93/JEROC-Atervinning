# Naturvårdsverket – JEROC:s anslutningsunderlag

Granskning **2026-10-09** inför byggplanering. Aktuell beställning är att
kontrollera API, testcertifikat och mockupflöden samt samla dokumentationen.
Den ursprungliga granskningen aktiverade ingen myndighetsanslutning.
Etapp 1 har därefter godkänts: [artikelmiljö, mottagning och ny testdata](etapp-1.md).
Aktuell leverans är kontorsdemo **0.12.0**, med en TEST-adapter och en gemensam
integrationssida. Se [aktuell testetapp](nvv-test-demo.md) för konfiguration,
gränser och faktiskt verifierade prov; den ursprungliga granskningen nedan
beskriver underlaget från 2026-10-09.

## Läs underlaget

| Dokument | Innehåll |
| --- | --- |
| [NVV:s första testetapp 0.12.0](nvv-test-demo.md) | TEST-klient, rapportjournal, kvittenser, rättelse, simulering och säkert osäkert utfall. |
| [Etapp 1 – leverans och provflöde](etapp-1.md) | Beständig mottagning, artikelklassificering, miljöbehörigheter och engångsåterställning av demoinvägningar. |
| [Byggplan i fyra etapper](byggplan.md) | Föreslagen leveransordning, ny extern åkeri-/chaufförsvy och separat startgodkännande för varje etapp. |
| [API-kontrakt](api-kontrakt.md) | Exakta rapporttyper, fält, platser, svar, rättelser och begränsningar i API:t. |
| [Certifikatgranskning](certifikatgranskning.md) | Vad ZIP-paketet innehåller, vilken certifikattyp vi behöver och vad som ännu inte är verifierat. |
| [Mockuper mot API](mockupmatchning.md) | Genomgång av vy 01–11, befintlig kod och nödvändiga kompletteringar. |
| [Testmiljö och verifiering](testmiljo.md) | Vad användaren behöver ordna, serverinställningar och föreslagna testfall. |
| [Uppladdad OpenAPI-definition](openapi/BTFA.Anteckning.json) | Myndighetens maskinläsbara API-beskrivning, bevarad oförändrad. |
| [Ursprungligt implementationsunderlag](underlag/JEROC_Farligt_Avfall_Specifikation_2026-10-09.txt) | Användarens bilaga; detaljkrav ska läsas tillsammans med senare beslut och denna granskning. |
| [Godkända mockuper och flöden](../../mockups/farligt-avfall/README.md) | Bilder, transportdokument och föreslagna interaktioner. |

## Det som är klarlagt

- Första avfallsslaget är **blybatterier, 16 06 01\***; API:t använder **160601**.
- JEROC:s antagna verksamhetsroll är **insamlare**: ta emot, lagra och lämna vidare.
  Mottagning rapporteras genom `/insamlingar`; borttransport av insamlat avfall
  genom `/insamlingstransport`. Transportörens egen rapporttyp är separat.
- Kundinlämning, JEROC-hämtning och utleverans med egen eller extern transportör
  ryms i flödena. Extern transportör anges som verklig transportör; det gör
  inte JEROC till ombud för åkeriets eller kundens rapportering.
- Vägning vid hämtning sker **hos kunden, före avfärd med last**.
- Transportdokument, miljöanteckning/API-rapport och ekonomisk avräkning har
  egna versioner och statusar. Kontorets nuvarande mottagningsflöde kräver
  kundgodkännande före mottagningsbekräftelse, med en särskild spårbar
  undantagsbehörighet vid kundtvist. Den faktiska mottagningstiden behålls;
  ekonomisk attest och betalning är separata från miljörapporten.
- API:t hanterar avfallskod och fysisk mängd; priser, BankID-godkännande och
  utbetalning ingår inte i dessa rapportobjekt.

## Granskningens viktigaste slutsatser

1. **ZIP-paketet innehåller hämtningsbrev, inte färdiga klientcertifikat.**
   Ett faktiskt klientcertifikat med privat nyckel behöver hämtas separat.
2. **Gratiscertifikatens organisationskoppling är inte bekräftad.** De generiska
   testbolagen är inte JEROC. Naturvårdsverket behöver bekräfta hur de får användas
   tillsammans med JEROC:s testanslutning, alternativt krävs eget testcertifikat.
3. **Platsuppgifter behöver struktureras.** För svensk adress används gatuadress,
   postnummer och kommunkod; andra villkorade platsalternativ finns i kontraktet.
   Kundens fakturaadress och
   materialets ursprungsplats är skilda uppgifter.
4. **Miljödata behöver gemensam beständig lagring.** Befintlig PostgreSQL används
   av terminaldelen. Order, miljöhändelser, lager, dokument och rapportkö behöver
   egna migrationer; dagens lokala orderregister och minnesbaserade demoutkorg
   räcker inte för den här integrationen.
5. **Rättelse ger ett nytt myndighets-ID.** Gamla och nya versioner måste länkas.
   Ett okänt svar efter nätverksavbrott får inte leda till blind omsändning.
6. **Mottagningstid och verksamhetsroll måste följa den verkliga händelsen.**
   Att chauffören kör till kunden, övertar avfallet eller anländer till JEROC
   är olika händelser. JEROC:s rutin för övertagande behöver fastställas.

## Vad är verifierat nu?

| Del | Resultat |
| --- | --- |
| Vald anslutning | Användarens portal visar **BTFA.Anteckning – Testmiljö** för JEROC. |
| API-definition | OpenAPI 3.0.1, API v1, 24 sökvägar och 34 scheman. Fälten motsvarar tidigare officiell Swagger; svenska beskrivningar har återställts. |
| Testcertifikatpaket | ZIP-struktur och PDF-innehåll granskade. Inget färdigt klientcertifikat finns i paketet. |
| API-nycklar | Utdelade av myndigheten enligt användaren; säker serverkonfiguration är inte verifierad. Värden sparas inte här. |
| Certifikatacceptans | Inte verifierad mot Naturvårdsverkets testserver. |
| API-anrop | Inget autentiserat kodlisteanrop eller rapportanrop har utförts i denna granskning. |
| Applikation | 0.12.0 har beständig rapportjournal och TEST-adapter. Den är avstängd som standard och inget autentiserat myndighetsanrop har verifierats här. Se separat leveransdokument. |

## Nästa planeringsbeslut

- Vilket klientcertifikat myndigheten accepterar för JEROC:s testanslutning.
- När JEROC faktiskt tar över avfallet vid hämtning och vilka verksamhetsroller
  som ska rapporteras för egna transporter.
- Första kundtypen i officiellt test: företagsinlämning först är ett avgränsat
  förslag; hushåll/okänd innehavare kräver sina villkorade identifieringsregler.
- Gemensam servermodell, migrationsordning och koppling till befintliga lokala
  demoordrar/viktkort utan att gamla testdata raderas.
- Behörigheter för miljögranskning, rapportering/rättelse och integrationsinställningar.

Vi kan planera och bygga lokalt simulerade flöden innan extern testanslutning
är klar. **Simulerat**, **Naturvårdsverkets TEST** och senare **PRODUKTION**
ska vara skilda lägen med tydlig visning och separata inställningar.

## Källor och filer

- [Naturvårdsverket: Avfallsregistrets API](https://www.naturvardsverket.se/vagledning-och-stod/avfall-farligt-avfall/rapportera-till-avfallsregistret-via-api/)
- [Naturvårdsverket: anslutning och autentisering](https://www.naturvardsverket.se/verktyg-och-tjanster/api-tjanster/anslutning-till-api-tjanst/)
- [API-portalen, BTFA.Anteckning](https://apionboarding.naturvardsverket.se/apis/BTFA.Anteckning/)
- [Expisoft: publika testcertifikat](https://eid.expisoft.se/expitrust-test-certifikat/)

OpenAPI-filen hämtades av användaren från API-portalen och granskades den
2026-10-09. SHA-256:
`4b29c43f4c6b818b13aaec51488edd06779a4a35f41fb7fb3bd1fe9c3f5f74cb`.
Filens serverlista anger produktion, inklusive HTTP; implementationen ska
välja den utfärdade **HTTPS-adressen för test** uttryckligen. Filens inbyggda
build-datum är 2023-05-23 och är inte ett påstående om när tjänsten senast uppdaterades.
