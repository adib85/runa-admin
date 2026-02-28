import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import dynamoClient from "./client.js";

const TABLE_NAME = dynamoClient.getTables().users;

// GSI names matching the original UserTable schema
const SHOP_INDEX = "shop_index";
const EMAIL_INDEX = "email-index";
const SALES_RANK_INDEX = "estimatedMonthlySales-rank-index";

/**
 * User operations in DynamoDB
 * Maintains compatibility with existing UserTable schema
 */

/**
 * Get user by ID
 * @param {string} userId - User ID
 * @param {string} region - AWS region (for multi-region support)
 * @returns {Promise<Object|undefined>} - User object or undefined
 */
export async function getUserById(userId, region = "us-east-1") {
  const docClient = dynamoClient.getDocClient();

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { id: userId }
    })
  );

  return result.Item;
}

/**
 * Get user by shop domain
 * Uses GSI shop_index for efficient lookup
 * @param {string} shop - Shop domain (e.g., "mystore.myshopify.com")
 * @param {string} region - AWS region
 * @returns {Promise<Object|null>} - User object or null
 */
export async function getUserByShop(shop, region = "us-east-1") {
  const docClient = dynamoClient.getDocClient();

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: SHOP_INDEX,
      KeyConditionExpression: "#shop = :shop",
      ExpressionAttributeNames: { "#shop": "shop" },
      ExpressionAttributeValues: { ":shop": shop }
    })
  );

  return result.Count > 0 ? result.Items[0] : null;
}

/**
 * Get user by email
 * Uses GSI email-index for efficient lookup
 * @param {string} email - User email
 * @param {string} region - AWS region
 * @returns {Promise<Object|null>} - User object or null
 */
export async function getUserByEmail(email, region = "us-east-1") {
  const docClient = dynamoClient.getDocClient();

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: EMAIL_INDEX,
      KeyConditionExpression: "#email = :email",
      ExpressionAttributeNames: { "#email": "email" },
      ExpressionAttributeValues: { ":email": email }
    })
  );

  return result.Count > 0 ? result.Items[0] : null;
}

/**
 * Save/update user
 * @param {Object} item - User object
 * @param {string} region - AWS region
 * @returns {Promise<Object>} - DynamoDB put result
 */
export async function saveUser(item, region = "us-east-1") {
  const docClient = dynamoClient.getDocClient();

  return docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    })
  );
}

/**
 * Update user context (store context/suggestions)
 * @param {string} shop - Shop domain
 * @param {string} region - AWS region
 * @param {Object} context - Context data
 */
export async function updateUserContext(shop, region, context) {
  const user = await getUserByShop(shop, region);
  if (!user) {
    console.error(`User not found for shop: ${shop}`);
    return;
  }

  user.context = context;

  // Update chat suggestions if available
  if (context.suggestions) {
    try {
      const newSuggestions = JSON.parse(context.suggestions);
      if (!user.chat) user.chat = {};
      if (!user.chat.suggestions || user.chat.suggestions.length === 0) {
        user.chat.suggestions = newSuggestions.suggestions;
      }
    } catch (e) {
      console.error("Failed to parse suggestions:", e);
    }
  }

  await saveUser(user, region);
}

/**
 * Update user context fetching status
 * @param {string} shop - Shop domain
 * @param {string} region - AWS region
 * @param {string} status - Status: "pending", "inProgress", "done", "error"
 */
export async function updateUserContextFetching(shop, region, status) {
  const user = await getUserByShop(shop, region);
  if (!user) {
    console.error(`User not found for shop: ${shop}`);
    return;
  }

  user.contextFetching = status;
  await saveUser(user, region);
}

/**
 * Get all users (paginated)
 * @param {Object} LastEvaluatedKey - The last evaluated key for pagination
 * @returns {Promise<{ results: Array, LastEvaluatedKey: any }>}
 */
export async function getAllUsers(LastEvaluatedKey) {
  const docClient = dynamoClient.getDocClient();

  let params;
  if (LastEvaluatedKey) {
    params = {
      TableName: TABLE_NAME,
      ExclusiveStartKey: LastEvaluatedKey
    };
  } else {
    params = {
      TableName: TABLE_NAME
    };
  }

  const dbResult = await docClient.send(new ScanCommand(params));

  let newLastEvaluatedKey = dbResult.LastEvaluatedKey;

  let results = [];
  if (dbResult.ScannedCount > 0) {
    results = dbResult.Items;
  }

  return {
    results: results,
    LastEvaluatedKey: newLastEvaluatedKey
  };
}

