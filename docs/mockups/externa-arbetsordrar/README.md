# JEROC – extern arbetsorder och mejlavisering

Designförslag 2026-10-10. Tre sammanhängande vyer i befintlig JEROC-design:
kontorets utleveransbeställning, åkeriets förfrågan och chaufförens uppdrag.
En fjärde bild visar mejlet som leder till förfrågan. Alla uppgifter är fiktiva.
Prototypen sparar inget i appen, använder inga API:er och skickar inga mejl.

| Vy | Bild |
| --- | --- |
| Kontoret – beställ utleverans och skicka transportförfrågan | [01_Kontoret_Transportforfragan.png](01_Kontoret_Transportforfragan.png) |
| Åkeriet – svara på förfrågan och tillsätt chaufför | [02_Akeriet_Forfragan.png](02_Akeriet_Forfragan.png) |
| Chauffören – eget uppdrag med lastning och transportunderlag | [03_Chaufforen_Uppdrag.png](03_Chaufforen_Uppdrag.png) |
| Mejl – ny transportförfrågan med länk till rätt uppdrag | [04_Mejl_Transportforfragan.png](04_Mejl_Transportforfragan.png) |

[Ladda ned den klickbara prototypen](JEROC_Externa_Arbetsordrar_Mockuper.zip).
Packa upp och öppna `index.html`; ingen installation behövs. GitHubs vanliga
HTML-förhandsvisning kör inte prototypen. Välj Kontoret, Åkeriet, Chauffören
eller Mejl i prototypens vyväljare. Samma AO-1048 följer alla vyer.

## Föreslaget flöde

1. Kontoret väljer avsändande anläggning, mottagare/leveransplats och material
   med uppskattad mängd. Därefter väljs åkeri, önskad tid och aviseringens mottagare.
2. Förfrågan visas hos åkeriet och ett mejl förbereds till dess transportledare.
   Önskad tid är inte en bekräftad bokning; fasta öppettider gäller separat.
3. Åkeriet accepterar, avböjer eller föreslår annan tid. Ett motförslag behöver
   bekräftas av kontoret. Åkeriet väljer en egen chaufför och ett fordon.
4. Chauffören ser sitt uppdrag, instruktioner och transportunderlag i mobilwebben.
   Körning till lastning är skild från avfärd med last.
5. Faktisk vikt, relevanta dokumentuppgifter och underskrifter färdigställs före
   bekräftad lastad avfärd. Först då minskas det fysiska lagret, en gång.

Exemplet använder Norrtälje, Nordic Metall AB och Sjöbergs Transport AB.
Utleveransen omfattar uppskattade 1 000 kg blybatterier. Det fysiska lagret är
1 680 kg; planering/reservation minskar den fria mängden men inte det fysiska
lagret. Ingen inkommande kunds viktkort väljs manuellt eller listas i översikten.
Transportörens acceptans är skild från kundgodkännande och dokumentunderskrift.

## Kopplingar som ska byggas i nästa appetapp

| Modul | Koppling |
| --- | --- |
| Anläggningar | Avsändande anläggnings-ID, öppettider och serverkontrollerad åtkomst |
| Lager/utleverans | Artikel-ID:n, planerad/reserverad/faktisk mängd och rörelsehistorik |
| Arbetsorder/karta/planerare | Samma order-ID; önskad, föreslagen, överenskommen och faktisk tid |
| Kund-/partsregister | Mottagare och leveransplats skilda från avsändare och faktureringskund |
| Personal/åkerier | Åkeritilldelning utan känd förare; transportledare väljer egna chaufförer |
| Chaufförsportal | Egna uppdrag, kontakt, dokument och utförandehändelser |
| Dokumentarkiv | AO-länkat transportunderlag; ändringar före fastställande ger rätt version |
| Miljö | Farliga material och verkliga händelser; koppar/vanligt lager hålls utanför NVV |
| Aviseringar | Separat leveransstatus och versionsanknutna mejlhändelser |

Arbetsorder, personal, chaufförsinloggning, dokumentutkast och beständig
integrationsutkorg finns redan. Åkeriets svarskö, transportledarkonto,
anläggningsindelning av transporter och komplett lager/utleverans behöver byggas.
Dagens kundbokningsbekräftelse är inte åkeriets uppdragsacceptans.

