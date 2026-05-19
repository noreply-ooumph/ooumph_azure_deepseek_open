require("dotenv").config();
const { CosmosClient } = require("@azure/cosmos");

let chatsContainer  = null;
let skillsContainer = null;
let cosmosReady     = false;

async function init() {
    if (!process.env.COSMOS_CONNECTION_STRING || process.env.COSMOS_CONNECTION_STRING === "REPLACE_AFTER_STEP_3") {
          console.log("   Cosmos DB not configured — using local JSON files");
          return;
    }
    try {
          const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
          const { database } = await client.databases.createIfNotExists({ id: "ooumphAI" });
          const { container: cc } = await database.containers.createIfNotExists({
                  id: "chats", partitionKey: { paths: ["/id"] }
          });
          const { container: sc } = await database.containers.createIfNotExists({
                  id: "skills", partitionKey: { paths: ["/id"] }
          });
          chatsContainer  = cc;
          skillsContainer = sc;
          cosmosReady     = true;
          console.log("   Cosmos DB connected — chats + skills containers ready");
    } catch (e) {
          console.warn("   Cosmos DB connection failed — falling back to JSON files:", e.message);
    }
}

module.exports = {
    init,
    getChatsContainer:  () => chatsContainer,
    getSkillsContainer: () => skillsContainer,
    isReady:            () => cosmosReady
};
