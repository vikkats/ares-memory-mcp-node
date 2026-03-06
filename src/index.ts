import http from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { createNodeHttpMcpHandler } from "@modelcontextprotocol/node";

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

const app = http.createServer(
  createNodeHttpMcpHandler(server, {
    basePath: "/mcp",
    cors: {
      origin: "*",
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Accept", "mcp-session-id"],
      exposedHeaders: ["mcp-session-id"],
    },
  })
);

app.listen(port, "0.0.0.0", () => {
  console.log(`Ares MCP listening on port ${port}`);
});
