# JEROC – arbetsprofiler, dashboard och mejlinkorg

Klickbart designförslag 2026-10-12 i befintlig JEROC-design.
[Öppna alla mockuper](https://jeroc-atervinning.onrender.com/mockups/roll-dashboard/index.html#kontor)
efter Render-deploy. Välj arbetsprofil överst eller öppna
[mejlinkorgen](https://jeroc-atervinning.onrender.com/mockups/roll-dashboard/index.html#mejl).
Det går också att öppna [index.html](../../../public/mockups/roll-dashboard/index.html) lokalt.
Alla exempel ligger i minnet och återställs vid omladdning.

## Dashboards

| Arbetsprofil | Bild | Huvudfokus |
| --- | --- | --- |
| Kontorist | [01_Kontorist.png](01_Kontorist.png) | Kundgodkännande, ID-kontroll och komplettering |
| Ekonomi och attest | [02_Ekonomi_Attest.png](02_Ekonomi_Attest.png) | Tillåten attest, betalflöde och Spiris-ärenden |
| Transportledare | [03_Transportledare.png](03_Transportledare.png) | Dagens uppdrag, önskemål och bemanningsproblem |
| Gruppledare | [04_Gruppledare.png](04_Gruppledare.png) | Bemanning, ersättare och kompetenser |
| VD | [05_VD.png](05_VD.png) | Material, inköpsvärde exklusive moms, trender och avvikelser |
| Systemadmin | [06_Systemadmin.png](06_Systemadmin.png) | Integrationsköer och ärenden som kräver kontroll |
| Gårdsmedarbetare | [07_Gard.png](07_Gard.png) | Pågående vägningar, dagens transporter och lager |
| Chaufför | [08_Chauffor.png](08_Chauffor.png) | Nästa uppdrag, dokument och nästa tillåtna steg |

Köer, statistik och dagens planering är anpassade per arbetsprofil. Flera vyer
har **Mitt arbete / Verksamheten**, lokala filter och en AI-sammanfattning.
En uppgift öppnar nästa steg med underlag och direktväg till rätt modul.
Arbetsprofilerna är designförslag; i implementationen ska serverns verkliga
behörigheter, anläggningsåtkomst och attestregler avgöra innehållet.

## Mejl och AI-förslag

| Vy | Bild |
| --- | --- |
| Gemensam inkorg, mejl och förslag | [09_Mejlinkorg.png](09_Mejlinkorg.png) |
| Granska arbetsorder från mejlet | [10_Mejl_Arbetsorderutkast.png](10_Mejl_Arbetsorderutkast.png) |
| Redigerbart svarsförslag | [11_Mejl_Svarsutkast.png](11_Mejl_Svarsutkast.png) |
| Kontorist på mobil | [12_Dashboard_Mobil.png](12_Dashboard_Mobil.png) |
| Mejlinkorg på mobil | [13_Mejl_Mobil.png](13_Mejl_Mobil.png) |
| Läsa mejl och AI-förslag på mobil | [14_Mejl_Laslage_Mobil.png](14_Mejl_Laslage_Mobil.png) |
| Chaufför på mobil | [15_Chauffor_Mobil.png](15_Chauffor_Mobil.png) |

Mejlvyn visar en gemensam Outlook-inkorg som designförslag, med ansvarig,
status, kopplad kund, kärl, avtal och arbetsorder. AI visar vilka uppgifter
som kommer från mejlet och vilka som återanvänds från registret.

- Kunden Elektriska AB ber om byte av kabelkärl. Arbetsorderutkastet är
  förifyllt från mejl, kund och avtal; önskad tid blir inte automatiskt bokad.
- Användaren granskar uppgifterna innan en lokal exempelorder skapas.
- Svarsförslag kan redigeras och sparas som utkast. Ett separat uttryckligt
  demoklick illustrerar sändning; prototypen skickar inget mejl.
- Ett nytt kundärende visar saknade uppgifter i stället för påhittade fakta.
- Ett befintligt uppdrag länkas för granskning så att mejlet inte skapar en
  extra arbetsorder. En bifogad tillståndshandling ger ett granskningsförslag.

Ingen Outlook-, AI-, NVV-, Spiris- eller bankanslutning används. Inga riktiga
kunduppgifter, behörigheter, bokningar, betalningar eller dokument ändras.
Detta är en fristående mockup, inte en uppdatering av produktionsflödena.
Backup och driftövervakning visas som planerade när dessa funktioner saknas.

## Rendering

Från repots rot:

```sh
node docs/mockups/roll-dashboard/render-mockups.mjs
```

Scriptet serverar enbart mockupens lokala resurser, exporterar bilderna och
kontrollerar arbetsprofilbyte, filter, arbetsorder-/svarsutkast och mobilvy.
Ingen produktionssvit eller extern API-sändning behövs för designunderlaget.
