# Xpert Beauty chat — what Sephora and Douglas do, and what we should change

**Date:** 2026-11-16 · **Status:** analysis only — no prompt, widget or Lambda changed yet.
**Prompt lab state read:** `runa-prompt-labs` main at `49b2bcd` (pulled today; one new commit — bundle rules, not published).
**How:** live in Adrian's Chrome — sephora.com/ca (13 product pages + 6 conversations, 16 turns), douglas.de ANNA
(3 products, 9 turns), and our own chat on xpertbeauty.ro (`?runa-preview=1`, Kérastase Curl Manifesto shampoo, 3 turns).
Raw notes with the verbatim turns (temporary session folder, may be cleared):
`/private/tmp/claude-501/-Users-adrian-Mobile-runa-admin/1ff0da47-8263-4ac2-8b8e-ce6180221737/scratchpad/sephora/`
(`notes.md` = Sephora, `douglas_notes.md`, `xpert_live_notes.md`).

---

## 1. Recommendation

**Keep Douglas' routine answer (our base) and add Sephora's conversation mechanics on top.**

- From **Douglas** keep: the routine layout (numbered, named steps, a "why for you" line and a price per step, the total
  against the budget, the page's product inside its step without a second card), exact prices in comparisons, real
  shade names when the data has them.
- From **Sephora** take: a visible "ask about this product" block on the product page with fixed chips, an answer that
  starts with the answer, 2–4 short paragraphs, one honest note, **one** closing question, chips that are the shopper's
  possible answers to that question, a decisive pick once the shopper gives the deciding fact, and graceful handling of
  questions that don't fit the product.
- Don't copy either one's weak spots: Sephora's category templates (an "ingredients" chip on a hair dryer), its
  question loop (three turns without naming a shade), and its weak routines; Douglas' ask-before-answer, Ja/Nein
  buttons for either/or questions, ignored concerns and over-promising.
- Fix the 6 problems found in our own chat (§6). Most fixes are in the prompts. Four need widget or Lambda work (§9).

---

## 2. Sephora — the product-page chips ("Try our AI Beauty Chat")

**Placement:** a full-width pastel block after the "Similar <type>" row, before Ratings & Reviews: title + NEW badge,
an input "Ask any question about this product", 5 chips in one row. The same chips also sit in the header's
"AI Beauty Chat" menu. The row loads only when scrolled into view.

**How they are built:** the page asks a "product-advisor" backend for the chips with the product id, SKU and category
(the same service has entry points for listings, CMS pages and home). In practice it returns **one template per top
category**, not chips per product:

| Category read | The 5 chips |
|---|---|
| Hair — shampoo, hair oil, **and hair dryers** | How do I use · How often · Benefits · Ingredients · *Should this be applied to wet or dry hair* |
| Skincare — serum | use · how often · benefits · ingredients · *Is this suitable for my skin type* |
| Sunscreen **and body lotion** | How to use · Ingredients · How often · *Is this good for sensitive skin* · Benefits |
| Make-up — foundation, **mascara, lipstick, eye palette** | How should I use · Benefits · *Is this long-wearing* · *What skin type is this good for* · Ingredients |
| Fragrance — women and men | *Key notes* · *Is it long-lasting* · How do I use · *What occasion* · *Is this a clean at Sephora product* |
| Gift sets | only the 4 generic ones |

**Rules behind them:** 4 information "jobs" every product-page shopper has (how to use, how often, what it does, what's
in it) + 1 category question; the chips never name the product, never sell (no similar / pairing chip on the page —
selling happens inside the chat), short question form.

**Their weak spot:** templates misfire — "ingredients" and "wet or dry hair" on a hair dryer, "skin type" on a lipstick
or mascara. **Ours are already better here:** `pdp_chips.md` writes chips per product (about the product · similar ·
one named complement).

---

## 3. Sephora — how the chat answers

Side panel, AI disclaimer, one thread across products (a divider with the product name is inserted when you change
product); "New Chat" adds "New Chat: <brand> – <product>" and repeats the 5 page chips inside the panel.

| # | Pattern | Seen as |
|---|---|---|
| S1 | **The first words answer the question** | "Yes — …", "Use it like your regular shampoo, but…", "best for date nights…" |
| S2 | **2–4 short paragraphs, one idea each, key action in bold, one emoji at the end** | usage: wet hair → scalp first → second wash if you use styling products → follow with conditioner |
| S3 | **One honest note**, taken from reviews | "a few reviewers mention residue — use a lighter amount if your hair is fine" |
| S4 | **Ends with ONE question that moves forward** (offer the next step or narrow) | "Want me to help you pick between the conditioner and mask?" |
| S5 | **5 chips in the shopper's voice**: 2–4 are the answers to that question, +1 nearby concern, +1 constant action | after "fine or thick?": *My hair is fine · My hair is thick · I want both · I need less frizz · Show more curl products* |
| S6 | Yes/no question → the chips include an explicit **No** | *Yes, more definition … No styling product* |
| S7 | **Answer first, then ask** on suitability | serum "suitable for my skin type?" → who it suits + who should be careful + how to use → "What's your skin type?" + *I'm oily · combination · dry · sensitive* |
| S8 | **Decisive pick** once the shopper gives the deciding fact | "My hair is fine" → "Then go with the Lightweight Conditioner" + one reason + how to still use the mask (once a week, lengths only) |
| S9 | **Lists: each product gets a different role** | gift under $100: closest vibe · sweeter/everyday · lighter mist (with its caveat) |
| S10 | **Remembers what the shopper said** | "fine hair" from two turns earlier used in the Olaplex comparison |
| S11 | **Graceful wrong-fit question** | dryer "ingredients?" → "it's a hair tool, not a formula" → the features it does know + a review note; chips switch to dryer topics |
| S12 | **Gift voice** | "it's for my wife" → chips become *She likes cozy scents · She wants long-lasting* |
| S13 | **Cards** | the product it talks about gets a card after the answer (rating, price, size, Add to Basket) + review tags ✓/⊖ |
| S14 | **Category-aware constant chip** | "Show me what pairs with this" (hair/skin/make-up) · "Show me layering options" (fragrance) |

**Where Sephora is weak:**
- **Routines:** AM/PM as arrow chains, no step names, no "why" per product, no total ("should land around your
  budget"), a mini-size sunscreen picked quietly to fit the budget.
- **Shade loop:** foundation, 3 turns — depth? → narrow? → tan easily? — and it never names a shade (no shade list in its
  data). The card kept showing the page's default 5W2 shade, the one it had told her to skip.
- **Competitors:** freely suggests the competing brand. We can't do that (distribution agreements, §4.B in Chat 1).

---

## 4. Douglas ANNA — what it does

**Mechanics:** no block on the product page, no starter chips; a small floating icon opens a side panel. It greets with a
product divider + "Do you have a question about <product>, or can I help with another beauty topic?". Each product page
starts a **fresh thread**. 👍/👎 under every answer. Every answer ends with one question + 2–3 buttons.

**Strengths (why our chat was modelled on it):**
- **Routine** — a tailored intro that echoes the profile ("for your fine, coloured curls… light care that doesn't weigh
  down"), **the total against the budget** ("87,97 € — inside your ~100 €"), then **1. REINIGUNG / 2. PFLEGE & ENTWIRRUNG /
  3. DEFINITION & STYLING**: each step a block with the product (linked), one "why for you" line, price + size + €/l,
  and the card right after; the page's product has no card. Skin: MORGENROUTINE / ABENDROUTINE sections, the same layout.
- **Cross-sell** — 3 products from the same line, each "Name von Brand: what it does" with its card right after.
- **Comparison** — exact prices both sides, other sizes, balanced, uses the profile.
- **Shades** — names 3 real shades at once (1W0 / 1W1 / 1W2) and explains the "W" code.

**Weak spots:**
- **Asks before answering:** "suitable for my skin type?" → nothing about the product, only "which skin type?" (3
  options, no normal / sensitive).
- **Flat usage answer:** two sentences, no tips.
- **Ja / Nein buttons for an either/or question:** "learn more about one of these, or looking for something specific?" → [Ja] [Nein].
- **Ignored a stated concern** — "I also have dark marks" got no step for it.
- **Product-type mistakes:** a body sunscreen in a face routine; a day fluid at night; the evening steps repeat the
  morning cards.
- **Over-promising:** "doesn't look cakey at all!"
- **Wrong card:** the foundation card showed a sister product in a 4th shade, not the product on the page and not one of
  the 3 shades it named.
- No review data, no starter chips, no ritual / bundle on the page.

---

## 5. Side by side

| | Sephora | Douglas | **Xpert today** | **Proposed for Xpert** |
|---|---|---|---|---|
| Entry on the product page | Visible block + input + 5 chips | Floating icon only | A small line that **rotates** through 3 questions | Visible block, input + **fixed** chips (R1) |
| Starter chips | Category template (misfires) | none | Per product, 3 slots ✔ | Per product, mostly about the product (R2) |
| First words | The answer | Often a question back | Varies | The answer (R3) |
| Answer length | 2–4 short paragraphs | 1–3 sentences; routines long | **≤120 chars, one sentence** (rule) | By intent (R4) |
| Suitability | Answer → then ask | Ask first | Partial, no yes/no | Answer → then ask (R6) |
| Closing | ONE question | ONE question + Ja/Nein | none | ONE question (R6) |
| Follow-up chips | 5, shopper's voice, answer the question | 2–3 answer buttons | 3 bare-noun browse chips + "Mai multe opțiuni" | 4, answer the question + 1 concern + 1 action (R12) |
| Deciding | "Then go with X" | Balanced, rarely decides | Lists | Decisive pick (R8) |
| Routine | Arrow lines, no total | **Numbered named steps, why, price, total** | Title + 3 cards, no steps, no total | Douglas layout with our ritual step names (R9) |
| Budget | Vague | Total stated | Over budget, not stated | Total stated, never over (R9) |
| Comparison | Lean + competitor | Exact prices, balanced | — | Exact prices + a lean from the profile (R15) |
| Shades | Question loop | Names shades | `other_shades` | ≤2 questions, then deliver (R7) |
| Honest note | From reviews | none / over-promises | none | One, from product data (R11) |
| Memory | Thread across products | Resets per page | `customer_profile` ✔ | Use it in the text (R17) |
| Brand rules | none | Same line | Exclusivity ✔ | keep |

---

## 6. Our chat today — live baseline (Kérastase Curl Manifesto shampoo)

1. **The entry line rotates under the cursor.** I clicked while it read "Pentru ce tip de păr e?" and the chat received
   "Un balsam pentru acest șampon". *(widget)*
2. **"Un balsam pentru acest șampon"** → 3 Kérastase conditioners (Nutritive "pentru păr uscat", Gloss Absolu,
   Discipline), none for curls, while the text promised "hidratare și definire". The line's own conditioner is sold out on
   the site, so skipping it is right — but nothing points to the same-line mask / leave-in, and there's no reason given
   per product. *(prompt + selection)*
3. **"Cum îl folosesc? Am părul fin și vopsit, e ok pentru mine?"** → answered about "balsamul" (which of the 3?), not the
   shampoo on the page; no "Da —" to "is it ok for me?"; no closing question. *(prompt: hero by default)*
4. **One-sentence cap.** `chat_2_response.md` Step 5 limits `text` to ~120 chars → usage / suitability answers can't
   carry real advice. Sephora's and Douglas' answers are 3–6× longer, and that text is what the shopper came for.
   *(prompt)*
5. **Routine "buget în jur de 450 lei"** → title + 3 cards (shampoo, Nutritive dry-hair conditioner, Curl Manifesto
   leave-in): no step names, no order, no "why", **total 462,50 lei (over budget, not mentioned)**, a dry-hair conditioner
   in a "fără încărcare" routine for fine hair. *(prompt + schema)*
6. **Price mismatch:** the shampoo showed 119,00 lei on the hero card and 125,00 lei inside the routine. *(data /
   Lambda — investigate)*

**What we already have that they don't:** per-product page chips, the numbered ritual on the page ("Pasul 1 · Curăță"),
the similar-products rail, brand-exclusivity rules, `customer_profile` memory, nail and device logic (Sephora sells
neither nails nor salon colour; Xpert sells no fragrance, so the fragrance patterns only matter as a gift-voice idea).

---

## 7. Proposed rules (to write into the lab after your OK)

Files: `chat_1_query.md` (C1), `chat_2_response.md` (C2), `pdp_chips.md` (CH). Romanian examples are drafts.

**R1 — Product-page entry (widget + CH).** A visible block "Întreabă AI Beauty Expert": input + the chips as a fixed row.
No rotation — the chip you click is the chip you read.

**R2 — Page chips are mostly about the product (CH).** 4 chips: 2 about the product (its top two "jobs" for its type:
how to use / how often / who it suits / what it contains / how long it lasts), 1 named complement (today's slot 3),
1 optional. Drop "Mai multe … ca acesta?" — the "Te-ar putea interesa și" rail sits right there. Keep our per-product
rules (no "ingredients" on a device, no "skin type" on a lipstick).
*Example, curl shampoo:* `Cum se folosește?` · `E bun pentru părul vopsit?` · `Un balsam pentru acest șampon` · `Cât de des îl folosesc?`

**R3 — The first words answer (C2).** "Da — …", "Nu chiar — …", or the instruction itself. Never open with a restatement.

**R4 — Length by intent (C2, replaces the 120-char cap).**
- Advice / usage / suitability / comparison: 2–4 short paragraphs, one idea each, **bold** the key action, ≤ ~450 chars.
- Product list: 1 intro sentence + one line per product (R10).
- Routine: R9.
- Greeting / redirect: 1 sentence.
The widget already renders bold and lists (`markdown.js`).

**R5 — The page's product is the default subject (C1 + C2).** On a product page, "îl / o / acesta / e ok pentru mine?"
means the hero, unless the message clearly points to a product just shown ("al doilea balsam").

**R6 — Answer first, then at most ONE question (C2).** Give the useful general answer even when a profile detail is
missing, then ask for that detail. Never more than one question per turn.
*Example:* "Da — e gândit pentru bucle și e fără sulfați, deci blând și cu părul vopsit. … Ai părul mai degrabă fin sau gros?"

**R7 — At most 2 profiling questions in a row, then deliver (C2).** A concrete pick, or a plain "nu am nuanțele aici —
uite cum alegi" (Sephora's shade loop is what this prevents).

**R8 — Decisive pick (C2).** Once the shopper gives the deciding fact, recommend one: "Atunci ia **X** — …" + one reason +
how to still use the other, if it's useful.

**R9 — Routine layout (C2 + schema).** Intro that echoes the profile → the total against the budget ("Totalul: 412 lei, în
bugetul tău de 450 lei") → numbered steps using **the same step names as the page ritual** (Curăță · Hrănește · Repară ·
Protejează · Definește · Finisează …): "**Pasul 1 · Curăță** — <product>: <why for you, 1 line>". Skin: Dimineața /
Seara sections. The page's product sits in its real step, with no second card. Never repeat a card. **The total never
goes over the budget**; if it's far under, say so or offer one more step. A concern the shopper named gets a step or an
honest "pentru pete nu am un pas potrivit aici".
*Needs* `step` + `why` per product in `bundles` (the ritual selection already returns `step` / `hero_step`) — see §9.

**R10 — Lists: every product gets a different role (C2).** "**cel mai apropiat**", "**mai ușor pentru păr fin**",
"**varianta mai accesibilă**" — one line each, not three near-duplicates.

**R11 — One honest note, from the product data only (C2).** E.g. "pe păr fin, puțin și doar pe lungimi". Never "nu
încarcă deloc" / "garantat". (Sephora takes these notes from reviews; we have no review data — see Q7.)

**R12 — Follow-up chips answer the question (C2 Step 6 + C1 §7.A).** Replaces "bare noun phrases":
- 2 chips = the shopper's likely answers to the question just asked, in the shopper's voice ("Am părul fin", "Părul meu
  e vopsit").
- 1 chip = a nearby concern or the next step ("Vreau mai multă definire").
- 1 chip = an action ("Ce se potrivește cu el?").
- After a yes/no question, one of the chips is the "no" ("Nu, fără styling").
- Gift → third person ("Ea preferă texturi ușoare").
Kept: no product names, no shipping / stock / order topics, every chip deliverable. First-person chips also feed
`customer_profile` (§7.B) directly.

**R13 — Wrong-fit questions (C2).** Say plainly what doesn't apply ("e un aparat, nu are listă de ingrediente"), then
what is known about it.

**R14 — Gift mode (C1 + C2).** "Cadou pentru…" → third-person chips, one question about the recipient (texture /
everyday vs special), keep the budget.

**R15 — Comparisons (C2).** Exact price + size both sides, then a lean based on the profile ("pentru părul tău fin și
vopsit aș merge pe…"). Another brand only when the shopper names it (existing §4.B exception).

**R16 — When the line's companion isn't available (C1 + C2).** Offer the same line's nearest other product (mask /
leave-in) first, then other lines that match the hero's need (curl, light) — never a contradictory one (a dry-hair
conditioner for fine hair). No stock wording (existing rule). The text describes only what's shown (existing rule —
it was broken in test 2).

**R17 — Use the profile in the words (C2).** Whatever the shopper said earlier ("fin", "vopsit", "ten mixt") appears in
later answers ("Pentru părul tău fin…"), not only in the retrieval.

---

## 8. Not to copy

- Category-template chips that don't fit the product (Sephora).
- Three questions without a recommendation; a card for a variant the text just rejected (Sephora).
- Routines without a total or step names; quietly using a mini size to fit a budget (Sephora).
- Asking before saying anything useful; Ja/Nein for either/or questions; ignoring a stated concern; wrong product
  types in a routine (body SPF on a face, day fluid at night); repeated cards; over-promising (Douglas).
- Suggesting a competitor brand unprompted (Sephora — and forbidden for us).

---

## 9. What needs code or data (beyond the prompts)

| # | Change | Where |
|---|---|---|
| X1 | Fixed chip row + input instead of the rotating entry line | widget `runa_web_xpert` (AIExpertEntry) |
| X2 | Routine steps in chat: `step` + `why` per product, total line | Lambda (xpertBeautyHelper chat path) + chat widget bundle card |
| X3 | 4 generated chips + the auto "Mai multe opțiuni" — check the Lambda doesn't cap at 3 (the widget renders all) | Lambda |
| X4 | Hero price 119 vs 125 lei in the same chat | Lambda / data — investigate |
| X5 | Thread across product pages with a product divider (Sephora) — not tested on ours yet | widget — check first |
| X6 | (later) review data for honest notes and ✓/⊖ tags on cards | data source unknown — Q7 |

Everything in R3–R8, R10–R17 is prompt-only. R9 can start text-only (steps written into `text` as a numbered list) and
move to proper step cards with X2.

---

## 10. Decisions for Adrian

1. **Direction:** Douglas routine layout + Sephora conversation mechanics, as above?
2. **Page chips:** 4 chips (2 about the product + complement + 1) and drop "Mai multe … ca acesta?" since the similar
   rail is on the page?
3. **Entry:** replace the rotating line with a fixed chip row + input (widget work)? Keep it under add-to-cart, or move
   it lower like Sephora (after the rails, before reviews)?
4. **Chip voice:** first-person shopper answers ("Am părul fin") instead of bare nouns ("Balsamuri")?
5. **Answer length:** raise the cap to ~450 chars for advice answers?
6. **Routine:** text-only steps first (prompt), or straight to step cards (X2)?
7. **Reviews:** does Xpert have product reviews / ratings we can read? It's Sephora's biggest advantage.

## 11. Next steps after your OK

1. `git pull --ff-only` on runa-prompt-labs again (main at `49b2bcd` today), then edit `chat_1_query.md`,
   `chat_2_response.md` and `pdp_chips.md` per the rules you approve.
2. Lab test on a few named products only (cost rules: no catalog-wide runs): the Curl Manifesto shampoo, a skin serum, a
   foundation, a semi-permanent polish, a hair dryer; the same 3–4 turns as above, compared with these transcripts.
3. Dry-run publish → your go → publish, then clear the data CDN for the chips.
4. Widget / Lambda items (X1–X5) as separate steps, each on your go.
