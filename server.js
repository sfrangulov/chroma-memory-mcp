#!/usr/bin/env node

/**
 * Chroma Memory MCP Server
 *
 * Streamable HTTP transport with Google OAuth2 auth and 7 memory tools.
 * Exports createMcpServerFactory(store) for testing; runs Express+MCP when executed directly.
 *
 * @module server
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import { ChromaClient } from "chromadb";
import { GoogleGeminiEmbeddingFunction } from "@chroma-core/google-gemini";
import { createMemoryStore } from "./lib/memory-store.js";
import { extractUserEmail } from "./lib/auth.js";
import { createOAuthProvider } from "./lib/oauth-provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(code, message) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
  };
}

// ---------------------------------------------------------------------------
// Factory (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Creates an McpServer wired to the given memory store.
 *
 * @param {object} store - memory store returned by createMemoryStore()
 * @returns {{ server: import("@modelcontextprotocol/sdk/server/index.js").Server }}
 */
export function createMcpServerFactory(store) {
  const mcpServer = new McpServer(
    { name: "chroma-memory", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  // 1. write_entry ---------------------------------------------------------
  mcpServer.registerTool(
    "write_entry",
    {
      description: "Create a new memory entry",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        slug: z.string().describe("URL-safe short name"),
        title: z.string().describe("Human-readable title"),
        content: z.string().describe("Markdown content"),
        tags: z.array(z.string()).default([]).describe("Categorisation tags"),
        type: z
          .enum(["note", "decision", "snippet", "doc", "log"])
          .default("note")
          .describe("Entry type"),
      },
    },
    async (args, extra) => {
      const author = extractUserEmail(extra.authInfo) || "anonymous";
      try {
        const result = await store.writeEntry({ ...args, author });
        return successResult(result);
      } catch (err) {
        if (err.message.includes("already exists")) {
          return errorResult("ALREADY_EXISTS", err.message);
        }
        throw err;
      }
    },
  );

  // 2. read_entry ----------------------------------------------------------
  mcpServer.registerTool(
    "read_entry",
    {
      description: "Read a memory entry by project and slug",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        slug: z.string().describe("Entry slug"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ project, slug }) => {
      const entry = await store.readEntry(project, slug);
      if (!entry) {
        return errorResult("NOT_FOUND", `Entry "${project}:${slug}" not found`);
      }
      return successResult(entry);
    },
  );

  // 3. update_entry --------------------------------------------------------
  mcpServer.registerTool(
    "update_entry",
    {
      description: "Update an existing memory entry",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        slug: z.string().describe("Entry slug"),
        content: z.string().optional().describe("New markdown content"),
        title: z.string().optional().describe("New title"),
        tags: z.array(z.string()).optional().describe("New tags"),
        type: z
          .enum(["note", "decision", "snippet", "doc", "log"])
          .optional()
          .describe("New entry type"),
      },
    },
    async ({ project, slug, ...changes }) => {
      try {
        const result = await store.updateEntry(project, slug, changes);
        return successResult(result);
      } catch (err) {
        if (err.message.includes("not found")) {
          return errorResult("NOT_FOUND", err.message);
        }
        throw err;
      }
    },
  );

  // 4. delete_entry --------------------------------------------------------
  mcpServer.registerTool(
    "delete_entry",
    {
      description: "Delete a memory entry",
      inputSchema: {
        project: z.string().describe("Project identifier"),
        slug: z.string().describe("Entry slug"),
      },
    },
    async ({ project, slug }) => {
      try {
        const result = await store.deleteEntry(project, slug);
        return successResult(result);
      } catch (err) {
        if (err.message.includes("not found")) {
          return errorResult("NOT_FOUND", err.message);
        }
        throw err;
      }
    },
  );

  // 5. search --------------------------------------------------------------
  mcpServer.registerTool(
    "search",
    {
      description: "Semantic search across memory entries",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        query: z.string().describe("Natural-language search query"),
        project: z.string().optional().describe("Filter by project"),
        author: z.string().optional().describe("Filter by author email"),
        n_results: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Max results to return"),
      },
    },
    async ({ query, project, author, n_results }) => {
      const results = await store.search({
        query,
        project,
        author,
        nResults: n_results,
      });
      return successResult(results);
    },
  );

  // 6. list_entries --------------------------------------------------------
  mcpServer.registerTool(
    "list_entries",
    {
      description: "List memory entries with optional filters",
      inputSchema: {
        project: z.string().optional().describe("Filter by project"),
        author: z.string().optional().describe("Filter by author email"),
        type: z
          .enum(["note", "decision", "snippet", "doc", "log"])
          .optional()
          .describe("Filter by entry type"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ project, author, type }) => {
      const entries = await store.listEntries({ project, author, type });
      return successResult(entries);
    },
  );

  // 7. list_projects -------------------------------------------------------
  mcpServer.registerTool(
    "list_projects",
    {
      description: "List all unique project names",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      const projects = await store.listProjects();
      return successResult(projects);
    },
  );

  return { server: mcpServer.server };
}

