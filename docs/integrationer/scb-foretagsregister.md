# Företagsuppslag via SCB

Första versionen hämtar ett bestämt svenskt företags namn, postadress, momsregistrering och F-skatt från SCB:s allmänna företagsregister. Organisationsnumret normaliseras och kontrolleras på servern innan något anrop görs. Funktionen föreslår uppgifter i ett formulär; den skapar eller sparar inte en kund eller ett SaaS-bolag automatiskt.

## Aktivering

1. Registrera en användare och ansök om API-nyckel enligt SCB:s sida nedan.
2. När SCB har beviljat ansökan: spara nyckeln som **`SCB_API_KEY`** i Render → **scrapplanner-app** → Environment och deploya appen.
3. Kontrollera ett känt organisationsnummer i kund- eller bolagsformuläret och jämför namn och postadress med SCB:s uppgifter.

Nyckeln finns bara på backend. Den ska inte ha ett `VITE_`-prefix, finnas i Git, skickas till webbläsaren eller skrivas i en logg. Samma serverkoppling används av de behörighetskontrollerade formulären; varje bolag får inte en egen kopia av nyckeln.

Utan nyckel visas att företagsuppslaget ännu inte är aktiverat. Manuell inmatning ska fortsätta fungera. Implementationen verifieras med syntetiska svar enligt SCB:s publicerade kontrakt; ett riktigt SCB-anrop behöver provas när en beviljad nyckel finns.

## Var funktionen finns och hur den används

Första versionen använder samma komponent och behörighetsskyddade serverkoppling i:

- Kontorets **Skapa kund** och redigering av företags-/BRF-kundens uppgifter.
- Kontorets **Ny kund** i snabbregistreringen på ett viktkort.
- Mobilens **Ny kund** för företag och BRF.
- Systemadmins **Skapa bolag**, även innan det första bolaget finns.

När ett komplett nummer har giltigt format och korrekt kontrollsiffra startar uppslaget efter 350 ms. Formuläret accepterar bindestreck och blanksteg; ett `16`-prefix normaliseras bort för uppslaget. Numret skickas aldrig för varje knapptryckning och personnummer skickas inte till SCB.

En träff visas med källa och hämtningstid. Användaren väljer **Använd företagsuppgifter** för att fylla formuläret och sparar därefter som vanligt. På Skapa bolag fylls endast namn och organisationsnummer; VD:s namn och e-post anges separat. Ingen kund, något bolag eller VD-konto skapas av uppslaget.

Adressuppgifterna är företagets **postadress**, inklusive eventuell c/o-rad. De blir inte automatiskt materialets ursprungsadress, hämtningsadress eller en anläggningsadress. Tomma adressfält i SCB tömmer inte redan angivna uppgifter. Betalningsuppgifter, kontaktperson, telefon, e-post, referenser och kommersiella villkor behålls.

Momsregistrering och F-skatt visas separat med källa och hämtningstid. När användaren väljer **Använd företagsuppgifter** fylls kundens momsval automatiskt i om SCB har ett uttryckligt ja/nej-besked. Okänd eller saknad momsstatus lämnar befintligt momsval orört. F-skatt påverkar inte momsvalet. Momsvalet går fortfarande att ändra manuellt före sparande. På **Skapa bolag** visas skatteuppgifterna i träffen, men där fylls endast bolagsnamn och organisationsnummer i.

Vid ändrat nummer, formulär, bolag eller konto kasseras en äldre förhandsvisning. Ingen träff, avbrott och saknad anslutning visas med skilda meddelanden, med möjlighet att fylla i manuellt eller söka igen.

### Återanvändning i senare steg

Samma uppslag kan anslutas till bolagsuppgifter samt registrering av leverantörer, åkerier och transportörer. Även miljörapporteringens företagsparter kan få uppslag, men rapportör, verksamhetsutövare och ombud måste fortfarande väljas uttryckligt med rätt identitet. Uppslaget får inte byta ägare på befintliga kundkort, betalningar eller låsta underlag.

Namn-/delsträngssökning är en separat senare funktion. Denna version gör exakt uppslag på organisationsnummer; ingen bolagslista laddas ned.

## ScrapPlanners interna API

```http
POST /api/company-register/lookup
Content-Type: application/json

{"organisationNumber":"559359-3626"}
```

Svaret har formen `{ "company": { ... } }` med avgränsade registerfält. Endast inloggad systemadmin eller en användare med rätt att registrera kunder får göra uppslaget. Servern verifierar den riktiga plattforms- eller personalsessionen; bolags-/användarheaders ger ingen behörighet. Plattformsanrop kräver CSRF-skydd. Behörighet och bolagskontext kontrolleras igen innan en långsam träff lämnas tillbaka.

Svar skickas med `private, no-store`. Inga registerträffar sparas centralt. Gatewayen tillåter högst fyra uppslag per sekund totalt i appinstansen och 30 per minut och användare/bolag. Samma API-nyckel över flera appinstanser kräver en delad begränsning före skalning.

## Verifierat API-kontrakt

Kontrollerat mot den publicerade dokumentationen den **20 oktober 2026**:

