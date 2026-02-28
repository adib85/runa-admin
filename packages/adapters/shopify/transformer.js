import { stripHtml } from "string-strip-html";

/**
 * Transform Shopify data to common format
 */

/**
 * Transform Shopify product to common Product format
 * @param {Object} shopifyProduct - Raw Shopify product from GraphQL
 * @returns {Object} - Normalized product
 */
export function transformProduct(shopifyProduct) {
  const {
    id,
    title,
    handle,
    descriptionHtml,
    vendor,
    productType,
    status,
    tags,
    createdAt,
    updatedAt,
    featuredImage,
    images,
    variants,
    collections,
    metafields
  } = shopifyProduct;

  // Strip HTML from description
  const description = descriptionHtml
    ? stripHtml(descriptionHtml).result.trim()
    : "";

  // Extract numeric ID from GraphQL ID
  const numericId = extractNumericId(id);

  // Transform images
  const imageUrls = images?.edges?.map((edge) => edge.node.url) || [];

  // Transform variants
  const transformedVariants = variants?.edges?.map((edge) =>
    transformVariant(edge.node)
  ) || [];

  // Extract collections
  const collectionNames = collections?.edges?.map((edge) => edge.node.title) || [];

  // Transform metafields to object
  const metafieldsObj = {};
  metafields?.edges?.forEach((edge) => {
    const { namespace, key, value, type } = edge.node;
    if (!metafieldsObj[namespace]) {
      metafieldsObj[namespace] = {};
    }
    metafieldsObj[namespace][key] = parseMetafieldValue(value, type);
  });

  return {
    id: numericId,
    graphqlId: id,
    title,
    handle,
    description,
    descriptionHtml,
    vendor,
    productType,
    status: status?.toLowerCase() || "active",
    tags: tags || [],
    createdAt,
    updatedAt,
    featuredImage: featuredImage?.url || imageUrls[0] || null,
    images: imageUrls,
    variants: transformedVariants,
    collections: collectionNames,
    metafields: metafieldsObj,
    // Computed fields
    currency: transformedVariants[0]?.currency || "USD",
    minPrice: Math.min(...transformedVariants.map((v) => v.price).filter(Boolean)) || 0,
    maxPrice: Math.max(...transformedVariants.map((v) => v.price).filter(Boolean)) || 0,
    hasVariants: transformedVariants.length > 1,
    totalInventory: transformedVariants.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0)
  };
}

/**
 * Transform Shopify variant to common Variant format
 * @param {Object} shopifyVariant - Raw Shopify variant
 * @returns {Object} - Normalized variant
 */
export function transformVariant(shopifyVariant) {
  const {
    id,
    title,
    sku,
    price,
    compareAtPrice,
    availableForSale,
    inventoryQuantity,
    selectedOptions,
    image
  } = shopifyVariant;

  // Parse options into named fields
  const options = {};
  let color = "";
  let size = "";

  selectedOptions?.forEach((opt) => {
    const name = opt.name.toLowerCase();
    options[name] = opt.value;

    if (name === "color" || name === "colour") {
      color = opt.value;
    } else if (name === "size") {
      size = opt.value;
    }
  });

  return {
    id: extractNumericId(id),
    graphqlId: id,
    title,
    sku: sku || "",
    price: parseFloat(price) || 0,
    compareAtPrice: compareAtPrice ? parseFloat(compareAtPrice) : null,
    currency: "USD", // Shopify doesn't include currency per variant
    available: availableForSale !== false,
    inventoryQuantity: inventoryQuantity || 0,
    color,
    size,
    options,
    image: image?.url || null
  };
}

/**
 * Transform Shopify collection to common Collection format
 * @param {Object} shopifyCollection - Raw Shopify collection
 * @returns {Object} - Normalized collection
 */
export function transformCollection(shopifyCollection) {
  const { id, title, handle, description, productsCount, image } = shopifyCollection;

  return {
    id: extractNumericId(id),
    graphqlId: id,
    title,
    handle,
    description: description || "",
    productsCount: productsCount?.count || 0,
    image: image?.url || null
  };
}

/**
 * Extract numeric ID from Shopify GraphQL ID
 * @param {string} graphqlId - e.g., "gid://shopify/Product/123456"
 * @returns {string} - e.g., "123456"
 */
export function extractNumericId(graphqlId) {
  if (!graphqlId) return "";
  const parts = graphqlId.split("/");
  return parts[parts.length - 1];
}

/**
 * Parse metafield value based on type
 * @param {string} value - Raw value
 * @param {string} type - Metafield type
 * @returns {any} - Parsed value
 */
function parseMetafieldValue(value, type) {
  if (!value) return null;

  try {
    switch (type) {
      case "number_integer":
        return parseInt(value, 10);
      case "number_decimal":
        return parseFloat(value);
      case "boolean":
        return value === "true";
      case "json":
      case "list.single_line_text_field":
        return JSON.parse(value);
      default:
        return value;
    }
  } catch {
    return value;
  }
}

/**
 * Build aggregated content string for AI processing
 * @param {Object} product - Transformed product
 * @returns {string} - Combined text content
 */
export function buildAggregatedContent(product) {
  const parts = [product.title];

  if (product.description) {
    parts.push(product.description);
  }

  if (product.vendor) {
    parts.push(`Brand: ${product.vendor}`);
  }

  if (product.productType) {
    parts.push(`Type: ${product.productType}`);
  }

  if (product.tags?.length > 0) {
    parts.push(`Tags: ${product.tags.join(", ")}`);
  }

  if (product.collections?.length > 0) {
    parts.push(`Collections: ${product.collections.join(", ")}`);
  }

  // Add variant info
  const colors = [...new Set(product.variants.map((v) => v.color).filter(Boolean))];
  const sizes = [...new Set(product.variants.map((v) => v.size).filter(Boolean))];

  if (colors.length > 0) {
    parts.push(`Colors: ${colors.join(", ")}`);
  }

  if (sizes.length > 0) {
    parts.push(`Sizes: ${sizes.join(", ")}`);
  }

  return parts.join(". ");
}

export default {
  transformProduct,
  transformVariant,
  transformCollection,
  extractNumericId,
  buildAggregatedContent
};
