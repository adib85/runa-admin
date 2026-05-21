/**
 * Cache Fan-Out Invalidation
 *
 * Helpers for finding and deleting CTL / Similar Products cache entries that
 * REFERENCE a given set of products in their payloads (not just the entries
 * keyed by those products' handles).
 *
 * Use case: when a product's image, price, or availability changes, every
 * cached widget that includes that product is now stale even though its own
 * cache key wasn't touched. Sweep the cache by storeId and delete every
 * entry whose payload mentions any of the target product ids/handles.
 *
 * Usage from another script:
 *   import { deleteReferencingCacheEntries } from "./cache-fanout.js";
 *   const summary = await deleteReferencingCacheEntries(docClient, {
 *     storeId, productIds: [123, 456], handles: ["a", "b"], dryRun: false,
 *   });
 */

const CACHE_TABLE_DEFAULT = "CacheTable";
const STOREID_GSI = "storeId-index";

function normaliseId(v) {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Walk the cache item payload and return true if it references any of the
 * provided product ids or handles. Looks at:
 *   - data.outfits[].products_for_outfit[]   (Complete The Look)
 *   - data.products[]                        (Similar Products)
 *   - data.candidateProducts[]               (Similar Products candidate set)
 *   - data.mainProduct                       (Similar Products main)
 */
function entryReferencesAny(item, idSet, handleSet) {
  const data = item?.data;
  if (!data || typeof data !== "object") return null;

  const matchProduct = p => {
    if (!p || typeof p !== "object") return false;
    if (p.id != null && idSet.has(normaliseId(p.id))) return { by: "id", value: normaliseId(p.id) };
    if (p.handle && handleSet.has(p.handle)) return { by: "handle", value: p.handle };
    return false;
  };

  if (Array.isArray(data.outfits)) {
    for (const outfit of data.outfits) {
      const products = outfit?.products_for_outfit || [];
      for (const p of products) {
        const m = matchProduct(p);
        if (m) return { location: `outfits[].products_for_outfit[] (${m.by}=${m.value})`, ...m };
      }
    }
  }

  if (Array.isArray(data.products)) {
    for (const p of data.products) {
      const m = matchProduct(p);
      if (m) return { location: `products[] (${m.by}=${m.value})`, ...m };
    }
  }

  if (Array.isArray(data.candidateProducts)) {
    for (const p of data.candidateProducts) {
      const m = matchProduct(p);
      if (m) return { location: `candidateProducts[] (${m.by}=${m.value})`, ...m };
    }
  }

  if (data.mainProduct) {
    const m = matchProduct(data.mainProduct);
    if (m) return { location: `mainProduct (${m.by}=${m.value})`, ...m };
  }

  return null;
}

/**
 * Scan all cache entries for `storeId` and return ones that reference any of
 * the provided product ids or handles.
 */
export async function findReferencingCacheEntries(docClient, opts) {
  const { storeId, productIds = [], handles = [], cacheTable = CACHE_TABLE_DEFAULT, onProgress } = opts;
  if (!storeId) throw new Error("findReferencingCacheEntries: storeId required");
  if (productIds.length === 0 && handles.length === 0) {
    return { scanned: 0, matches: [] };
  }

  const idSet = new Set(productIds.map(normaliseId).filter(Boolean));
  const handleSet = new Set(handles.filter(Boolean));

  const matches = [];
  let scanned = 0;
  let lastKey;

  do {
    const params = {
      TableName: cacheTable,
      IndexName: STOREID_GSI,
      KeyConditionExpression: "storeId = :s",
      ExpressionAttributeValues: { ":s": storeId },
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const res = await docClient.query(params).promise();
    for (const item of res.Items || []) {
      scanned++;
      const ref = entryReferencesAny(item, idSet, handleSet);
      if (ref) {
        matches.push({ id: item.id, location: ref.location, by: ref.by, value: ref.value });
      }
    }
    lastKey = res.LastEvaluatedKey;
    if (typeof onProgress === "function") onProgress({ scanned, matched: matches.length });
  } while (lastKey);

  return { scanned, matches };
}

/**
 * Delete every cache entry that references any of the provided product
 * ids/handles. Skips delete if dryRun.
 */
export async function deleteReferencingCacheEntries(docClient, opts) {
  const {
    storeId,
    productIds = [],
    handles = [],
    cacheTable = CACHE_TABLE_DEFAULT,
    dryRun = false,
    onProgress,
  } = opts;

  const { scanned, matches } = await findReferencingCacheEntries(docClient, {
    storeId, productIds, handles, cacheTable, onProgress,
  });

  if (matches.length === 0) {
    return { scanned, matched: 0, deleted: 0, failed: 0, matches: [] };
  }

  let deleted = 0;
  let failed = 0;
  const failures = [];

  if (!dryRun) {
    const CONC = 8;
    let i = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (true) {
        const my = i++;
        if (my >= matches.length) return;
        const m = matches[my];
        try {
          await docClient.delete({ TableName: cacheTable, Key: { id: m.id } }).promise();
          deleted++;
        } catch (e) {
          failed++;
          failures.push({ id: m.id, error: e.message });
        }
      }
    }));
  }

  return { scanned, matched: matches.length, deleted, failed, failures, matches };
}
