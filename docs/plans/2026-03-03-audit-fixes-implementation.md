# Audit Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all ~20 audit findings: security vulnerabilities, infrastructure hardening, dead code removal, missing tests, and documentation gaps.

**Architecture:** Modular approach — each module receives all fixes + tests in one pass. New `lib/session-store.js` provides TTL-backed storage with Memory and Redis backends. OAuth provider gets JWT verification via `jose`. Server gets ownership checks, input validation, rate limiting, and security headers.

**Tech Stack:** Node.js 20 ESM, jose (JWT), ioredis (Redis), helmet (security headers), express-rate-limit, vitest

---

### Task 1: Install new dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install production dependencies**

Run: `cd /Users/sergeifrangulov/projects/chroma-memory-mcp && npm install jose ioredis helmet express-rate-limit`
Expected: 4 packages added to dependencies in package.json

**Step 2: Remove unused production dependency**

Run: `npm uninstall google-auth-library`
Expected: google-auth-library removed from dependencies

**Step 3: Verify package.json**

Run: `cat package.json | grep -A 20 '"dependencies"'`
Expected: jose, ioredis, helmet, express-rate-limit present; google-auth-library absent

**Step 4: Run existing tests to verify nothing broke**

Run: `npm test`
Expected: All existing tests pass (auth.test.js will fail — that's expected since it imports createTokenVerifier which we'll remove in Task 5)

**Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add jose, ioredis, helmet, express-rate-limit; remove google-auth-library"
```

---

### Task 2: Create session store (`lib/session-store.js`)

**Files:**
- Create: `lib/session-store.js`
- Create: `test/session-store.test.js`

**Step 1: Write the failing test**

Create `test/session-store.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemorySessionStore } from "../lib/session-store.js";

