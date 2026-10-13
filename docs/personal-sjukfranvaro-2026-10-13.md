# Personal, anläggningsåtkomst och sjukfrånvaro

Bygge 2026-10-13: ÄL 119–122, mobilwebb **0.12.0**, kontor **0.29.0**.
Beställningens 129 tolkades som 120. Inga nya Render-inställningar behövs.

## Anläggningar och mobilens Hem

Välj anläggningsåtkomst en gång under **Personal → person → Inloggning &
behörigheter**. Personprofil, mobil och planering använder kontots gemensamma
åtkomst. Profilens andra behörighetsväljare har tagits bort. Konton utan
personprofil, exempelvis plattformssupport, behåller sin egen kontrollerade åtkomst.

Migreringen bevarar gamla person-/kontolistors effektiva snitt; den ger ingen
automatisk extra åtkomst. Administratören ser avvikelsen och kan bekräfta den.
En behörig administratör med åtkomst till hela bolaget kan uttryckligen välja
**Alla anläggningar, även nya**. Utelämnade fält från äldre klienter öppnar inte
ett tidigare begränsat konto. Externa förare behåller eget åkeri/egna uppdrag.

I mobilen öppnar **Byt anläggning** den behöriga aktiva listan. Valet styr nya
vägningar; befintliga viktkort, arbetspass och uppdrag flyttas inte. Återkallad
åtkomst upphör vid nästa serverkontroll. Nästa uppdrag visar den kommande
sjudagarsperioden medan Din dag fortsätter visa dagens jobb. **Din insats idag**
finns i Gårdsarbete, efter Starta invägning och före Pågående vägningar.

## Förare och fordon

Personkortets **Förare & fordon** innehåller förarroll, ordinarie fordon,
inline skapande och ett enkelt register för ändring/avaktivering. Registret är
gemensamt med transporter. Registreringsnummer normaliseras och dubbletter
stoppas även för inaktiva fordon. Ändring av den gemensamma flottan kräver
korrekta personal-/transportbehörigheter och åtkomst till alla anläggningar.

Ett ordinarie fordon är ett planeringsförslag. Nya tilldelningar använder aktiva
fordon och befintliga kompetenskontroller; historiska tilldelningar bevaras.

## Medarbetarens sjukflöde

1. **Sjukanmälan** på Hem/Tid registrerar faktisk sjukfrånvaro direkt, inte en
   ledighetsansökan. Ange första sjukdag, eventuell starttid, omfattning och
   skriftlig försäkran om nedsatt arbetsförmåga. Ingen diagnos efterfrågas.
2. Vid pågående arbete kan **Stämpla ut och sjukanmäl** avsluta stämpling och
   arbetsordertid i samma transaktion. Redan arbetad tid behålls. Ett gammalt
   pass eller en låst tidigare månad skapar uppföljning, inte nekad anmälan.
3. Prognos är datum eller Vet inte och är skild från verklig frånvaro. Daglig
   bekräftelse fortsätter samma ärende. Arbetsplatsens dagliga kontaktrutin
   kan ställas in; utebliven kontakt avslutar aldrig sjukperioden.
4. Läkarintyg kan laddas upp som PDF/JPEG/PNG, högst 5 MB. HR kontrollerar
   mottagning och giltighetsdatum separat. Filen hamnar i ett privat arkiv.
5. **Friskanmälan** fastställer faktisk sista sjukdag och eventuell återkomsttid.
   Heltidssjukfrånvaro hindrar ny arbetsstart tills återkomsten är registrerad.
   Deltidssjukfrånvaro tillåter arbete och hanteras som procentandel utan ett
   påhittat frånvarointervall i slutet av passet.

Sjukanmälan och friskanmälan nås även när gammal tid saknas. Det gör inte den
gamla tidsspärren ogiltig. Frysta månader behöver befintlig återöppning/rättelse.
Dubbeltryck och osäkra återförsök binds till samma kommando-ID och egna kontot.
Offline visas aldrig som en registrerad sjukanmälan.

## Chef/HR och karensunderlaget

**Personal → Sjukfrånvaro**, även som flik på personkortet, visar ärenden,
prognos, daglig kontakt, försäkran, intyg, historik, rättelser och uppföljning.
Planeringen får frånvarofakta och uppgifter att lösa; uppdrag omfördelas inte
automatiskt. Intyg och lönegrunder kräver separata rättigheter. Både faktisk
och effektiv användare samt hela personens anläggningsscope kontrolleras.

