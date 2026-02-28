#!/usr/bin/env node

/**
 * EXACT COPY of Shopify Product Sync from:
 * /Users/adrian/Mobile/runa_server/crawler/__processShopLocalRaicu.js
 * /Users/adrian/Mobile/runa_server/crawler/__processShop.js
 * /Users/adrian/Mobile/runa_server/crawler/saveProductsGraph.js
 * /Users/adrian/Mobile/runa_server/crawler/__createProducts_v1.js
 * 
 * Includes ALL shop-specific features:
 * - Bogas: getProductStyleBogas with image analysis
 * - DyFashion: getProductStyleDyFashion + S3 image upload
 * - Andreea Raicu: English translations from Amalin.com
 * 
 * Usage:
 *   node apps/api/src/scripts/sync-shopify-exact.js <shop-domain> <access-token>
 */

import dotenv from "dotenv";
dotenv.config();

import { GraphQLClient, gql } from "graphql-request";
import { stripHtml } from "string-strip-html";
import neo4j from "neo4j-driver";
import Pubnub from "pubnub";
import OpenAI from "openai";
import AWS from "aws-sdk";
import fetch from "node-fetch";
import Shopify from "shopify-api-node";
import { v4 as uuidv4 } from "uuid";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { JSDOM } from "jsdom";

// ==================== EXACT CONFIGURATION FROM ORIGINAL ====================

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const pubnub = new Pubnub({
  publishKey: process.env.PUBNUB_PUBLISH_KEY,
  subscribeKey: process.env.PUBNUB_SUBSCRIBE_KEY,
  uuid: "main",
  autoNetworkDetection: true,
  restore: true
});

AWS.config.update({ region: process.env.AWS_REGION || "us-east-1" });
const dynamodb = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});
const S3_BUCKET = 'traveline-images';
const S3_KEY_PREFIX = 'uploads/';

// Embedding cache
let generatedEmbeddings = [];

// ==================== SHOPIFY CATEGORIES ====================

// EXACT from __shopifyCategories.js
const shopifyCategories = [
  "After Shave Lotions", "Anklets", "Backpacks", "Bags", "Bath Salts", "Beanies",
  "Beauty Tools", "Bikini Bottoms", "Bikini Tops", "Bikinis", "Blazers", "Blouses",
  "Blushers", "Bodies", "Body Olls", "Body Tapes", "Body Treatments", "Bracelets",
  "Bralets", "Bras", "Briefs", "Bum Bags", "Camis", "Candles", "Caps", "Cardigans",
  "Cleansers", "Co-ords", "Coats", "Colour Correctors", "Concealers", "Conditioners",
  "Corset Tops", "Corsets", "Cover Ups", "Crop Tops", "Dresses", "Dressing Gowns",
  "Dungarees", "Earrings", "Eye Creams", "Eye Masks", "Eye Primers", "Eye Serums",
  "Eye Shadow Palettes", "Eye Shadows", "Eyebrow Gels", "Face + Body Sets", "Face Masks",
  "Facial Exfoliators", "Facial Moisturisers", "Facial Oils", "Facial Serums", "False Nails",
  "Fleeces", "Gilets", "Gloves", "Hair Accessories", "Hair Bands", "Hair Brushes",
  "Hair Clips", "Hair Creams", "Hair Grips", "Hair Masks", "Hair Serums", "Hair Sets",
  "Hair Straighteners", "Hair Treatments", "Hairbands", "Harnesses", "Hats", "Headbands",
  "Highlighters", "Hoodies", "Jackets", "Jeans", "Jeggings", "Joggers", "Jumpers",
  "Jumpsuits", "Leggings", "Lingerie Bodies", "Lingerie Bralets", "Lingerie Sets",
  "Lip Balms", "Lip Liners", "Lipsticks", "Loungewear Sets", "Makeup Bags",
  "Makeup Brush Sets", "Makeup Brushes", "Makeup Sets", "Mascaras", "Micellar Water",
  "Nail Polishes", "Nail Treatments", "Necklaces", "Nighties", "Nightwear Sets",
  "Palettes", "Pencil Sharpeners", "Piercings", "Playsuits", "Polo Shirts", "Powders",
  "Primers", "Pyjama Bottoms", "Pyjama Tops", "Pyjamas", "Rings", "Robes", "Sandals",
  "Self Tan", "Setting Sprays", "Shampoos", "Shapewear", "Shirts", "Shoes", "Shorts",
  "Ski Pants", "Ski Suits", "Skincare Sets", "Skirts", "Sleep Aids", "Sleep Masks",
  "Slippers", "Slips", "Socks", "Sponges", "Sports Bras", "Sun Care", "Sunglasses",
  "Sunglasses Accessories", "Sweatshirts", "Swimsuits", "T-shirts", "Tank Tops",
  "Thongs", "Tights", "Toe Rings", "Trainers", "Trousers", "Tweezers", "Unitards",
  "Vests", "Wash Bags", "Watches", "Water Bottles", "Sets", "Gift Cards", "Fragrances",
  "Textile Fragrances"
];

// ==================== GRAPHQL QUERY ====================