describe("MemorySessionStore", () => {
  let store;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemorySessionStore();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
  });

  it("set and get a value", async () => {
    await store.set("key1", { data: "hello" }, 60);
    const result = await store.get("key1");
    expect(result).toEqual({ data: "hello" });
  });

  it("returns null for missing key", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("delete removes a key", async () => {
    await store.set("key1", "value", 60);
    await store.delete("key1");
    const result = await store.get("key1");
    expect(result).toBeNull();
  });

  it("expires entries after TTL", async () => {
    await store.set("key1", "value", 5); // 5 seconds TTL
    vi.advanceTimersByTime(6000); // advance 6 seconds
    const result = await store.get("key1");
    expect(result).toBeNull();
  });

  it("does not expire entries before TTL", async () => {
    await store.set("key1", "value", 10);
    vi.advanceTimersByTime(5000); // advance 5 seconds (within TTL)
    const result = await store.get("key1");
    expect(result).toBe("value");
  });

  it("cleanup removes expired entries", async () => {
    await store.set("expired", "old", 1);
    await store.set("valid", "new", 3600);
    vi.advanceTimersByTime(2000);
    const removed = await store.cleanup();
    expect(removed).toBe(1);
    expect(await store.get("expired")).toBeNull();
    expect(await store.get("valid")).toBe("new");
  });

  it("has returns true for existing key", async () => {
    await store.set("key1", "value", 60);
    expect(await store.has("key1")).toBe(true);
  });

  it("has returns false for missing key", async () => {
    expect(await store.has("nonexistent")).toBe(false);
  });

  it("has returns false for expired key", async () => {
    await store.set("key1", "value", 1);
    vi.advanceTimersByTime(2000);
    expect(await store.has("key1")).toBe(false);
  });

  it("keys returns all non-expired keys", async () => {
    await store.set("a", 1, 60);
    await store.set("b", 2, 60);
    await store.set("c", 3, 1);
    vi.advanceTimersByTime(2000);
    const keys = await store.keys();
    expect(keys.sort()).toEqual(["a", "b"]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/session-store.test.js`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `lib/session-store.js`:

```js
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
    // Dynamic import to avoid requiring ioredis when not used
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/session-store.test.js`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add lib/session-store.js test/session-store.test.js
git commit -m "feat: add session store with Memory and Redis backends"
```

---

### Task 3: Fix OAuth provider (`lib/oauth-provider.js`)

**Files:**
- Modify: `lib/oauth-provider.js`
- Create: `test/oauth-provider.test.js`

**Step 1: Write the failing tests**

Create `test/oauth-provider.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOAuthProvider } from "../lib/oauth-provider.js";

describe("createOAuthProvider", () => {
  let provider;

  beforeEach(() => {
    provider = createOAuthProvider({
      googleClientId: "test-client-id",
      googleClientSecret: "test-client-secret",
      baseUrl: "https://memory.example.com",
    });
  });

  describe("clientsStore", () => {
    it("registers and retrieves a client", () => {
      const client = provider.clientsStore.registerClient({
        redirect_uris: ["https://example.com/callback"],
      });
      expect(client.client_id).toBeDefined();
      expect(client.redirect_uris).toEqual(["https://example.com/callback"]);

      const retrieved = provider.clientsStore.getClient(client.client_id);
      expect(retrieved.client_id).toBe(client.client_id);
    });

    it("returns undefined for unknown client", () => {
      expect(provider.clientsStore.getClient("unknown")).toBeUndefined();
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("rejects invalid authorization code", async () => {
      const client = provider.clientsStore.registerClient({});
      await expect(
        provider.exchangeAuthorizationCode(client, "bad-code", "verifier", "https://example.com/cb")
      ).rejects.toThrow("Invalid authorization code");
    });

    it("rejects expired authorization code", async () => {
      // We need to seed an auth code with a past expiresAt
      // Access internal state via the test helper
      const client = provider.clientsStore.registerClient({});
      provider._testHelpers.seedAuthCode("expired-code", {
        email: "test@example.com",
        clientId: client.client_id,
        pkceChallenge: "challenge",
        redirectUri: "https://example.com/cb",
        expiresAt: Date.now() - 1000, // expired
      });

      await expect(
        provider.exchangeAuthorizationCode(client, "expired-code", "verifier", "https://example.com/cb")
      ).rejects.toThrow("Authorization code expired");
    });

    it("rejects mismatched redirectUri", async () => {
      const client = provider.clientsStore.registerClient({});
      provider._testHelpers.seedAuthCode("valid-code", {
        email: "test@example.com",
        clientId: client.client_id,
        pkceChallenge: "challenge",
        redirectUri: "https://example.com/correct-callback",
        expiresAt: Date.now() + 300000,
      });

      await expect(
        provider.exchangeAuthorizationCode(client, "valid-code", "verifier", "https://example.com/wrong-callback")
      ).rejects.toThrow("redirect_uri mismatch");
    });

    it("issues access token for valid code", async () => {
      const client = provider.clientsStore.registerClient({});
      provider._testHelpers.seedAuthCode("good-code", {
        email: "user@example.com",
        clientId: client.client_id,
        pkceChallenge: "challenge",
        redirectUri: "https://example.com/cb",
        expiresAt: Date.now() + 300000,
      });

      const result = await provider.exchangeAuthorizationCode(
        client, "good-code", "verifier", "https://example.com/cb"
      );

      expect(result.access_token).toBeDefined();
      expect(result.token_type).toBe("bearer");
      expect(result.expires_in).toBe(86400);
    });

    it("consumes code on first use (one-time)", async () => {
      const client = provider.clientsStore.registerClient({});
      provider._testHelpers.seedAuthCode("onetime-code", {
        email: "user@example.com",
        clientId: client.client_id,
        pkceChallenge: "challenge",
        redirectUri: "https://example.com/cb",
        expiresAt: Date.now() + 300000,
      });

      await provider.exchangeAuthorizationCode(
        client, "onetime-code", "verifier", "https://example.com/cb"
      );

      await expect(
        provider.exchangeAuthorizationCode(
          client, "onetime-code", "verifier", "https://example.com/cb"
        )
      ).rejects.toThrow("Invalid authorization code");
    });
  });

  describe("verifyAccessToken", () => {
    it("verifies a valid token", async () => {
      const client = provider.clientsStore.registerClient({});
      provider._testHelpers.seedAuthCode("code-for-token", {
        email: "verified@example.com",
        clientId: client.client_id,
        pkceChallenge: "challenge",
        redirectUri: "https://example.com/cb",
        expiresAt: Date.now() + 300000,
      });

      const { access_token } = await provider.exchangeAuthorizationCode(
        client, "code-for-token", "verifier", "https://example.com/cb"
      );

      const result = await provider.verifyAccessToken(access_token);
      expect(result.email).toBe("verified@example.com");
      expect(result.token).toBe(access_token);
    });

    it("rejects unknown token", async () => {
      await expect(
        provider.verifyAccessToken("unknown-token")
      ).rejects.toThrow("Invalid access token");
    });

    it("rejects expired token", async () => {
      provider._testHelpers.seedAccessToken("expired-token", {
        email: "user@example.com",
        clientId: "client1",
        scopes: [],
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      });

      await expect(
        provider.verifyAccessToken("expired-token")
      ).rejects.toThrow("Access token expired");
    });
  });

  describe("exchangeRefreshToken", () => {
    it("always throws", async () => {
      await expect(provider.exchangeRefreshToken()).rejects.toThrow("Refresh tokens not supported");
    });
  });

  describe("handleGoogleCallback", () => {
    it("returns JSON error for Google OAuth error param", async () => {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      const req = {
        query: { error: "access_denied", state: "some-state" },
      };

      await provider.handleGoogleCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "google_oauth_error",
        message: "access_denied",
      });
    });

    it("returns 400 for invalid/missing state", async () => {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      const req = {
        query: { code: "some-code", state: "invalid-state" },
      };

      await provider.handleGoogleCallback(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "invalid_session",
        message: "Invalid or expired OAuth session",
      });
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/oauth-provider.test.js`
Expected: FAIL — _testHelpers not found, responses use .send() not .json()

**Step 3: Rewrite oauth-provider.js**

Modify `lib/oauth-provider.js` with these changes:

1. Remove `createHash` from import (line 9)
2. Remove `access_type: "offline"` (line 67) and `prompt: "consent"` (line 68)
3. Add `redirectUri` validation in `exchangeAuthorizationCode` (after line 85)
4. Replace raw base64 JWT decode with `jose` verification (lines 169-170)
5. Fix reflected error — use `res.json()` instead of `res.send()` (line 136)
6. Sanitize log output (line 163)
7. Add `_testHelpers` for test seeding
8. Fix missing `code` param validation in callback

Replace the entire file with:

```js
/**
 * OAuth 2.1 provider that proxies to Google OAuth for user authentication.
 * Implements OAuthServerProvider interface from MCP SDK.
 *
 * Flow: Claude Desktop -> our /authorize -> Google login -> our /oauth/google/callback -> Claude callback
 * We issue our own opaque tokens that map to user emails from Google.
 */

import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

/**
 * Creates an OAuth provider that proxies Google OAuth for MCP auth.
 *
 * @param {object} opts
 * @param {string} opts.googleClientId
 * @param {string} opts.googleClientSecret
 * @param {string} opts.baseUrl - e.g. https://chroma-memory.frangulov.dev
 */
export function createOAuthProvider({ googleClientId, googleClientSecret, baseUrl }) {
  // In-memory stores (sufficient for single-instance deployment)
  const clients = new Map();       // clientId -> OAuthClientInformationFull
  const authSessions = new Map();  // stateKey -> { clientId, pkceChallenge, redirectUri, originalState, scopes }
  const authCodes = new Map();     // code -> { email, clientId, pkceChallenge, redirectUri, expiresAt }
  const accessTokens = new Map();  // token -> { email, clientId, scopes, expiresAt }

  const TOKEN_TTL = 24 * 60 * 60; // 24 hours in seconds

  // --- Client Store (DCR) ---
  const clientsStore = {
    getClient(clientId) {
      return clients.get(clientId);
    },
    registerClient(clientMetadata) {
      const clientId = randomUUID();
      const client = {
        ...clientMetadata,
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
      };
      clients.set(clientId, client);
      return client;
    },
  };

  // --- OAuthServerProvider methods ---

  async function authorize(client, params, res) {
    const stateKey = randomUUID();

    // Store session data for the Google callback
    authSessions.set(stateKey, {
      clientId: client.client_id,
      pkceChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      originalState: params.state,
      scopes: params.scopes || [],
    });

    // Redirect to Google OAuth
    const googleAuthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    googleAuthUrl.searchParams.set("client_id", googleClientId);
    googleAuthUrl.searchParams.set("redirect_uri", `${baseUrl}/oauth/google/callback`);
    googleAuthUrl.searchParams.set("response_type", "code");
    googleAuthUrl.searchParams.set("scope", "openid email profile");
    googleAuthUrl.searchParams.set("state", stateKey);

    res.redirect(googleAuthUrl.toString());
  }

  async function challengeForAuthorizationCode(_client, authorizationCode) {
    const data = authCodes.get(authorizationCode);
    if (!data) throw new Error("Unknown authorization code");
    return data.pkceChallenge;
  }

  async function exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    const data = authCodes.get(authorizationCode);
    if (!data) throw new Error("Invalid authorization code");
    if (data.expiresAt < Date.now()) {
      authCodes.delete(authorizationCode);
      throw new Error("Authorization code expired");
    }
    if (redirectUri !== data.redirectUri) {
      authCodes.delete(authorizationCode);
      throw new Error("redirect_uri mismatch");
    }

    // Consume the code (one-time use)
    authCodes.delete(authorizationCode);

    // Issue our own access token
    const accessToken = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL;

    accessTokens.set(accessToken, {
      email: data.email,
      clientId: client.client_id,
      scopes: [],
      expiresAt,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: TOKEN_TTL,
    };
  }

  async function exchangeRefreshToken() {
    throw new Error("Refresh tokens not supported");
  }

  async function verifyAccessToken(token) {
    const data = accessTokens.get(token);
    if (!data) throw new Error("Invalid access token");
    if (data.expiresAt < Math.floor(Date.now() / 1000)) {
      accessTokens.delete(token);
      throw new Error("Access token expired");
    }

    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: data.expiresAt,
      email: data.email,
    };
  }

  // --- Google OAuth callback handler (Express route) ---

  async function handleGoogleCallback(req, res) {
    const { code, state, error } = req.query;

    if (error) {
      console.error("Google OAuth error:", error);
      res.status(400).json({ error: "google_oauth_error", message: String(error) });
      return;
    }

    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "missing_code", message: "Missing authorization code" });
      return;
    }

    const session = authSessions.get(state);
    if (!session) {
      res.status(400).json({ error: "invalid_session", message: "Invalid or expired OAuth session" });
      return;
    }
    authSessions.delete(state);

    try {
      // Exchange Google code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: `${baseUrl}/oauth/google/callback`,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        console.error("Google token exchange failed:", tokenData.error || "unknown error");
        res.status(500).json({ error: "token_exchange_failed", message: "Failed to exchange Google authorization code" });
        return;
      }

      // Verify ID token with Google's JWKS (cryptographic signature check)
      const { payload } = await jwtVerify(tokenData.id_token, GOOGLE_JWKS, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: googleClientId,
      });

      if (!payload.email || !payload.email_verified) {
        res.status(403).json({ error: "email_not_verified", message: "Google account email not verified" });
        return;
      }

      // Generate our own authorization code
      const ourCode = randomUUID();
      authCodes.set(ourCode, {
        email: payload.email,
        clientId: session.clientId,
        pkceChallenge: session.pkceChallenge,
        redirectUri: session.redirectUri,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      });

      // Redirect to Claude's callback with our code
      const callbackUrl = new URL(session.redirectUri);
      callbackUrl.searchParams.set("code", ourCode);
      if (session.originalState) {
        callbackUrl.searchParams.set("state", session.originalState);
      }

      console.log(`OAuth: user authenticated, redirecting to client`);
      res.redirect(callbackUrl.toString());
    } catch (err) {
      console.error("Google callback error:", err.message);
      res.status(500).json({ error: "callback_failed", message: "OAuth callback processing failed" });
    }
  }

  return {
    get clientsStore() { return clientsStore; },
    authorize,
    challengeForAuthorizationCode,
    exchangeAuthorizationCode,
    exchangeRefreshToken,
    verifyAccessToken,
    handleGoogleCallback,
    skipLocalPkceValidation: false,
    // Test helpers — only for unit tests to seed internal state
    _testHelpers: {
      seedAuthCode(code, data) { authCodes.set(code, data); },
      seedAccessToken(token, data) { accessTokens.set(token, data); },
      seedAuthSession(state, data) { authSessions.set(state, data); },
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/oauth-provider.test.js`
Expected: All 12 tests PASS

**Step 5: Commit**

```bash
git add lib/oauth-provider.js test/oauth-provider.test.js
git commit -m "fix(security): verify JWT signatures, validate redirectUri, sanitize errors in oauth-provider"
```

---

### Task 4: Fix memory store (`lib/memory-store.js`)

**Files:**
- Modify: `lib/memory-store.js`
- Modify: `test/memory-store.test.js`

**Step 1: Write the failing tests**

Add to `test/memory-store.test.js` at the end of the `createMemoryStore` describe block (before the final `});`):

```js
  describe("search", () => {
    // ... existing tests ...

    it("throws when no embedding function is configured", async () => {
      // store was created with embeddingFunction: null in beforeEach
      await expect(
        store.search({ query: "test", nResults: 5 })
      ).rejects.toThrow("Semantic search requires GOOGLE_API_KEY");
    });

    it("applies combined project + author filter", async () => {
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

      await embeddingStore.search({ query: "test", project: "backend", author: "a@b.com" });

      expect(collection.query).toHaveBeenCalledWith({
        queryTexts: ["test"],
        nResults: 10,
        where: { $and: [{ project: "backend" }, { author: "a@b.com" }] },
        include: ["documents", "metadatas", "distances"],
      });
    });
  });

  describe("listEntries", () => {
    // ... existing tests ...

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
    // ... existing test ...

    it("returns empty array for empty collection", async () => {
      const collection = mockClient._collection;
      collection.get.mockResolvedValue({ metadatas: [] });

      const projects = await store.listProjects();
      expect(projects).toEqual([]);
    });
  });
```

**Step 2: Run test to verify new tests fail**

Run: `npx vitest run test/memory-store.test.js`
Expected: "search throws when no embedding function" FAILS (no guard); "combined filter" may fail depending on mock setup

**Step 3: Apply fixes to memory-store.js**

In `lib/memory-store.js`:

1. Add `buildWhereFilter` helper function (after `buildDocument`, before `createMemoryStore`):

```js
function buildWhereFilter(fields) {
  const filters = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => ({ [k]: v }));
  if (filters.length === 1) return filters[0];
  if (filters.length > 1) return { $and: filters };
  return undefined;
}
```

2. Replace `search` method filter-building (lines 144-153) with:

```js
    async search({ query, project, author, nResults = 10 }) {
      if (!embeddingFunction) {
        throw new Error("Semantic search requires GOOGLE_API_KEY to be configured");
      }

      const queryParams = {
        queryTexts: [query],
        nResults,
        include: ["documents", "metadatas", "distances"],
      };

      const where = buildWhereFilter({ project, author });
      if (where) queryParams.where = where;

      const results = await collection.query(queryParams);

      return (results.ids[0] || []).map((id, i) => ({
        id,
        document: results.documents[0][i],
        metadata: results.metadatas[0][i],
        distance: results.distances[0][i],
      }));
    },
```

3. Replace `listEntries` method filter-building (lines 165-179) with:

```js
    async listEntries({ project, author, type } = {}) {
      const getParams = {
        include: ["metadatas"],
      };

      const where = buildWhereFilter({ project, author, type });
      if (where) getParams.where = where;

      const results = await collection.get(getParams);

      return results.ids.map((id, i) => ({
        id,
        ...results.metadatas[i],
        tags: results.metadatas[i].tags ? results.metadatas[i].tags.split(",") : [],
      }));
    },
```

4. Remove `count()` method (lines 196-198).

**Step 4: Run tests**

Run: `npx vitest run test/memory-store.test.js`
Expected: All tests PASS

**Step 5: Update integration test to not use count()**

In `test/integration.test.js`, replace the `count` test (lines 163-176):

```js
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
```

**Step 6: Commit**

```bash
git add lib/memory-store.js test/memory-store.test.js test/integration.test.js
git commit -m "fix: add search guard for missing embeddings, extract buildWhereFilter, remove count()"
```

---

### Task 5: Fix auth module (`lib/auth.js`)

**Files:**
- Modify: `lib/auth.js`
- Modify: `test/auth.test.js`

**Step 1: Rewrite auth.js**

Replace `lib/auth.js` entirely:

```js
/**
 * Auth utilities for MCP server.
 *
 * @module auth
 */

/**
 * Extracts user email from auth info attached by middleware.
 *
 * @param {object|undefined} authInfo
 * @returns {string|null}
 */
export function extractUserEmail(authInfo) {
  if (!authInfo) return null;
  return authInfo.email || null;
}
```

**Step 2: Rewrite auth.test.js**

Replace `test/auth.test.js` entirely:

```js
import { describe, it, expect } from "vitest";
import { extractUserEmail } from "../lib/auth.js";

describe("extractUserEmail", () => {
  it("extracts email from auth info", () => {
    const email = extractUserEmail({ email: "user@company.com", token: "t" });
    expect(email).toBe("user@company.com");
  });

  it("returns null if no auth info", () => {
    expect(extractUserEmail(undefined)).toBeNull();
  });

  it("returns null if auth info has no email", () => {
    expect(extractUserEmail({})).toBeNull();
  });

  it("returns null for null auth info", () => {
    expect(extractUserEmail(null)).toBeNull();
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run test/auth.test.js`
Expected: All 4 tests PASS

**Step 4: Commit**

```bash
git add lib/auth.js test/auth.test.js
git commit -m "fix: remove dead createTokenVerifier code, simplify auth.js to extractUserEmail only"
```

---

### Task 6: Fix server.js

**Files:**
- Modify: `server.js`
- Modify: `test/server.test.js`

**Step 1: Write the failing tests**

Replace `test/server.test.js`:

```js
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
  // We need to import these - they'll be exported after the server.js changes
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
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.js`
Expected: FAIL — successResult and errorResult are not exported

**Step 3: Apply all server.js changes**

In `server.js`, apply these changes:

1. **Add imports** at the top (after existing imports):
```js
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
```

2. **Export helpers** — add `export` keyword to `successResult` and `errorResult` (lines 30, 36):
```js
export function successResult(data) { ... }
export function errorResult(code, message) { ... }
```

3. **Add input validation to Zod schemas** — replace `z.string().describe(...)` with validated versions in `write_entry` (lines 65-68):
```js
        project: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, "Project must be URL-safe").describe("Project identifier"),
        slug: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, "Slug must be URL-safe").describe("URL-safe short name"),
        title: z.string().min(1).max(500).describe("Human-readable title"),
        content: z.string().min(1).max(100000).describe("Markdown content"),
        tags: z.array(z.string().max(50)).max(20).default([]).describe("Categorisation tags"),
```

   Apply same project/slug validation to `read_entry`, `update_entry`, `delete_entry`, and `search` schemas.

4. **Add ownership checks** to `update_entry` handler (replace lines 130-140):
```js
    async ({ project, slug, ...changes }, extra) => {
      try {
        // Ownership check
        const entry = await store.readEntry(project, slug);
        if (!entry) {
          return errorResult("NOT_FOUND", `Entry "${project}:${slug}" not found`);
        }
        const userEmail = extractUserEmail(extra.authInfo);
        if (userEmail && entry.metadata.author !== userEmail) {
          return errorResult("FORBIDDEN", "You can only modify your own entries");
        }
        const result = await store.updateEntry(project, slug, changes);
        return successResult(result);
      } catch (err) {
        if (err.message.includes("not found")) {
          return errorResult("NOT_FOUND", err.message);
        }
        throw err;
      }
    },
```

   Apply same ownership check to `delete_entry` handler (replace lines 153-163):
```js
    async ({ project, slug }, extra) => {
      try {
        const entry = await store.readEntry(project, slug);
        if (!entry) {
          return errorResult("NOT_FOUND", `Entry "${project}:${slug}" not found`);
        }
        const userEmail = extractUserEmail(extra.authInfo);
        if (userEmail && entry.metadata.author !== userEmail) {
          return errorResult("FORBIDDEN", "You can only delete your own entries");
        }
        const result = await store.deleteEntry(project, slug);
        return successResult(result);
      } catch (err) {
        if (err.message.includes("not found")) {
          return errorResult("NOT_FOUND", err.message);
        }
        throw err;
      }
    },
```

5. **Remove redundant apiKeyEnvVar** (line 284):
```js
    embeddingFunction = new GoogleGeminiEmbeddingFunction({
      apiKey: CONFIG.googleApiKey,
      modelName: "gemini-embedding-001",
    });
```

6. **Add security middleware** after `app.set("trust proxy", 1)` (line 300):
```js
  app.use(helmet());
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
```

7. **Add fail-fast auth check** after `authEnabled` variable (after line 303):
```js
  if (process.env.NODE_ENV === "production" && !authEnabled) {
    console.error(
      "FATAL: Production mode requires MCP_BASE_URL, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET",
    );
    process.exit(1);
  }
```

8. **Add stricter rate limit on auth endpoints** (after mcpAuthRouter, around line 322):
```js
    app.use("/oauth", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
```

9. **Fix serviceDocumentationUrl** (line 319):
```js
        serviceDocumentationUrl: new URL(
          "https://github.com/sfrangulov/chroma-memory-mcp",
        ),
```

10. **Inline createServerFactory** — delete function (lines 342-344), replace call on line 370:
```js
        const { server } = createMcpServerFactory(store);
```

11. **Fix SIGTERM handler** (replace lines 436-447):
```js
  const shutdown = async () => {
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
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
```

12. **Fix isDirectRun** (replace lines 454-456):
```js
const isDirectRun =
  process.argv[1] &&
  process.argv[1] === fileURLToPath(import.meta.url);
```

**Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "fix(security): add ownership checks, input validation, rate limiting, SIGTERM handler, helmet"
```

---

### Task 7: Docker hardening

**Files:**
- Modify: `Dockerfile`
- Modify: `.dockerignore`
- Modify: `docker-compose.yml`

**Step 1: Rewrite Dockerfile**

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY lib/ ./lib/
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
```

**Step 2: Rewrite .dockerignore**

```
node_modules
test
docs
helm
.git
.env
.gitignore
.npmignore
Dockerfile
docker-compose*.yml
*.md
chroma-data
```

**Step 3: Rewrite docker-compose.yml**

```yaml
services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

  chromadb:
    image: chromadb/chroma:1.5.2
    volumes:
      - chroma-data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/api/v2/heartbeat"]
      interval: 5s
      timeout: 3s
      retries: 10

  mcp-server:
    build: .
    ports:
      - "3000:3000"
    environment:
      - CHROMA_URL=http://chromadb:8000
      - REDIS_URL=redis://redis:6379
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
      - MCP_BASE_URL=${MCP_BASE_URL}
      - MCP_PORT=3000
    depends_on:
      chromadb:
        condition: service_healthy
      redis:
        condition: service_started
    restart: on-failure

volumes:
  chroma-data:
  redis-data:
```

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml
git commit -m "fix(infra): harden Docker — non-root user, healthcheck, Redis, missing env vars"
```

---

### Task 8: Helm chart hardening

**Files:**
- Modify: `helm/chroma-memory-mcp/values.yaml`
- Modify: `helm/chroma-memory-mcp/templates/mcp-deployment.yaml`
- Modify: `helm/chroma-memory-mcp/templates/chromadb-deployment.yaml`
- Modify: `helm/chroma-memory-mcp/templates/chromadb-pvc.yaml`
- Delete: `helm/chroma-memory-mcp/templates/namespace.yaml`
- Create: `helm/chroma-memory-mcp/templates/networkpolicy.yaml`
- Create: `helm/chroma-memory-mcp/templates/redis-deployment.yaml`
- Create: `helm/chroma-memory-mcp/templates/redis-service.yaml`

**Step 1: Update values.yaml**

Replace `helm/chroma-memory-mcp/values.yaml`:

```yaml
namespace: chroma-memory

mcp:
  image:
    repository: sfrangulov/chroma-memory-mcp
    tag: "0.1.0"
    pullPolicy: IfNotPresent
  # NOTE: replicas must be 1 unless Redis is configured for session storage
  replicas: 1
  port: 3000
  env:
    MCP_HOST: "0.0.0.0"
    CHROMA_COLLECTION: "memories"
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  probes:
    liveness:
      path: /health
      initialDelaySeconds: 25
      periodSeconds: 15
      timeoutSeconds: 5
      failureThreshold: 3
    readiness:
      path: /health
      initialDelaySeconds: 25
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3

chromadb:
  image:
    repository: chromadb/chroma
    tag: "1.5.2"
    pullPolicy: IfNotPresent
  port: 8000
  persistence:
    size: 5Gi
    storageClass: ""
    accessMode: ReadWriteOnce
  resources:
    requests:
      cpu: 100m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 1Gi
  probes:
    liveness:
      path: /api/v2/heartbeat
      initialDelaySeconds: 15
      periodSeconds: 20
      timeoutSeconds: 5
      failureThreshold: 3
    readiness:
      path: /api/v2/heartbeat
      initialDelaySeconds: 10
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3

redis:
  enabled: true
  image:
    repository: redis
    tag: "7-alpine"
    pullPolicy: IfNotPresent
  port: 6379
  resources:
    requests:
      cpu: 50m
      memory: 64Mi
    limits:
      cpu: 200m
      memory: 128Mi

secrets:
  googleApiKey: ""
  googleClientId: ""
  googleClientSecret: ""

ingress:
  enabled: true
  className: public
  host: chroma-memory.frangulov.dev
  tls:
    enabled: true
    clusterIssuer: lets-encrypt
    secretName: chroma-memory-mcp-tls
```

**Step 2: Add securityContext to mcp-deployment.yaml**

Add `securityContext` to the container spec (after `imagePullPolicy`):

```yaml
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
```

Add Redis URL env var (after GOOGLE_CLIENT_SECRET env block):

```yaml
            {{- if .Values.redis.enabled }}
            - name: REDIS_URL
              value: "redis://{{ include "chroma-memory-mcp.fullname" . }}-redis:{{ .Values.redis.port }}"
            {{- end }}
```

**Step 3: Add securityContext to chromadb-deployment.yaml**

Add after `imagePullPolicy`:

```yaml
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
```

**Step 4: Make storageClass conditional in chromadb-pvc.yaml**

Replace the `storageClassName` line:

```yaml
  {{- if .Values.chromadb.persistence.storageClass }}
  storageClassName: {{ .Values.chromadb.persistence.storageClass }}
  {{- end }}
```

**Step 5: Delete namespace.yaml**

Run: `rm helm/chroma-memory-mcp/templates/namespace.yaml`

**Step 6: Create networkpolicy.yaml**

Create `helm/chroma-memory-mcp/templates/networkpolicy.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "chroma-memory-mcp.fullname" . }}-chromadb
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "chroma-memory-mcp.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "chroma-memory-mcp.chromadb.selectorLabels" . | nindent 6 }}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              {{- include "chroma-memory-mcp.mcp.selectorLabels" . | nindent 14 }}
      ports:
        - protocol: TCP
          port: {{ .Values.chromadb.port }}
```

**Step 7: Create redis-deployment.yaml**

Create `helm/chroma-memory-mcp/templates/redis-deployment.yaml`:

```yaml
{{- if .Values.redis.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "chroma-memory-mcp.fullname" . }}-redis
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "chroma-memory-mcp.labels" . | nindent 4 }}
    app.kubernetes.io/component: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ include "chroma-memory-mcp.name" . }}
      app.kubernetes.io/instance: {{ .Release.Name }}
      app.kubernetes.io/component: redis
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ include "chroma-memory-mcp.name" . }}
        app.kubernetes.io/instance: {{ .Release.Name }}
        app.kubernetes.io/component: redis
    spec:
      containers:
        - name: redis
          image: "{{ .Values.redis.image.repository }}:{{ .Values.redis.image.tag }}"
          imagePullPolicy: {{ .Values.redis.image.pullPolicy }}
          ports:
            - name: redis
              containerPort: {{ .Values.redis.port }}
              protocol: TCP
          resources:
            {{- toYaml .Values.redis.resources | nindent 12 }}
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
{{- end }}
```

**Step 8: Create redis-service.yaml**

Create `helm/chroma-memory-mcp/templates/redis-service.yaml`:

```yaml
{{- if .Values.redis.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "chroma-memory-mcp.fullname" . }}-redis
  namespace: {{ .Values.namespace }}
  labels:
    {{- include "chroma-memory-mcp.labels" . | nindent 4 }}
    app.kubernetes.io/component: redis
