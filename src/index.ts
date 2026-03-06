import http from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const COLLECTION = "ares_memory";

if (!QDRANT_URL || !QDRANT_API_KEY || !OPENROUTER_API_KEY) {
  throw new Error("Missing QDRANT_URL, QDRANT_API_KEY, or OPENROUTER_API_KEY");
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
        size: 1536,
        distance: "Cosine",
      },
    });
  }
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!res.ok) {
    throw new Error(`Embedding error: ${await res.text()}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

function createServer() {
  const server = new McpServer({
    name: "ares-memory",
    version: "1.0.0",
  });

  server.tool(
    "store_memory",
    "Store a memory string in external memory",
    {
      text: z.string(),
      type: z.string().optional(),
    },
    async ({ text, type }) => {
      const vector = await embed(text);
      const id = randomUUID();

      await qdrant.upsert(COLLECTION, {
        wait: true,
        points: [
          {
            id,
            vector,
            payload: {
              text,
              type: type ?? "general",
              created_at: new Date().toISOString(),
            },
          },
        ],
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "stored", id, text }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "search_memory",
    "Search relevant memories by semantic similarity",
    {
      query: z.string(),
      limit: z.number().optional(),
    },
    async ({ query, limit }) => {
      const vector = await embed(query);

      const results = await qdrant.search(COLLECTION, {
        vector,
        limit: limit ?? 5,
        with_payload: true,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              results.map((r) => ({
                id: r.id,
                score: r.score,
                text: r.payload?.text ?? "",
                type: r.payload?.type ?? "general",
                created_at: r.payload?.created_at ?? null,
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
    "list_memories",
    "List stored memories",
    {
      limit: z.number().optional(),
    },
    async ({ limit }) => {
      const result = await qdrant.scroll(COLLECTION, {
        limit: limit ?? 20,
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
                text: p.payload?.text ?? "",
                type: p.payload?.type ?? "general",
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
            text: JSON.stringify({ status: "deleted", id }, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

function isInitializeRequest(body: any): boolean {
  if (!body) return false;
  if (Array.isArray(body)) {
    return body.some((msg) => msg?.method === "initialize");
  }
  return body?.method === "initialize";
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

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.url === "/") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok", name: "ares-memory" }));
      return;
    }

    if (!req.url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    // Read JSON body for POST requests
    let body: any = undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? JSON.parse(raw) : undefined;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          transports.set(newSessionId, transport!);
        },
      });

      transport.onclose = () => {
        if (transport?.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = createServer();
      await server.connect(transport);
    } else {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        })
      );
      return;
    }

    await transport!.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP server error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal server error",
        },
        id: null,
      })
    );
  }
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Ares MCP listening on port ${port}`);
});