- [SCB: avgiftsfria uppgifter, registrering och tekniska förutsättningar](https://www.scb.se/vara-tjanster/bestall-data-och-statistik/foretagsregistret/avgiftsfria-uppgifter-i-foretagsregistret/)
- [OpenAPI-visning](https://apiafr.scb.se/scalar/)
- [Maskinläsbar OpenAPI-specifikation](https://apiafr.scb.se/swagger/v1/swagger.json)
- [Postbeskrivning för företag, JE](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/postbeskrivning-je.pdf)
- [Variabelbeskrivning, version 9 oktober 2026](https://www.scb.se/contentassets/8a8eb5c3d45f461ea93482f8e8d4de4f/variabelbeskrivning-afr_261009.pdf)

Detta är det nya API:et med API-nyckel. Det äldre certifikatbaserade API:et används inte.

```http
GET https://apiafr.scb.se/v1/juridiskaenheter/165593593626/full
Accept: application/json
X-API-Key: <serverns SCB_API_KEY>
```

Ingen JSON-body skickas till SCB. Sökparametern `peOrgNr` är **tolv siffror**: för juridiska personer använder SCB prefixet **`16`** följt av det vanliga tiosiffriga organisationsnumret. Det interna organisationsnumret och formulärens nummer fortsätter vara tio siffror, exempelvis `5593593626` med eller utan bindestreck vid inmatning.

SCB:s svar är ett direkt `jeFullData`-objekt, inte en lista eller ett `{ data: ... }`-omslag. Implementationen använder en avgränsad del av det dokumenterade svaret:

| SCB-fält | Användning |
|---|---|
| `orgNr`, `peOrgNr` | Båda måste motsvara exakt det begärda organisationsnumret. |
| `namn` | Företagets juridiska namn. |
| `postAdress.gatuAdress` | Postadressens gat-/boxrad. |
| `postAdress.coAdress` | Separat eventuell c/o-rad. |
| `postAdress.postNr`, `postAdress.postOrt` | Postnummer med fem siffror och postort. |
| `ftgStat` | Status enligt SCB:s kriterier. |
| `jurform` | Kod för juridisk form, utan gissad klartext. |
| `momsStat`, `fSkattStat` | Registerinformation enligt definitionerna nedan. |

Övriga råfält, exempelvis telefonnummer, e-post och omsättningsklass, lämnas inte vidare till formuläret. Uppslaget returnerar källa `SCB` och hämtningstid. Det skapar inte ett gemensamt kundregister och har ingen delad innehållscache mellan kundbolag.

### Registerstatus och skatteuppgifter

Variabelbeskrivningen anger:

| Fält | Kod | Tolkning |
|---|---|---|
| `ftgStat` | `1` | Verksam enligt företagsregistrets kriterier. |
| `ftgStat` | `0` | Har aldrig varit verksam. |
| `ftgStat` | `9` | Ej verksam enligt företagsregistrets kriterier. |
| `momsStat` | `1` | Registrerad för moms. |
| `momsStat` | `3` | Registrerad för moms via representant. |
| `momsStat` | `0`, `9` | Aldrig registrerad respektive avregistrerad. |
| `fSkattStat` | `1` | Registrerad för F-skatt. |
| `fSkattStat` | `0`, `9` | Aldrig registrerad respektive avregistrerad. |

Okända eller saknade koder betyder okänt, inte automatiskt nej. OpenAPI beskriver flera koder som strängar medan PDF-postbeskrivningen anger heltal; klienten accepterar båda representationerna för kodfälten.

Detta är registeruppgifter, inte ett nytt beslut om hur en invägning eller utbetalning ska beskattas. Kundens momsregistrering fylls i vid uttrycklig användning av träffen. Befintliga artikelregler och kraven för omvänd skattskyldighet gäller fortfarande; F-skatt ersätter inte momsregistrering. Ett uppslag ändrar inga låsta underlag och bevisar inte att den inloggade användaren får företräda företaget.

## Avgränsningar och fel

- Exakt uppslag på komplett, giltigt organisationsnummer. Ingen delsträngssökning, namnlista eller nedladdning av hela registret.
- Juridiska personer, inklusive BRF, omfattas. Privatpersoner och enskild firmas personnummer skickas inte till detta uppslag. SPAR är en separat kommande koppling.
- Endast bekräftad HTTP **404** från SCB visas som ingen träff. Nätfel, timeout, nekad API-nyckel och driftavbrott visas som anslutningsfel med möjlighet till manuell inmatning.
- Fast officiell HTTPS-adress och `redirect: error`; användaren kan inte ange annan värd eller skicka nyckeln till en annan server.
- Timeout högst åtta sekunder i normal konfigurering, även om svarskroppen stannar. Svar större än 64 KiB eller med oväntad struktur avvisas.
- Felmeddelanden återger inte råa SCB-svar, API-nyckeln eller begärans headers. Klienten gör inga automatiska omförsök.
- SCB tillåter högst **fem anrop per sekund per API-nyckel**. Gatewayen begränsar anropen gemensamt och per användare; horisontell skalning behöver samordna den gemensamma gränsen mellan instanser.
- SCB anger ett dagligt uppdateringsfönster från **04:00 i cirka 30 minuter**. Registret är inte en realtidstjänst; flera enskilda variabler uppdateras veckovis eller mer sällan.

## Testning

```sh
node scripts/build-domain-models.mjs
node --test server/scb-company-register.test.mjs server/company-register-api.test.mjs server/company-register-gateway.test.mjs
npx playwright test tests/company-register-entrypoints.spec.ts tests/customer-form.spec.ts --workers=2
```

Testerna täcker det dokumenterade anropet och fälten, kanoniskt nummerformat, personnummeravvisning, fel kund i svar, okända koder, saknad nyckel, separat hantering av ingen träff och anslutningsfel, begränsad svarsstorlek samt timeout och avbrutet uppslag. Inga tester använder en riktig API-nyckel eller gör nätanrop.
