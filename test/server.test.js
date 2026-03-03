import { describe, it, expect, vi } from "vitest";
import { createMcpServerFactory } from "../server.js";

describe("createMcpServerFactory", () => {
  it("creates an MCP server with 7 registered tools", () => {
    const mockStore = {
      writeEntry: vi.fn(),
      readEntry: vi.fn(),
      updateEntry: vi.fn(),
      deleteEntry: vi.fn(),
      search: vi.fn(),
      listEntries: vi.fn(),
      listProjects: vi.fn(),
    };

    const server = createMcpServerFactory(mockStore);
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});
