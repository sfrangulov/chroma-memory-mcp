# Audit Fixes Design — chroma-memory-mcp

**Date:** 2026-03-03
**Scope:** Full audit remediation — Security, Infrastructure, Code Quality, Tests
**Approach:** Modular — each module receives all fixes + tests in one pass

---

## Context

A 5-agent audit identified ~20 issues across security (CRITICAL-HIGH), infrastructure (MEDIUM), and code quality (LOW-MEDIUM). This design covers all three phases in a modular approach.

### Key Decisions

- **Dead code:** Remove entirely (createTokenVerifier, google-auth-library, createHash)
- **State management:** Redis for sessions + OAuth state (new `lib/session-store.js`)
- **Tests:** Cover all changed modules
- **Approach:** Modular — work per-module, each commit self-contained

---

## Module 1: OAuth Provider (`lib/oauth-provider.js`)

### 1.1 JWT Verification

Replace raw base64 decode of Google ID token with `jose` library (lightweight JWKS verification).

```js
// Before (INSECURE)
const idTokenParts = tokenData.id_token.split(".");
const payload = JSON.parse(Buffer.from(idTokenParts[1], "base64url").toString());

// After
import { createRemoteJWKSet, jwtVerify } from "jose";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const { payload } = await jwtVerify(tokenData.id_token, GOOGLE_JWKS, {
  issuer: ["https://accounts.google.com", "accounts.google.com"],
  audience: googleClientId,
});
```

### 1.2 redirectUri Validation

Add RFC 6749 Section 4.1.3 compliance:

```js
if (redirectUri !== data.redirectUri) {
  authCodes.delete(authorizationCode);
  throw new Error("redirect_uri mismatch");
}
```

### 1.3 Dead Code Cleanup

- Remove `createHash` from import
- Remove `access_type: "offline"` and `prompt: "consent"` (refresh tokens not supported)

### 1.4 Reflected Error Fix

HTML-encode or JSON-encode the `error` query param in `handleGoogleCallback`:

```js
// Before
res.status(400).send(`Google OAuth error: ${error}`);

// After
res.status(400).json({ error: "google_oauth_error", message: String(error) });
```

### 1.5 Log Sanitization

```js
// Before
console.error("Google token exchange failed:", tokenData);

// After
console.error("Google token exchange failed:", tokenData.error || "unknown error");
```

### 1.6 Tests

- Code expiry in `exchangeAuthorizationCode`
- Token expiry in `verifyAccessToken`
- redirectUri mismatch
- Google callback with error param
- Google callback with invalid/missing state
- Reflected error sanitization
- One-time auth code consumption

---

## Module 2: Session Store (`lib/session-store.js`) — NEW

### Interface

```js
class SessionStore {
  async set(key, value, ttlSeconds) {}
  async get(key) {}
  async delete(key) {}
  async cleanup() {}
}
```

### Implementations

**MemorySessionStore** — default for dev, uses Map with TTL tracking.
**RedisSessionStore** — when `REDIS_URL` is set, uses `ioredis`.

### TTL Defaults

| Store | TTL |
|-------|-----|
| authCodes | 5 minutes |
| authSessions | 10 minutes |
| accessTokens | 24 hours |
| transports | 1 hour |
| clients | 7 days |

### Integration

- `oauth-provider.js` receives a `sessionStore` instance via dependency injection
- `server.js` `transports` map replaced with session store
- Periodic cleanup sweep every 5 minutes (for MemorySessionStore)

### Tests

- MemorySessionStore: set/get/delete, TTL expiry, cleanup
- RedisSessionStore: same interface tests with redis mock

---

## Module 3: Server (`server.js`)

### 3.1 SIGTERM Handler

```js
const shutdown = async () => {
  console.log("Shutting down...");
  // close all transports via session store
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

### 3.2 Fail-Fast Auth

```js
if (process.env.NODE_ENV === "production" && !authEnabled) {
  console.error("FATAL: Auth env vars required in production");
  process.exit(1);
}
```

### 3.3 Ownership Checks

`update_entry` and `delete_entry` verify `entry.author === currentUserEmail`:

```js
const entry = await store.readEntry(project, slug);
if (authEnabled && entry.author !== userEmail) {
  return errorResult("FORBIDDEN", "You can only modify your own entries");
}
```

### 3.4 Input Validation (Zod)

```js
project: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
slug:    z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
title:   z.string().min(1).max(500),
content: z.string().min(1).max(100_000),
tags:    z.array(z.string().max(50)).max(20).default([]),
```

### 3.5 Security Middleware

```js
import helmet from "helmet";
import rateLimit from "express-rate-limit";

