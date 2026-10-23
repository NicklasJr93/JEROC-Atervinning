# Bokslut, granskningsbilagor och fortsatt bokföring nästa år

Utbyggnaden den 23 oktober 2026 lägger till ett praktiskt årsflöde i den lokala bokföringsdemon. Den är inte en färdig årsredovisnings- eller deklarationstjänst.

## Årsbyte utan dubblering

1. Stäm av årets fakturor, bank, moms, löner, inventarier, lager och periodiseringsplaner.
2. Upprätta bokslutsbilagor. En bilaga kan kopplas till ett kontosaldo och sparar kommentar, underlagsreferens, upprättare, granskare och versionshistorik.
3. Granska skapade bilagor och lås perioderna. Ett ändrat konto efter granskning kräver att bilagan uppdateras och granskas igen.
4. Bokför årets resultat och avsluta året.
5. Öppna nästa år. Det börjar dagen efter föregående års slut; luckor och överlapp avvisas.

Hela verifikationskedjan bevaras i samma journal. Balansräkningen bygger på journalen fram till valt slutdatum; resultatrapporten omfattar det valda året. Ingen ny ingående balans bokförs ovanpå en redan bevarad journal, eftersom det skulle dubblera tillgångar och skulder.

Föregående års resultat flyttas från 2099 till 2098, **Vinst eller förlust från föregående år**, i det nya året. Det är inte ett automatiskt beslut om utdelning eller slutlig resultatdisposition till 2091.

Obetalda kund- och leverantörsfakturor fortsätter med samma identiteter och betalningshistorik. En betalning under nästa år bokförs då mot den befintliga fordran eller skulden. Inventarier, avskrivningshistorik, lager och fleråriga periodiseringsplaner behålls.

## Årsarkiv och bilagor

När nästa år öppnas skapas en fryst lokal ögonblicksbild av det avslutade årets företag, bokslut, rapport, verifikationer, fakturor, tillgångar och granskningsbilagor. Senare betalningar uppdaterar den löpande reskontran men skriver inte om den sparade ögonblicksbilden.

Arkiverade årsuppgifter och äldre bilageversioner kan inte skrivas om eller tas bort genom modellens transaktioner. Detta är fortfarande webbläsarlagring, inte ett manipulationssäkert serverarkiv. Rensad webbläsardata kan förstöra den lokala informationen; beständig lagring, backup och provad återläsning återstår inför produktion.

Statusen **Granskad i demon** kräver två olika angivna namn samt en underlagsreferens. Namnen kommer från formuläret. Den statusen är inte identifierad attest, revisorers godkännande eller bevis på en extern granskning.

## Skatt och årsredovisningsunderlag

- **Bolagsskatt:** beräkningsunderlaget utgår från resultat före bokförd bolagsskatt, manuellt bedömda skattemässiga tillägg/avdrag och ett manuellt bedömt utnyttjbart underskott. Modellens uppskattning använder 20,6 procent för svenskt aktiebolag. Beräkningen avgör inte om en viss kostnad är avdragsgill eller om ett tidigare underskott får användas. Den bokför inget automatiskt och producerar inte en INK2-fil.
- **Årsredovisningsunderlag:** exporten samlar årets resultat, balanskonton och, när föregående år finns, jämförelsetal. Användaren kan ange utkast till förvaltningsberättelse och noter. Exporten är uttryckligen ett granskningsunderlag och markerar `submissionReady: false`.
- **Återstående formalia:** tillämpligt K-regelverk, fullständig uppställning och noter, redovisningsprinciper, resultatdisposition, underskrifter, fastställelseintyg, eventuell revisionsberättelse och godkänt inlämningsformat behöver färdigställas och granskas. Företagets storlek, form och förhållanden styr innehållet.

## Tekniska integrationer

- `fiscal-periods.js`: registrerade år, aktivt bokslut, historiskt företagsintervall och skydd av tidigare års-/bilagehistorik.
- `fiscal-reports.js`: datumavgränsade resultatrapporter och kumulativa balansrapporter.
- `financial-years.js`: årsöppning, frysta årsunderlag, bokslutsbilagor och granskningsunderlag.
- `year-workspace.js`: arbetsyta med avstämningar, bilagor, periodlåsning, årsbyte och lokala JSON-exporter.
- `server/bokforing-year-continuation.test.mjs`: bland annat betalning av föregående års fakturor, fleråriga inventarier/periodiseringar, andra årsavslutet, oförändrat årsarkiv och ändrade granskningssaldon.

Regelbedömningar behöver stämmas av mot aktuell vägledning hos [Bokföringsnämnden](https://www.bfn.se/), [Skatteverket](https://www.skatteverket.se/) och [Bolagsverket](https://bolagsverket.se/). Dessa länkar är vägvisare; de innebär inte att exporten har godkänts av myndigheterna.
