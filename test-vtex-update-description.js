import dotenv from "dotenv";
dotenv.config();

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || "toffro";
const VTEX_API_KEY = process.env.VTEX_API_KEY;
const VTEX_API_TOKEN = process.env.VTEX_API_TOKEN;
const BASE_URL = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
const SKU_ID = 59149;

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": VTEX_API_KEY,
  "X-VTEX-API-AppToken": VTEX_API_TOKEN,
};

const newDescription = [
  "Această bluză din dantelă reprezintă o piesă vestimentară de o eleganță atemporală, definită de o feminitate discretă și un rafinament artizanal aparte. Textura sa delicată și jocul de transparențe conferă o notă sofisticată oricărei ținute, transformând-o într-o alegere ideală pentru evenimentele de seară sau pentru momentele în care doriți să adăugați un plus de stil garderobei urbane. Se poate asocia armonios cu o fustă creion pentru un look office de lux sau cu o pereche de pantaloni din mătase pentru o apariție spectaculoasă și plină de personalitate.",
  "<br>",
  "Caracteristici: <br>",
  "- Confecționată din dantelă florală prețioasă, cu detalii brodate fin <br>",
  "- Croială regular fit care oferă libertate de mișcare și o siluetă fluidă <br>",
  "- Decolteu rotund la baza gâtului, pentru o notă de eleganță clasică <br>",
  "- Mâneci lungi realizate integral din dantelă transparentă <br>",
  "- Margini festonate la tiv și manșete, evidențiind motivele florale <br>",
  "- Închidere discretă la spate cu un nasture delicat <br>",
  "- Decupaj rafinat în formă de lacrimă în zona posterioară <br>",
  "- Include un top interior tip furou, detașabil, pentru confort și opacitate <br>",
  "- Detaliu metalic discret sub formă de inimă, simbolul iconic al brandului <br>",
  "- Design versatil, ușor de integrat în ținute romantice sau moderne <br>",
  "- Finisaje premium executate cu atenție la fiecare detaliu <br>",
  "- Material ușor și plăcut la atingere, ideal pentru purtări îndelungate <br>",
  "<br>",
  "Compoziție produs: 75% Bumbac, 25% Poliamidă; Dublură: 100% Poliester<br>",
  "<br>",
].join("\r\n");

async function getProductIdFromSku(skuId) {
  const url = `${BASE_URL}/api/catalog/pvt/stockkeepingunit/${skuId}`;
  console.log(`[1] Fetching SKU ${skuId} to get ProductId...`);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get SKU: ${res.status} ${res.statusText} - ${await res.text()}`);
  }
  const data = await res.json();
  console.log(`    ProductId: ${data.ProductId}`);
  return data.ProductId;
}

async function getProduct(productId) {
  const url = `${BASE_URL}/api/catalog/pvt/product/${productId}`;
  console.log(`[2] Fetching product ${productId}...`);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get product: ${res.status} ${res.statusText} - ${await res.text()}`);
  }
  const data = await res.json();
  console.log(`    Product name: ${data.Name}`);
  console.log(`    Current description length: ${(data.Description || "").length} chars`);
  return data;
}

async function updateProductDescription(productId, product) {
  const url = `${BASE_URL}/api/catalog/pvt/product/${productId}`;
  console.log(`[3] Updating description for product ${productId}...`);

  const body = { ...product, Description: newDescription };

  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to update product: ${res.status} ${res.statusText} - ${errorText}`);
  }
  const data = await res.json();
  console.log(`    Description updated successfully!`);
  console.log(`    New description length: ${(data.Description || "").length} chars`);
  return data;
}

async function verifyDescription(productId) {
  const url = `${BASE_URL}/api/catalog/pvt/product/${productId}`;
  console.log(`[4] Verifying — re-fetching product ${productId} from API...`);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to verify product: ${res.status} ${res.statusText} - ${await res.text()}`);
  }
  const data = await res.json();
  const desc = data.Description || "";
  console.log(`    Product name: ${data.Name}`);
  console.log(`    Description length: ${desc.length} chars`);
  console.log(`    Description preview: ${desc.substring(0, 120)}...`);
  console.log(`    Match: ${desc === newDescription ? "YES — description matches what we sent" : "NO — description differs from what we sent"}`);
  return data;
}

