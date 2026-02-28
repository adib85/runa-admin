/**
 * Shopify Provider
 * Implementation of BaseProvider for Shopify stores
 * Includes shop-specific features for Bogas, DyFashion, and Raicu
 */

import { GraphQLClient, gql } from "graphql-request";
import Shopify from "shopify-api-node";
import fetch from "node-fetch";
import { stripHtml } from "string-strip-html";
import { BaseProvider } from "./base.js";
import { s3Service, openaiService } from "../services/index.js";
import { convertHtmlToMarkdown, extractRelevantFields, delay } from "../utils/index.js";

const GET_PRODUCTS_QUERY = gql`
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      edges {
        cursor
        node {
          id title descriptionHtml handle vendor productType status tags publishedAt
          images(first: 10) { edges { node { src altText } } }
          variants(first: 100) {
            edges {
              node {
                id title price compareAtPrice sku inventoryQuantity
                selectedOptions { name value }
              }
            }
          }
          collections(first: 10) { edges { node { id title handle } } }
          metafields(first: 10) { edges { node { key value namespace } } }
        }
      }
    }
  }
`;

export class ShopifyProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.endpoint = `https://${this.shopName}/admin/api/2023-04/graphql.json`;
    this.graphQLClient = new GraphQLClient(this.endpoint, {
      headers: {
        "X-Shopify-Access-Token": this.accessToken,
        "Content-Type": "application/json"
      }
    });
    this.shopifyApi = new Shopify({ shopName: this.shopName, accessToken: this.accessToken });
  }

  get providerType() {
    return "Shopify";
  }

  async fetchProducts(options = {}) {
    const { cursor, limit = 20 } = options;
    
    // Shop-specific batch size
    let batchSize = limit;
    if (this.shopName === "andreearaicu.myshopify.com") {
      batchSize = 2;
    }

    const response = await this.graphQLClient.request(GET_PRODUCTS_QUERY, {
      first: batchSize,
      after: cursor
    });

    const products = this.transformGraphQLResponse(response);
    
    // Fetch English translations for Raicu
    if (this.shopName === "andreearaicu.myshopify.com") {
      await this.fetchRaicuTranslations(products);
    }

    return {
      products,
      nextCursor: response.products.pageInfo.hasNextPage 
        ? response.products.edges[response.products.edges.length - 1].cursor 
        : null,
      hasNextPage: response.products.pageInfo.hasNextPage
    };
  }

  transformGraphQLResponse(response) {
    return response.products.edges.map(edge => {
      const node = edge.node;
      const id = node.id.replace("gid://shopify/Product/", "");

      return {
        id,
        title: node.title,
        body_html: node.descriptionHtml,
        descriptionHtml: node.descriptionHtml,
        handle: node.handle,
        vendor: node.vendor,
        product_type: node.productType,
        status: node.status?.toLowerCase(),
        tags: node.tags?.join(", ") || "",
        published_at: node.publishedAt,
        images: node.images?.edges?.map(e => ({ src: e.node.src, alt: e.node.altText })) || [],
        variants: node.variants?.edges?.map(e => {
          const v = e.node;
          const variantId = v.id.replace("gid://shopify/ProductVariant/", "");
          const options = {};
          v.selectedOptions?.forEach((opt, idx) => {
            options[`option${idx + 1}`] = opt.value;
          });
          return {
            id: variantId,
            title: v.title,
            price: v.price,
            compare_at_price: v.compareAtPrice,
            sku: v.sku,
            inventory_quantity: v.inventoryQuantity,
            ...options
          };
        }) || [],
        options: this.extractOptions(node.variants?.edges || []),
        collections: node.collections?.edges?.map(e => ({
          id: e.node.id.replace("gid://shopify/Collection/", ""),
          title: e.node.title,
          handle: e.node.handle
        })) || [],
        metafields: node.metafields?.edges?.map(e => ({
          key: e.node.key,
          value: e.node.value,
          namespace: e.node.namespace
        })) || []
      };
    });
  }

  extractOptions(variantEdges) {
    if (!variantEdges.length) return [];
    const firstVariant = variantEdges[0].node;
    return (firstVariant.selectedOptions || []).map((opt, idx) => ({
      name: opt.name,
      position: idx + 1
    }));
  }

  async fetchCollections() {
    try {
      const custom = await this.shopifyApi.customCollection.list();
      const smart = await this.shopifyApi.smartCollection.list();
      return [...custom, ...smart].map(c => ({ title: c.title }));
    } catch (e) {
      console.log("Error fetching collections:", e.message);
      return [];
    }
  }

  async getShopData() {
    // Shop-specific currencies
    if (this.shopName.includes("dyfashion")) {
      return { currency: "RON" };
    }

    try {
      const shop = await this.shopifyApi.shop.get();
      return {
        currency: shop.currency || "USD",
        name: shop.name,
        domain: shop.domain
      };
    } catch (e) {
      console.log("Error fetching shop data:", e.message);
      return { currency: "USD" };
    }
  }

  // ==================== SHOP-SPECIFIC FEATURES ====================

  // Override for DyFashion-specific category handling
  determineCategory(product, productProperties, websiteCategories) {
    let category;
    const productTypeCategory = product.product_type ? product.product_type.toLowerCase() : "";
    console.log("\n\ncheck", productTypeCategory);

    // Special handling for DyFashion
    if (this.shopName.includes("dyfashion")) {
      console.log("\n\n========================================");
      console.log("[DYFASHION] Getting category from collections");
      console.log("[DYFASHION] Product ID:", product.id);
      console.log("[DYFASHION] Product Title:", product.title);
      console.log("[DYFASHION] Collections:", JSON.stringify(product.collections, null, 2));
      console.log("[DYFASHION] CategoriesDetails:", JSON.stringify(product.categoriesDetails, null, 2));

      if (product.collections && product.collections.length > 0) {
        category = product.collections[0].title;
        console.log("\n✅ [DYFASHION] CATEGORY FROM COLLECTIONS:", category);
      } else if (product.categoriesDetails && product.categoriesDetails.length > 0) {
        console.log("[DYFASHION] Using categoriesDetails for category");
        category = product.categoriesDetails[0].category_seo_name || product.categoriesDetails[0].category_name;
        product.collections = product.categoriesDetails.map(c => ({
          id: c.category_id,
          title: c.category_seo_name || c.category_name,
          name: c.category_name
        }));
        console.log("\n✅ [DYFASHION] CATEGORY FROM CATEGORIESDETAILS:", category);
      } else {
        console.log("\n❌ [DYFASHION] No collections or categoriesDetails found");
        category = productProperties.category?.toLowerCase() || "clothing";
      }
      console.log("\n🏷️  [DYFASHION] FINAL CATEGORY:", category);
      console.log("========================================\n");
      console.log("✓ Continuing execution...\n");
      return category;
    }

    // Default handling for other shops
    if (product.collections && product.collections.length > 0) {
      category = product.collections[0].title;
      console.log("found category from collections");
    } else if (websiteCategories.map(c => c.toLowerCase()).includes(productTypeCategory)) {
      category = productTypeCategory;
      console.log("found category");
    } else {
      console.log("not found category");
      console.log("productProperties.categories", productProperties.category, product.collections);
      category = productProperties.category?.toLowerCase() || "clothing";
    }

    console.log("category match", `initial category: ${product.product_type}`, `final category: ${category}`);
    return category;
  }

  async fetchRaicuTranslations(products) {
    console.log(`  [Raicu] Fetching English for ${products.length} products...`);
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (!p.handle) continue;
      try {
        const enRes = await fetch(`https://amalin.com/en-intl/products/${p.handle}.json`);
        if (enRes.ok) {
          const enData = await enRes.json();
          const enP = enData.product;
          p.en_title = enP.title?.trim() || "";
          p.en_price = enP.variants?.[0]?.price || "";
          p.en_price_currency = enP.variants?.[0]?.price_currency || "EUR";
          p.en_url = `https://amalin.com/en-intl/products/${p.handle}`;
          p.en_product_type = enP.product_type || "";
          p.en_description = enP.body_html ? stripHtml(enP.body_html).result : "";
          p.en_json = JSON.stringify(enP);
          console.log(`    ✓ EN: ${p.title?.substring(0, 30)}`);
        }
        if (i < products.length - 1) await delay(200);
      } catch (e) {
        console.log(`    ✗ EN error: ${p.handle}`);
      }
    }
  }

  async classifyStyle(product) {
    // Bogas style classification
    if (this.shopName === "bogas-com-international.myshopify.com") {
      console.log("  [BOGAS] Getting style code...");
      try {
        const result = await this.getProductStyleBogas(product);
        console.log("getProductStyleBogasResult", result);
        return result;
      } catch (e) {
        console.log("  [BOGAS] Style error:", e.message);
        return null;
      }
    }

    // DyFashion style classification
    if (this.shopName === "dyfashion.avanticart.ro") {
      console.log("  [DYFASHION] Getting style code...");
      try {
        const result = await this.getProductStyleDyFashion(product);
        console.log("getProductStyleDyFashion result", result);
        return result;
      } catch (e) {
        console.log("  [DYFASHION] Style error:", e.message);
        return null;
      }
    }

    return null;
  }

  async getProductStyleBogas(product) {
    console.log("getProductStyleBogas", product);
    const filteredData = extractRelevantFields(product);
    console.log("filteredData", filteredData);

    const PERSONAS = ["ELEGANT_CHIC", "ADVENTURE_LUXE", "ROMANTIC_SOFT", "URBAN_MINIMAL", "POWER_POLISHED"];
    const BODY_SHAPES = ["triangle", "inverted_triangle", "rectangle", "hourglass", "oval"];
    const SEASONS = ["winter", "summer", "autumn", "spring"];

    const messages = [
      { role: "system", content: "You are a fashion style classifier. Given product info, return a JSON style code with keys: body, personality, chromatic." },
      {
        role: "user",
        content: `
Product data:
${JSON.stringify(filteredData, null, 2)}

/* ---------- FULL RULES (learned from bogas.ro) ---------- */
• ELEGANT_CHIC
  – Satin, lace, chiffon, velvet or crepe fabrics
  – Jewel-tone or neutral evening palette (emerald, navy, burgundy, ivory)
  – Midi & column dresses, mermaid hems, cape sleeves
  – Formal sets (blazer + midi skirt) for weddings, galas, graduation
  – Accessories: pearl clutches, stilettos, crystal belts
• ADVENTURE_LUXE
  – Technical ski suits, overalls, padded jackets, metallic snow pants
  – Beach & resort neoprene swim, triangle bikinis, linen cover-ups
  – Bright primaries or icy metallics; performance zips, waterproof seams
  – Cross-sell: goggles, fur-trim hoods, sun visors
• ROMANTIC_SOFT
  – Ruffle, wrap, tiered or balloon-sleeve silhouettes
  – Pastel / floral prints, ditsy patterns, broderie anglaise
  – Day dresses, chiffon skirts, soft-knit cardigans
  – Accessories: silk scarves, straw hats, dainty belts
• URBAN_MINIMAL   (absorbs SPORTY_STREET)
  – Ribbed bodycon dresses, tank midi, cropped racer tanks, hoodie sets
  – Monochrome (black, white, beige, camel) or bold-stripe logo tracksuits
  – Straight denim, biker shorts, athleisure with stretch
  – Clean copy tone; comfort & 24-h wear emphasised
• POWER_POLISHED   (absorbs GLAM_DIVA)
  – Tailored blazer dresses, shoulder-padded suits, cigarette trousers
  – Club-ready vinyl or sequin minis that project confidence
  – Jewel or stark monochrome palette; waist-cinching belts, plunge necks
  – Split by occasion in copy ("Boardroom" vs "After-dark")

/* BODY SHAPE NOTES */
triangle           – shoulders narrower than hips; add volume up top
inverted_triangle  – broad shoulders; draw eye downward
rectangle          – little waist definition; add curves / structure
hourglass          – balanced bust & hips; emphasise waist
oval               – fuller midsection; elongate torso

/* CHROMATIC SEASONS */
winter  – cool undertone + high contrast: black, white, jewel, icy brights
summer  – cool undertone + soft contrast: dusty pastels, powdery blues
autumn  – warm undertone + muted depth: camel, rust, olive, mustard
spring  – warm undertone + clear brights: coral, peach, aqua, light gold

/* NEUTRAL COLORS */
Neutral colors (black, white, grey, beige, navy, cream) can work across multiple seasons:
- Set "is_neutral" to true if the product's dominant color is neutral
- Set "neutral_whitelist" to an array of seasons where this neutral color works well; for non-neutral items, set neutral_whitelist to []
- Provide "color_vec" as a 3-element array [L, a, b] representing the LAB color space values for the dominant color

Example:
  - Pure white: is_neutral=true, neutral_whitelist=["winter","summer","spring","autumn"], color_vec=[100, 0, 0]
  - Warm beige: is_neutral=true, neutral_whitelist=["autumn","spring"], color_vec=[80, 5, 20]
  - Cool grey: is_neutral=true, neutral_whitelist=["winter","summer"], color_vec=[60, 0, -5]
  - Coral dress: is_neutral=false, neutral_whitelist=[], color_vec=[70, 40, 30]`
      }
    ];

    if (product.image) {
      console.log("product.image", product.image);
      try {
        const bytes = await fetch(product.image).then(r => r.arrayBuffer());
        messages.push({
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" } }]
        });
      } catch (e) {
        console.warn("Could not fetch image for Bogas");
      }
    }

    const jsonSchema = {
      name: "product_style_classification",
      strict: true,
      schema: {
        type: "object",
        properties: {
          body: { type: "array", items: { type: "string", enum: BODY_SHAPES } },
          personality: { type: "array", items: { type: "string", enum: PERSONAS } },
          chromatic: { type: "array", items: { type: "string", enum: SEASONS } },
          is_neutral: { type: "boolean" },
          neutral_whitelist: { type: "array", items: { type: "string", enum: SEASONS } },
          color_vec: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }
        },
        required: ["body", "personality", "chromatic", "is_neutral", "neutral_whitelist", "color_vec"],
        additionalProperties: false
      }
    };

    const completion = await openaiService.client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1000,
      response_format: { type: "json_schema", json_schema: jsonSchema },
      messages
    });

    return JSON.parse(completion.choices[0].message.content);
  }

  async getProductStyleDyFashion(product) {
    console.log("getProductStyleDyFashion", product);
    const filteredData = extractRelevantFields(product);
    console.log("filteredData", filteredData);

    const PERSONAS = ["classic", "romantic", "creative"];
    const BODY_SHAPES = ["triangle", "inverted_triangle", "rectangle", "hourglass", "oval"];
    const SEASONS = ["winter", "spring", "summer", "autumn"];

    const messages = [
      { role: "system", content: "You are a fashion style classifier. Given product info, return a JSON style code with keys: body, personality, chromatic." },
      {
        role: "user",
        content: `
Product data:
${JSON.stringify(filteredData, null, 2)}

Analyze the product for recommended silhouette, personality, and color palette.

## Body Shapes
- "triangle": shoulders narrower than hips
- "inverted_triangle": broad shoulders
- "rectangle": little waist definition
- "hourglass": balanced bust & hips
- "oval": fuller midsection

## Personality Types
- "classic": timeless, elegant, structured pieces
- "romantic": soft, feminine, flowing silhouettes
- "creative": bold, artistic, unique designs

## Chromatic Seasons
- "winter": cool undertone, high contrast (black, white, jewel tones)
- "summer": cool undertone, soft contrast (dusty pastels, powdery blues)
- "autumn": warm undertone, muted depth (camel, rust, olive, mustard)
- "spring": warm undertone, clear brights (coral, peach, aqua)

Make sure the response is valid JSON, with no additional text or formatting beyond the JSON object itself.
Include at least one value for "body", "personality", and "chromatic" in every response. 

##Neutral Colors Handling

Neutral colors (black, white, grey, beige, navy, cream, tan) can work across multiple seasons:
- Set "is_neutral" to true if the product's dominant color is neutral (not seasonal colors like coral, emerald, mustard, etc.)
- Set "neutral_whitelist" to an array of seasons where this neutral color works well
- Provide "color_vec" as a 3-element array [L, a, b] representing the LAB color space values for the dominant color
  (L = lightness 0-100, a = green-red axis -128 to 127, b = blue-yellow axis -128 to 127)

Example responses:
  - Pure white product: is_neutral=true, neutral_whitelist=["winter","summer","spring","autumn"], color_vec=[100, 0, 0]
  - Warm beige product: is_neutral=true, neutral_whitelist=["autumn","spring"], color_vec=[80, 5, 20]
  - Cool grey product: is_neutral=true, neutral_whitelist=["winter","summer"], color_vec=[60, 0, -5]
  - Black product: is_neutral=true, neutral_whitelist=["winter","autumn"], color_vec=[0, 0, 0]
  - Navy product: is_neutral=true, neutral_whitelist=["winter","summer","autumn"], color_vec=[25, 10, -30]
  - Coral dress: is_neutral=false (seasonal color - spring), no neutral_whitelist, color_vec=[70, 40, 30]`
      }
    ];

    if (product.image) {
      try {
        const bytes = await fetch(product.image).then(r => r.arrayBuffer());
        messages.push({
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" } }]
        });
      } catch (e) {
        console.warn("Could not fetch image for DyFashion");
      }
    }

    const jsonSchema = {
      name: "product_style_classification_dyfashion",
      strict: true,
      schema: {
        type: "object",
        properties: {
          body: { type: "array", items: { type: "string", enum: BODY_SHAPES } },
          personality: { type: "array", items: { type: "string", enum: PERSONAS } },
          chromatic: { type: "array", items: { type: "string", enum: SEASONS } },
          is_neutral: { type: "boolean" },
          neutral_whitelist: { type: "array", items: { type: "string", enum: SEASONS } },
          color_vec: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }
        },
        required: ["body", "personality", "chromatic", "is_neutral", "neutral_whitelist", "color_vec"],
        additionalProperties: false
      }
    };

    const completion = await openaiService.client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1000,
      response_format: { type: "json_schema", json_schema: jsonSchema },
      messages
    });

    return JSON.parse(completion.choices[0].message.content);
  }

  // Override to handle Bogas HTML->Markdown and DyFashion S3 uploads
  async processProducts(products, defaultCategories, shopData) {
    // First do standard processing
    const processedProducts = await super.processProducts(products, defaultCategories, shopData);

    // Then do shop-specific post-processing
    for (const product of processedProducts) {
      // Bogas: Convert HTML to Markdown
      if (this.shopName === "bogas-com-international.myshopify.com") {
        console.log("  [BOGAS] Converting HTML to Markdown");
        product.body_html = convertHtmlToMarkdown(product.descriptionHtml || product.body_html);
      }

      // DyFashion: Upload images to S3
      if (this.shopName === "dyfashion.avanticart.ro" && product.images && product.images.length > 0) {
        console.log(`  [DYFASHION] Uploading ${product.images.length} images to S3...`);
        const imageUrls = product.images.map(img => typeof img === 'string' ? img : img.src);
        const uploadedUrls = await s3Service.uploadMultipleImages(imageUrls);
        product.images = uploadedUrls.map(url => ({ src: url }));
        if (uploadedUrls.length > 0) {
          product.image = uploadedUrls[0];
        }
      }
    }

    return processedProducts;
  }
}

export default ShopifyProvider;
