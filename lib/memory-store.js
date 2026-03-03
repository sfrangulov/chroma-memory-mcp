/**
 * Memory store backed by ChromaDB.
 * Wraps ChromaDB collection into a clean CRUD + search interface.
 *
 * @module memory-store
 */

/**
 * Extracts raw content from a formatted document (strips header metadata).
 */
function extractContentFromDocument(doc) {
  // Document format: "# Title\n\n- **Author:**...\n- **Tags:**...\n- **Type:**...\n\ncontent"
  const parts = doc.split("\n\n");
  // Skip title (index 0) and metadata block (index 1), rest is content
  return parts.slice(2).join("\n\n");
}

/**
 * Builds a formatted document string from entry fields.
 */
function buildDocument({ title, author, tags, type, content }) {
  let doc = `# ${title}\n\n`;
  doc += `- **Author:** ${author}\n`;
  doc += `- **Tags:** ${tags.join(", ")}\n`;
  doc += `- **Type:** ${type}\n\n`;
  doc += content;
  return doc;
}

/**
 * Creates a memory store backed by a ChromaDB collection.
 *
 * @param {object} params
 * @param {import("chromadb").ChromaClient} params.client - ChromaDB client
 * @param {object|null} params.embeddingFunction - Embedding function instance
 * @param {string} params.collectionName - Collection name (default: "memories")
 * @returns {Promise<object>} store with CRUD + search methods
 */
export async function createMemoryStore({ client, embeddingFunction, collectionName = "memories" }) {
  const collection = await client.getOrCreateCollection({
    name: collectionName,
    embeddingFunction,
  });

  return {
    async writeEntry({ project, slug, title, content, author, tags, type }) {
      const id = `${project}:${slug}`;

      // Check for duplicates
      const existing = await collection.get({ ids: [id] });
      if (existing.ids.length > 0) {
        throw new Error(`Entry "${id}" already exists`);
      }

      const now = new Date().toISOString();
      const document = buildDocument({ title, author, tags, type, content });

      await collection.add({
        ids: [id],
        documents: [document],
        metadatas: [{
          project,
          title,
          author,
          tags: tags.join(","),
          type,
          created_at: now,
          updated_at: now,
        }],
      });

      return { id, created_at: now };
    },

    async readEntry(project, slug) {
      const id = `${project}:${slug}`;
      const result = await collection.get({
        ids: [id],
        include: ["documents", "metadatas"],
      });

      if (result.ids.length === 0) return null;

      return {
        id: result.ids[0],
        document: result.documents[0],
        metadata: result.metadatas[0],
      };
    },

    async updateEntry(project, slug, changes) {
      const id = `${project}:${slug}`;

      // Read existing entry (metadata + document for content fallback)
      const existing = await collection.get({ ids: [id], include: ["metadatas", "documents"] });
      if (existing.ids.length === 0) {
        throw new Error(`Entry "${id}" not found`);
      }

      const oldMeta = existing.metadatas[0];
      const oldDoc = existing.documents[0];
      const title = changes.title ?? oldMeta.title;
      const tags = changes.tags ?? oldMeta.tags.split(",");
      const type = changes.type ?? oldMeta.type;
      const author = oldMeta.author;
      // Extract content from old document if not provided in changes
      const content = changes.content ?? extractContentFromDocument(oldDoc);

      const now = new Date().toISOString();
      const document = buildDocument({ title, author, tags, type, content });

      await collection.update({
        ids: [id],
        documents: [document],
        metadatas: [{
          ...oldMeta,
          title,
          tags: Array.isArray(tags) ? tags.join(",") : tags,
          type,
          updated_at: now,
        }],
      });

      return { id, updated_at: now };
    },

    async deleteEntry(project, slug) {
      const id = `${project}:${slug}`;
      const existing = await collection.get({ ids: [id] });
      if (existing.ids.length === 0) {
        throw new Error(`Entry "${id}" not found`);
      }
      await collection.delete({ ids: [id] });
      return { id, deleted: true };
    },

    async search({ query, project, author, nResults = 10 }) {
      const queryParams = {
        queryTexts: [query],
        nResults,
        include: ["documents", "metadatas", "distances"],
      };

      // Build where filter
      const filters = [];
      if (project) filters.push({ project });
      if (author) filters.push({ author });

      if (filters.length === 1) {
        queryParams.where = filters[0];
      } else if (filters.length > 1) {
        queryParams.where = { $and: filters };
      }

      const results = await collection.query(queryParams);

      return (results.ids[0] || []).map((id, i) => ({
        id,
        document: results.documents[0][i],
        metadata: results.metadatas[0][i],
        distance: results.distances[0][i],
      }));
    },

    async listEntries({ project, author, type }) {
      const filters = [];
      if (project) filters.push({ project });
      if (author) filters.push({ author });
      if (type) filters.push({ type });

      const getParams = {
        include: ["metadatas"],
      };

      if (filters.length === 1) {
        getParams.where = filters[0];
      } else if (filters.length > 1) {
        getParams.where = { $and: filters };
      }

      const results = await collection.get(getParams);

      return results.ids.map((id, i) => ({
        id,
        ...results.metadatas[i],
        tags: results.metadatas[i].tags ? results.metadatas[i].tags.split(",") : [],
      }));
    },

    async listProjects() {
      const results = await collection.get({ include: ["metadatas"] });
      const projects = new Set(results.metadatas.map((m) => m.project));
      return [...projects].sort();
    },

    async count() {
      return collection.count();
    },
  };
}