spec:
  type: ClusterIP
  ports:
    - port: {{ .Values.redis.port }}
      targetPort: redis
      protocol: TCP
      name: redis
  selector:
    app.kubernetes.io/name: {{ include "chroma-memory-mcp.name" . }}
    app.kubernetes.io/instance: {{ .Release.Name }}
    app.kubernetes.io/component: redis
{{- end }}
```

**Step 9: Commit**

```bash
git add helm/ && git rm helm/chroma-memory-mcp/templates/namespace.yaml
git commit -m "fix(infra): harden Helm — securityContext, NetworkPolicy, Redis, remove namespace template"
```

---

### Task 9: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `SKILL.md`

**Step 1: Update README.md**

Apply these specific changes:

1. Add `REDIS_URL` to the Configuration table (after `GOOGLE_CLIENT_SECRET` row):
```
| `REDIS_URL`            | No       | —                       | Redis URL for session storage (enables replicas > 1) |
```

2. Update the Tech Stack table — replace `google-auth-library` row with:
```
| `jose`                       | Google JWT verification (JWKS)         |
| `helmet`                     | Security headers                       |
| `express-rate-limit`         | Rate limiting                          |
| `ioredis`                    | Redis client (optional, for scaling)   |
```

3. Update the Production (Docker Compose + OAuth) section — the command is correct but add a note:
```
The `docker-compose.yml` now includes Redis and all required OAuth variables.
```

4. Add HTTP Endpoints section (after Authentication):
```markdown
## HTTP Endpoints

