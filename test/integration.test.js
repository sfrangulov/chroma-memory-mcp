import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChromaClient } from "chromadb";
import { DefaultEmbeddingFunction } from "@chroma-core/default-embed";
import { createMemoryStore } from "../lib/memory-store.js";

/**
 * Integration tests — require ChromaDB running on localhost:8100.
 *
 * Start: docker compose -f docker-compose.test.yml up -d --wait
 * Stop:  docker compose -f docker-compose.test.yml down
 */

const CHROMA_URL = process.env.TEST_CHROMA_URL || "http://localhost:8100";

describe("Integration: Memory Store + ChromaDB", () => {
  let client;
  let store;

  beforeAll(async () => {
    const url = new URL(CHROMA_URL);
    client = new ChromaClient({
      host: url.hostname,
      port: parseInt(url.port || "8000", 10),
    });

    // Wait for ChromaDB to be ready
    let retries = 10;
    while (retries > 0) {
      try {
        await client.heartbeat();
        break;
      } catch {
        retries--;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (retries === 0) throw new Error("ChromaDB not available");

    // Clean slate — delete test collection if it exists
    try {
      await client.deleteCollection({ name: "integration-test" });
    } catch { /* ignore */ }

    const embeddingFunction = new DefaultEmbeddingFunction();
    store = await createMemoryStore({
      client,
      embeddingFunction,
      collectionName: "integration-test",
    });
  });

  afterAll(async () => {
    try {
      await client.deleteCollection({ name: "integration-test" });
    } catch { /* ignore */ }
  });

  it("write → read → update → delete lifecycle", async () => {
    // Write
    const written = await store.writeEntry({
      project: "test-project",
      slug: "test-entry",
      title: "Test Entry",
      content: "This is a test entry for integration testing",
      author: "test@example.com",
      tags: ["test", "integration"],
      type: "note",
    });
    expect(written.id).toBe("test-project:test-entry");
    expect(written.created_at).toBeTruthy();

    // Read
    const read = await store.readEntry("test-project", "test-entry");
    expect(read).not.toBeNull();
    expect(read.metadata.title).toBe("Test Entry");
    expect(read.metadata.author).toBe("test@example.com");
    expect(read.metadata.tags).toBe("test,integration");
    expect(read.document).toContain("This is a test entry for integration testing");

    // Update
    const updated = await store.updateEntry("test-project", "test-entry", {
      title: "Updated Test Entry",
      content: "Updated content for integration test",
      tags: ["test", "updated"],
    });
    expect(updated.id).toBe("test-project:test-entry");
    expect(updated.updated_at).toBeTruthy();

    // Read again to verify update
    const readAgain = await store.readEntry("test-project", "test-entry");
    expect(readAgain.metadata.title).toBe("Updated Test Entry");
    expect(readAgain.metadata.tags).toBe("test,updated");
    expect(readAgain.document).toContain("Updated content for integration test");

    // Delete
    const deleted = await store.deleteEntry("test-project", "test-entry");
    expect(deleted.deleted).toBe(true);

    // Verify deleted
    const readDeleted = await store.readEntry("test-project", "test-entry");
    expect(readDeleted).toBeNull();
  });

  it("listEntries filters by project", async () => {
    await store.writeEntry({
      project: "proj-a", slug: "e1", title: "Entry A1",
      content: "A1", author: "a@b.com", tags: [], type: "note",
    });
    await store.writeEntry({
      project: "proj-b", slug: "e2", title: "Entry B1",
      content: "B1", author: "a@b.com", tags: [], type: "note",
    });

    const projA = await store.listEntries({ project: "proj-a" });
    expect(projA).toHaveLength(1);
    expect(projA[0].id).toBe("proj-a:e1");

    const projB = await store.listEntries({ project: "proj-b" });
    expect(projB).toHaveLength(1);
    expect(projB[0].id).toBe("proj-b:e2");

    // Cleanup
    await store.deleteEntry("proj-a", "e1");
    await store.deleteEntry("proj-b", "e2");
  });

  it("listProjects returns unique projects", async () => {
    await store.writeEntry({
      project: "unique-a", slug: "u1", title: "U1",
      content: "u1", author: "a@b.com", tags: [], type: "note",
    });
    await store.writeEntry({
      project: "unique-b", slug: "u2", title: "U2",
      content: "u2", author: "a@b.com", tags: [], type: "note",
    });

    const projects = await store.listProjects();
    expect(projects).toContain("unique-a");
    expect(projects).toContain("unique-b");

    // Cleanup
    await store.deleteEntry("unique-a", "u1");
    await store.deleteEntry("unique-b", "u2");
  });

  it("rejects duplicate write", async () => {
    await store.writeEntry({
      project: "dup", slug: "same", title: "Original",
      content: "original", author: "a@b.com", tags: [], type: "note",
    });

    await expect(
      store.writeEntry({
        project: "dup", slug: "same", title: "Duplicate",
        content: "dup", author: "b@c.com", tags: [], type: "note",
      })
    ).rejects.toThrow("already exists");

    // Cleanup
    await store.deleteEntry("dup", "same");
  });

  it("tracks entry count via listEntries", async () => {
    const before = await store.listEntries({});

    await store.writeEntry({
      project: "count-test", slug: "c1", title: "Count1",
      content: "c1", author: "a@b.com", tags: [], type: "note",
    });

    const after = await store.listEntries({});
    expect(after.length).toBe(before.length + 1);

    // Cleanup
    await store.deleteEntry("count-test", "c1");
  });

  it("update on non-existent entry throws", async () => {
    await expect(
      store.updateEntry("ghost", "missing", { title: "Nope" })
    ).rejects.toThrow("not found");
  });

  it("delete on non-existent entry throws", async () => {
    await expect(
      store.deleteEntry("ghost", "missing")
    ).rejects.toThrow("not found");
  });

  it("listEntries filters by author", async () => {
    await store.writeEntry({
      project: "auth-test", slug: "by-alice", title: "Alice Entry",
      content: "alice", author: "alice@co.com", tags: ["x"], type: "note",
    });
    await store.writeEntry({
      project: "auth-test", slug: "by-bob", title: "Bob Entry",
      content: "bob", author: "bob@co.com", tags: ["y"], type: "decision",
    });

    const aliceOnly = await store.listEntries({
      project: "auth-test",
      author: "alice@co.com",
    });
    expect(aliceOnly).toHaveLength(1);
    expect(aliceOnly[0].id).toBe("auth-test:by-alice");

    const decisions = await store.listEntries({
      project: "auth-test",
      type: "decision",
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe("auth-test:by-bob");

    // Cleanup
    await store.deleteEntry("auth-test", "by-alice");
    await store.deleteEntry("auth-test", "by-bob");
  });
});
