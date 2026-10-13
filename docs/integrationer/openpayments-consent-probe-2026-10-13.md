# Verifierat bankmedgivande i Open Payments sandbox, 2026-10-13

Ett kontrollerat AIS-prov reproducerade felet vid bankens återkoppling och
bekräftade orsaken. Klientuppgifter och den registrerade HTTPS-returadressen
fungerade. Att ta bort `localhost` från portalens lista orsakade inte felet.

## Resultat

| Steg | Faktiskt providersvar |
| --- | --- |
| Skapa ett sandboxmedgivande | HTTP 201, `received` |
| Skapa och starta signering | HTTP 201/200, `REDIRECT`, `started` |
| Godkänn i sandboxens inloggning | OAuth-kod och korrekt `state` returnerades |
| Växla kod med appens `ConsentAuthorisationId` i `acr_values` | HTTP 500, tom svarskropp |
| Ny OAuth-kod, samma medgivande och signerings-ID, `consentAuthorisationId` | HTTP 200, `Bearer` |
| Läs medgivande/signering efter växlingen | HTTP 200, `valid`/`finalised` |
| Läs konton | HTTP 200, sju syntetiska konton |
| Läs saldo för ett SEK-konto | HTTP 200, två saldon: `interimBooked` och `expected` |

Det felaktiga fältet var skiftläget i OAuth-länkens `acr_values`:

```text
ConsentAuthorisationId:…  →  consentAuthorisationId:…
```

Open Payments faktiska `_links.scaOAuth.href` använder den senare formen.
Den publicerade [signeringsguiden](https://docs.openpayments.io/docs/authorisations)
visar däremot `ConsentAuthorisationId` genom sitt `ResourceType`-exempel.
Sandboxen behandlade dessa former olika. I det lyckade provet ändrades endast
selektorns skiftläge och en ny OAuth-kod med ny `state` hämtades; medgivandet och
signerings-ID:t behölls. Ingen tidigare förbrukad kod återanvändes i det lyckade
provet.

## Återförsök

Sandboxen vägrade att skapa ytterligare en signering för samma medgivande:
HTTP 400, `UNEXPECTED_ERROR`, med texten att en signering redan finns.
GET av den befintliga signeringen returnerade endast `scaStatus: started`.
Återställning kunde genomföras med en ny OAuth-länk/kod för samma befintliga
signering efter kontroll av dess status; ytterligare POST eller PUT behövdes
inte för det lyckade provet.

## Avgränsning

Provet använde endast dokumenterade syntetiska identiteter hos Swedbanks
sandbox. Returkoden fångades lokalt före anrop till ScrapPilots produktionsserver.
Ingen produktionsdatabas ändrades och ingen betalning eller PIS-begäran skapades.
Kontonummer, inloggningsuppgifter, tokens och returkoder finns inte i denna rapport.
Betalningssigneringens motsvarande fältnamn har inte provats mot PIS i detta prov.
