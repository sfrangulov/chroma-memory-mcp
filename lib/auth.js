/**
 * Google OAuth2 JWT verification for MCP auth.
 *
 * The MCP server acts as a Resource Server — it validates Google-issued
 * JWTs and extracts user email for author attribution.
 *
 * @module auth
 */

import { OAuth2Client } from "google-auth-library";

/**
 * Creates a token verifier that validates Google ID tokens.
 *
 * @param {object} params
 * @param {string} params.googleClientId - Google OAuth2 Client ID
 * @param {OAuth2Client} [params._oauth2Client] - injectable for testing
 * @returns {{ verifyAccessToken: (token: string) => Promise<object> }}
 */
export function createTokenVerifier({ googleClientId, _oauth2Client }) {
  const oauth2Client = _oauth2Client || new OAuth2Client(googleClientId);

  return {
    async verifyAccessToken(token) {
      const ticket = await oauth2Client.verifyIdToken({
        idToken: token,
        audience: googleClientId,
      });

      const payload = ticket.getPayload();
      if (!payload) {
        throw new Error("Token payload is missing");
      }
      if (!payload.email_verified) {
        throw new Error("Email not verified");
      }
      if (!payload.email) {
        throw new Error("Email claim is missing from token");
      }

      return {
        token,
        clientId: googleClientId,
        scopes: [],
        email: payload.email,
        sub: payload.sub,
      };
    },
  };
}

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
