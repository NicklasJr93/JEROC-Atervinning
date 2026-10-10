# Kontorsdemo 0.12.2 – NVV-anslutningskontroll

Skärmbilder från den testade appen med isolerad testdata. Animerad väntan
provas mot lokal simulering. TEST-resultatens anrop och svar är uttryckligt
märkta renderingsfixturer; inga externa myndighetsanrop görs i browserproven.

- [Anslutningskontroll pågår – 1440 px](pending-1440.png)
- [Resultat med anrop och svar – 1440 px](success-1440.png)
- [Resultat med anrop och svar – 390 px](success-390.png)

Tre riktade webbläsarfall passerade, inklusive återförsök, fokusretur,
bakgrundskörning och minskad rörelse. Produktionsbygget samt klientens
25 tester och rapporteringens 16 regressioner passerade.
Den verkliga Render-anslutningens åtkomst och kodlistor hade verifierats
separat; riktiga rapportkvittenser och rättelsekedja provas senare.
