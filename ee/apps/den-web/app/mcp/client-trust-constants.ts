/**
 * Reviewed CIMD identity hosts, not callback hosts or client-supplied names.
 * Exact matches only: adding a host trusts every metadata path on that host.
 * Do not add shared/user-content hosting domains or wildcard subdomains.
 * This controls consent copy only, not authorization or software attestation.
 * Claude Code publishes https://claude.ai/oauth/claude-code-client-metadata.
 */
export const KNOWN_MCP_CIMD_DOMAINS: readonly string[] = ["claude.ai"];

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