const GET_PRODUCTS_QUERY_PUBLISHED_STATUS = gql`
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "published_status:published") {
      edges {
        node {
          id
          title
          description
          descriptionHtml
          vendor
          productType
          createdAt
          updatedAt
          publishedAt
          handle
          templateSuffix
          tags
          status
          totalInventory
          metafields(first: 10) {
            edges {
              node {
                id
                namespace
                key
                value
                type
              }
            }
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                price
                sku
                position
                inventoryQuantity
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          options {
            id
            name
            position
            values
          }
          collections(first: 100) {
            edges {
              node {
                id
                title
              }
            }
          }
          images(first: 100) {
            edges {
              node {
                id
                altText
                src
                width
                height
              }
            }
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

// ==================== HELPER FUNCTIONS ====================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// HTML to Markdown conversion (for Bogas)
function convertHtmlToMarkdown(html) {
  if (!html) return '';
  try {
    const dom = new JSDOM(`<body>${html}</body>`);
    const { document } = dom.window;
    const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
    td.use(gfm);
    return td.turndown(document.body.innerHTML).trim();
  } catch (e) {
    return stripHtml(html).result || '';
  }
}

// Extract relevant fields for style classification
function extractRelevantFields(product) {
  const title = product.title || "";
  const description = product.body_html || "";
  const tags = (product.tags || "").split(",").map(tag => tag.trim());
  const properties = product.properties || {};

  let sizes = [];
  let colors = [];
  if (Array.isArray(product.variants)) {
    product.variants.forEach(variant => {
      if (variant.sizeValue) sizes.push(variant.sizeValue);
      if (variant.colorValue) colors.push(variant.colorValue);
    });
    sizes = [...new Set(sizes)];
    colors = [...new Set(colors)];
  }

  return { title, description, tags, properties, sizes, colors };
}

// S3 upload for DyFashion
async function uploadImageToS3(imageUrl) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return null;

    const buffer = await response.buffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const urlParts = imageUrl.split('.');
    const extension = urlParts[urlParts.length - 1].split('?')[0] || 'jpg';
    const s3Key = `${S3_KEY_PREFIX}${uuidv4()}.${extension}`;

    const uploadParams = {
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: contentType,
      ACL: 'public-read'
    };

    const uploadResult = await s3.upload(uploadParams).promise();
    console.log(`Image uploaded: ${uploadResult.Location}`);
    return uploadResult.Location;
  } catch (error) {
    console.error(`Error uploading image to S3:`, error.message);
    return null;
  }
}

// ==================== DYNAMODB FUNCTIONS ====================

async function getUserByShop(shop, region = "us-east-1") {
  const params = {
    TableName: "UserTable",
    IndexName: "shop_index",
    KeyConditionExpression: "#shop = :shop",
    ExpressionAttributeNames: { "#shop": "shop" },
    ExpressionAttributeValues: { ":shop": shop }
  };
  const result = await dynamodb.query(params).promise();
  return result.Count > 0 ? result.Items[0] : null;
}

async function saveUser(user, region = "us-east-1") {
  const params = { TableName: "UserTable", Item: user };
  return dynamodb.put(params).promise();
}

const updateUser = async (shop, syncInProgress, processed, total, region) => {
  let syncProgress = parseInt(100 * (processed / total));
  let user = await getUserByShop(shop, region);
  user.syncInProgress = syncInProgress;
  user.syncProgress = syncProgress;
  console.log("updating user", user.shop);
  await saveUser(user, region);
};

// ==================== EMBEDDING FUNCTION ====================

async function generateEmbedding(inputText) {
  if (!inputText) return null;
  const url = "https://api.openai.com/v1/embeddings";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: inputText })
    });
    const data = await response.json();
    return data?.data?.[0]?.embedding || null;
  } catch (e) {
    console.log("error generateEmbedding", e.message);
    return null;
  }
}

// ==================== getProductProperties ====================

const getProductProperties = async (aggregatedContent, defaultCategories, maxRetries = 2) => {
  let retries = 0;
  let websiteCategories = defaultCategories || shopifyCategories;

  const requestSummary = async () => {
    const messages = [
      {
        role: "system",
        content: `
              Extract from the prompt provided the following information and return a JSON of this type:
              {
              "product": "Item detailed type, for example 'high waist pants', 'maxi dress', 'slim fit jeans'",
              "characteristics": "if present, item characteristics, for example, 'cotton', 'low rise'",
              "color": "if present, the color of the item",
              "material": "if present, the material of the item",
              "brand": "if present, the brand of the item",
              "demographic": "target demographic group for the product: 'woman', 'man'",
              "category": "A category from this list: ${websiteCategories.join(", ")}."
              }

              Important: "product", "characteristics", "color", "demographic" and "category" are mandatory

              Examples of "product" and "characteristics":
              product – High rise wide leg jeans, Washed low rise flare jeans, Cargo jeans, Slouchy full-length jeans
              characteristics – cotton, decorative belt, embellishments, front pockets, relaxed, raw hem, cuff details

              Respond in the same language as the prompt except for the category which must be from the provided list.       
         `
      },
      { role: "user", content: aggregatedContent }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.7,
        max_tokens: 4096,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "product_properties_extraction",
            strict: false,
            schema: {
              type: "object",
              properties: {
                product: { type: "string" },
                characteristics: { type: "string" },
                color: { type: "string" },
                material: { type: "string" },
                brand: { type: "string" },
                demographic: { type: "string", enum: ["woman", "man"] },
                category: { type: "string" }
              },
              required: ["product", "characteristics", "color", "demographic", "category"],
              additionalProperties: false
            }
          }
        }
      });
      return response.choices[0].message.content;
    } catch (error) {
      if (retries < maxRetries) { retries++; return requestSummary(); }
      throw error;
    }
  };
  return requestSummary();
};

// ==================== STYLE CLASSIFIERS ====================

// BOGAS style classifier (EXACT from original)
async function getProductStyleBogas(product) {
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
  (L = lightness 0-100, a = green-red axis -128 to 127, b = blue-yellow axis -128 to 127)

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
    } catch (e) { console.warn("Could not fetch image for Bogas"); }
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

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 1000,
    response_format: { type: "json_schema", json_schema: jsonSchema },
    messages
  });

  return JSON.parse(completion.choices[0].message.content);
}

// DYFASHION style classifier (EXACT from original)
async function getProductStyleDyFashion(product) {
  console.log("getProductStyleDyFashion", product);
  const filteredData = extractRelevantFields(product);
  console.log("filteredData", filteredData);

  const PERSONAS = ["classic", "romantic", "creative"];
  const BODY_SHAPES = ["triangle", "inverted_triangle", "rectangle", "hourglass", "oval"];
  const SEASONS = ["winter", "spring", "summer", "autumn"];

  const messages = [
    { role: "system", content: `You are a fashion‑style classifier for DyFashion.\nAlways analyse BOTH the textual metadata and, when provided, the product IMAGE.\nUse visual evidence (dominant colours, fabric texture/shine, silhouette) to refine palette and personality.\nReturn only JSON with keys: body, personality, chromatic.` },
    {
      role: "user",
      content: `
You will have as input a product. 
Analyze it for recommended silhouette, personality, and color palette.
         
These are the exact possible values:
              body:
              - triangle
              - inverted_triangle
              - rectangle
              - hourglass
              - oval

              personality:
              - classic
              - romantic
              - creative

              chromatic:
              - winter
              - summer
              - autumn
              - spring


Follow the next rules when classifying products

##Chromatic rules

chromatic: spring
Spring Color Palette
✔ Must-Have Colors for Spring:
Warm, clear, and bright shades with yellow undertones
Blues: Sky Blue, Turquoise, Aqua
Pinks & Corals: Peach, Apricot, Warm Coral, Geranium Pink
Greens: Fresh Lime, Light Olive, Warm Jade, Leaf Green
Yellows: Golden Yellow, Daffodil, Buttercup
Neutrals: Warm Ivory, Cream, Camel, Light Honey
✖ Colors to Exclude:
Cool & Muted Shades: Dusty Blue, Slate, Mauve, Lavender
Dark & Heavy Tones: Deep Burgundy, Charcoal, Black
Cool Greens & Blues: Teal, Forest Green, Icy Blue
Muted & Earthy Tones: Rust, Terracotta, Deep Mustard

chromatic: autumn
Autumn Color Palette
✔ Must-Have Colors for Autumn:
Warm, rich, and earthy shades with golden undertones
Oranges & Reds: Rust, Copper, Brick Red, Warm Terracotta
Greens: Olive, Moss, Forest Green, Warm Teal
Browns & Yellows: Mustard, Goldenrod, Caramel, Cinnamon
Neutrals: Warm Beige, Camel, Chocolate Brown, Cream
✖ Colors to Exclude:
Cool & Icy Shades: Pastel Blue, Periwinkle, Icy Lilac
Bright & Clear Tones: Hot Pink, Neon Green, Pure White
Cool Neutrals: Charcoal, Cool Gray, Black
Blue-Undertoned Colors: Magenta, Fuchsia, Blue-Red

