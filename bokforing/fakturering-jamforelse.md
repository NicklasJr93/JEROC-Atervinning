# Fakturering – jämförelse med de visade Fortnox-bilderna

**Datum: 2026-10-23. Status: implementerad och lokalt verifierad. Separat publicering på app-domänen återstår.**

Jämförelsen utgår från de två skärmbilder som användaren har skickat och från bokföringsdemons kod. Den är inte en genomgång av hela Fortnox eller ett påstående om likvärdig funktionalitet. Bilderna används som underlag för arbetsflöden och uppgifter; vårt eget gränssnitt behåller bokföringsdemons formspråk.

Före denna ändring öppnades en vald faktura i en högerspalt, medan nytt och redigerat utkast öppnades i dialog. Grundflödet för fakturering, moms, betalning och ROT fanns, men arbetsytan och uppgifternas omfång var betydligt mindre än i bilderna.

## Egen arbetsyta och fakturauppgifter

| Synligt i bilderna / önskat flöde | Omfattning i denna ändring |
| --- | --- |
| Fakturalista och egen sida för vald faktura | Egen fakturasida med adress i webbläsaren, tillbaka till lista och stöd för bakåt/framåt. Högerspaltens förhandsvisning ersätts. |
| Skapa och redigera faktura på stor arbetsyta | Egen sida med sektioner, stor radtabell, löpande summering och sparåtgärder. Osparade ändringar ska inte tappas vid vanlig navigering. |
| Fakturadatum, förfallodatum och betalningsvillkor | Datum och villkor i antal dagar. Det är fakturavillkor, ingen kreditbedömning av kunden. |
| Vår referens, er referens och ert ordernummer | Fakturaspecifika uppgifter som sparas och följer med till fakturadokumentet. |
| Projekt och kostnadsställe | Projektkoppling finns. Kostnadsställe är en sparad uppgift i denna version, inte en färdig redovisningsdimension med egna rapporter och fördelningsregler. |
| Kundnamn, organisationsnummer, fakturaadress, postnummer, ort, land, telefon och e-post | Fakturaspecifika mottagaruppgifter. Nya utfärdade fakturor använder en fryst kopia så att senare registerändringar inte skriver om dokumentet. Sverige är den stödda landsavgränsningen. |
| E-post för påminnelser | Kontaktuppgift som kan sparas. Automatisk påminnelsedistribution ingår inte. |
| Leveransnamn, adress, datum, leveranssätt och leveransvillkor | Sparade och utskrivna leveransuppgifter. De skapar ingen transportbokning eller lagerleverans. |
| Kommentar och fakturatext | Fakturatext följer med till dokumentet. Ett separat internt kommentarsflöde med meddelanden och samarbete återstår. |
| Fakturanummer, OCR och verifikationsnummer | Faktura-/kreditnummer och koppling till verifikation finns. Generering och kontroll av OCR-betalningsreferens återstår. |

## Rader, priser och summering

| Synligt i bilderna | Omfattning i denna ändring |
| --- | --- |
| Artikelnummer och benämning | Artikelnummer och beskrivning kan sparas på raden. Ett sökbart artikelregister med artikelstyrda priser och konteringar återstår. |
| Antal och enhet | Antal och enhet per rad. På ROT-arbetsrader används faktiskt arbetade timmar; separat fastpris- och timunderlag återstår. |
| À-pris och priser inklusive moms | Prisgrund per rad samt visning/inmatning inklusive eller exklusive moms. Beräkningen måste följa den valda grunden. |
| Radrabatt och fakturarabatt | Procentrabatter påverkar belopp, moms, ROT-underlag och bokföring. Fakturarabatten läggs efter radrabatten. Frakt och fakturaavgift omfattas inte av denna rabatt. |
| Fraktavgift och fakturaavgift | Egna avgiftsrader med uttrycklig momssats; de räknas med i fakturan men inte i ROT-underlaget. |
| Summa, moms, skattereduktion och att betala | Samma beräknade belopp används av arbetsyta, dokument, kundfordran och betalningsflöde. |
| Öresutjämning | Belopp beräknas i ören. Valbar avrundning av fakturans slutsumma till hela kronor återstår. ROT-begärans särskilda avrundning till hela kronor finns sedan tidigare. |
| Konto, kostnadsställe och projekt per rad | Momssats per rad finns. Försäljningskontot styrs av det stödda affärsfallet, inte av ett fritt kontoval i radtabellen. Redovisningsdimensioner per rad återstår. |
| Prislista | En eventuell prislistbenämning är metadata. Ingen automatisk prislista, kundprisregel eller artikelprisuppslagning ingår. |
| Valuta, kurs och valutaenhet | SEK stöds. Flera valutor, omräkning, kursdifferenser och valutabetalningar återstår; ett valutaval utan dessa beräkningar skulle inte räcka. |
| Momstyp | Vanlig svensk moms och det avgränsade fallet omvänd byggmoms finns. EU-/exportförsäljning och andra internationella momsfall återstår. |

