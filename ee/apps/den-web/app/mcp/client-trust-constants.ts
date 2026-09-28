/**
 * Reviewed CIMD identity hosts, not callback hosts or client-supplied names.
 * Exact matches only: adding a host trusts every metadata path on that host.
 * Do not add shared/user-content hosting domains or wildcard subdomains.
 * This controls consent copy only, not authorization or software attestation.
 * Only clients that present a CIMD URL can match; dynamically registered
 * clients keep the generic warning because their names are self-asserted.
 *
 * - claude.ai: Claude web, desktop, mobile, and Cowork
 *   (/oauth/mcp-oauth-client-metadata) and Claude Code
 *   (/oauth/claude-code-client-metadata).
 * - chatgpt.com: ChatGPT (/oauth/client.json or /oauth/<callback_id>/client.json)
 *   and Codex (/oauth/codex/<callback_id>/client.json).
 * - vscode.dev: VS Code (/oauth/client-metadata.json).
 */
export const KNOWN_MCP_CIMD_DOMAINS: readonly string[] = ["claude.ai", "chatgpt.com", "vscode.dev"];

export function mcpCimdDomain(clientId: string | null): string | null {
  if (!clientId) return null;
  try {
    const url = new URL(clientId);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/") return null;
    return url.host;
  } catch {
    return null;
  }
}

export function knownMcpCimdDomain(clientId: string | null): string | null {
  const domain = mcpCimdDomain(clientId);
  return domain && KNOWN_MCP_CIMD_DOMAINS.includes(domain) ? domain : null;
}
