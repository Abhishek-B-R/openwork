import { gatewayGovernanceErrorSchema, hasGatewayGovernanceHttpMarker, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";

export const GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER = "x-openwork-governance-request-kind";
export const GATEWAY_GOVERNANCE_ATTEMPT_HEADER = "x-openwork-governance-request-attempt";
export const MANAGED_GATEWAY_PROVIDER_ID = "openwork";

/** The managed OpenWork Models route: only the `openwork` provider's own
 * configured Gateway base (`…/api/v1`), never a derived or arbitrary URL. */
export function managedGatewayBase(id: string, baseURL: unknown): URL | undefined {
  if (id !== MANAGED_GATEWAY_PROVIDER_ID || typeof baseURL !== "string") return;
  try {
    const url = new URL(baseURL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith("/api/v1")) return;
    return url;
  } catch {
    return;
  }
}

/** Organization-provider routes own everything below their provider base; the
 * managed route owns exactly its chat-completions endpoint. */
export function withinGatewayRoute(base: URL, url: URL, managed = false) {
  return url.origin === base.origin && (managed
    ? url.pathname === `${base.pathname}/chat/completions`
    : url.pathname.startsWith(`${base.pathname}/`));
}

export async function readGatewayGovernanceResponse(base: URL, url: URL, response: Response, managed = false): Promise<GatewayGovernanceError | null> {
  const within = (candidate: URL) => withinGatewayRoute(base, candidate, managed);
  if (!within(url) || (response.url && !within(new URL(response.url))) || !hasGatewayGovernanceHttpMarker(response)) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const parsed = gatewayGovernanceErrorSchema.safeParse(JSON.parse(text + decoder.decode()));
    return parsed.success ? parsed.data : null;
  };
  try {
    return await Promise.race([read(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 5_000); })]);
  } catch { return null; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => undefined); }
}
