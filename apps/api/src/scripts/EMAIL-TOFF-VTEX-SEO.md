# Email — către TOFF + echipa VTEX storefront

**Subject:** TOFF.ro — SEO și descrieri produse actualizate + modificări template necesare

---

Bună,

Am rulat update-ul automat de SEO și descrieri pentru produsele Toff conform briefingului trimis:

- **SEO** — `Title` (max 50 char, format `... | TOFF.ro`) și `MetaTagDescription` (~120-160 char, cu emoji ⭐ ✓ ✈) populate pentru toate produsele care erau goale. Cele cu SEO setat manual au fost păstrate intacte.
- **Descrieri** — descrierile generate anterior automat au fost reformatate cu noile reguli (eliminat „premium", „piele de miel/vițel/oaie/cerf", „fuziune", acord gramatical, structură intro → caracteristici → compoziție). **Descrierile setate manual de echipa TOFF nu au fost atinse**, iar o parte dintre ele conțin în continuare cuvinte care, conform briefingului, ar trebui evitate (ex.: „premium"). Vă recomand o revizuire manuală a descrierilor proprii pentru a le alinia complet cu noile reguli.

Datele se scriu corect prin API-ul VTEX, însă pe pagini observăm 3 lucruri ce țin de template-ul storefront-ului — vă rog (echipa VTEX) să verificați și ajustați:

1. **Dublu sufix pe `<title>`** — template-ul adaugă automat ` - TOFF.ro` la sfârșitul oricărui `Title` din catalog, deci produsele cu format `... | TOFF.ro` apar ca `... | TOFF.ro - TOFF.ro`. Puteți scoate sufix-ul automat ca să folosim direct ce e în catalog?

2. **`<meta name="description">`** afișează mereu textul generic la nivel de magazin, nu valoarea din `MetaTagDescription` a produsului. Poate fi configurat să folosească câmpul din catalog?

3. **`<meta property="og:description">`** este gol — ar fi util populat tot din `MetaTagDescription`.

Puteți verifica pe orice produs din catalog (toate au acum `Title` și `MetaTagDescription` populate corect).

Mulțumesc,
[Numele tău]