- Karensavdrag är normalt **20 % av genomsnittlig veckosjuklön**. Vid 200 kr
  i timlönegrund, 40 timmar per vecka och 80 % sjuklön blir karensmålet
  1 280 kr. Ett kort första sjukpass drar bara tillgänglig sjuklön; resten
  följer senare berättigade dagar i samma period.
- Återinsjuknande inom **fem kalenderdagar** efter föregående sjukperiod
  kopplas till samma sjuklöneperiod. Det ger inget nytt karensmål.
- Arbetsgivarens period börjar vid faktiskt förlorad arbetstid och omfattar
  normalt högst 14 kalenderdagar, inklusive helger efter periodens start.
  Efter förbrukad period behövs korrekt återgång/kvalifikation för ny sjuklön.
- Efter tio faktiska karensavdragstillfällen inom tolv månader hanteras
  allmänt högriskskydd. Tidigare tillfällen kan importeras med datum och källa.
  Dagliga kontakter räknas inte som nya avdragstillfällen. Särskilt högriskskydd
  registreras med giltighetsdatum och referens; ett beslut för lång sjukdom
  innebär inte automatiskt befrielse från karens.
- Normalt intyg dag 8, särskilt dokumenterat förstadagskrav, arbetsgivarens
  FK-uppföljning efter sjuklöneperioden och återgångsplan vid lång frånvaro
  visas som uppgifter. De är inga automatiska myndighetsanmälningar.

För beräknade belopp behöver ansvarig fastställa bolagets avtalsgrund och en
verifierad löneprofil med timlönegrund, genomsnittlig veckoarbetstid, sjuklönesats,
giltighetsdatum och källa. Månadslön räknas inte om med en gissad divisor.
Bekräfta bara kollektivavtal som passar den stödda veckosjuklönsmodellen;
andra modeller behöver manuell beräkning. Okänd avtalsgrund, saknad försäkran,
intyg eller kvalifikation ger tydlig kontrollstatus, utan gissade belopp.

CSV hämtas med nya behörighetskontroller och sparar en privat, fryst
underlagsversion med beräkningsgrund, ärende-/periodreferenser och kontrollsumma.
Identisk export återanvänder kvittensen. En senare rättelse skapar en ny version
och bevarar den gamla. Underlaget är inte en lönekörning eller bankutbetalning.

Intyg lagras separat i bolagets PostgreSQL-schema i Render. Lokal utveckling
använder en separat SQLite-fil med privata filrättigheter. Hämtningar kräver
egen identitet eller aktuell HR-behörighet, levereras som nedladdning med
no-store och loggas utan dokumentbytes. Intyg finns inte i publika artikelbilder,
vanliga verksamhets-PDF:er eller mobila bootstrap-paket.

## Källor och verifiering

Regler kontrollerade 2026-10-13:

- [Sjuklönelagen (1991:1047), särskilt §§ 3–9, 10a och 13–16](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-19911047-om-sjuklon_sfs-1991-1047/)
- [Försäkringskassan: sjuklön för arbetsgivare](https://www.forsakringskassan.se/arbetsgivare/sjukdom-och-skada/sjuklon)
- [Försäkringskassan: sjukpenning för anställda](https://www.forsakringskassan.se/privatperson/sjuk/anstalld/sjukpenning-for-anstallda)
- [Arbetsmiljöverket: när en medarbetare blir sjuk eller skadas](https://www.av.se/halsa-och-sakerhet/arbetsanpassning-individuella-atgarder/om-din-medarbetare-blir-sjuk-eller-skadas/)

Daglig sjukanmälan är en lokal arbetsplatsrutin, inte ett generellt lagkrav.
Systemet ger stöd för arbetsflödet och den beskrivna beräkningsmodellen;
avtalsbedömning, faktisk FK-anmälan och slutlig lönekörning görs av ansvarig.

Verifieringen omfattar produktionsbygge, riktade serverprov för karensmatematik,
återinsjuknande, kvalifikation, låsta perioder, profilrättelser, migration,
fordon, privata filer och riktiga HTTP-rutter samt isolerade mobil-/kontorsprov.
Proven använder fiktiva lokala uppgifter och skickar inga externa betalningar,
myndighetsanmälningar eller mejl.
