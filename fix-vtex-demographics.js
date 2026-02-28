import dotenv from "dotenv";
dotenv.config();
import neo4j from "neo4j-driver";

const NEO4J_URI = process.env.NEO4J_URI || "neo4j://3.95.143.107:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

const VTEX_ACCOUNT = process.env.VTEX_ACCOUNT || "toffro";
const VTEX_API_KEY = process.env.VTEX_API_KEY;
const VTEX_API_TOKEN = process.env.VTEX_API_TOKEN;
const VTEX_BASE_URL = `https://${VTEX_ACCOUNT}.vtexcommercestable.com.br`;
const STORE_ID = "toffro.vtexcommercestable.com.br";

const vtexHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-VTEX-API-AppKey": VTEX_API_KEY,
  "X-VTEX-API-AppToken": VTEX_API_TOKEN,
};

const BATCH_SIZE = 10;

function detectDemographic(firstCategory) {
  if (firstCategory.startsWith('/femei/')) return 'woman';
  if (firstCategory.startsWith('/bărbați/')) return 'man';
  return 'unisex';
}

async function fetchProductFromVtex(handle) {
  const url = `${VTEX_BASE_URL}/api/catalog_system/pub/products/search/${encodeURIComponent(handle)}/p`;
  const res = await fetch(url, { headers: vtexHeaders });
  if (!res.ok) return null;
  const products = await res.json();
  return products[0] || null;
}

async function fetchProductByIdFromVtex(productId) {
  const url = `${VTEX_BASE_URL}/api/catalog_system/pub/products/search?fq=productId:${productId}`;
  const res = await fetch(url, { headers: vtexHeaders });
  if (!res.ok) return null;
  const products = await res.json();
  return products[0] || null;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

  try {
    const countSession = driver.session();
    const countResult = await countSession.run(
      `MATCH (p:Product) WHERE p.storeId = $storeId RETURN count(p) AS total`,
      { storeId: STORE_ID }
    );
    const totalProducts = countResult.records[0].get('total').toNumber();
    await countSession.close();

    console.log(`\nFound ${totalProducts} products for ${STORE_ID}`);
    console.log(`Processing in batches of ${BATCH_SIZE}...\n`);

    let skip = 0;
    let processed = 0;
    let updated = 0;
    let unchanged = 0;
    let notFoundInVtex = 0;
    let errors = 0;

    while (skip < totalProducts) {
      const session = driver.session();

      const result = await session.run(
        `MATCH (p:Product)
         WHERE p.storeId = $storeId
         OPTIONAL MATCH (p)-[:HAS_DEMOGRAPHIC]->(d:Demographic)
         RETURN p.id AS id, p.handle AS handle, p.title AS title, collect(d.name) AS currentDemographics
         ORDER BY p.id
         SKIP $skip LIMIT $limit`,
        { storeId: STORE_ID, skip: neo4j.int(skip), limit: neo4j.int(BATCH_SIZE) }
      );

      const products = result.records.map(r => ({
        id: r.get('id'),
        handle: r.get('handle'),
        title: r.get('title'),
        currentDemographics: r.get('currentDemographics'),
      }));

      await session.close();

      if (products.length === 0) break;

      console.log(`── Batch ${Math.floor(skip / BATCH_SIZE) + 1} (products ${skip + 1}-${skip + products.length} of ${totalProducts}) ──`);

      for (const product of products) {
        processed++;

        let vtexProduct = null;
        if (product.handle) {
          vtexProduct = await fetchProductFromVtex(product.handle);
        }
        if (!vtexProduct && product.id) {
          vtexProduct = await fetchProductByIdFromVtex(product.id);
        }

        if (!vtexProduct) {
          console.log(`  [${processed}/${totalProducts}] "${product.title}" — NOT FOUND in VTEX, skipping`);
          notFoundInVtex++;
          continue;
        }

        const firstCategory = (vtexProduct.categories || [])[0]?.toLowerCase() || '';
        const newDemographic = detectDemographic(firstCategory);
        const currentDemo = product.currentDemographics.sort().join(',');

        if (currentDemo === newDemographic) {
          console.log(`  [${processed}/${totalProducts}] "${product.title}" — already "${newDemographic}", no change`);
          unchanged++;
          continue;
        }

        const updateSession = driver.session();
        try {
          await updateSession.run(
            `MATCH (p:Product {id: $productId, storeId: $storeId})
             OPTIONAL MATCH (p)-[r:HAS_DEMOGRAPHIC]->()
             DELETE r
             WITH p
             MERGE (d:Demographic {name: $demographic})
             MERGE (p)-[:HAS_DEMOGRAPHIC]->(d)`,
            { productId: product.id, storeId: STORE_ID, demographic: newDemographic }
          );
          console.log(`  [${processed}/${totalProducts}] "${product.title}" — "${currentDemo || 'none'}" → "${newDemographic}" (category: ${firstCategory})`);
          updated++;
        } catch (err) {
          console.log(`  [${processed}/${totalProducts}] "${product.title}" — ERROR: ${err.message}`);
          errors++;
        } finally {
          await updateSession.close();
        }

        await sleep(100);
      }

      skip += BATCH_SIZE;
      console.log();
    }

    console.log("════════════════════════════════════════════════════");
    console.log("  SUMMARY");
    console.log("════════════════════════════════════════════════════");
    console.log(`  Total products:    ${totalProducts}`);
    console.log(`  Processed:         ${processed}`);
    console.log(`  Updated:           ${updated}`);
    console.log(`  Unchanged:         ${unchanged}`);
    console.log(`  Not found in VTEX: ${notFoundInVtex}`);
    console.log(`  Errors:            ${errors}`);
    console.log("════════════════════════════════════════════════════\n");

  } finally {
    await driver.close();
  }
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