## Förberedelse för mejl

**Ny transportförfrågan** skickas till åkeriets utsedda transportkontakt.
**Nytt uppdrag** aviserar tilldelad chaufför, om en fungerande kontaktkanal finns;
annars följer transportledaren upp bemanningen. Ändring/återkallelse och en
konfigurerbar påminnelse för obesvarad förfrågan ska också kunna aviseras.
Kontoret får svarshändelser i arbetsordern och vid behov egen mejlavisering.

Mejlet innehåller AO-nummer, anläggning, mottagare, uppskattad last och önskad
tid, med knappen **Öppna förfrågan**. Länken ger inget godkännande i sig.
Den framtida portalen kan använda `/chauffor#/forfragningar/<order-id>` med
åkeri-/chaufförsroll; efter inloggning ska samma tillåtna uppdrag öppnas.
Denna åkerirutt finns inte i appen ännu. Inga priser, bankkonton eller HR-uppgifter
följer med aviseringen.

Den befintliga beständiga utkorgen och adaptergränsen återanvänds. Före riktiga
utskick behöver den utökas med mottagare/kanal, databaserad arbetsreservation,
återförsök och leverantörskvitton. Händelsen lagras i samma transaktion som
orderändringen. Nyckeln order/förfrågningsversion/händelse/mottagare/kanal
hindrar dubbla utkorgsposter; osäkert leveransresultat stäms av innan omsändning.
Återförsök skickar aviseringen, inte en ny arbetsorder eller lagerhändelse.
Gamla påminnelser stoppas när förfrågan besvarats, ersatts eller återkallats.
Förfrågningar till flera åkerier samtidigt ingår inte i första flödet.

Visa **Förberett**, **Simulerat** eller **Leveransfel** efter verkligt läge.
När en leverantör senare används skiljs accepterat utskick från faktisk
leverans, där leverantören stöder leveranskvitto. Ett öppnat mejl betyder
aldrig accepterat uppdrag. Riktig mejlleverantör och credentials väljs senare.

Föreslagna nya händelser, separata från kundens `work_order.confirmation_*`:

| Händelse | Mottagare/effekt |
| --- | --- |
| `transport_request.sent` | Åkeriets transportledare: ny förfrågan |
| `transport_request.accepted`, `.declined`, `.alternative_proposed` | Ansvarig beställare: svar i arbetskön, valfritt mejl |
| `transport_request.updated`, `.cancelled` | Berörd transportledare: ändrat/återkallat uppdrag |
| `transport_request.expired` | Beställaren: svarstiden har gått ut |
| `driver_assignment.created`, `.changed` | Tilldelad/berörd chaufför: nytt eller ändrat uppdrag |

Förfrågan har eget ID, åkeri-ID, revision, svarstid och status samt önskat,
föreslaget och överenskommet tidsfönster. Vanlig sparning av ett utkast
utlöser inget mejl; knappen **Skicka transportförfrågan** gör det. Ändrat
åkeri, material, adress eller tid kräver en ny aktuell revision och gammalt
svar får inte godkänna den. Oskickade äldre aviseringar ersätts. Vid byte av
åkeri återkallas den tidigare åtkomsten, medan historiken bevaras.

## Återskapa och kontrollera

```bash
node docs/mockups/externa-arbetsordrar/render-mockups.mjs
```

Renderingen använder repots Playwright/Chromium och lokala resurser.
Den skapar PNG-bilderna och kontrollerar det klickbara demoflödet, smal skärm
och att inga backend-/externa anrop görs. Inga databas- eller appändringar
ingår i mockupen. Tidigare godkända mockuper och PDF-original bevaras.

Verifierat 2026-10-10: de fyra bilderna är renderade och visuellt granskade.
Förfrågan, mejllänk, tidsförslag, kontorets bekräftelse, chaufförstilldelning,
körning till lastning, avböjande och ny revision är provade i prototypen.
Fysiskt lager och AO-ID bevaras genom dessa planeringssteg. Kontor, åkeri,
chaufför och mejl fungerar på smal skärm utan horisontellt sidöverflöde.
Inga JavaScript-fel eller backend-/externa anrop noterades.
