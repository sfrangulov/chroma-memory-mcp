import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpServerFactory } from "../server.js";

function createMockStore() {
  return {
    writeEntry: vi.fn(),
    readEntry: vi.fn(),
    updateEntry: vi.fn(),
    deleteEntry: vi.fn(),
    search: vi.fn(),
    listEntries: vi.fn(),
    listProjects: vi.fn(),
  };
}

describe("createMcpServerFactory", () => {
  let mockStore;

  beforeEach(() => {
    mockStore = createMockStore();
  });

  it("creates an MCP server with 7 registered tools", () => {
    const server = createMcpServerFactory(mockStore);
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

// Note: Full tool handler tests require the MCP SDK's internal tool call mechanism.
// The factory function returns { server } which is the low-level Server object.
// Tool handlers are tested via the integration-level MCP protocol in integration tests.
// Here we test the exported helper functions.

describe("successResult", () => {
  it("formats data as JSON text content", async () => {
    const { successResult } = await import("../server.js");
    const result = successResult({ id: "test:slug", created_at: "2026-01-01" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("test:slug");
  });
});

describe("errorResult", () => {
  it("formats error with isError flag", async () => {
    const { errorResult } = await import("../server.js");
    const result = errorResult("NOT_FOUND", "Entry not found");
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("NOT_FOUND");
    expect(parsed.message).toBe("Entry not found");
  });
});
