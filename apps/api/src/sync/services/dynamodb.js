/**
 * DynamoDB Service
 * Handles user data and sync progress storage
 */

import AWS from "aws-sdk";
import { AWS_REGION, DYNAMODB_USER_TABLE } from "./config.js";

class DynamoDBService {
  constructor() {
    AWS.config.update({ region: AWS_REGION });
    this.docClient = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
    this.tableName = DYNAMODB_USER_TABLE;
  }

  async getUserByShop(shop, region = "us-east-1") {
    const params = {
      TableName: this.tableName,
      IndexName: "shop_index",
      KeyConditionExpression: "#shop = :shop",
      ExpressionAttributeNames: { "#shop": "shop" },
      ExpressionAttributeValues: { ":shop": shop }
    };
    const result = await this.docClient.query(params).promise();
    return result.Count > 0 ? result.Items[0] : null;
  }

  async saveUser(user, region = "us-east-1") {
    const params = { TableName: this.tableName, Item: user };
    return this.docClient.put(params).promise();
  }

  async updateSyncProgress(shop, syncInProgress, processed, total, region = "us-east-1") {
    const syncProgress = parseInt(100 * (processed / total));
    const user = await this.getUserByShop(shop, region);
    if (!user) return;
    
    user.syncInProgress = syncInProgress;
    user.syncProgress = syncProgress;
    console.log("updating user", user.shop);
    await this.saveUser(user, region);
  }

  async updateUserContext(shop, region, context) {
    const user = await this.getUserByShop(shop, region);
    if (!user) return;
    
    user.context = context;
    if ((user.chat && user.chat.suggestions && user.chat.suggestions.length === 0) || (user.chat && !user.chat.suggestions)) {
      if (context.suggestions) {
        const newSuggestions = JSON.parse(context.suggestions);
        user.chat.suggestions = newSuggestions.suggestions;
      }
    }
    console.log("saving shop", shop);
    try {
      console.log("saving user", user.id, region);
      await this.saveUser(user, region);
      console.log("save user done");
    } catch (e) {
      console.log(e);
    }
  }

  async updateUserContextFetching(shop, region, fetching) {
    const user = await this.getUserByShop(shop, region);
    if (!user) return;
    
    user.contextFetching = fetching;
    console.log("saving shop", shop);
    try {
      console.log("saving user", user.id, region);
      await this.saveUser(user, region);
    } catch (e) {
      console.log(e);
    }
  }
}

export default new DynamoDBService();
