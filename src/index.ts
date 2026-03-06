import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({
  name: "ares-memory",
  version: "1.0.0",
});

const memories: { id: string; text: string; type: string }[] = [];

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

server.tool(
  "store_memory",
  "Store a memory in temporary server memory",
  {
    text: z.string(),
    type: z.string().optional(),
  },
  async ({ text, type }) => {
    const item = {
      id: makeId(),
      text,
      type: type ?? "general",
    };
    memories.push(item);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(item, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "list_memories",
  "List all stored memories",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(memories, null, 2),
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
    const index = memories.findIndex((m) => m.id === id);
    if (index !== -1) memories.splice(index, 1);

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

const port = Number(process.env.PORT || 3000);

const httpServer = http.createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Missing URL");
    return;
  }

  if (req.url.startsWith("/mcp")) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  if (req.url === "/") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", name: "ares-memory" }));
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Ares MCP listening on port ${port}`);
});
