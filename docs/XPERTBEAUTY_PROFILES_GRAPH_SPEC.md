# Xpert Beauty — Profiles & Graph: implementation spec (living)

Status 2026-09-22. Companion to `runa_serverless/prompt-lab-xpertbeauty/ARCHITECTURE.md` (data contract)
and the client plan (Runa_XpertBeauty_Plan_Integrare.pdf). Principle: **the current, client-approved
bundles stay the default; profiles, graph and learning are overlays proven by a parity gate.**

## What exists (do not rebuild)
| Piece | Where |
|---|---|
| Catalog sync from the merchant's Meta feed (2×/day), download + sanity gate, weekly --force | `runa-admin/apps/api/src/sync/providers/xpertbeauty.js`, `src/scripts/sync-xpertbeauty-all.sh` |
| GraphQL enrichment (public, no token): size/line/tip_produs/attrs, ALL categories, bundle components | `src/scripts/enrich-xpertbeauty-graphql.mjs` (`--all` once, `--new` daily) |
| Product → profile affinity (10 profiles), ontology nodes, review CSVs | `src/scripts/extract-xpertbeauty-profiles.mjs` → `pf_<profile>` props, `(:HairType|:SkinType)`, `SUITABLE_FOR {score,source}`; CSVs in `apps/data/xpertbeauty_profiles_review/` |
| Routine ontology (STEP 3 + 3B of the approved prompt, as graph) | `src/graph/xpertbeauty-routines.config.mjs`, `src/scripts/seed-xpertbeauty-routines.mjs` → `(:Routine)-[:HAS_STEP]->(:RoutineStep)-[:COMPLEMENTS {rank}]->(:Category)` |
| Named graph operations | `src/graph/xpertbeauty-ops.mjs`: `getHero`, `loadRoutines`, `pickRoutine`, `getComplements(hero, {profile})`; CLI `src/scripts/xpertbeauty-complements.mjs` |
| Golden set (production ritual output, DB prompts) + parity gate | lab `tests/ritual-golden.cjs` → `golden/*.json`; `src/scripts/xpertbeauty-parity.mjs` |
| Chat + ritual + chips runtime (one Lambda, action-routed, lab overrides, DynamoDB CacheTable, Gemini ctx cache) | `runa_serverless/handlerXpertBeautyChat.js` + `xpertBeautyHelper.js` (`computeRitual`, `fetchComplements`) |
| Widgets | `runa_web/src/pdpWidgetsXpertBeauty/` (CompleteTheLook, AskAIStylist, Similar, `?runa_preview=1`), `chatWidgetXpertBeauty/` |
| Prompts (source of truth = UserTable `chat.*`; lab repo mirrors it) | `/Users/adrian/Mobile/xpertbeauty-prompt-lab/prompts/` |

## Ritual pipeline today (xpertBeautyHelper.computeRitual)
1. generation prompt (aiWidgetPersonalization) → `{outfits:[{title, queries:[{category, product, characteristics}]}]}`
2. per query: `fetchComplements` = category (exact, store-scoped) + in-stock + priced, ranked by embeddings of the query text, top 8
3. selection prompt (adminWidgetContext) picks ids + copy → `{hero, ritual:{title, description, products, userOptions}}`
4. cached in DynamoDB `CacheTable` under `${storeId}_demo_ritual_${productId}_${promptVersionHash}`

## Plug points (Phase 1 — overlay, default unchanged)
- `computeRitual(..., { profile })`: when `profile` is null → exactly today's flow (default). When a confident
  profile is given → candidate pool = union of (2) and `getComplements(hero, {profile})` per step, each graph
  candidate carrying reason codes; the selection prompt receives them as extra candidates. **Cache key += profile.**
- Gate before ANY surface uses graph candidates for the default: parity `xpertbeauty-parity.mjs` category
  recall ≥ 0.85 against the golden set (re-snapshot after prompt publishes).
- Cart Virtual Bundler (new): rank = replenishment → `getComplements(hero, {profile})` step-1 candidates →
  universal; single LLM pick+wording; Magento bundle create keyed (hero, complement).

## Profiles (user side) — to build
- Store: DynamoDB `runa_profiles` keyed by widget anon id, merged into customer id on login; TTL 90d; SKUs/dates only.
- Signals → weights: chat explicit 1.0 · orders 0.8 (recency) · add-to-cart 0.6 · PDP view 0.3 (decay). Each event
  contributes the product's `pf_*` vector. Two profiles (hair, skin) + confidence; primary+secondary allowed.
