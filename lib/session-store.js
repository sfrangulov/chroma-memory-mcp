/**
 * Session store with TTL support.
 * Two implementations: MemorySessionStore (default) and RedisSessionStore.
 *
 * @module session-store
 */

/**
 * In-memory session store with TTL expiration.
 * Suitable for single-instance deployments and development.
 */
export class MemorySessionStore {
  constructor({ cleanupIntervalMs = 5 * 60 * 1000 } = {}) {
    this._store = new Map(); // key -> { value, expiresAt }
    this._cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Prevent the interval from keeping the process alive
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  }

  async set(key, value, ttlSeconds) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async get(key) {
    const entry = this._store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  async delete(key) {
    this._store.delete(key);
  }

  async has(key) {
    return (await this.get(key)) !== null;
  }

  async keys() {
    const now = Date.now();
    const result = [];
    for (const [key, entry] of this._store) {
      if (entry.expiresAt > now) {
        result.push(key);
      }
    }
    return result;
  }

  async cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this._store) {
      if (entry.expiresAt <= now) {
        this._store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    this._store.clear();
  }
}

/**
 * Redis-backed session store with TTL expiration.
 * Required for multi-instance deployments (replicas > 1).
 *
 * @param {object} opts
 * @param {string} opts.redisUrl - Redis connection URL
 * @param {string} [opts.prefix="mcp:"] - Key prefix for namespacing
 */
export class RedisSessionStore {
  constructor({ redisUrl, prefix = "mcp:" }) {
    this._prefix = prefix;
    this._redisUrl = redisUrl;
    this._client = null;
  }

  async _getClient() {
    if (!this._client) {
      const { default: Redis } = await import("ioredis");
      this._client = new Redis(this._redisUrl);
    }
    return this._client;
  }

  _key(key) {
    return `${this._prefix}${key}`;
  }

  async set(key, value, ttlSeconds) {
    const client = await this._getClient();
    await client.set(this._key(key), JSON.stringify(value), "EX", ttlSeconds);
  }

  async get(key) {
    const client = await this._getClient();
    const data = await client.get(this._key(key));
    return data ? JSON.parse(data) : null;
  }

  async delete(key) {
    const client = await this._getClient();
    await client.del(this._key(key));
  }

  async has(key) {
    const client = await this._getClient();
    return (await client.exists(this._key(key))) === 1;
  }

  async keys() {
    const client = await this._getClient();
    const keys = await client.keys(`${this._prefix}*`);
    return keys.map((k) => k.slice(this._prefix.length));
  }

  async cleanup() {
    // Redis handles TTL expiration automatically
    return 0;
  }

  async destroy() {
    if (this._client) {
      await this._client.quit();
      this._client = null;
    }
  }
}

/**
 * Creates the appropriate session store based on environment.
 *
 * @param {object} [opts]
 * @param {string} [opts.redisUrl] - If provided, uses Redis; otherwise in-memory
 * @returns {MemorySessionStore|RedisSessionStore}
 */
export function createSessionStore({ redisUrl } = {}) {
  if (redisUrl) {
    return new RedisSessionStore({ redisUrl });
  }
  return new MemorySessionStore();
}
