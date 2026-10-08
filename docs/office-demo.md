# JEROC kontorsdemo 0.3.0

Öppna https://jeroc-atervinning.onrender.com/kontor. Samma repository och Render-tjänst används. Befintligt byggkommando, `npm start` och Expo-token behålls. Mobilappen är fortsatt version 0.2.3 på `/`; Expo Go fungerar som tidigare.

[Skärmbilder från version 0.2.0](office-demo/v0.2.0/README.md)

## Prova uppdateringen

- **Kajsa Nilsson:** granska viktkort, koppla kund, referens/ursprung, ID och betalningsuppgift. Läsa LME Cash, men inte ändra referenspriser eller artikelregler. Kundval räknar priset via servern. Knappen Beräkna priser uppdaterar ett redigerbart kort enligt reglerna på inlämningsdagen.
- **Anna Nilsson:** attest högst 25 000 kr, egen attest spärrad, demoutbetalningar. #2039 kan attesteras; #2040 överstiger gränsen. Ingen LME-behörighet.
- **Lars Andersson (VD):** verksamhetsmoment, artikeladministration, manuella LME-priser, kundprisregler och användare. Attest högst 100 000 kr. Kan inte ändra systemadmin eller tilldela en högre attestgräns än sin egen.
- **Systemadmin:** välj **Jobba som** i övre högra hörnet. Den valda användarens menyer, moment, maxbelopp och egenattestregel gäller. Historiken visar både inloggad och utförande användare. Avsluta Jobba som återställer systemadminläget.

Översikten har arbetsköer, snabbåtgärder, dagstatistik och en förhandsvisning när ett kort väljs. Attest och utbetalningar har egna nyckeltal och statusfilter. Användare med rapportbehörighet kan exportera den filtrerade kön som CSV; materialpriser respekterar prisbehörigheterna.

Viktkort visar material, prisregel och kundvolym per artikel under senaste 12 månaderna. Kontaktuppgifter, referens och ursprungsadress ligger under kundkortet; betalning och ID ligger i en kompakt egen del. Referens/ursprung kan användas först efter kundval. Fordonsunderlaget visar infart, utfart, netto före avdrag och slutvikt.

## LME, artiklar och kundpriser

LME Cash skrivs manuellt i USD/ton tillsammans med USD/SEK och datum då priset börjar gälla. Referensen i SEK/kg är `Cash × USD/SEK / 1000`. Historiken behåller tidigare registreringar och vem som ändrade dem. Det finns separata behörigheter för att läsa och ändra LME; ändra kräver också läsa.

Artiklar & priser har kategorifilter, sökning, materialbilder, A/B/C-priser och artikelinställningar. Ny artikel och ändringar sparas på servern. Artikeln har referensbilder, ingår/ingår inte, kategori, aktivstatus, LME-metall eller manuell bas, ABC-formler och B/A-volymgränser. Prisförhandsvisningen visar formlerna innan de sparas. Ändringar får ett giltighetsdatum.

Kundpriser är en egen flik: fast kr/kg, tillägg/avdrag i kronor mot en vald ABC-lista eller eget procentavdrag från LME. Ett aktivt kundundantag går före volympriset. En prisregel kan avslutas från valt datum, så ordinarie volympris används igen.

Volym räknas per kund och artikel över rullande tolv månader. Alla rader med samma artikel på aktuell leverans räknas ihop. Den aktuella leveransen ingår i prisnivån: en ny kund som lämnar 101 kg får A när artikelns A-gräns är 100 kg. Annan artikel påverkas inte. Inlämningsdagen i svensk tid styr vilken historisk prisregel som används.

Serverns demovolym kommer från registrerade prisunderlag, inklusive exempeldata. Lokala gårdsutkast och andra telefoners vägningar kommer inte in förrän gemensam lagring och synkning byggs.

## Prisunderlag och spårbarhet

När underlaget skickas för attest sparar servern en oföränderlig prisögonblicksbild. Senare LME- eller artikeländringar ändrar inte den. Manuella ABC-val och engångspriser sparas med pris före/efter i viktkortets historik. Om ett kort som väntar på attest behöver prisändras återgår det till komplettering. När ett återlämnat kort bereds igen sparas en ny version; den gamla finns kvar och volym dubbelräknas inte.

Attest kontrollerar maxbelopp och egen attest. Låsta kort flyttas mellan **Invägningar**, **Attest** och **Utbetalningar**, med egna flikar **Aktiva** och **Historik**. Invägningarnas historik kan söka alla kort. Öppning och tillbakagång behåller rätt huvudmeny, filter och sökning.

## Kunder, betalningsval och saldo

