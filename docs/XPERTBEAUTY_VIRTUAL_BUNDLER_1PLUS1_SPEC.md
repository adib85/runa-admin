# Xpert Beauty — Virtual Bundler "1 + 1" (spec)

**Status: BUILT and DEPLOYED 2026-11-16 (Adrian's go), visible only in our own preview** (`?runa-preview=1` /
test / dev). Never in the client's preview link (`?runa_mode=preview`) and not for shoppers (store off) — the 10% is not
charged by the cart until Xpert gives the coupon (`XB_BUNDLE_COUPON`). Decided with Adrian on 2026-11-11.

**Update 2026-11-18 (Adrian: "only show products they visited"), deployed, runa_serverless b625b64:** the +1 comes only
from products the shopper visited. The ritual is used only when they visited no other product. Section 2 below is the
current order. Past orders (replenishment) are no longer a source.

Where: `runa_serverless/xpertBeautyBundler.js` `proposeOnePlusOne` (default `XB_BUNDLE_MODE=1plus1`; the old 3-product
mode = `mode: "routine"`), action `cart_bundle` in `xpertBeautyHelper.js` (session views from the widget, earlier visits
from the profile store's view events (`recentViews`, 30 days), the product's cached "Ritualul complet" read-only, the
similar row's brand agreements). Widget: `VirtualBundler.jsx` (caps, holdout 10%, waits for the shop's popup, 1+1
wording) + `api.js trackViewTime` (visible seconds + visits per product page, sessionStorage `runa_xb_viewtime`).
"Never a substitute" = never the same `runaType`. Not built: the concern-compatibility rule beyond the ritual's own
choice; promotion stacking (open question).

## 1. What the offer is

- After the shopper adds a product to the cart, a popup offers **one** other product: 1 + 1.
- **The price is shown at the end as one total for both products, with 10% off the sum**
  (e.g. 75 lei + 92 lei = 167 lei → 150,30 lei for both). The 10% is on the total of the two, not on one of them.
- Accepting adds **both products to the cart**. How the cart gets the 10% (a coupon code, or our script) is not
  decided yet — see section 5.

## 2. Which product is offered — in this order

Current order (2026-11-18): **only products the shopper visited**.

1. **A product opened in this visit.** The most interest wins: more visits first, then longer visible time on the
   page. It can come from any routine (a face cream next to a shampoo is fine). Reason `viewed_this_session`.
2. **A product opened on an earlier visit** (profile store view events, last 30 days, most recent first).
   Reason `viewed_before`.
3. **Only when the shopper opened no other product** (e.g. landed from an ad and added straight away): the next step
   of the **Ritualul complet** of the product just added. Reason `ritual_step`.

If they opened other products but none passes the rules below (e.g. only other shampoos, or only an exclusive brand),
there is **no offer** (note `no_visited_product_fits`). It does not fall back to the ritual.

Before 2026-11-18 the order was session (complementary, then long views) → past orders → ritual.

## 3. Rules for every offer (approved 2026-11-11)

1. **Never a substitute.** The offered product is never in the same category / step as the one added (no second
   shampoo next to a shampoo). It is another step of the routine, or another kind of product.
2. **The added product decides compatibility.** The offered product must not work against the added product's
   concern (same principle as the ritual on the product page).
3. **Guards:** in stock; can be added to the cart from the popup (has a Magento id); not already in the cart;
   respects the brand rules (never-together pairs, single-brand heroes); no professional-only product unless the
   added one is professional; no salon size (750 ml and up) next to a retail product (since 2026-11-18; the old
   "same size class" check blocked e.g. a 15 ml cream next to a 100 ml shampoo); price at most about 1.5× the added product's.
4. **With several products in the cart**, the +1 is chosen against the product just added.
5. **Frequency:** one offer per session unless it was accepted; none after two dismissals; none when the popup's own
   add triggered the event; never on top of the store's own add-to-cart popup.
6. ~~Past-orders offers~~: removed 2026-11-18 (they need logged-in customers and order events, which we don't have).
7. **The copy prompt receives the reason** as data — `viewed_this_session`, `viewed_before` or `ritual_step`
   (2026-11-18; `viewed_long` and `replenishment` are no longer sent) — so `bundler_copy.md` (runa-prompt-labs) can say why this product.
8. **Measure it:** a small holdout that never sees the popup; shown / accepted / dismissed counted per source.

## 4. What exists today (to be changed)

- `runa_serverless/xpertBeautyBundler.js` → `proposeCartBundle`: the added product + **up to 2** complements
  (`XB_BUNDLE_SIZE` = 3), chosen only by the catalog graph (routine steps), 10% (`XB_BUNDLE_DISCOUNT_PCT`), coupon mode
  via `XB_BUNDLE_COUPON` (empty today).
- `runa_web_xpert/src/pdpWidgetsXpertBeauty/widgets/VirtualBundler.jsx`: listens for add-to-cart, one offer per added
  product per session (`runa_xb_bundle_shown`), adds items one by one, applies the coupon through the store's `couponPost`.
- Copy: `runa-prompt-labs/clients/xpertbeauty/prompts/bundler_copy.md` (field `virtualBundlerPrompt`); test with
  `npm run cartoffer`.
- Signals available now: the session's viewed product ids (`sessionStorage runa_xb_viewed`, no time spent), the
  profile store's events (views, carts, orders with timestamps) and its replenishment estimate (`usageDays`, `daysLeft`).
- Not live: the store switch is off.

## 5. Needed before building / going live

- **Time spent per product page** in the session (visible time, repeat visits) — the widget stores only ids today.
- **From Xpert:** the customer id on the page and order events (source 2 cannot work without them).
- **How the 10% reaches the cart** (coupon code from Xpert, or our script). The popup shows the discounted total, so
  the cart has to charge that total before the popup is shown to shoppers.

## 6. Still open

- Are products already on promotion excluded from the offer? (Xpert's discount-stacking rules.)