chromatic: winter
Winter Color Palette
✔ Must-Have Colors for Winter:
Cool, deep, and high-contrast shades with blue undertones
Blues: Royal Blue, Navy, Sapphire, Icy Blue
Reds & Pinks: True Red, Cranberry, Fuchsia, Cool Burgundy
Greens: Emerald, Teal, Pine Green
Neutrals: Pure White, Jet Black, Charcoal, Cool Gray
✖ Colors to Exclude:
Warm & Earthy Shades: Rust, Mustard, Terracotta, Warm Olive
Muted & Soft Tones: Dusty Rose, Peach, Beige, Pastel Yellow
Golden & Warm Neutrals: Camel, Warm Taupe, Chocolate Brown
Bright Warm Shades: Coral, Apricot, Tomato Red

chromatic: summer
Summer Color Palette
✔ Must-Have Colors for Summer:
Cool, soft, and muted shades with blue undertones
Blues: Powder Blue, Slate Blue, Periwinkle, Denim
Pinks & Mauves: Blush Pink, Dusty Rose, Soft Raspberry, Cool Fuchsia
Greens: Seafoam, Silver Green, Eucalyptus, Cool Mint
Purples: Lilac, Smoky Plum, Wisteria, Amethyst
Neutrals: Dove Gray, Cool Taupe, Pearl White, Soft Ivory
✖ Colors to Exclude:
Warm & Earthy Shades: Rust, Camel, Terracotta, Warm Olive
Bright & Strong Colors: Tomato Red, Neon Yellow, Bright Orange, Royal blue
Golden & Warm Neutrals: Caramel, Honey, Sand
Muted Warm Shades: Mustard, Apricot, Warm Beige
Dark & heavy tones: Black


##Personality rules

### personality: romantic

**Romantic Style Personality (soft, feminine, graceful)**
**✔ Must-Have Attributes:**

* **Fabrics:** lace/dantelă, chiffon/voal, tulle, soft satin (lurex/sparkle optional).
* **Details:** ruffles/volane, bows/fundă, floral prints & 3D/appliqué flowers, delicate transparencies, softly gathered waists.
* **Silhouettes:** fit-and-flare/în cloș, A-line midi, wrap/petrecută, empire waist, off-shoulder, peasant/balloon sleeves.
* **Preferred categories:** rochii de seară & rochii elegante; bluze elegante; fuste midi vaporoase; clutch + sandale/pumps.
* **Occasions:** wedding guest, garden parties, date nights, cocktail.
  **✖ Exclude:** rigid tailoring, utility/tech details, harsh neon contrasts, heavy platforms, aggressive cut-outs.

---

### personality: classic

**Classic Style Personality (polished, structured, minimal)**
**✔ Must-Have Attributes:**

* **Fabrics:** poplin, cotton twill, viscose/crepe suiting, tweed for blazers/vests.
* **Details:** structured collars, neat plackets & buttons, tie-neck blouses, minimal hardware; clean darts and seams.
* **Silhouettes:** sheath/shift, pencil midi, straight or tapered trousers, single-breasted/cambrat blazers, tailored vests.
* **Preferred categories:** cămăși damă, bluze/topuri pentru birou, rochii office/elegante cu linii curate, pantaloni office, sacouri & compleuri.
* **Footwear & accessories:** classic pumps/slingbacks, loafers, structured tote/top-handle, slim belts.
* **Occasions:** office, business meetings, interviews, smart events.
  **✖ Exclude:** paiete/strass ca piesă centrală, fante adânci, denim deteriorat, imprimeuri stridente/neon, umeri exagerați, adidași chunky casual.

---

### personality: creative

**Creative Style Personality (boho/fashionista/dramatic)**
**✔ Must-Have Attributes:**

* **Fabrics & textures:** silk/satin (inclusiv satin duchesse), organza, chiffon, heavy crepe, tulle, jacquard, brocade, velvet, crochet/dantelă croșetată, cotton gauze/linen, metallic/lamé, coated finishes.
* **Details:** asymmetry, sculptural draping, statement bows, 3D florals, ladder lace, ruffles/volane, tassels/franjuri, architectural pleats, feathers, tasteful corsetry, bold/metal belts, cape/capelet, trenă opțională.
* **Silhouettes:** blazer-dress, column & mermaid/sirenă, one-shoulder, high-low (slit controlat), dramatic A-line, peplum, wide-leg palazzo, coordinated sets/co-ords, wrap/maxi dresses, tiered skirts, peasant/balloon-sleeve tops, mini + longline blazer combos, slip/column cu overlay sheer.
* **Prints & motifs:** large-scale florals, paisley, etnic/geom, abstract brushstrokes, bold placements.
* **Accessories & footwear:** statement earrings/cuffs, rigid/geometric clutches, mini/top-handle & micro bags, straw/soft bags (day-boho); stilettos, pointed/strappy sandals, elegant mules, slingbacks, platforms, espadrilles, ankle boots (transitional).
* **Preferred categories:** rochii de seară & rochii elegante (paiete, tulle, funde, satin), bluze elegante, fuste midi/lungi, salopete, sacouri statement, seturi/co-ords.
* **Occasions:** evening events, cocktail, city nights, party/gala.
  **✖ Exclude:** piese sport/utilitare ca element central, look-uri prea corporatiste, tricouri basic subțiri ca piesă-cheie, printuri haotice sau culori în afara sezonului cromatic, decupaje agresive.


If the body, personality or chromatic is in the product data (styleProfileDefault from metafields) return the data that is present in the product data (styleProfileDefault)

Specifically, return a JSON object with the following keys:
          {
            "body": ["triangle", "hourglass", ...],       // silhouettes that match
            "personality": ["romantic", "classic", ...],  // personality traits
            "chromatic": ["winter", "summer", ...],       // color palettes or seasons
            "is_neutral": true/false,                     // true if dominant color is neutral (black, white, grey, beige, navy, cream, tan)
            "neutral_whitelist": ["winter", "summer", ...], // color palettes or seasons where this neutral works well; for non-neutral items, set neutral_whitelist to []
            "color_vec": [L, a, b]                        // 3-element LAB color space array for dominant color
          }
    
Product data:
${JSON.stringify(filteredData, null, 2)}
    
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
  - Coral dress: is_neutral=false (seasonal color - spring), no neutral_whitelist, color_vec=[70, 40, 30]
`
    }
  ];

  if (product.image) {
    try {
      const bytes = await fetch(product.image).then(r => r.arrayBuffer());
      messages.push({
        role: "user",
        content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`, detail: "low" } }]
      });
    } catch (e) { console.warn("Could not fetch image for DyFashion"); }
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

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 1000,
    response_format: { type: "json_schema", json_schema: jsonSchema },
    messages
  });

  return JSON.parse(completion.choices[0].message.content);
}

// ==================== NEO4J FUNCTIONS ====================

async function createApplicationAndStore(storeData, appData) {
  const { id: storeId, storeName } = storeData;
  const { id: appId, appName } = appData;
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  const tx = session.beginTransaction();

  try {
    await tx.run(`MERGE (app:Application {id: $appId}) ON CREATE SET app.name = $appName ON MATCH SET app.name = $appName`, { appId, appName });
    await tx.run(`MERGE (store:Store {id: $storeId}) ON CREATE SET store.name = $storeName ON MATCH SET store.name = $storeName WITH store MATCH (app:Application {id: $appId}) MERGE (app)-[:HAS_STORE]->(store)`, { storeId, storeName, appId });
    await tx.commit();
  } catch (e) { await tx.rollback(); console.log(e); }
  finally { await session.close(); await driver.close(); }
}

