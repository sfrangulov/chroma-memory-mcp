import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryStore } from "../lib/memory-store.js";

// Mock ChromaDB collection
function createMockCollection() {
  return {
    add: vi.fn(),
    query: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
    upsert: vi.fn(),
  };
}

// Mock ChromaDB client
function createMockClient() {
  const collection = createMockCollection();
  return {
    getOrCreateCollection: vi.fn().mockResolvedValue(collection),
    _collection: collection,
  };
}

describe("createMemoryStore", () => {
  let mockClient;
  let store;

  beforeEach(async () => {
    mockClient = createMockClient();
    store = await createMemoryStore({
      client: mockClient,
      embeddingFunction: null,
      collectionName: "test-memories",
    });
  });

  it("creates collection on init", () => {
    expect(mockClient.getOrCreateCollection).toHaveBeenCalledWith({
      name: "test-memories",
      embeddingFunction: null,
    });
  });

  describe("writeEntry", () => {
    it("adds document with metadata", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: [] });

      await store.writeEntry({
        project: "backend",
        slug: "postgres-optimization",
        title: "PostgreSQL Query Optimization",
        content: "Use indexes for large tables...",
        author: "sergei@gmail.com",
        tags: ["postgres", "performance"],
        type: "decision",
      });

      expect(collection.add).toHaveBeenCalledWith({
        ids: ["backend:postgres-optimization"],
        documents: ["# PostgreSQL Query Optimization\n\n- **Author:** sergei@gmail.com\n- **Tags:** postgres, performance\n- **Type:** decision\n\nUse indexes for large tables..."],
        metadatas: [{
          project: "backend",
          title: "PostgreSQL Query Optimization",
          author: "sergei@gmail.com",
          tags: "postgres,performance",
          type: "decision",
          created_at: expect.any(String),
          updated_at: expect.any(String),
        }],
      });
    });

    it("rejects duplicate entry", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: ["backend:postgres-optimization"] });

      await expect(
        store.writeEntry({
          project: "backend",
          slug: "postgres-optimization",
          title: "Duplicate",
          content: "...",
          author: "a@b.com",
          tags: [],
          type: "note",
        })
      ).rejects.toThrow("already exists");
    });
  });

  describe("readEntry", () => {
    it("returns entry by id", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({
        ids: ["backend:pg-opt"],
        documents: ["# PG Optimization\n\ncontent"],
        metadatas: [{ project: "backend", title: "PG Optimization", author: "a@b.com", tags: "pg", type: "note", created_at: "2026-03-02", updated_at: "2026-03-02" }],
      });

      const result = await store.readEntry("backend", "pg-opt");
      expect(result.id).toBe("backend:pg-opt");
      expect(result.document).toBe("# PG Optimization\n\ncontent");
      expect(result.metadata.project).toBe("backend");
    });

    it("returns null for non-existent entry", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: [], documents: [], metadatas: [] });

      const result = await store.readEntry("backend", "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("search", () => {
    it("performs semantic search with metadata filter", async () => {
      const collection = mockClient._collection;
      collection.query.mockResolvedValue({
        ids: [["backend:pg-opt"]],
        documents: [["# PG Optimization"]],
        metadatas: [[{ project: "backend", title: "PG Optimization", tags: "pg,sql" }]],
        distances: [[0.15]],
      });

      // Create a store with an embedding function to bypass the guard
      const embeddingStore = await createMemoryStore({
        client: mockClient,
        embeddingFunction: {},
        collectionName: "test",
      });

      const results = await embeddingStore.search({
        query: "database performance",
        project: "backend",
        nResults: 5,
      });

      expect(collection.query).toHaveBeenCalledWith({
        queryTexts: ["database performance"],
        nResults: 5,
        where: { project: "backend" },
        include: ["documents", "metadatas", "distances"],
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("backend:pg-opt");
      expect(results[0].distance).toBe(0.15);
    });

    it("searches without project filter", async () => {
      const collection = mockClient._collection;
      collection.query.mockResolvedValue({
        ids: [[]], documents: [[]], metadatas: [[]], distances: [[]],
      });

      // Create a store with an embedding function to bypass the guard
      const embeddingStore = await createMemoryStore({
        client: mockClient,
        embeddingFunction: {},
        collectionName: "test",
      });

      await embeddingStore.search({ query: "test", nResults: 10 });

      expect(collection.query).toHaveBeenCalledWith({
        queryTexts: ["test"],
        nResults: 10,
        include: ["documents", "metadatas", "distances"],
      });
    });

    it("throws when no embedding function is configured", async () => {
      await expect(
        store.search({ query: "test", nResults: 5 })
      ).rejects.toThrow("Semantic search requires GOOGLE_API_KEY");
    });

    it("applies combined project + author filter", async () => {
      const collection = mockClient._collection;
      collection.query.mockResolvedValue({
        ids: [[]], documents: [[]], metadatas: [[]], distances: [[]],
      });

      const embeddingStore = await createMemoryStore({
        client: mockClient,
        embeddingFunction: {},
        collectionName: "test",
      });

      await embeddingStore.search({ query: "test", project: "backend", author: "a@b.com" });

      expect(collection.query).toHaveBeenCalledWith({
        queryTexts: ["test"],
        nResults: 10,
        where: { $and: [{ project: "backend" }, { author: "a@b.com" }] },
        include: ["documents", "metadatas", "distances"],
      });
    });
  });

  describe("updateEntry", () => {
    it("updates document and metadata", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({
        ids: ["backend:pg-opt"],
        documents: ["# Old\n\n- **Author:** a@b.com\n- **Tags:** pg\n- **Type:** note\n\nOld content"],
        metadatas: [{ project: "backend", title: "Old", author: "a@b.com", tags: "pg", type: "note", created_at: "2026-03-01", updated_at: "2026-03-01" }],
      });

      await store.updateEntry("backend", "pg-opt", {
        title: "Updated Title",
        content: "New content",
        tags: ["pg", "updated"],
      });

      expect(collection.update).toHaveBeenCalledWith({
        ids: ["backend:pg-opt"],
        documents: ["# Updated Title\n\n- **Author:** a@b.com\n- **Tags:** pg, updated\n- **Type:** note\n\nNew content"],
        metadatas: [expect.objectContaining({
          title: "Updated Title",
          tags: "pg,updated",
          updated_at: expect.any(String),
        })],
      });
    });

    it("preserves existing content when content not provided", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({
        ids: ["backend:pg-opt"],
        documents: ["# Old Title\n\n- **Author:** a@b.com\n- **Tags:** pg\n- **Type:** note\n\nExisting content here"],
        metadatas: [{ project: "backend", title: "Old Title", author: "a@b.com", tags: "pg", type: "note", created_at: "2026-03-01", updated_at: "2026-03-01" }],
      });

      await store.updateEntry("backend", "pg-opt", {
        title: "New Title Only",
      });

      expect(collection.update).toHaveBeenCalledWith({
        ids: ["backend:pg-opt"],
        documents: [expect.stringContaining("Existing content here")],
        metadatas: [expect.objectContaining({ title: "New Title Only" })],
      });
    });

    it("throws on non-existent entry", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: [], documents: [], metadatas: [] });

      await expect(
        store.updateEntry("backend", "nonexistent", { content: "x" })
      ).rejects.toThrow("not found");
    });
  });

  describe("deleteEntry", () => {
    it("deletes by id", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: ["backend:pg-opt"] });

      await store.deleteEntry("backend", "pg-opt");

      expect(collection.delete).toHaveBeenCalledWith({
        ids: ["backend:pg-opt"],
      });
    });

    it("throws on non-existent entry", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: [] });

      await expect(
        store.deleteEntry("backend", "nonexistent")
      ).rejects.toThrow("not found");
    });
  });

  describe("listEntries", () => {
    it("lists entries with project filter", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({
        ids: ["backend:a", "backend:b"],
        metadatas: [
          { project: "backend", title: "A", author: "x@y.com", tags: "a", type: "note" },
          { project: "backend", title: "B", author: "z@w.com", tags: "b", type: "guide" },
        ],
      });

      const results = await store.listEntries({ project: "backend" });
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe("A");
    });

    it("filters by author", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ ids: ["x:y"], metadatas: [{ author: "a@b.com" }] });

      await store.listEntries({ project: "backend", author: "a@b.com" });

      expect(collection.get).toHaveBeenCalledWith({
        where: { $and: [{ project: "backend" }, { author: "a@b.com" }] },
        include: ["metadatas"],
      });
    });

    it("lists all entries without filters", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({
        ids: ["a:1", "b:2"],
        metadatas: [
          { project: "a", title: "A", tags: "x" },
          { project: "b", title: "B", tags: "y,z" },
        ],
      });

      const results = await store.listEntries({});
      expect(results).toHaveLength(2);
      expect(collection.get).toHaveBeenCalledWith({
        include: ["metadatas"],
      });
    });
  });

  describe("listProjects", () => {
    it("returns unique project names", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({
        metadatas: [
          { project: "backend" },
          { project: "frontend" },
          { project: "backend" },
        ],
      });

      const projects = await store.listProjects();
      expect(projects).toEqual(["backend", "frontend"]);
    });

    it("returns empty array for empty collection", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ metadatas: [] });

      const projects = await store.listProjects();
      expect(projects).toEqual([]);
    });
  });
});
