# Email — către administratorii storefront-ului TOFF.ro

**Subject:** TOFF.ro — ajustare template storefront pentru SEO produse

---

Bună,

Am început să populez automat câmpurile `Title` și `MetaTagDescription` din catalogul VTEX (toffro) pentru produsele Toff, conform regulilor SEO primite de la client (format `<Tip produs> <Model>| TOFF.ro` pentru title, max 50 caractere).

Am observat că storefront-ul adaugă automat ` - TOFF.ro` la sfârșitul oricărui `Title` din catalog. Acest lucru produce **dublu sufix** afișat pe pagină pentru orice produs care are deja `| TOFF.ro` în câmpul `Title` din catalog (atât produse populate manual anterior, cât și cele generate de noi acum, conform briefului clientului).

Exemplu pe https://www.toff.ro/saint-laurent-pantofi-champagne-115mm-7634312wja11011/p:

- `Title` în catalog: `Pantofi Champagne 115mm| TOFF.ro`
- `<title>` afișat pe pagină: `Pantofi Champagne 115mm| TOFF.ro - TOFF.ro` ❌

Am verificat 15 produse random din catalog și **6 dintre ele (~40%)** au deja `| TOFF.ro` setat manual în `Title`, deci sunt afișate cu dublu sufix chiar acum, nu doar cele noi.

**Rugăminte**: puteți scoate sufix-ul automat ` - TOFF.ro` din template-ul storefront-ului, ca să folosim direct ce e în câmpul `Title` din catalog? Astfel:
- Produsele cu format corect (`...| TOFF.ro`) se vor afișa curat.
- Restul produselor (care în prezent nu au nimic în `Title`, ~60%) le populez eu cu noul format conform briefului.

Pe lângă asta, mai sunt 2 lucruri pe care vă rog să le verificați în template:

1. **Meta description** — pe pagina produsului, `<meta name="description">` afișează mereu textul generic la nivel de magazin („Imbracaminte, incaltaminte si accesorii de la cei mai in voga designeri…"), nu valoarea din câmpul `MetaTagDescription` al produsului. Poate fi configurat să folosească `MetaTagDescription` din catalog?

2. **og:description** este gol pe paginile de produs. Ar fi util să fie populat tot din `MetaTagDescription` (pentru shares pe Facebook, LinkedIn, Slack etc.).

Pagina de test (cu noul format generat de noi):
https://www.toff.ro/acne-studios-rochie-camasa-cu-esarfa-aplicata-a20937-dlc/p

Mulțumesc,
[Numele tău]