app.use(helmet());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
// Stricter limit on auth endpoints
app.use("/oauth", rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }));
```

### 3.6 Minor Fixes

- `isDirectRun`: use `fileURLToPath(import.meta.url)`
- Inline `createServerFactory` wrapper
- Remove redundant `apiKeyEnvVar`

### 3.7 Tests

- Tool handlers: ALREADY_EXISTS, NOT_FOUND, FORBIDDEN responses
- Author extraction: anonymous vs email
- successResult/errorResult format
- Ownership check enforcement
- Input validation rejection (bad slug, oversized content)

---

## Module 4: Memory Store (`lib/memory-store.js`)

### 4.1 Search Guard

```js
async search({ query, project, author, nResults = 10 }) {
  if (!embeddingFunction) {
    throw new Error("Semantic search requires GOOGLE_API_KEY to be configured");
  }
  // ...
}
```

### 4.2 Extract buildWhereFilter

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

### 4.3 Remove count()

Delete `count()` method. Update integration tests to use `listEntries().length`.

### 4.4 Tests

- Combo filters (project + author)
- listEntries with no filter
- search without embedding function (error message)
- Empty collection edge case

---

## Module 5: Auth (`lib/auth.js`)

### Changes

- Delete `createTokenVerifier` (lines 20-49)
- Delete `OAuth2Client` import
- Remove `google-auth-library` from package.json dependencies
- Module shrinks to single `extractUserEmail` function

### Tests

- Delete createTokenVerifier tests
- Add edge case: `extractUserEmail({})` → null

---

## Module 6: Docker + Helm

### Dockerfile

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
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
```

### .dockerignore additions

```
helm/
Dockerfile
docker-compose*.yml
*.md
test/
docs/
.git/
```

### docker-compose.yml

- Add `GOOGLE_CLIENT_SECRET`, `MCP_BASE_URL`, `REDIS_URL`
- Add ChromaDB healthcheck + `depends_on: condition: service_healthy`
- Add Redis service

### Helm Chart

- **SecurityContext** on both deployments: runAsNonRoot, readOnlyRootFilesystem, drop ALL
- **NetworkPolicy**: ChromaDB ingress only from MCP pods
- **Remove** `namespace.yaml`
- **StorageClass**: conditional (default to cluster default)
- **Add** Redis deployment + service + env vars
- **Sync** image tag version with package.json

---

## Module 7: Documentation

### server.js

- Fix `serviceDocumentationUrl` to actual repo URL

### README.md

- Add `GOOGLE_CLIENT_SECRET`, `MCP_BASE_URL`, `REDIS_URL` to config table
- Document HTTP endpoints (POST/GET/DELETE /mcp, GET /health)
- Document OAuth flow (opaque tokens, 24h expiry, no refresh)
- Add `TEST_CHROMA_URL` to Development section
- Note `listProjects()` full-scan limitation

### SKILL.md

- Clarify `/memory` etc. are prompting patterns, not slash commands

---

## New Dependencies

| Package | Purpose | Type |
|---------|---------|------|
| `jose` | JWT verification with JWKS | production |
| `ioredis` | Redis client for session store | production |
| `helmet` | Security headers | production |
| `express-rate-limit` | Rate limiting | production |

## Removed Dependencies

| Package | Reason |
|---------|--------|
| `google-auth-library` | Dead code (createTokenVerifier never called in prod) |

---

## Execution Order

1. `lib/session-store.js` (new) — foundation for modules 2 and 3
2. `lib/oauth-provider.js` — security fixes + session store integration
3. `lib/auth.js` — dead code removal
4. `lib/memory-store.js` — search guard + filter helper
5. `server.js` — all server-level fixes + integrations
6. Docker + Helm — infrastructure hardening
7. Documentation — README, SKILL.md, URLs