// ---------------------------------------------------------------------------
// Main (Express + Streamable HTTP transport)
// ---------------------------------------------------------------------------

async function main() {
  const CONFIG = {
    port: parseInt(process.env.MCP_PORT || "3000", 10),
    host: process.env.MCP_HOST || "0.0.0.0",
    chromaUrl: process.env.CHROMA_URL || "http://localhost:8000",
    chromaCollection: process.env.CHROMA_COLLECTION || "memories",
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleApiKey: process.env.GOOGLE_API_KEY,
    baseUrl: process.env.MCP_BASE_URL, // e.g. https://memory.example.com — required for auth
  };

  // ChromaDB client — parse URL into host + port for chromadb v3
  const chromaUrl = new URL(CONFIG.chromaUrl);
  const chromaClient = new ChromaClient({
    host: chromaUrl.hostname,
    port: parseInt(chromaUrl.port || "8000", 10),
    ssl: chromaUrl.protocol === "https:",
  });

  // Wait for ChromaDB to be ready (for Docker startup ordering)
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await chromaClient.heartbeat();
      break;
    } catch {
      if (attempt === 10) throw new Error("ChromaDB not available after 10 attempts");
      console.log(`Waiting for ChromaDB (attempt ${attempt}/10)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // Embedding function — requires GOOGLE_API_KEY
  let embeddingFunction = null;
  if (CONFIG.googleApiKey) {
    embeddingFunction = new GoogleGeminiEmbeddingFunction({
      apiKey: CONFIG.googleApiKey,
      apiKeyEnvVar: "GOOGLE_API_KEY",
      modelName: "gemini-embedding-001",
    });
  } else {
    console.log("Embeddings disabled — set GOOGLE_API_KEY to enable semantic search");
  }

  // Memory store
  const store = await createMemoryStore({
    client: chromaClient,
    embeddingFunction,
    collectionName: CONFIG.chromaCollection,
  });

  // Express app
  const app = createMcpExpressApp({ host: CONFIG.host });
  app.set("trust proxy", 1); // Behind nginx ingress

  // Auth setup — optional, requires MCP_BASE_URL, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET
  const authEnabled = CONFIG.baseUrl && CONFIG.googleClientId && CONFIG.googleClientSecret;
  let authMiddleware = (_req, _res, next) => next(); // no-op for dev mode

  if (authEnabled) {
    const provider = createOAuthProvider({
      googleClientId: CONFIG.googleClientId,
      googleClientSecret: CONFIG.googleClientSecret,
      baseUrl: CONFIG.baseUrl,
    });

    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(CONFIG.baseUrl),
        baseUrl: new URL(CONFIG.baseUrl),
        serviceDocumentationUrl: new URL(
          "https://github.com/anthropics/claude-shared-memory-plugin",
        ),
      }),
    );

    // Google OAuth callback (proxied — not part of MCP spec)
    app.get("/oauth/google/callback", provider.handleGoogleCallback.bind(provider));

    authMiddleware = requireBearerAuth({
      verifier: provider,
      requiredScopes: [],
      resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource", CONFIG.baseUrl),
    });
  } else {
    console.log(
      "Auth disabled — set MCP_BASE_URL, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET to enable",
    );
  }

  // Transport sessions
  const transports = {};

  // Helper: create a new MCP server + transport for a session
  function createServerFactory() {
    return createMcpServerFactory(store);
  }

  // POST /mcp — main MCP endpoint
  app.post("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      let transport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        const { server } = createServerFactory();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET /mcp — SSE stream for server notifications
  app.get("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE /mcp — session cleanup
  app.delete("/mcp", authMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      console.error("Error handling session termination:", error);
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination");
      }
    }
  });

  // GET /health — health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Start listening
  app.listen(CONFIG.port, CONFIG.host, () => {
    console.log(
      `Chroma Memory MCP server listening on http://${CONFIG.host}:${CONFIG.port}/mcp`,
    );
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    for (const sid of Object.keys(transports)) {
      try {
        await transports[sid].close();
        delete transports[sid];
      } catch (err) {
        console.error(`Error closing session ${sid}:`, err);
      }
    }
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Run main() only when executed directly (not imported for testing)
// ---------------------------------------------------------------------------

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