async function inspectAllFields(productId) {
  console.log(`\n========== INSPECT ALL PRODUCT FIELDS ==========\n`);

  // 1. Full product object
  const productUrl = `${BASE_URL}/api/catalog/pvt/product/${productId}`;
  const productRes = await fetch(productUrl, { headers });
  const product = await productRes.json();
  console.log("[A] Full product object:");
  console.log(JSON.stringify(product, null, 2));

  // 2. Product specifications (custom fields — often where storefront descriptions live)
  const specsUrl = `${BASE_URL}/api/catalog/pvt/product/${productId}/specification`;
  console.log("\n[B] Product specifications:");
  const specsRes = await fetch(specsUrl, { headers });
  if (specsRes.ok) {
    const specs = await specsRes.json();
    console.log(JSON.stringify(specs, null, 2));
  } else {
    console.log(`    Failed: ${specsRes.status} ${specsRes.statusText}`);
  }

  // 3. SKU specifications
  const skuSpecsUrl = `${BASE_URL}/api/catalog/pvt/stockkeepingunit/${SKU_ID}/specification`;
  console.log("\n[C] SKU specifications:");
  const skuSpecsRes = await fetch(skuSpecsUrl, { headers });
  if (skuSpecsRes.ok) {
    const skuSpecs = await skuSpecsRes.json();
    console.log(JSON.stringify(skuSpecs, null, 2));
  } else {
    console.log(`    Failed: ${skuSpecsRes.status} ${skuSpecsRes.statusText}`);
  }

  // 4. Also try to look for a product with description on the storefront API
  // (the Wolford body SKU — to compare which field it uses)
  console.log("\n[D] Storefront search API for this product (to see rendered fields):");
  const searchUrl = `${BASE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}`;
  const searchRes = await fetch(searchUrl, { headers });
  if (searchRes.ok) {
    const searchData = await searchRes.json();
    if (searchData.length > 0) {
      const p = searchData[0];
      console.log(`    productName: ${p.productName}`);
      console.log(`    description: ${(p.description || "").substring(0, 150)}`);
      console.log(`    metaTagDescription: ${(p.metaTagDescription || "").substring(0, 150)}`);
      console.log(`    Specifications keys: ${Object.keys(p).filter(k => k.toLowerCase().includes("spec") || k.toLowerCase().includes("desc") || k.toLowerCase().includes("detail")).join(", ")}`);
      console.log(`    All keys: ${Object.keys(p).join(", ")}`);
      if (p.allSpecifications) {
        console.log(`    allSpecifications: ${JSON.stringify(p.allSpecifications)}`);
        for (const specName of p.allSpecifications) {
          console.log(`      -> ${specName}: ${JSON.stringify(p[specName])}`);
        }
      }
    }
  } else {
    console.log(`    Failed: ${searchRes.status}`);
  }
}

async function main() {
  try {
    const productId = await getProductIdFromSku(SKU_ID);
    const product = await getProduct(productId);

    console.log("\n[3] Updating description with HTML <br> formatting (matching Wolford pattern)...");
    await updateProductDescription(productId, product);

    console.log("\nWaiting 5 seconds before verification...\n");
    await new Promise((r) => setTimeout(r, 5000));

    await verifyDescription(productId);
    console.log("\nDone! Check the product page — it may take a few minutes for VTEX CDN cache to update.");
  } catch (err) {
    console.error("\nError:", err.message);
    if (err.message.includes("403") || err.message.includes("401")) {
      console.error("Note: The provided credentials are labeled 'Read-Only' — write operations may be blocked.");
    }
  }
}

main();