- Replenishment: consumption window per category × size class (LLM once) → bought, in window, not re-bought, in stock.
- Learning v0: log (hero, complement, profile, shown/accepted/purchased) → nightly `COMPLEMENTS` weight, decay;
  LLM proposals outside the graph → candidate edges, promoted after review. Never edits `EXCLUDED_BY`/`pro_only`.

## Ops / cron
- Feed sync: `sync-xpertbeauty-all.sh` 2×/day (~30 min after merchant generation; ask their 2nd time).
- After each sync: `enrich-xpertbeauty-graphql.mjs --new` then `extract-xpertbeauty-profiles.mjs` (new products only).
- Re-seed routines after editing the config: `seed-xpertbeauty-routines.mjs` (replaces steps).
- Re-snapshot golden after any prompt publish: `node tests/ritual-golden.cjs 40` in the lab.


---

## Runtime overlays — implemented 2026-09-22 (pending deploy)

Everything below is **off by default**: with no `profile`, `candidates`, or `visitorId` parameter the ritual runs the
exact v1 prompt path with the v1 cache key, so the client-approved bundles are byte-for-byte unchanged (verified: the
v1 URL still returns the cached golden output). Files: `runa_serverless/xpertBeautyHelper.js` (handler), new
`xpertBeautyGraphOps.js` (port of `apps/api/src/graph/xpertbeauty-ops.mjs` — keep in sync), `xpertBeautyProfileStore.js`,
`xpertBeautyBundler.js`; chat: `handlerXpertBeautyChat.js`.

| Action / param | What it does |
|---|---|
| `complete_ritual&profile=<key>` | pf-boosted candidate ranking (`(pf−0.2)×0.4` on the embedding score), profile line in the generation input, `INPUT_CUSTOMER_PROFILE` + `suitable_for_profile` flags in the selection input. Cache key suffix `_pf_<key>` (10 edge-cacheable variants). |
| `complete_ritual&candidates=graph` | Routine ontology replaces the generation LLM call: steps + reason-coded candidates from `getComplements`; the selection prompt still writes the copy. Response has `source:"graph"`, `routine`. Cache suffix `_g1`. Gated by the parity check (recall 0.90 / precision 0.71 on 37 golden heroes). |
| `complete_ritual&visitorId=<id>` | Resolves the visitor's profile for the hero's domain (hair→hairProfile, skin→skinProfile) from the store; unknown/insufficient → v1 path. The widget instead calls `profile_get` first and passes `profile=` so the v1 URL stays edge-cached. |
| `complements&productId=&profile=&perStep=` | Raw graph op, no LLM (QA, lab, bundler). |
| `profile_event` (POST) | `{visitorId, type: declared\|order\|bundle_accept\|cart\|chat_query\|ritual_click\|view, productId\|productIds, profile, at}` → weights `w[k] = w[k]·0.97 + weight·max(0,(pf_k−0.2)/0.8)`; a profile is asserted only when top ≥ 0.5 and ≥ 1.3× the runner-up; a `declared` profile wins for 180 days. `order` events feed replenishment (days of use by category & size, e.g. shampoo 5 ml/day → 250 ml ≈ 50 days; due items = within 14 days). Stored in CacheTable `xpertbeauty.ro_profile_<visitorId>` (anonymous id + product ids only). |
| `profile_get&visitorId=` | `{hairProfile, skinProfile, confidence, weights, replenishment[]}`. |
| `cart_bundle` (POST) | `{anchorId, cartIds[], visitorId}` → anchor + up to 2 complements (one per routine step, not in cart, distinct categories, pro-only allowed only for pro-only heroes), `listTotal → bundlePrice` at `XB_BUNDLE_DISCOUNT_PCT` (10), one short Gemini call for title/pitch/roles, cached 30 days by content hash. With `XB_MAGENTO_TOKEN` (+ `XB_MAGENTO_BASE`, `XB_MAGENTO_ATTR_SET`, `XB_MAGENTO_WEBSITE_IDS`) it also creates the fixed-price Magento bundle (`POST /rest/V1/products`, type bundle, visibility 1, one required select option per component) and returns `magento.{productId, sku, bundleOptions, addUrl}`; without the token `magento.status = "pending_token"` and the widget adds the complements one by one (`/checkout/cart/add/product/<magentoId>/` + form_key — `magentoId` now comes from the GraphQL enrichment). |
| `track` (POST) | Learning v0 sink: one structured CloudWatch line (`evt:"xb_track"`) per `bundle_shown / bundle_accepted / bundle_dismissed / ritual_shown / ritual_click`. |

