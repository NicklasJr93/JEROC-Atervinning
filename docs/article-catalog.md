# Artikelregistret och gårdsappens materialmeny

Gäller kontorsdemo **0.17.0** och gårdsapp **0.4.0**.

Kontoret administrerar artiklar, grupper, bilder och instruktioner under
**Artiklar & priser**. Gårdsappen använder samma serverregister. En ny
appversion behövs inte för att ändra presentationen eller materialgrupperna.

## Grupper och undergrupper

Fliken **Artikelgrupper** visar befintliga huvudgrupper och deras undergrupper.
Varje grupp har namn, beskrivning, en bild, sorteringsordning och aktivstatus.
Lägre sorteringsnummer visas först. Gruppdetaljen visar kopplade artiklar och
länkar till deras redigeringssidor.

Registret stödjer två gruppnivåer: **huvudgrupp → undergrupp**. En huvudgrupp
kan också innehålla artiklar direkt. Exempel:

```text
Koppar
├─ Koppar klass 2                  (artikel direkt i huvudgruppen)
└─ Ren koppar                      (undergrupp)
   └─ Koppar klass 1               (artikel)
```

På artikelsidan väljs **Artikelgrupp** och eventuell **Undergrupp** med
dropdowns. Undergruppsvalet visar bara den valda huvudgruppens undergrupper.
**Ingen** lämnar artikeln utan grupp; den visas då under **Övrigt** i appen.
Äldre okända grupp-ID:n behålls i registret och visas också under Övrigt tills
kopplingen kompletteras.

En inaktiv grupp döljs i appen tillsammans med sina undergrupper och deras
artiklar, även i materialets sökning. Kopplingarna finns kvar på kontoret;
aktivering återställer visningen. En artikel kan också vara inaktiv för
invägning. Artikelns aktivstatus följer dess befintliga giltighetsdatum,
liksom prisregeln. Nya artikelkopplingar måste gå till aktiva grupper;
befintliga kopplingar till inaktiva grupper kan behållas vid andra ändringar.

En grupp med undergrupper kan inte flyttas under en annan grupp. Gamla
gruppkopplingar raderas inte när en grupp avaktiveras. Samtidiga gruppändringar
kontrolleras mot gruppens revision så att någon annans sparande inte skrivs
över av en gammal vy.

## Bilder och artikeltexter

Artikelns namn, korta beskrivning, **Ingår** och **Ingår inte** återanvänds
i appen. Mobilförhandsvisningen på artikel- och gruppsidan visar hur
presentationen blir.

Bildväljaren kan kombinera de 72 befintliga exempelbilderna med egna
uppladdningar. En artikel har högst **sex bilder**; en grupp har **en bild**.
Flytta bilderna framåt/bakåt eller välj en huvudbild. Första bilden används
som huvudbild i materialrutan. Bildordningen och artikelkopplingen sparas
när artikeln eller gruppen sparas.

För uppladdningar gäller:

- JPEG, PNG, WebP eller AVIF; högst **10 MB per fil**.
- Servern läser bildens faktiska innehåll och avvisar ogiltiga eller animerade
  filer. Upplösningen begränsas till 40 miljoner pixlar.
- Bilden roteras enligt originalets orientering och skalas med bevarade
  proportioner: full bild högst **1600 × 1600**, miniatyr högst **400 × 400**.
  Mindre original förstoras inte.
- Båda varianterna sparas som WebP. EXIF, GPS och annan bildmetadata tas bort.
- Bildvarianter och metadata sparas i PostgreSQL på Render, i tabellen
  `jeroc_article_media`. Ingen tillfällig Render-disk används för bilderna.

Uppladdade bilder får oföränderliga UUID-referenser. Att ta bort en bild från
artikelns bildlista tar bort kopplingen där; en redan lagrad fil skrivs inte
över. Servern kontrollerar att nya uppladdningsreferenser finns före sparande.
Bildändringar kräver artikelredigeringsbehörighet för både inloggad och
utförande användare, även vid **Jobba som**.

## Befintligt register och ekonomiska underlag

Vid uppdateringen skapas de tidigare appgrupperna med samma stabila ID:n:
Aluminium, Bly, Batterier, Järn, Kabel, Koppar, Mässing och Rostfritt.
Befintliga lagrade artikelkopplingar bevaras. Migreringen skriver inte om
artikelns prishistorik, miljöklassificering, lagerrörelser eller frysta
kundgodkända ekonomisnapshots.

Ändrad grupp, bild eller presentationstext blir aktuell i appkatalogen direkt
efter sparande och synkning. Pris, momsregel och artikelns aktivstatus väljs
fortsatt efter inlämningsdatumet. En ny katalogbild eller grupp ändrar därför
inte ett redan godkänt belopp eller en tidigare avräkning.

Appen hämtar grupper och artiklar tillsammans och behåller den senaste
katalogen i sin lokala cache. Efter återanslutning används serverns aktuella
register. Bilder hämtas vid behov och kan återanvändas från webbläsarens
bildcache; ett helt nytt bildarkiv laddas inte ner automatiskt för offlinebruk.

## Provflöde

1. Öppna **Artiklar & priser → Artikelgrupper** med artikelredigeringsbehörighet.
   Skapa en huvudgrupp och välj en exempelbild eller ladda upp en egen bild.
2. Öppna gruppen och skapa en undergrupp. Ange namn, beskrivning och
   sorteringsordning. Kontrollera mobilförhandsvisningen.
3. Öppna en artikel. Välj huvudgruppen och undergruppen. Ändra beskrivningen,
   ladda upp en egen bild och placera den först. Spara artikeln.
4. Öppna gårdsappens materialval eller prislista. Kontrollera grupp,
   undergrupp, artikeltext och bild. Återöppna kontorssidan för att kontrollera
   att sparandet finns kvar.
5. Välj **Ingen** på artikeln och spara. Kontrollera att artikeln finns under
   **Övrigt**. Avaktivera en grupp och kontrollera att den och dess artiklar
   döljs i appens meny/sökning; återaktivera för att visa dem igen.
6. Scrolla kontorets artikellista. Rubrik, flikar, filter och tabellrubriker
   ska ligga kvar. Öppna en artikel och kontrollera breadcrumbs och
   tillbaka-knappen. LME Cash nås via fliken, utan separat vänstermenyval.
7. Visa en lång avräkning på terminalen, scrolla längst ner och välj fysisk
   legitimation. Instruktionen ska synas direkt mitt i skärmen. Avbryt ska
   återställa scroll och fokus; personalens legitimeringskontroll fungerar
   fortfarande på den aktuella versionen.

## Lagring, installation och verifiering

Inga nya Renderfält behövs. Befintlig `DATABASE_URL` används; bildtabellen
skapas av serverns migration före mottagning av anrop. Lokalt utan PostgreSQL
finns SQLite-fallback för utveckling. På Render krävs PostgreSQL för beständig
bildlagring.

Fulla serversviten kördes med **506 tester: 483 godkända, 23 överhoppade**.
De överhoppade fallen var miljöberoende. Separat passerade **32 tester mot
isolerad PostgreSQL**, bland annat grupper, bildlagring, omstart och referenser.
Riktade webbläsarfall täcker grupp/undergrupp, artikelkoppling, uppladdning och
bildordning, stickyvy, mobilens meny/sökning samt terminalens ID-popup efter
scrollning och återanslutning.

Dessa resultat avser de körda testmiljöerna. De bekräftar inte att en viss
Render-deploy har blivit aktiv eller att aktuell drift har verifierats.