async function createOrUpdateCategories(categories) {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  const tx = session.beginTransaction();
  try {
    await Promise.all(categories.map(c => tx.run(`MERGE (c:Category {name: toLower($title)}) ON CREATE SET c.name = toLower($title)`, { title: c.title })));
    await tx.commit();
  } catch (e) { await tx.rollback(); console.error(e); }
  finally { await session.close(); await driver.close(); }
}

async function createOrUpdateProductWithVariantsAndStoreApplication(productsData, storeData, appData, demographicsData) {
  console.log("saving products", productsData.length);
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  const tx = session.beginTransaction();

  try {
    let newProducts = [];
    for (const p of productsData) {
      let images = p.images ? p.images.map(img => typeof img === 'string' ? img : img.src) : [];
      let styleData = p.styleData;
      let styleBody = null, stylePersonality = null, styleChromatic = null, is_neutral = null, neutral_whitelist = null, color_vec = null;

      if (styleData) {
        let obj = typeof styleData === 'string' ? JSON.parse(styleData) : styleData;
        if (obj) { styleBody = obj.body; stylePersonality = obj.personality; styleChromatic = obj.chromatic; is_neutral = obj.is_neutral; neutral_whitelist = obj.neutral_whitelist; color_vec = obj.color_vec; }
      }

      // BOGAS: Convert HTML to Markdown for description (EXACT from original)
      let description = p.body_html || "";
      if (storeData.id === "bogas-com-international.myshopify.com") {
        console.log("  [BOGAS] Converting HTML to Markdown");
        description = convertHtmlToMarkdown(p.descriptionHtml || p.body_html);
      }
      // Append tags to description
      if (p.tags && p.tags.trim() !== "") {
        description = description ? `${description}\n\nTags: ${p.tags}` : `Tags: ${p.tags}`;
      }

      // DYFASHION: Upload images to S3 (EXACT from original)
      if (storeData.id === "dyfashion.avanticart.ro") {
        console.log(`  [DYFASHION] Uploading ${images.length} images to S3...`);
        images = await Promise.all(images.map(async (image) => {
          const s3Url = await uploadImageToS3(image.replace("-4.webp", "-2.webp"));
          return s3Url;
        }));
        images = images.filter(img => img !== null);
      }

      newProducts.push({
        productId: p.id.toString(), storeId: storeData.id, title: p.title, titleEmbedding: p.titleEmbedding || [],
        description, vendor: p.vendor, category: p.category,
        handle: p.handle, status: p.status, variants: p.variants || [], options: p.options, properties: p.properties,
        content: p.content, product: p.product, characteristics: p.characteristics,
        styleCode: p.styleCode || "none", styleData: typeof styleData === 'object' ? JSON.stringify(styleData) : styleData,
        contentEmbedding: p.contentEmbedding || [], productEmbedding: p.productEmbedding || [],
        characteristicsEmbedding: p.characteristicsEmbedding || [], categoryEmbedding: p.categoryEmbedding || [],
        styleCodeEmbedding: p.styleCodeEmbedding || [], image: p.image, images, demographics: demographicsData,
        currency: p.currency, collections: p.collections || [], tags: p.tags || "",
        styleBody, stylePersonality, styleChromatic, is_neutral, neutral_whitelist, color_vec,
        searchAttributesText: p.searchAttributesText || "", searchAttributesEmbedding: p.searchAttributesEmbedding || [],
        en_title: p.en_title || null, en_price: p.en_price || null, en_price_currency: p.en_price_currency || null,
        en_url: p.en_url || null, en_product_type: p.en_product_type || null, en_description: p.en_description || null, en_json: p.en_json || null
      });
    }

    const nowIso = new Date().toISOString();
    await tx.run(`
      UNWIND $newProducts AS product
      MERGE (p:Product {id: product.productId})
      ON CREATE SET p += { id: product.productId, title: product.title, titleEmbedding: product.titleEmbedding, description: product.description,
        content: product.content, product: product.product, characteristics: product.characteristics, styleCode: product.styleCode, styleData: product.styleData,
        styleBody: product.styleBody, stylePersonality: product.stylePersonality, styleChromatic: product.styleChromatic,
        is_neutral: product.is_neutral, neutral_whitelist: product.neutral_whitelist, color_vec: product.color_vec,
        image: product.image, images: product.images, vendor: product.vendor, currency: product.currency, category: product.category,
        handle: product.handle, status: product.status, storeId: product.storeId, contentEmbedding: product.contentEmbedding,
        productEmbedding: product.productEmbedding, characteristicsEmbedding: product.characteristicsEmbedding,
        categoryEmbedding: product.categoryEmbedding, styleCodeEmbedding: product.styleCodeEmbedding,
        searchAttributesText: product.searchAttributesText, searchAttributesEmbedding: product.searchAttributesEmbedding, updated_at: $nowIso,
        color: CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorValue ELSE null END,
        colorEmbedding: CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorEmbedding ELSE [] END,
        en_title: product.en_title, en_price: product.en_price, en_price_currency: product.en_price_currency,
        en_url: product.en_url, en_product_type: product.en_product_type, en_description: product.en_description, en_json: product.en_json }
      ON MATCH SET p += { id: product.productId, title: product.title, titleEmbedding: product.titleEmbedding, description: product.description,
        content: product.content, product: product.product, characteristics: product.characteristics, styleCode: product.styleCode, styleData: product.styleData,
        styleBody: product.styleBody, stylePersonality: product.stylePersonality, styleChromatic: product.styleChromatic,
        is_neutral: product.is_neutral, neutral_whitelist: product.neutral_whitelist, color_vec: product.color_vec,
        image: product.image, images: product.images, vendor: product.vendor, currency: product.currency, category: product.category,
        handle: product.handle, status: product.status, storeId: product.storeId, contentEmbedding: product.contentEmbedding,
        productEmbedding: product.productEmbedding, characteristicsEmbedding: product.characteristicsEmbedding,
        categoryEmbedding: product.categoryEmbedding, styleCodeEmbedding: product.styleCodeEmbedding,
        searchAttributesText: product.searchAttributesText, searchAttributesEmbedding: product.searchAttributesEmbedding, updated_at: $nowIso,
        color: CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorValue ELSE null END,
        colorEmbedding: CASE WHEN size(product.variants) > 0 THEN product.variants[0].colorEmbedding ELSE [] END,
        en_title: product.en_title, en_price: product.en_price, en_price_currency: product.en_price_currency,
        en_url: product.en_url, en_product_type: product.en_product_type, en_description: product.en_description, en_json: product.en_json }
      WITH p, product
      UNWIND product.variants AS variant
      MERGE (v:Variant {id: variant.id})
      ON CREATE SET v += { id: variant.id, title: variant.title, price: variant.price, price_old: variant.compare_at_price,
        size: variant.sizeValue, color: variant.colorValue, sizeEmbedding: variant.sizeEmbedding, colorEmbedding: variant.colorEmbedding, inventoryQuantity: variant.inventory_quantity }
      ON MATCH SET v += { id: variant.id, title: variant.title, price: variant.price, price_old: variant.compare_at_price,
        size: variant.sizeValue, color: variant.colorValue, sizeEmbedding: variant.sizeEmbedding, colorEmbedding: variant.colorEmbedding, inventoryQuantity: variant.inventory_quantity }
      MERGE (p)-[:HAS_VARIANT]->(v)
      WITH p, product
      UNWIND product.collections AS collection
      MERGE (c:Category {name: toLower(collection.title)})
      MERGE (p)-[:HAS_CATEGORY]->(c)
      WITH p, product
      UNWIND split(product.tags, ",") AS tag WITH p, product, trim(tag) AS tag WHERE tag <> ""
      MERGE (c:Category {name: toLower(tag)}) MERGE (p)-[:HAS_CATEGORY]->(c)
      WITH p, product
      UNWIND product.demographics AS demographic MERGE (d:Demographic {name: demographic}) MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)
      WITH p, product.storeId AS storeId MATCH (store:Store {id: storeId}) MERGE (store)-[:HAS_PRODUCT]->(p)
    `, { newProducts, nowIso });
    await tx.commit();
    console.log("Batch of products created or updated successfully");
  } catch (error) { 
    console.log("roll back!");
    console.log("products not saved ", productsData.length);
    await tx.rollback(); 
    console.error("Transaction rolled back due to error:", error); 
  }
  finally { await session.close(); await driver.close(); }
}

