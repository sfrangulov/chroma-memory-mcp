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
