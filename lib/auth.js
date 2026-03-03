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