async function retryOnDeadlock(operation, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (error.code === 'Neo.TransientError.Transaction.DeadlockDetected' && attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 500 + Math.floor(Math.random() * 300);
        console.log(`Deadlock detected, retrying in ${backoffMs}ms (attempt ${attempt}/${maxRetries})`);
        await delay(backoffMs);
        continue;
      }
      throw error;
    }
  }
}

async function distributeProducts(productsData, storeData, appData, demographicsData) {
  // Keep concurrency low to avoid Neo4j deadlocks on shared nodes (store/app)
  const numConcurrentTransactions = 2;
  const chunkSize = Math.ceil(productsData.length / numConcurrentTransactions);
  const preparedProducts = productsData;
  const productChunks = [];
  for (let i = 0; i < preparedProducts.length; i += chunkSize) {
    productChunks.push(preparedProducts.slice(i, i + chunkSize));
  }
  // Process chunks with limited parallelism (2 at a time)
  for (let i = 0; i < productChunks.length; i += numConcurrentTransactions) {
    const batch = productChunks.slice(i, i + numConcurrentTransactions);
    await Promise.all(batch.map(chunk => retryOnDeadlock(() => createOrUpdateProductWithVariantsAndStoreApplication(chunk, storeData, appData, demographicsData))));
    // small jitter between waves to reduce lock contention
    await delay(200 + Math.floor(Math.random() * 200));
  }
  console.log("All products processed with controlled concurrency");
}

// ==================== TRANSFORM ====================

function transformGraphQLToRestAPIArray(graphQLResponse) {
  return graphQLResponse.products.edges.map(edge => {
    const n = edge.node;
    const primaryImage = n.images.edges.length > 0 ? n.images.edges[0].node : null;
    return {
      id: parseInt(n.id.split("/").pop()),
      title: n.title, body_html: n.description, descriptionHtml: n.descriptionHtml, vendor: n.vendor,
      product_type: n.productType, handle: n.handle, published_at: n.publishedAt ? new Date(n.publishedAt).toISOString() : null,
      tags: n.tags.join(", "), status: n.status.toLowerCase(),
      variants: n.variants.edges.map(ve => {
        const v = ve.node;
        return { id: parseInt(v.id.split("/").pop()), title: v.title, price: v.price, sku: v.sku, position: v.position,
          option1: v.selectedOptions[0]?.value || null, option2: v.selectedOptions[1]?.value || null, option3: v.selectedOptions[2]?.value || null,
          inventory_quantity: v.inventoryQuantity };
      }),
      options: n.options.map(o => ({ id: parseInt(o.id.split("/").pop()), name: o.name, position: o.position, values: o.values })),
      images: n.images.edges.map(ie => ({ id: parseInt(ie.node.id.split("/").pop()), src: ie.node.src, alt: ie.node.altText })),
      image: primaryImage ? { id: parseInt(primaryImage.id.split("/").pop()), src: primaryImage.src, alt: primaryImage.altText } : null,
      collections: n.collections.edges.map(ce => ({ id: parseInt(ce.node.id.split("/").pop()), title: ce.node.title }))
    };
  });
}

async function getShopData(shopDomain, accessToken) {
  try {
    const response = await fetch(`https://${shopDomain}/admin/api/2023-07/shop.json`, {
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken }
    });
    const data = await response.json();
    return response.ok ? data.shop : { currency: "USD" };
  } catch (e) { return { currency: "USD" }; }
}

// ==================== processProducts ====================

