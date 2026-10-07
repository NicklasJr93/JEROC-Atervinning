# Fordonsvägning – mockuper

Mobilflöden för fordonsvåg, kontorets vågunderlag och en avräkningsnota i A4. Alla företags-, fordons- och affärsuppgifter är testdata.

| Mockup | Öppna |
| --- | --- |
| Mobil: infart, pågående fordon, utfart och sammanställning | [Bild](01_Mobil_Fordonsvag.png) |
| Mobil: blandad last med mellanvägning | [Bild](02_Mobil_Blandad_Last.png) |
| Kontor: materialpris och spårbart vågunderlag | [Bild](03_Kontor_Vagunderlag.png) |
| Avräkningsnota för fordonsvägning | [A4-PDF](04_Avrakningsnota_Fordonsvag_A4.pdf) · [Förhandsvisning](04_Avrakningsnota_Fordonsvag_A4.png) |

## Normal last

Fordonsvägning #1416, ABC123. Infart 12 450 kg den 7 oktober 2026 kl. 10:10, utfart 11 600 kg kl. 10:38. Nettovikten är 850 kg. Viktavdrag 20 kg för betongrester ger 830 kg järnskrot. Kontorets exempelpris är 2,40 kr/kg, vilket ger 1 992,00 kr.

Vägaren väljer material med den befintliga materialväljaren. Pågående fordonsvägningar delas med gårdspersonalen. Kunden är valfri när vägningen skickas till kontoret; referens och ursprungsadress kan anges först när kunden är vald. Gårdsappen visar vikter. Kontoret hanterar priser, ID-kontroll och överlämning till attest.

![Mobilflöde för fordonsvåg](01_Mobil_Fordonsvag.png)

## Blandad last

Fordonsvägning #1417, GHI456. Infart 12 450 kg, mellanvägning 12 000 kg och utfart 11 600 kg. Första lossningen ger 450 kg järnskrot, med ett viktavdrag på 20 kg: 430 kg materialvikt. Andra lossningen ger 400 kg koppar klass 1. Sammanlagd materialvikt är 830 kg.

Varje lossning kopplas till sin artikel och sina vågavläsningar. Mellanvägningen blir utgångsvikt för nästa lossning.

![Blandad last med mellanvägning](02_Mobil_Blandad_Last.png)

## Kontorets underlag

Fordonsvägda artikelrader visar registreringsnummer, infart, utfart, nettovikt, viktavdrag med motivering och materialvikt. Kontoret kan ändra vågunderlaget före attest, med historik. Efter attest används rättelsekort. Volymen i prisberäkningen baseras på materialvikten efter viktavdrag och kundens senaste tolv månader per artikel.

![Kontorets vågunderlag](03_Kontor_Vagunderlag.png)

## Avräkningsnota

En sida stående A4 med samma fordonsuppgifter och beräkning som normalflödet. Dokumentet visar ett testfall för självfakturering och omvänd betalningsskyldighet.

[Öppna avräkningsnotan som PDF](04_Avrakningsnota_Fordonsvag_A4.pdf)

![Avräkningsnota för fordonsvägning](04_Avrakningsnota_Fordonsvag_A4.png)