**Chat** (`handlerXpertBeautyChat.js`): Prompt 1's schema gained an optional `customer_profile` (set only when the shopper
states their hair/skin type) → stored as a `declared` event for `userId`; the stored profile then adds `(pf−0.2)×0.15`
to every category fetch (hair profile for hair categories, skin profile for skin ones). `?debug=true` shows `visitor_profile`.

**Widget** (`runa_web/src/pdpWidgetsXpertBeauty`): `widgets/VirtualBundler.jsx` (mount `runa-bundler`, in the preview
allowlist) listens for the Magento add-to-cart (`ajax:addToCart`, the PDP form submit, or `runa:cart-add`), builds the
anchor id from `data-product-sku`, posts `cart_bundle` and shows a slide-in offer (one per anchor per session). Accept →
Magento bundle form post when created, else one-by-one adds, then minicart reload, `bundle_accept` profile event and
`bundle_accepted` track. Complete-the-Look now sends `ritual_shown` / `ritual_click` and asks for the profile-ranked
ritual when `profile_get` knows the hero's domain profile. Visitor id = `localStorage.user_id` (same as analytics/chat).

**Learning v0** (`apps/api/src/scripts/learn-xpertbeauty-v0.mjs`, nightly): Logs Insights over the `xb_track` lines →
acceptance rate per (routine, category) vs the routine mean → `COMPLEMENTS.learnedBoost ∈ [−0.3, +0.3]` (≥ 20 impressions),
which `getComplements` adds to the candidate score. `--dry-run` prints the table only.

**Cron** (`sync-xpertbeauty-all.sh`, 2×/day): step 3 `enrich --new` (size/line/categories/bundles/magentoId), step 4
profile extraction for new products (+ review CSVs). Weekly `--force` re-embeds; `REENRICH=1` redoes the enrichment.

### Deploy checklist
1. Lambda (main stack, keys exported so the lab path is not wiped): in `runa_serverless`
   `set -a; . ./.lab-keys.env; set +a; export XB_LAB_KEY=$RUNA_LAB_KEY MOBEXPERT_LAB_KEY=$RUNA_LAB_KEY; ./node_modules/.bin/serverless deploy --config serverless.yml`
   → require the `✔ Service deployed` line. Then `node tests/profile-overlay.cjs` in the lab and `node tests/ritual-golden.cjs`
   spot checks (v1 URLs must hit the cache).
2. Widget: `npx webpack --config webpack.pdp-xpertbeauty.js` → upload `build-widget/pdp-xpertbeauty.js` to
   `s3://traveline-images/runa/pdp/pdp-xpertbeauty.js` + CloudFront invalidation (distribution E2FRY2MFS00I1N), or use the
   preview flag on the site first.
3. When the client sends the integration token: set `XB_MAGENTO_TOKEN` (+ base/attr-set) on the function and re-deploy;
   the bundler switches to real Magento bundles automatically. Order history → `profile_event type=order` (replenishment).

### Discount mode (decided 2026-09-22): Cart Price Rule coupon
The client defines a coupon (code + percentage). Set `XB_BUNDLE_COUPON` and `XB_BUNDLE_DISCOUNT_PCT` on the function
(serverless.yml reads them from env, defaults '' / '10') and re-deploy. The proposal then carries `coupon:{code, discountPct}`,
`magento.status = "coupon"`, and the widget adds the complements one by one, then posts `/checkout/cart/couponPost/` with the
code. No Magento bundle product is created and no catalog rights are needed (the token is only for order history later).

### Identity, browsing signals and the dev panel (2026-09-23)
- **Identity** (`runa_web/src/widgetShared/runaIdentity.js`, shared by chat + PDP): logged-in → `cust_<id>` when the merchant
  renders the customer id on the page (`<body data-runa-customer="…">`, `<meta name="runa-customer">` or `window.__runaCustomerId`;
  one template line on their side — Magento does not expose the id to JS by default); otherwise the anonymous device id
  (`localStorage.user_id`, cookie fallback). First page view after login → `profile_merge` folds the device record into the
  customer's (idempotent). The chat sends `visitorId` on every turn (its `userId` is a fixed tenant value, never used for profiles).
- **Browsing**: every PDP view posts a `view` event once per product per session (0.3); add-to-cart 0.6, ritual click 0.4,
  bundle accept 0.7, chat-declared 1.0; orders 0.8 will come from the order history once the token exists.