/**
 * Finds users by estimated monthly sales, sorted by rank in ascending order,
 * attempting to retrieve a specified number of items while handling pagination.
 * @param {string} salesRange - The estimated monthly sales range.
 * @param {number} itemsToFetch - The maximum number of items to retrieve.
 * @returns {Promise<{ results: Array, LastEvaluatedKey: any }>} - The query results, sorted by rank in ascending order.
 */
export async function findUsersBySales(salesRange, itemsToFetch) {
  const docClient = dynamoClient.getDocClient();
  let allResults = [];
  let newLastEvaluatedKey = null;

  let params = {
    TableName: TABLE_NAME,
    IndexName: SALES_RANK_INDEX,
    KeyConditionExpression: "#ems = :emsVal",
    ExpressionAttributeNames: {
      "#ems": "estimatedMonthlySales"
    },
    ExpressionAttributeValues: {
      ":emsVal": salesRange
    }
  };

  do {
    const dbResult = await docClient.send(new QueryCommand(params));
    allResults = [...allResults, ...dbResult.Items];

    newLastEvaluatedKey = dbResult.LastEvaluatedKey;
    if (newLastEvaluatedKey) {
      params.ExclusiveStartKey = newLastEvaluatedKey;
    }

    // Adjust the limit based on items fetched
    itemsToFetch -= dbResult.Items.length;

    if (itemsToFetch <= 0) break; // Exit if we've collected the desired number of items
    else params.Limit = itemsToFetch; // Update the limit for the next iteration
  } while (newLastEvaluatedKey && itemsToFetch > 0);

  let data = {
    results: allResults.slice(0, itemsToFetch), // Ensure we return no more than the specified number of items
    LastEvaluatedKey: newLastEvaluatedKey
  };

  console.log(data.results.length);

  return data;
}

/**
 * Finds users by estimated monthly sales and filters the results for a specific estimated products sold range,
 * sorted by rank in ascending order, attempting to retrieve a specified number of items while handling pagination.
 * @param {string} salesRange - The estimated monthly sales range.
 * @param {string} productSoldRange - The range of estimated products sold.
 * @param {number} itemsToFetch - The maximum number of items to retrieve.
 * @returns {Promise<{ results: Array, LastEvaluatedKey: any }>} - The query results, sorted by rank in ascending order.
 */
export async function findUsersBySalesAndProductsSoldSortedByRank(
  salesRange,
  productSoldRange,
  itemsToFetch
) {
  const docClient = dynamoClient.getDocClient();
  let allResults = [];
  let newLastEvaluatedKey = null;

  let params = {
    TableName: TABLE_NAME,
    IndexName: SALES_RANK_INDEX,
    KeyConditionExpression: "#ems = :emsVal",
    FilterExpression: "#eps = :epsVal",
    ExpressionAttributeNames: {
      "#ems": "estimatedMonthlySales",
      "#eps": "estimatedProductsSold"
    },
    ExpressionAttributeValues: {
      ":emsVal": salesRange,
      ":epsVal": productSoldRange
    }
  };

  do {
    const dbResult = await docClient.send(new QueryCommand(params));
    allResults = [...allResults, ...dbResult.Items];

    newLastEvaluatedKey = dbResult.LastEvaluatedKey;
    if (newLastEvaluatedKey) {
      params.ExclusiveStartKey = newLastEvaluatedKey;
    }

    // Adjust the limit based on items fetched
    itemsToFetch -= dbResult.Items.length;

    if (itemsToFetch <= 0) break; // Exit if we've collected the desired number of items
    else params.Limit = itemsToFetch; // Update the limit for the next iteration
  } while (newLastEvaluatedKey && itemsToFetch > 0);

  let data = {
    results: allResults.slice(0, itemsToFetch), // Ensure we return no more than the specified number of items
    LastEvaluatedKey: newLastEvaluatedKey
  };

  console.log(data.results.length);

  return data;
}

// Aliases for compatibility with crawler project naming
export const findUserById = getUserById;
export const findAllUsersPaginated = getAllUsers;

export default {
  getUserById,
  findUserById,
  getUserByShop,
  getUserByEmail,
  saveUser,
  updateUserContext,
  updateUserContextFetching,
  getAllUsers,
  findAllUsersPaginated,
  findUsersBySales,
  findUsersBySalesAndProductsSoldSortedByRank
};