async function processProducts(products, defaultCategories, shopName) {
  let user = await getUserByShop(shopName, "us-east-1");
  let shopData;
  if (shopName.includes("dyfashion")) {
    shopData = { currency: "RON" };
  } else {
    try { shopData = await getShopData(shopName, user?.accessToken); } catch (e) { shopData = { currency: "USD" }; }
  }
  console.log("shopData", shopData);

  const processedProducts = await Promise.all(products.map(async productItem => {
    console.log("productItem - ", productItem.id, " -- ", productItem.product_type, " -- ", productItem.title, productItem);
    console.log("productItem initial", productItem);

    let collections = productItem.collections || [];
    let categoriesCollections = collections.map(collection => collection.title);
    let collectionsContent = categoriesCollections.join(",");

    productItem.body_html = `${productItem.body_html}`;
    let productContent = `${productItem.title} ${productItem.body_html}`;

    // Generate enhanced search attributes from product info and image
    console.log("Generating enhanced search attributes...");
    let searchAttributesText = "";
    console.log("\n\n\n\n\nsearchAttributesText", searchAttributesText);
    productItem.searchAttributesText = searchAttributesText.trim();
    console.log("Search attributes text created, length:", searchAttributesText.length);

    // Get product properties
    let productProperties;
    try {
      console.log("defaultCategories in products", defaultCategories);
      productProperties = await getProductProperties(productContent, defaultCategories);
    } catch (e) {
      console.log(e);
    }

    productProperties = JSON.parse(productProperties);
    if (!productProperties.product) {
      console.log("error on properties", productProperties);
      productProperties.product = "unknown";
    }
    if (!productProperties.characteristics) {
      console.log("error on properties", productProperties);
      productProperties.characteristics = "unknown";
    }
    productItem.properties = productProperties;

    let image;
    if (productItem.images && productItem.images.length > 0) {
      image = productItem.images[0].src;
    } else if (productItem.image) {
      image = productItem.image.src;
    }
    productItem.image = image;

    let product = productItem.properties.product;
    let characteristics = productItem.properties.characteristics;
    let variants = productItem.variants;

    // Handle size/color options
    let isSizeOptionAvailable = !!productItem.options.find(item => item.name.toLowerCase() === "size");
    let isColorOptionAvailable = !!productItem.options.find(item => item.name.toLowerCase() === "color");

    if (!isSizeOptionAvailable) {
      let newOptionPosition = productItem.options.length + 1;
      productItem.options.push({ name: "Size", position: newOptionPosition });
      for (const [indexVariant, variant] of productItem.variants.entries()) {
        variant[`option${newOptionPosition}`] = "unknown";
        productItem.variants[indexVariant] = variant;
      }
    }

    if (!isColorOptionAvailable) {
      let newOptionPosition = productItem.options.length + 1;
      productItem.options.push({ name: "Color", position: newOptionPosition });
      for (const [indexVariant, variant] of productItem.variants.entries()) {
        variant[`option${newOptionPosition}`] = productItem.properties.color ? productItem.properties.color : "unknown";
        productItem.variants[indexVariant] = variant;
      }
    }

    // Generate option embeddings
    console.log("\n\n\n\n\nvariants", variants);
    const uniqueOptionValues = new Map();
    variants.forEach(variant => {
      productItem.options.forEach((option, index) => {
        console.log("\n\n\n\n\nvariant", variant);
        console.log("\n\n\n\n\noption", option);
        console.log("\n\n\n\n\n`option${index + 1}`", `option${index + 1}`);
        if (variant[`option${index + 1}`]) {
          const optionValue = variant[`option${index + 1}`].toLowerCase();
          const optionValueForEmbedding = `${option.name.toLowerCase()}: ${optionValue}`;
          if (!uniqueOptionValues.has(optionValueForEmbedding)) {
            uniqueOptionValues.set(optionValueForEmbedding, null);
          }
        }
      });
    });

    const embeddingPromises = Array.from(uniqueOptionValues.keys()).map(async optionValueForEmbedding => {
      let embedding = generatedEmbeddings.find(item => item.id === optionValueForEmbedding)?.value;
      if (!embedding) {
        try {
          embedding = await generateEmbedding(optionValueForEmbedding);
          generatedEmbeddings.push({ id: optionValueForEmbedding, value: embedding });
        } catch (e) {
          console.log(e);
          embedding = null;
        }
      }
      uniqueOptionValues.set(optionValueForEmbedding, embedding);
    });
    await Promise.all(embeddingPromises);

    variants.forEach((variant, indexVariant) => {
      productItem.options.forEach((option, index) => {
        if (variant[`option${index + 1}`]) {
          const optionValue = variant[`option${index + 1}`].toLowerCase();
          const optionValueForEmbedding = `${option.name.toLowerCase()}: ${optionValue}`;
          const embedding = uniqueOptionValues.get(optionValueForEmbedding);
          if (embedding !== null) {
            const optionName = option.name.toLowerCase();
            productItem.variants[indexVariant][`${optionName}Embedding`] = embedding;
            productItem.variants[indexVariant][`${optionName}Value`] = optionValueForEmbedding;
          }
        }
      });
    });

    // Make price to float
    variants.forEach((variant, indexVariant) => {
      productItem.variants[indexVariant]["price"] = parseFloat(productItem.variants[indexVariant]["price"]);
      if (productItem.variants[indexVariant]["compare_at_price"]) {
        productItem.variants[indexVariant]["compare_at_price"] = parseFloat(productItem.variants[indexVariant]["compare_at_price"]);
      }
    });
    if (productItem.price) productItem.price = parseFloat(productItem.price);
    if (productItem.price_old) productItem.price_old = parseFloat(productItem.price_old);

    // Category logic
    let category;
    let productTypeCategory = productItem.product_type ? productItem.product_type.toLowerCase() : "";
    console.log("\n\ncheck", productTypeCategory);

    // Special handling for dyfashion
    if (shopName.includes("dyfashion")) {
      console.log("\n\n========================================");
      console.log("[DYFASHION] Getting category from collections");
      console.log("[DYFASHION] Product ID:", productItem.id);
      console.log("[DYFASHION] Product Title:", productItem.title);
      console.log("[DYFASHION] Collections:", JSON.stringify(productItem.collections, null, 2));
      console.log("[DYFASHION] CategoriesDetails:", JSON.stringify(productItem.categoriesDetails, null, 2));

      if (productItem.collections && productItem.collections.length > 0) {
        category = productItem.collections[0].title;
        console.log("\n✅ [DYFASHION] CATEGORY FROM COLLECTIONS:", category);
      } else if (productItem.categoriesDetails && productItem.categoriesDetails.length > 0) {
        console.log("[DYFASHION] Using categoriesDetails for category");
        category = productItem.categoriesDetails[0].category_seo_name || productItem.categoriesDetails[0].category_name;
        productItem.collections = productItem.categoriesDetails.map(c => ({ id: c.category_id, title: c.category_seo_name || c.category_name, name: c.category_name }));
        console.log("\n✅ [DYFASHION] CATEGORY FROM CATEGORIESDETAILS:", category);
      } else {
        console.log("\n❌ [DYFASHION] No collections or categoriesDetails found");
      }
      console.log("\n🏷️  [DYFASHION] FINAL CATEGORY:", category);
      console.log("========================================\n");
      console.log("✓ Continuing execution...\n");
    } else if (user && user.defaultCategories) {
      console.log("not found category");
      console.log("productProperties.categories", productProperties.category, productItem.collections);
      category = productProperties.category ? productProperties.category.toLowerCase() : "";
      productItem.collections = [{ title: category }];
    } else if (shopifyCategories.map(item => item.toLowerCase()).includes(productTypeCategory.toLowerCase())) {
      console.log("found category");
      category = productTypeCategory;
    } else {
      console.log("not found category");
      console.log("productProperties.categories", productProperties.category, productItem.collections);
      if (productItem.collections && productItem.collections[0]) {
        category = productItem.collections[0].title;
      } else if (productItem.categoriesDetails && productItem.categoriesDetails.length > 0) {
        console.log("Using categoriesDetails for category");
        category = productItem.categoriesDetails[0].category_seo_name || productItem.categoriesDetails[0].category_name;
        productItem.collections = productItem.categoriesDetails.map(c => ({ id: c.category_id, title: c.category_seo_name || c.category_name, name: c.category_name }));
      }
    }

    if (!category) category = "clothing";
    if (!productItem.collections || productItem.collections.length === 0) {
      productItem.collections = [{ title: category }];
    }

    console.log("productItem", productItem.id, " -- ", productItem.product_type, " -- ", productItem.title);
    console.log("category match", `initial category: ${productItem.product_type}`, `final category: ${category}`);

    let categoryForEmbedding = `category: ${category}`;
    console.log("category", category);

    // SHOP-SPECIFIC: Style classification
    let styleCode = null;
    let styleCodeText = "none";

    if (shopName === "bogas-com-international.myshopify.com") {
      console.log("  [BOGAS] Getting style code...");
      try {
        styleCode = await getProductStyleBogas(productItem);
        console.log("getProductStyleBogasResult", styleCode);
        if (styleCode) styleCodeText = `${styleCode.body?.join(",")},${styleCode.personality?.join(",")},${styleCode.chromatic?.join(",")}`;
      } catch (e) { console.log("  [BOGAS] Style error:", e.message); }
    }

    if (shopName === "dyfashion.avanticart.ro") {
      console.log("  [DYFASHION] Getting style code...");
      try {
        styleCode = await getProductStyleDyFashion(productItem);
        console.log("getProductStyleDyFashion result", styleCode);
        if (styleCode) styleCodeText = `${styleCode.body?.join(",")},${styleCode.personality?.join(",")},${styleCode.chromatic?.join(",")}`;
      } catch (e) { console.log("  [DYFASHION] Style error:", e.message); }
    }

    // Content for embeddings
    let content = `${productItem.title}. ${stripHtml(productItem.body_html).result || ""}`;
    if (productItem.tags) content += ` Tags: ${productItem.tags}`;

    // Generate embeddings
    const [titleEmb, contentEmb, productEmb, charEmb, catEmb, styleEmb, searchEmb] = await Promise.all([
      generateEmbedding(productItem.title),
      generateEmbedding(content),
      generateEmbedding(product),
      generateEmbedding(characteristics),
      generateEmbedding(categoryForEmbedding),
      generateEmbedding(styleCodeText),
      searchAttributesText ? generateEmbedding(searchAttributesText) : null
    ]);

    productItem.title = productItem.title;
    productItem.titleEmbedding = titleEmb;
    productItem.content = content;
    productItem.contentEmbedding = contentEmb;
    productItem.product = product;
    productItem.productEmbedding = productEmb;
    productItem.characteristics = characteristics;
    productItem.characteristicsEmbedding = charEmb;
    productItem.category = category;
    productItem.categoryEmbedding = catEmb;
    productItem.styleCode = styleCodeText;
    productItem.styleCodeEmbedding = styleEmb;
    productItem.styleData = styleCode;
    productItem.searchAttributesEmbedding = searchEmb;
    productItem.currency = shopData.currency;

    return productItem;
  }));

  return processedProducts;
}

