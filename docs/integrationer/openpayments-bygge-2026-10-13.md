# Banköverföring och mottagare – ÄL 109

Levererat 2026-10-13 i kontor 0.24.0 och mobilwebb 0.8.2.
Endast Open Payments sandbox och SEK är aktiverbara. Produktionsbank,
utlandsbetalningar och betalfil/buntar ingår inte i detta bygge.

## Prova efter deploy

1. I Open Payments → ScrapPilot Gateway → Redirect URI whitelist, lägg till
   `https://jeroc-atervinning.onrender.com/api/integrations/openpayments/callback`
   och spara. Den lokala adressen kan finnas kvar för lokal utveckling.
2. Öppna **Integrationer → Banköverföring / Open Payments** i kontoret.
   Aktivera sandbox, hämta banker och välj testbank samt testidentiteter.
3. Spara inställningarna och anslut testbankens medgivande. Om signering via
   bankens webbsida behövs visas en separat länk. Återkomsten verifieras på
   servern för samma bolag, faktiska användare, valda konto och session.
4. Hämta konton efter godkännandet och välj ett verifierat SEK-konto.
   Kontona kommer från medgivandet; ett manuellt inmatat avsändarkonto godtas inte.
   Saldoläsningen visar testbankens svar och tid för hämtningen.
5. För betalningsbokföring: välj eget bankkonto från det anslutna
   Spiris-sandboxföretaget och aktivera registrering efter bankbekräftelse.
6. På ett kundgodkänt, mottagningsbekräftat och attesterat viktkort med bokförd
   Spiris-faktura: tryck **Betala ut**. Mottagaren är låst tills Redigera väljs;
   en ändring kräver orsak. Belopp och finansiellt underlag är fortsatt låsta.
   Före en reserverad instruktion kan bank-/Swish-vy väljas, även utan aktiv
   bankkoppling. Bytet ändrar inga sparade uppgifter och skickar ingen betalning;
   den nya instruktionen behöver rätt mottagardata, redigering och orsak.
7. Starta banktestet och följ eventuell separat signering. Skapad instruktion
   eller lyckad signering innebär inte betald. Statuskontroll läser samma
   instruktion; ett oklart svar reserverar kortet och skickar inga nya pengar.

Testsida:
<https://jeroc-atervinning.onrender.com/kontor/integration/systemadminbanktest.html>.
Den provar anslutning, banker, medgivande, konton och saldo. Betalningar initieras
från viktkortet så att den låsta attestversionen och dubblettskyddet används.

## Render

De redan sparade `OPENPAYMENTS_CLIENT_ID` och `OPENPAYMENTS_CLIENT_SECRET` används
endast på servern. Returadressen hämtas automatiskt från `RENDER_EXTERNAL_URL`
med den fasta callback-sökvägen ovan. `OPENPAYMENTS_REDIRECT_URI` kan anges som
en exakt HTTPS-adress när automatisk adress inte finns, exempelvis i utveckling.
Ingen ny nyckel eller certifikat krävs för detta sandboxbygge.

## Mottagaruppgifter

**Banköverföring** har undervalen svenskt bankkonto, bankgiro, plusgiro och IBAN.
Kontoret och behöriga användare vid mobilens kundskapande använder samma
normalisering och validering. Inaktiva nummerfält rensas vid typbyte. Giro har
format-/kontrollsiffrekontroll; IBAN har landsformat, längd och mod97; BIC och
eventuellt OCR valideras separat. Giltigt format bevisar inte kontoägande.

Äldre svenska bankkonton utan undertyp tolkas vid läsning. Frysta attestunderlag,
tidigare PDF:er och hashvärden skrivs inte om. Spiris får `Clearing` /
`BankAccountNumber`, `BankgiroNumber`, `PlusgiroNumber` eller `BankIban` /
`BankBic` samt korrekt `BankCountryCode`. Ursprung är inte mottagaradress.

Mobilens vanliga kundlista lämnar inga bankprofiler. Den valfria betalningsprofilen
vid kundskapande visas och accepteras endast med betalningsbehörighet.

## Bekräftelse, återhämtning och isolering

Bankens `ACSC` accepteras först efter återläsning med matchat belopp, SEK,
mottagare, avsändarkonto och betalningsreferens. Journalen bevarar bolag,
attestversion, konto, instruktion, faktisk/effektiv användare och bankens ID.
Postning reserveras beständigt innan nätverksanrop; bank och Swish delar en
atomisk spärr för samma kort. Okända HTTP-resultat återpostar inte betalningar.

Bekräftelsen ger en ny arkiverad PDF med maskerad mottagare och tydlig märkning
**Open Payments sandbox**. Testbanken lämnar inte ett verifierat verkligt
betalningsklockslag; datumet märks därför som tid för sandboxbekräftelsen.
Originalet finns kvar. Spiris-betalningsbokföringen är en separat journal med
`SP-BANK`-referens, slutlig återläst faktura och betalningsverifikation.
Fel i PDF eller Spiris skickar aldrig bankinstruktionen igen.

Callback är tidsbegränsad, sessionsbunden och reserveras före kodväxling.
Återspelning, bolagsbyte och sen callback kan inte återställa ett bekräftat
resultat. Serverarbete återupptas efter omstart i bolagets egna lagring.

## Verifiering och kvarvarande prov

Det nya klientbiblioteket har provats mot riktig Open Payments sandbox för
token, banklista och Swedbanks kapabiliteter: HTTP 200. Swedbanks testsvar
annonserade bland annat `domestic` och `swedish-giro`. Inga externa betalningar
skapades under byggets verifiering.

Automatiserade tester använder verklig adapter och motor med stubbat HTTP för
medgivande/signering, callback, betalningsstatus, dubbletter, återstart,
behörigheter, frysta hashvärden, maskerad PDF och Spiris-registrering. UI-tester
täcker mottagartyper, mobil behörighet, integrationskort och utbetalningspopup.

Slutkontroller: serverregressionen gav 297 passerande och 4 överhoppade
PostgreSQL-prov (ingen isolerad testdatabas var konfigurerad). Efter den sista
Swish-kompatibilitetsändringen passerade dess 28 betalningsprov. Samtliga
29 UI-prov, produktionsbygget och Expo-typkontrollen passerade.

Girodokumentationens generiska betalningssvar är inkonsekvent om mottagar-/OCR-
och fakturareferenser. Ett faktiskt BG/PG-sandboxprov återstår. Om ett svar saknar
det nödvändiga mottagar-/referensbeviset håller systemet betalningen oklart
reserverad och skapar ingen betalnings-PDF eller Spiris-registrering. Enbart
`ACSC` är otillräckligt. Svenska IBAN stöds för verifierade SEK-produkter;
utländska IBAN kan registreras men skickas inte av denna första bankadapter.

Källor och miljöuppgifter:
[Sandboxguide](openpayments-sandbox-setup.md),
[planerat generellt utbetalningsflöde](utbetalningar-plan.md).