Kundlistan söker även kundnummer och registreringsnummer, filtrerar kundtyp och visar faktisk aktivitet. Kundkortet har **Översikt**, **Vägningar**, **Priser**, **Uppgifter & betalning** samt **Rättelser & saldo**. Kontaktuppgifter, referenser, ursprungsadresser, registrerade fordon och betalningsprofil kan sparas av behörig personal. Tolvmånadersstatistiken räknar frysta inlämningar och godkända rättelser; påbörjade underlag visas som öppna kort. Artikelvolym och prisnivå hålls separata per artikel.

Betalningsrutan på invägningskortet har **Bankkonto**, **Swish**, **Kontant** och **Spara på saldo**. Det sista alternativet ersätter Kreditfaktura i tidigare mockuper. Bank- och Swish-fält valideras och kundens sparade profil kan hämtas. ID-kontrollen är manuell på varje kort. Ett kort med Spara på saldo blir efter attest ett låst saldokort utan betalningspost. Från historiken kan beloppet senare demoutbetalas med ett faktiskt betalningssätt. Originalets val bevaras.

Ett rättelsekort innehåller originalkort, material, plus/minus kg, orsak och underlag. Efter granskning skickas det för attest. Godkännande kontrollerar beloppsgräns, egen attest och återstående materialmängd. Minus justerar saldo och kundstatistik. Plus skapar ett separat klart utbetalningskort och påverkar statistiken en gång. Volymen korrigeras vid originalets inlämningsdatum. Originalkortet redigeras aldrig.

Vid nästa demoutbetalning kvittas kvarvarande minussaldo; nettobelopp och hänvisningar till rättelser visas. Kvittningen är en informationspost och dras inte av från saldot en gång till. Godkännanden och betalningsregistreringar tål upprepade anrop utan dubbelposter.

Låsta kort har **Avräkningsnota** och betalda kort har **Utbetalningskvitto**, med en utskrivbar A4-vy. Välj Skriv ut / spara som PDF i webbläsaren. Företagsuppgifter och bokföringsunderlag är märkta demo; momsregler och konton behöver beslutas före skarp drift.

## Lagring och avgränsning

Prisregler, LME, kundundantag, serverbehörigheter och prisarkiv ligger i **serverns minne**. De delas mellan kontorswebbens besökare och återställs till exempeldata när Render startar om eller publicerar en ny version. Databas byggs senare enligt beslut. Viktkort, kunder, rättelsekort, betalningsjournal och lokal användarvy sparas separat i webbläsarens `jeroc.office.demo.v1`.

Demokontona är valbara exempel; API:t kontrollerar rättigheter för dessa identiteter, men det är inte en riktig inloggning. Sparade lokala kunder kan behöva registreras i prismotorn av kontoret igen efter en serveromstart; gamla frysta prisunderlag återställs bara när de stämmer exakt med låsta originalkort. Använd enbart testuppgifter. Lokal användarkonfiguration kan behöva sparas på servern igen efter en omstart. Återställ kontorsdemo återställer bara webbläsarens kontorsdata, inte serverns gemensamma priser eller mobilens sparade kort.

Mobilens prislista är ännu inte kopplad till servern. Gårdsappens vägningar och konton synkas inte till kontoret. Ingen bank, Swish eller Visma är ansluten. Registrera demoutbetalning skickar ingen transaktion. Utskrift är ett märkt demounderlag.

## Utveckling och kontroll

`npm ci`, `npm run build`, sedan `npm run dev` startar Vite på 5173 och prismotorn på 3000. Vite skickar API-anrop till Node. Windows_Starta_JEROC.cmd och Mac_Starta_JEROC.command installerar och startar samma Node-tjänst lokalt på 4173; öppna `/kontor` för kontorsdemon. `npm start` serverar produktionsbygge och API i samma process; `npm run preview` visar bara det statiska bygget och saknar prismotorn.

Kör `npm run test:server`, `npm test -- --workers=1`, `npm run build` och `npm run expo:check`. Pristesterna omfattar Cash/valuta, historiska datum, volym per artikel inklusive aktuell leverans, kundundantag, oföränderliga/versionerade prisunderlag, rättelseposter och serverns demobehörigheter. Webbtesterna omfattar kontorsflödet, Jobba som och attestgräns, LME läs/ändra, sparad prissättning och fortsatt mobilflöde.

Verifierat för v0.3.0: 53 Playwright-tester (22 mobilflöden, 19 kontorsflöden och 12 rena modelltester), 38 servertester, produktionsbygge och Expo-typkontroll. Kundkortets fem flikar har granskats i webbläsaren utan JavaScriptfel eller sidöverflöde. Avräkningsnotan verifierades som en A4-PDF på en sida. Rättelser i båda riktningar, saldokvittning, historik, egen attest och unika rättelse-ID ingår i kontrollerna. Ett mobiltest kördes om efter en kollision i testverktygets artefaktmapp och passerade. Startfilerna har inte körts på Windows eller macOS här.
