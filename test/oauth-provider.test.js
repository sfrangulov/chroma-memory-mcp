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