- **Dev panel**: in test mode (`?test_enabled=1`) a "Profile" pill opens the panel: identity, hair/skin profile with how it was
  decided, the 10 weights as bars (click a row to declare that profile for testing), last events, replenishment. Data = `profile_get`,
  which now also returns `events` (last 12) and the purchase count.

### Ritual warm-up + daily stale refresh (2026-09-23)
- **Warm-up** (`warm-xpertbeauty-rituals.mjs`, cron step 5 with `WARM=1` on the evening run): default ritual + chips for
  in-stock products never warmed (`p.ritualWarmedAt`), 4 in parallel; `--refresh 25 --invalidate` recomputes everything older
  than 25 days (monthly line, opt-in). Profile variants are never pre-generated.
- **Stale refresh** (`refresh-xpertbeauty-stale-rituals.mjs`, cron step 6, daily, always on): the Lambda stamps every served
  ritual on its hero (`p.ritualItems` = union of complement ids across cached variants, `p.ritualVariants`). The job finds
  in-stock heroes whose ritualItems contain a product now OOS or removed, recomputes each cached variant with `skipCaching`
  (default / `pf_<key>` / `+graph`), and invalidates `/?action=complete_ritual&domain=xpertbeauty.ro&productId=<id>*` on the
  edge (distribution E1M8L85URRPIX9). Rituals cached before 2026-09-23 have no stamp until they are served once through the
  function URL — the first warm-up pass does that for every in-stock hero.
- Models: rituals/chips/bundle copy and the chat run on gemini-3.8-flash with retry → 3.7 → 3.5 on 503/429 (`XB_RITUAL_MODEL`,
  `XB_CHAT_MODEL` override). Probe before changes: `runa_serverless/_modelbench/probe503.mjs 10 gemini-3.8-flash,gemini-3.7-flash`.

### PDP widgets, 2026-10-13 design (built in the isolated copy `~/Mobile/runa_web_xpert`, node_modules symlinked)
Design page: https://claude.ai/artifact/SQyPCryBsiqPPaG68T6ehg. Published to `s3://traveline-images/runa/pdp/pdp-xpertbeauty.js`
(always `--acl public-read` + CloudFront E2FRY2MFS00I1N invalidation). Delta vs the live tree: scratchpad `xpert-pdp-2026-10-13.patch`;
merge into `runa_web` on Adrian's command.
- `widgets/RitualRail.jsx` ("Ritualul complet"): pink uppercase title + "◆ recomandat de AI Beauty Expert", plain intro
  (`ritual.title — ritual.description`, "Pentru părul tău …" prefix when a profile is known), cards brand/name/price/role
  (`products[].text`, clamped 70), "+" per card (Magento form post with `magentoId`, else product link), footer = plain total +
  "ADAUGĂ RITUALUL ÎN COȘ" (sequential adds of every card with a magentoId). No discount. Mobile = swipe rail (62% cards).
- `widgets/AIExpertEntry.jsx` ("AI BEAUTY EXPERT"): one tappable line typing the 3 chip questions (28 ms/char, 2.6 s hold,
  two cycles, reduced-motion → static), label under it; tap → `sendDataToChat` with the question shown. Same on desktop.
- `widgets/InterestRail.jsx` ("Te-ar putea interesa și"): subtitle (category + "în jur de N lei"), 4 cards in the store's
  card grammar (brand, name, "why" chip from fields, price, În stoc, cart + heart), rules in `api.fetchSimilarProducts`
  (in stock, hero's sizeClass, one per line, 0.5–2× hero price, else plain list).
- Placement (index.jsx anchors, Magento only): entry after `.product.info.detailed`; ritual before `.bundle-options-container`
  else before the tiles row (`.delivery_days` → closest `.row`) else after `.product-add-form`; similar after the tiles row
  (= above the AJAX "Produse complementare / similare" tabs when they exist). A merchant container with `data-runa-placed`
  is never moved.
- Network: GETs via the edge (d3k1ptgqhqxdgx); POSTs (profile_event, track, cart_bundle, profile_merge) and profile_get go
  to the function URL — the edge only serves GET/HEAD and the POSTs were failing CORS preflight until 2026-10-13.
- Lambda: cards carry sku/magentoId/line/sizeValue/sizeUnit/sizeClass/inStock; `backfillRitualCards` fills them into
  rituals cached before this date at serve time and rewrites the cache; search cache key bumped to `_demo_search_v2_`.
  After deploy: CloudFront E1M8L85URRPIX9 `/*` invalidation so the edge re-serves enriched copies.
- Not done yet: the chat sheet (AI Beauty Expert: open on product, "+" on the card, profile question chip, routine answers).
