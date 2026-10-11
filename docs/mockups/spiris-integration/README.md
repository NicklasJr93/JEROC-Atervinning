# Spiris – inställningar och anläggningarnas kostnadsställen

Klickbart designförslag 2026-10-12 i befintlig JEROC-design.
[Öppna prototypen](https://jeroc-atervinning.onrender.com/mockups/spiris-integration/index.html)
efter Render-deploy, eller öppna
[index.html](../../../public/mockups/spiris-integration/index.html) lokalt.
Alla leverantörsstatusar, betalvillkor,
kontoplaner, momskoder och kostnadsställen är exempel. Prototypen anropar
inga API:er och sparar inga inställningar.

- Gemensamt standardbetalvillkor: **Direkt · 0 dagar**. Det motsvarar ett
  riktigt inköpsbetalvillkor i Spiris; dess ID hämtas från provider och
  kunden kan ha ett eget betalvillkor. Förfallodatum samma dag innebär
  ingen automatisk utbetalning.
- Ekonomiansvarig väljer gemensamma konton och momskoder från Spiris.
  Privatinköp och omvänd moms är olika regler. Omvänd moms för det aktuella
  skrotinköpet förutsätter rätt artikelkategori och kundens momsstatus.
  Förhandsvisningen visar ett exempel med full avdragsrätt för beräknad moms.
- Norrtälje och Rimbo har egna rader med kostnadsställe och valfritt projekt.
  **Gemensamma** öppnar en anläggningsspecifik avvikelse från standardkontona.
  Inga nya konton eller projekt skapas i Spiris av fältvalet.
- Företagsundantag och vanlig moms ligger under **Övriga inköp och momsregler**.
  De behöver egna fastställda regler; saknad registrering innebär inte
  automatiskt att alla inköp från företaget är momsbefriade.
- Förhandsvisningen reagerar på betalvillkor, anläggning, kostnadsställe,
  köpets momshantering och anläggningens kontoavvikelse. Utkast, bokföring och
  betalning förblir olika steg.

Den föreslagna liveöverföringen efter attest är ett framtida flöde. Dagens
Spiris-sandbox kräver fortfarande ett uttryckligt testklick. Ingen appkod
eller Render-konfiguration ändras av mockupen.

Rendering från repots rot: `node docs/mockups/spiris-integration/render-mockups.mjs`.

| Vy | Bild |
| --- | --- |
| Inställningar och anläggningar | [Översikt](01_Spiris_Integration_Anlaggningar.png) |
| Anläggningens egna konton | [Expanderad Rimbo](02_Spiris_Anlaggning_Egna_Konton.png) |
| Mobil | [Mobilvy](03_Spiris_Integration_Mobil.png) |
