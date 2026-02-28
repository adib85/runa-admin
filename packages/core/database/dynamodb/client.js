import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import config from "@runa/config";

/**
 * DynamoDB client singleton with document client for easier operations
 */
class DynamoDBClientWrapper {
  constructor() {
    this.client = null;
    this.docClient = null;
  }

  /**
   * Get the raw DynamoDB client
   */
  getClient() {
    if (!this.client) {
      this.client = new DynamoDBClient({
        region: config.aws.region,
        credentials: config.aws.accessKeyId
          ? {
              accessKeyId: config.aws.accessKeyId,
              secretAccessKey: config.aws.secretAccessKey
            }
          : undefined
      });
    }
    return this.client;
  }

  /**
   * Get the DynamoDB Document Client (handles marshalling/unmarshalling)
   */
  getDocClient() {
    if (!this.docClient) {
      this.docClient = DynamoDBDocumentClient.from(this.getClient(), {
        marshallOptions: {
          convertEmptyValues: true,
          removeUndefinedValues: true
        },
        unmarshallOptions: {
          wrapNumbers: false
        }
      });
    }
    return this.docClient;
  }

  /**
   * Get table names from config
   */
  getTables() {
    return config.dynamodb.tables;
  }
}

// Export singleton instance
export const dynamoClient = new DynamoDBClientWrapper();
export default dynamoClient;