// ==================== fetchAllProductsGraph ====================

async function fetchAllProductsGraph(shop, accessToken, channelId, region, app, user, forceAll = false) {
  const endpoint = `https://${shop}/admin/api/2023-04/graphql.json`;
  const graphQLClient = new GraphQLClient(endpoint, { headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" } });

  const appData = { id: "runa", appName: "Runa" };
  const storeData = { id: shop, storeName: shop };
  const demographicsData = ["woman"];
  const defaultCategories = user?.defaultCategories || null;
  const shopData = await getShopData(shop, accessToken);
  
  if (forceAll) console.log("⚡ FORCE MODE: Processing ALL products (ignoring existing)");

  // SHOP-SPECIFIC: Batch size
  let mainLimit = 20;
  if (shop === "andreearaicu.myshopify.com") mainLimit = 2;

  let hasNextPage = true, afterCursor = null, countProcessed = 0, totalProductsSeen = 0, count = 0;

  do {
    const response = await graphQLClient.request(GET_PRODUCTS_QUERY_PUBLISHED_STATUS, { first: mainLimit, after: afterCursor });
    let products = transformGraphQLToRestAPIArray(response);
    hasNextPage = response.products.pageInfo.hasNextPage;
    if (hasNextPage) afterCursor = response.products.edges[response.products.edges.length - 1].cursor;

    products = products.filter(p => p.status === "active" && !!p.published_at);
    totalProductsSeen += products.length;
    if (!count) count = totalProductsSeen + (hasNextPage ? mainLimit * 10 : 0);

    console.log(`\n=== Batch: ${products.length} products, Total: ${totalProductsSeen} ===`);

    // Check existing products in Neo4j (skip if forceAll)
    if (products.length > 0 && !forceAll) {
      try {
        const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
        const session = driver.session();
        try {
          const productIds = products.map(p => p.id);
          const idList = productIds.map(id => `"${id}"`).join(', ');
          const result = await session.run(`MATCH (p:Product) WHERE p.storeId = "${shop}" AND p.id IN [${idList}] AND (p.need_update IS NULL OR p.need_update <> true) RETURN p.id as existingId`);
          const existingIds = new Set(result.records.map(r => String(r.get('existingId'))));
          const existingProducts = products.filter(p => existingIds.has(String(p.id)));
          const newProducts = products.filter(p => !existingIds.has(String(p.id)));
          console.log(`  Existing: ${existingProducts.length}, New: ${newProducts.length}`);

          // SHOP-SPECIFIC: Raicu English translations
          if (shop === "andreearaicu.myshopify.com") {
            const allProducts = [...newProducts, ...existingProducts];
            const checkSession = driver.session();
            let hasEnglish = new Set();
            try {
              const checkResult = await checkSession.run(`MATCH (p:Product) WHERE p.storeId = $storeId AND p.id IN $productIds AND p.en_title IS NOT NULL AND p.en_title <> "" RETURN p.id as productId`, { storeId: shop, productIds: allProducts.map(p => p.id.toString()) });
              hasEnglish = new Set(checkResult.records.map(r => r.get('productId')));
            } finally { await checkSession.close(); }

            const needsEnglish = allProducts.filter(p => !hasEnglish.has(p.id.toString()));
            if (needsEnglish.length > 0) {
              console.log(`  [Raicu] Fetching English for ${needsEnglish.length} products...`);
              for (let i = 0; i < needsEnglish.length; i++) {
                const p = needsEnglish[i];
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
                  if (i < needsEnglish.length - 1) await delay(200);
                } catch (e) { console.log(`    ✗ EN error: ${p.handle}`); }
              }
              // Save English data for existing products
              const withEn = needsEnglish.filter(p => p.en_title);
              if (withEn.length > 0) {
                const enUpdates = withEn.map(p => ({ productId: p.id.toString(), storeId: shop, en_title: p.en_title, en_price: p.en_price, en_price_currency: p.en_price_currency, en_url: p.en_url, en_product_type: p.en_product_type, en_description: p.en_description, en_json: p.en_json }));
                for (let i = 0; i < enUpdates.length; i += 50) {
                  const batch = enUpdates.slice(i, i + 50);
                  const updateSession = driver.session();
                  try { await updateSession.run(`UNWIND $updates AS u MATCH (p:Product {id: u.productId, storeId: u.storeId}) SET p.en_title = u.en_title, p.en_price = u.en_price, p.en_price_currency = u.en_price_currency, p.en_url = u.en_url, p.en_product_type = u.en_product_type, p.en_description = u.en_description, p.en_json = u.en_json`, { updates: batch }); }
                  finally { await updateSession.close(); }
                }
              }
            }
          }

          // Mark existing products updated
          if (existingProducts.length > 0) {
            const nowIso = new Date().toISOString();
            for (let i = 0; i < existingProducts.length; i += 50) {
              const batch = existingProducts.slice(i, i + 50).map(p => ({ productId: p.id.toString(), storeId: shop, updated_at: nowIso }));
              const updateSession = driver.session();
              try { await updateSession.run(`UNWIND $updates AS u MATCH (p:Product {id: u.productId, storeId: u.storeId}) SET p.updated_at = u.updated_at`, { updates: batch }); }
              finally { await updateSession.close(); }
            }
          }

          products = newProducts;
        } finally { await session.close(); await driver.close(); }
      } catch (e) { console.error("Neo4j check error:", e.message); }
    } else if (forceAll && products.length > 0) {
      console.log(`  Force mode: processing all ${products.length} products`);
      // SHOP-SPECIFIC: Raicu English translations (still fetch for force mode)
      if (shop === "andreearaicu.myshopify.com") {
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
          } catch (e) { console.log(`    ✗ EN error: ${p.handle}`); }
        }
      }
    }

    // Process new products
    if (products.length > 0) {
      const processedProducts = await processProducts(products, defaultCategories, shop);
      await distributeProducts(processedProducts, storeData, appData, demographicsData);
      countProcessed += products.length;
      if (countProcessed > count) countProcessed = count;

      console.log(`  Progress: ${totalProductsSeen}/${count} (${((totalProductsSeen / count) * 100).toFixed(1)}%)`);
      pubnub.publish({ channel: channelId, message: { total: count, processed: countProcessed } });
      await updateUser(shop, countProcessed !== count, countProcessed, count, region);
    }
  } while (hasNextPage);

  // Finalize
  pubnub.publish({ channel: channelId, message: { total: count, processed: countProcessed } });
  await updateUser(shop, false, countProcessed, count, region);
  console.log(`\n✓ Finalized: ${countProcessed} products`);
}

