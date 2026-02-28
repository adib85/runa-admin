import dotenv from "dotenv";
dotenv.config();

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || "toffro";
const VTEX_API_KEY = process.env.VTEX_API_KEY;
const VTEX_API_TOKEN = process.env.VTEX_API_TOKEN;
const BASE_URL = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": VTEX_API_KEY,
  "X-VTEX-API-AppToken": VTEX_API_TOKEN,
};

function detectDemographic(product) {
  const steps = [];
  const firstCategory = (product.categories || [])[0]?.toLowerCase() || '';

  steps.push(`Checking first category: "${firstCategory}"`);

  const demographics = [];

  if (firstCategory.startsWith('/femei/')) {
    demographics.push('woman');
    steps.push('  → Starts with /femei/ → "woman"');
  }
  if (firstCategory.startsWith('/bărbați/')) {
    demographics.push('man');
    steps.push('  → Starts with /bărbați/ → "man"');
  }
  if (demographics.length === 0) {
    demographics.push('unisex');
    steps.push('  → No /femei/ or /bărbați/ found → defaulting to "unisex"');
  }

  return { demographics, steps };
}

function parseInput(input) {
  // Full URL: https://www.toff.ro/acne-studios-tricou-cu-imprimeu-cl0333-j83/p?skuId=113651
  try {
    const url = new URL(input);
    const skuId = url.searchParams.get('skuId');
    const pathParts = url.pathname.split('/').filter(Boolean);
    const handle = pathParts[0]; // first segment before /p
    return { handle, skuId };
  } catch {
    // Not a URL — treat as handle or numeric product ID
    if (/^\d+$/.test(input)) {
      return { productId: input };
    }
    return { handle: input };
  }
}

async function fetchByHandle(handle) {
  const url = `${BASE_URL}/api/catalog_system/pub/products/search/${encodeURIComponent(handle)}/p`;
  console.log(`\nFetching by handle: ${url}`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Handle search failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchByProductId(productId) {
  const url = `${BASE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}`;
  console.log(`\nFetching by productId: ${url}`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Product ID search failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchBySkuId(skuId) {
  const url = `${BASE_URL}/api/catalog_system/pub/products/search?fq=skuId:${skuId}`;
  console.log(`\nFetching by skuId: ${url}`);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SKU search failed: ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.log("Usage: node test-vtex-demographic.js <url|handle|productId>");
    console.log("Examples:");
    console.log('  node test-vtex-demographic.js "https://www.toff.ro/acne-studios-tricou-cu-imprimeu-cl0333-j83/p?skuId=113651"');
    console.log("  node test-vtex-demographic.js acne-studios-tricou-cu-imprimeu-cl0333-j83");
    console.log("  node test-vtex-demographic.js 12345");
    process.exit(1);
  }

  const parsed = parseInput(input);
  console.log("Parsed input:", parsed);

  let products = [];

  // Try handle first, then skuId, then productId
  if (parsed.handle) {
    try {
      products = await fetchByHandle(parsed.handle);
    } catch (e) {
      console.log(`Handle lookup failed: ${e.message}`);
    }
  }

  if (products.length === 0 && parsed.skuId) {
    try {
      products = await fetchBySkuId(parsed.skuId);
    } catch (e) {
      console.log(`SKU lookup failed: ${e.message}`);
    }
  }

  if (products.length === 0 && parsed.productId) {
    try {
      products = await fetchByProductId(parsed.productId);
    } catch (e) {
      console.log(`Product ID lookup failed: ${e.message}`);
    }
  }

  if (!products || products.length === 0) {
    console.log("\nNo product found for input:", input);
    process.exit(1);
  }

  const product = products[0];

  console.log("\n════════════════════════════════════════════════════");
  console.log("  PRODUCT INFO");
  console.log("════════════════════════════════════════════════════");
  console.log(`  Name:       ${product.productName}`);
  console.log(`  ID:         ${product.productId}`);
  console.log(`  Brand:      ${product.brand}`);
  console.log(`  Link:       ${product.link}`);
  console.log(`  Categories: ${(product.categories || []).join(' | ')}`);

  if (product.productClusters) {
    console.log(`  Clusters:   ${Object.values(product.productClusters).join(', ')}`);
  }
  if (product.clusterHighlights) {
    console.log(`  Highlights: ${Object.values(product.clusterHighlights).join(', ')}`);
  }

  const { demographics, steps } = detectDemographic(product);

  console.log("\n════════════════════════════════════════════════════");
  console.log("  DEMOGRAPHIC DETECTION (step by step)");
  console.log("════════════════════════════════════════════════════");
  steps.forEach(s => console.log(s));
  console.log("\n  ➤ FINAL DEMOGRAPHIC: " + demographics.join(', '));
  console.log("════════════════════════════════════════════════════\n");
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
