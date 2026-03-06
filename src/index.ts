import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({
  name: "ares-test",
  version: "1.0.0",
});

server.tool(
  "hello",
  "Simple test tool",
  {
    name: z.string().optional(),
  },
  async ({ name }) => {
    return {
      content: [
        {
          type: "text",
          text: `Hello${name ? `, ${name}` : ""} from Ares MCP`,
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
    res.end(JSON.stringify({ status: "ok", name: "ares-test" }));
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Ares MCP listening on port ${port}`);
});