async function fetchAllCollections(shop, accessToken) {
  try {
    const shopify = new Shopify({ shopName: shop, accessToken });
    const custom = await shopify.customCollection.list();
    const smart = await shopify.smartCollection.list();
    return [...custom, ...smart].map(c => ({ title: c.title }));
  } catch (e) { return []; }
}

const saveProducts = async (shopName, shopAccessToken, channelId, region, app, forceAll = false) => {
  console.log("saving products started 1");
  console.log("shopName, region", shopName, region);
  
  let user = await getUserByShop(shopName, region);
  console.log("user", user);
  
  user.syncInProgress = true;
  user.syncProgress = 0;
  await saveUser(user, region);

  const allCategories = await fetchAllCollections(shopName, shopAccessToken);
  console.log("allCategories", allCategories);
  
  if (allCategories && allCategories.length > 0) {
    await createOrUpdateCategories(allCategories);
  }

  await fetchAllProductsGraph(shopName, shopAccessToken, channelId, region, app, user, forceAll);
};

// ==================== Context Processing ====================

async function processContextCategories(appId, storeId) {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const result = await session.run(`MATCH (store:Store {id: $storeId})-[:HAS_PRODUCT]->(p:Product)-[:HAS_CATEGORY]->(c:Category) RETURN DISTINCT c.name AS name`, { storeId });
    const categories = result.records.map(r => r.get("name"));
    let allCategoriesContext = categories.map(c => c.toLowerCase());
    const categoriesList = allCategoriesContext.join(", ");

    // EXACT generateSuggestions from original __processContext.js
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { 
          role: "system", 
          content: `You are a highly knowledgeable assistant who will receive a summary of a website's content, organized by categories. Your task is to generate a JSON with 3 short conversation starters designed to enhance the shopping experience on the website. By analyzing the provided summary you'll create engaging prompts. These prompts aim to facilitate easy discovery and interaction with the site's inventory, encouraging users to explore and inquire about products through the AI chat feature.

        Example JSON Output:
        {
          "suggestions": [
            "Casual outfit for outdoors",
            "Slim fit blue jeans",
            "Breezy tops"
          ]
        }

        Each suggestion should be straightforward and tailored to guide users on what to search for or ask about, with at least one prompt being 3-4 words long.` 
        },
        { role: "user", content: categoriesList }
      ],
      temperature: 0.7, max_tokens: 4096, response_format: { type: "json_object" }
    });

    return { categories: categoriesList, suggestions: response.choices[0].message.content };
  } catch (e) { 
    console.error("Failed to fetch categories:", e);
    return { categories: "" }; 
  }
  finally { await session.close(); await driver.close(); }
}

const updateUserContext = async (shop, region, context) => {
  let user = await getUserByShop(shop, region);
  user.context = context;
  if ((user.chat && user.chat.suggestions && user.chat.suggestions.length === 0) || (user.chat && !user.chat.suggestions)) {
    if (context.suggestions) {
      let newSuggestions = JSON.parse(context.suggestions);
      user.chat.suggestions = newSuggestions.suggestions;
    }
  }
  console.log("saving shop", shop);
  try {
    console.log("saving user", user.id, region);
    await saveUser(user, region);
    console.log("save user done");
  } catch (e) {
    console.log(e);
  }
};

const updateUserContextFetching = async (shop, region, fetching) => {
  let user = await getUserByShop(shop, region);
  user.contextFetching = fetching;
  console.log("saving shop", shop);
  try {
    console.log("saving user", user.id, region);
    await saveUser(user, region);
  } catch (e) {
    console.log(e);
  }
};

// ==================== processShop (MAIN) ====================

const processShop = async ({ appId, appName, shopName, shopAccessToken, channelId, region, forceAll = false }) => {
  const appData = { id: appId, appName };
  const storeData = { id: shopName, storeName: shopName };

  await createApplicationAndStore(storeData, appData);
  console.log("store created", storeData, appData);

  // process products
  await saveProducts(shopName, shopAccessToken, channelId, region, null, forceAll);

  console.log("context fetching");
  let contextFetching = "inProgress";
  let message = { contextFetching };
  pubnub.publish({ channel: channelId, message: message });
  await updateUserContextFetching(shopName, region, contextFetching);
  console.log("contextFetching", contextFetching);

  const context = await processContextCategories(appId, shopName);
  if (context) {
    await updateUserContext(shopName, region, context);
  } else {
    console.log("error on generating context");
  }

  contextFetching = "done";
  message = { contextFetching };
  pubnub.publish({ channel: channelId, message: message });
  await updateUserContextFetching(shopName, region, contextFetching);
  console.log("contextFetching", contextFetching);
};

// ==================== MAIN ====================

async function main() {
  // Parse arguments - support both positional and flag-based
  const args = process.argv.slice(2);
  const forceAll = args.includes('--force') || args.includes('-f');
  const filteredArgs = args.filter(a => !a.startsWith('-'));
  
  const shopName = filteredArgs[0] || process.env.SHOP_DOMAIN;
  const shopAccessToken = filteredArgs[1] || process.env.ACCESS_TOKEN;

  if (!shopName || !shopAccessToken) {
    console.error(`Usage: node sync-shopify-exact.js <shop-domain> <access-token> [--force]

Options:
  --force, -f   Process ALL products (skip existing product check)
                Without this flag, only new products are processed.
`);
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║   EXACT COPY - SHOPIFY SYNC (ALL SHOPS SUPPORTED)                 ║
╠═══════════════════════════════════════════════════════════════════╣
║  Shop: ${shopName.padEnd(55)}║
║  Mode: ${forceAll ? 'FORCE (all products)'.padEnd(55) : 'Normal (new products only)'.padEnd(55)}║
║  Features:                                                        ║
║    - Bogas: Style classification + HTML to Markdown               ║
║    - DyFashion: Style classification + S3 upload                  ║
║    - Raicu: English translations from Amalin.com                  ║
╚═══════════════════════════════════════════════════════════════════╝
  `);

  await processShop({
    appId: "runa",
    appName: "Runa",
    shopName,
    shopAccessToken,
    channelId: `${shopName}_scan`,
    region: "us-east-1",
    forceAll
  });

  console.log("\n✓ Sync completed successfully");
  process.exit(0);
}

main().catch(e => { console.error("Sync failed:", e); process.exit(1); });