## Fakturans arbetsflöden

| Synligt i bilderna | Omfattning och kvarstående arbete |
| --- | --- |
| Förhandsgranska och utskriftsmall | Fakturadokument och webbläsarens utskrift/spara som PDF. Mallredigerare, flera dokumentmallar och språk återstår; svenska stöds. |
| Kopiera faktura | Kopia skapas som nytt utkast med nytt kommande nummer. Betalningar, bokföring och ROT-begäran kopieras inte. Originalet bevaras. |
| Faktura / kontantfaktura | Vanlig kundfaktura med senare betalningsregistrering finns. Ett särskilt kontantfakturaflöde återstår. |
| Kreditfaktura | Länkad helkredit av en helt obetald faktura finns. Delkredit, kredit efter betalning och återbetalningsflöde återstår. |
| Inbetalningar | Delbetalningar, slutbetalning och användning av en befintlig fiktiv bankhändelse finns. Bankanslutning och automatisk återrapportering ingår inte. |
| Påminnelser | En påminnelse kan förberedas/noteras i historiken. Automatisk distribution, avgifter, dröjsmålsränta, inkasso och flexibel påminnelsekedja återstår. |
| Husarbete / ROT | ROT 2026 för en person per faktura, personutrymme, kundandel, demobegäran, beslut och separat skatteutbetalning finns. Arbetsrader får egen ROT-markering så att övrigt arbete kan hållas utanför underlaget. |
| Övrigt husarbete | RUT, flera ROT-personer på samma faktura, proportionella delbegäranden, årsskifte och återkrav återstår. |
| Periodisering på kundfakturan | Fristående förutbetalda **kostnader** finns i ekonomidemon. Det är inte kundfakturans intäktsperiodisering; det senare återstår. |
| Återkommande fakturor | Scheman, automatisk utkastsgenerering, indexering och bevakning återstår. |
| Markera ej klar | Utkast och utfärdad faktura är separata tillstånd. Ett mer omfattande attest-/samarbetsflöde återstår. |
| Distributionssätt, e-post och fakturaservice | Dokumentet kan skrivas ut/sparas. Verkliga utskick via e-post, e-faktura eller brev ingår inte. |
| Kreditupplysning, få betalt direkt och fakturaservice | Externa tjänster och avtal. De är inte täckta av extra formulärfält och ingår inte i denna demo. |

## Prioritering efter denna ändring

1. Artikelregister och verkliga prislistor, separata interna kommentarer och mer komplett fakturaunderlag.
2. Delkrediter, betalda krediter och återbetalningar; kontantfaktura och OCR.
3. Återkommande fakturor och intäktsperiodisering, med egna bokförings- och rättelseflöden.
4. Ytterligare moms-/valutafall och husarbetsfall. Varje fall behöver egna beräkningar och tester.
5. Distribution, bankåterrapportering och externa fakturatjänster när integrationer tas in i omfattningen.

Fler synliga fält är inte i sig bevis på redovisningsmässig täckning. Därför skiljer tabellerna mellan uppgifter som sparas på dokumentet, belopp som faktiskt beräknas och bokförs, och flöden som återstår. [Ekonomidemons övergripande omfattning och gränser](README.md#klickbar-demo) gäller fortsatt.
