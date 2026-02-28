import neo4j from "neo4j-driver";
import { config } from "@runa/config";

/**
 * Neo4j client with connection pooling.
 * Singleton pattern to reuse connections across the application.
 */
class Neo4jClient {
  constructor() {
    this.driver = null;
  }

  /**
   * Get or create the Neo4j driver instance
   */
  getDriver() {
    if (!this.driver) {
      this.driver = neo4j.driver(
        config.neo4j.uri,
        neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
        {
          maxConnectionPoolSize: config.neo4j.maxConnectionPoolSize,
          connectionTimeout: config.neo4j.connectionTimeout
        }
      );
    }
    return this.driver;
  }

  /**
   * Execute work within a session, automatically handling session lifecycle
   * @param {Function} work - Async function that receives the session
   * @returns {Promise<any>} - Result of the work function
   */
  async withSession(work) {
    const session = this.getDriver().session();
    try {
      return await work(session);
    } finally {
      await session.close();
    }
  }

  /**
   * Execute work within a transaction, with automatic commit/rollback
   * @param {Function} work - Async function that receives the transaction
   * @returns {Promise<any>} - Result of the work function
   */
  async withTransaction(work) {
    return this.withSession(async (session) => {
      const tx = session.beginTransaction();
      try {
        const result = await work(tx);
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    });
  }

  /**
   * Run a simple query
   * @param {string} cypher - Cypher query string
   * @param {Object} params - Query parameters
   * @returns {Promise<any>} - Query result records
   */
  async run(cypher, params = {}) {
    return this.withSession(async (session) => {
      const result = await session.run(cypher, params);
      return result.records;
    });
  }

  /**
   * Close the driver connection
   */
  async close() {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  /**
   * Verify connectivity to the database
   */
  async verifyConnectivity() {
    try {
      await this.getDriver().verifyConnectivity();
      return true;
    } catch (error) {
      console.error("Neo4j connectivity check failed:", error.message);
      return false;
    }
  }
}

// Export singleton instance
export const neo4jClient = new Neo4jClient();
export default neo4jClient;
