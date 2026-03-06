import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION = "ares_memory_plain";

if (!QDRANT_URL || !QDRANT_API_KEY) {
  throw new Error("Missing QDRANT_URL or QDRANT_API_KEY");
}

const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

async function ensureCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: {
        size: 1,
        distance: "Cosine",
      },
    });
  }
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function createServer() {
  const server = new McpServer({
    name: "ares-memory",
    version: "1.0.0",
  });

  server.tool(
    "store_memory",
    "Store one memory string in persistent storage",
    {
      memory: z.string(),
    },
    async ({ memory }) => {
      const id = makeId();

      await qdrant.upsert(COLLECTION, {
        wait: true,
        points: [
          {
            id,
            vector: [0],
            payload: {
              memory,
              created_at: new Date().toISOString(),
            },
          },
        ],
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "stored",
                id,
                memory,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "list_memories",
    "List all stored memories from Qdrant",
    {},
    async () => {
      const result = await qdrant.scroll(COLLECTION, {
        limit: 100,
        with_payload: true,
        with_vector: false,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              result.points.map((p) => ({
                id: p.id,
                memory: p.payload?.memory ?? "",
                created_at: p.payload?.created_at ?? null,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "delete_memory",
    "Delete a memory by ID",
    {
      id: z.string(),
    },
    async ({ id }) => {
      await qdrant.delete(COLLECTION, {
        wait: true,
        points: [id],
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "deleted",
                id,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}

const port = Number(process.env.PORT || 3000);

await ensureCollection();

const httpServer = http.createServer(async (req, res) => {
  try {
    if (!req.url) {
      res.statusCode = 400;
      res.end("Missing URL");
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Accept, mcp-session-id"
    );
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.url === "/") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          status: "ok",
          name: "ares-memory-qdrant-plain",
        })
      );
      return;
    }

    if (req.url.startsWith("/mcp")) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  } catch (err) {
    console.error("MCP server error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Internal server error",
      })
    );
  }
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Ares MCP listening on port ${port}`);
});