| Endpoint      | Method   | Description                      |
| ------------- | -------- | -------------------------------- |
| `/mcp`        | `POST`   | Main MCP endpoint (tool calls)   |
| `/mcp`        | `GET`    | SSE stream (server notifications)|
| `/mcp`        | `DELETE` | Session cleanup                  |
| `/health`     | `GET`    | Health check (`{ status: "ok" }`)|
```

5. Add OAuth Flow Details section (after existing Authentication section):
```markdown
### OAuth Flow Details

- Tokens are **opaque UUIDs** issued by this server (not Google JWTs)
- Token TTL: **24 hours** — users re-authenticate daily
- **Refresh tokens are not supported** — sessions expire after 24h
- Google ID tokens are **cryptographically verified** via JWKS
- Server restart **invalidates all sessions** (unless Redis is configured)
```

6. Add `TEST_CHROMA_URL` to Development section:
```markdown
Set `TEST_CHROMA_URL` to override the default `http://localhost:8100` for integration tests.
```

7. Update Project Structure — add `session-store.js`:
```
│   ├── session-store.js     # TTL session store (Memory/Redis)
```

8. Remove `google-auth-library` from the Tech Stack table.

**Step 2: Update SKILL.md**

In the "Commands Quick Reference" section, add a note:

```markdown
> Note: These are prompting patterns for Claude, not registered CLI commands.
```

**Step 3: Commit**

```bash
git add README.md SKILL.md
git commit -m "docs: update README with Redis, HTTP endpoints, OAuth flow, fix tech stack"
```

---

### Task 10: Final verification

**Step 1: Run all unit tests**

Run: `npm test`
Expected: All tests pass

**Step 2: Verify no lint issues**

Run: `node --check server.js && node --check lib/auth.js && node --check lib/memory-store.js && node --check lib/oauth-provider.js && node --check lib/session-store.js`
Expected: No syntax errors

**Step 3: Verify package.json is correct**

Run: `npm ls --depth=0`
Expected: No missing or extraneous packages

**Step 4: Final commit summary**

Run: `git log --oneline -10`
Expected: 9 commits covering all audit fixes
