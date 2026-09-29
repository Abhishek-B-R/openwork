import { APICallError } from "@ai-sdk/provider";
import { GATEWAY_USAGE_LIMIT_ERROR_CODE } from "@openwork/types/den/gateway-usage-limits";
import { gatewayBase, GATEWAY_QUOTA_MESSAGE, isGatewayQuotaResponse, record } from "../gateway-quota.js";
import {
  GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER,
  GATEWAY_GOVERNANCE_ENGINE_MESSAGE,
  GATEWAY_GOVERNANCE_ERROR_HEADER,
  GATEWAY_GOVERNANCE_SESSION_HEADER,
  encodeGatewayGovernanceEngineBody,
  gatewayGovernanceEngineStatus,
  type GatewayGovernanceError,
} from "@openwork/types/den/gateway-governance";

/** Only the governance correlation headers reach the engine; retry-after and
 * request IDs are dropped so they cannot influence engine retry decisions. */
function governanceResponseHeaders(response: Response): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, GATEWAY_GOVERNANCE_SESSION_HEADER]) {
    const value = response.headers.get(name);
    if (value) kept[name] = value;
  }
  return kept;
}
import { GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER, managedGatewayBase, readGatewayGovernanceResponse, withinGatewayRoute } from "../gateway-governance.js";
import { reportGovernance, reportGovernanceNotice, GovernanceRecoveryHeldError, type GovernanceAttempt } from "./governance-client.js";

export const OpenWorkGatewayQuota = async (context?: { directory: string }) => {
  const attempts = new Map<string, GovernanceAttempt>();
  const bases = new Map<string, URL>();
  const marker = "x-openwork-local-governance-attempt";
  return {
    "chat.headers": async (input: { sessionID: string; agent: string; model: { providerID: string }; message?: { id: string; sessionID: string; role: string } }, output: { headers: Record<string, string> }) => {
      delete output.headers[marker];
      delete output.headers[GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER];
      delete output.headers[GATEWAY_GOVERNANCE_SESSION_HEADER];
      delete output.headers[GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER];
      if (!bases.has(input.model.providerID) || !context) return;
      const messageID = input.message?.role === "user" && input.message.sessionID === input.sessionID ? input.message.id : undefined;
      const key = crypto.randomUUID();
      if (attempts.size >= 1024) attempts.delete(attempts.keys().next().value ?? "");
      attempts.set(key, { directory: context.directory, sessionID: input.sessionID, messageID, agent: input.agent });
      output.headers[marker] = key;
      if (messageID) output.headers[GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER] = messageID;
      output.headers[GATEWAY_GOVERNANCE_SESSION_HEADER] = input.sessionID;
      output.headers[GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER] = input.agent === "title" ? "title" : input.agent === "compaction" ? "compaction" : "primary";
    },
    config: async (config: { provider?: Record<string, unknown> }) => {
      for (const [id, provider] of Object.entries(config.provider ?? {})) {
        if (!record(provider) || !record(provider.options)) continue;
        const options = provider.options;
        const providerBase = gatewayBase(id, options.baseURL);
        const managedBase = providerBase ? undefined : managedGatewayBase(id, options.baseURL);
        const base = providerBase ?? managedBase;
        const managed = managedBase !== undefined;
        if (!base || options.fetch !== undefined) continue;
        bases.set(id, base);
        options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          const attempt = attempts.get(headers.get(marker) ?? "");
          headers.delete(marker);
          const withinGateway = withinGatewayRoute(base, url, managed);
          const owned = attempt && withinGateway ? attempt : undefined;
          headers.delete(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER);
          headers.delete(GATEWAY_GOVERNANCE_SESSION_HEADER);
          headers.delete(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER);
          if (owned) {
            if (owned.messageID) headers.set(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, owned.messageID);
            headers.set(GATEWAY_GOVERNANCE_SESSION_HEADER, owned.sessionID);
            headers.set(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER, owned.agent === "title" ? "title" : owned.agent === "compaction" ? "compaction" : "primary");
          }
          // The engine retries 5xx statuses and transient-looking text even when
          // isRetryable is false, so it only ever sees a terminal status, a static
          // message and an opaque body. OpenWork decodes the body for display.
          const failure = (governance: GatewayGovernanceError, response?: Response) => new APICallError({
            message: GATEWAY_GOVERNANCE_ENGINE_MESSAGE, url: `${url.origin}${url.pathname}`, requestBodyValues: undefined,
            statusCode: gatewayGovernanceEngineStatus(governance),
            responseHeaders: {
              ...(response ? governanceResponseHeaders(response) : {}),
              [GATEWAY_GOVERNANCE_ERROR_HEADER]: "1",
              "x-should-retry": "false",
            },
            responseBody: encodeGatewayGovernanceEngineBody(governance), isRetryable: false,
          });
          const requestID = crypto.randomUUID();
          let tracked = false;
          try {
            if (owned?.messageID) {
              const admission = await reportGovernance(owned, requestID, "begin");
              if (admission.blocked) throw failure(admission.blocked);
              tracked = admission.recorded;
            } else if (owned) {
              await reportGovernanceNotice({ directory: owned.directory, sessionID: owned.sessionID, requestID, agent: owned.agent, phase: "check" });
            }
          } catch (error) {
            if (error instanceof GovernanceRecoveryHeldError) throw new APICallError({ message: error.message, url: `${url.origin}${url.pathname}`, requestBodyValues: undefined, isRetryable: false });
            throw error;
          }
          let response: Response;
          try { response = await globalThis.fetch(input, { ...init, headers }); }
          catch (error) {
            if (tracked && owned) await reportGovernance(owned, requestID, "finish", undefined, false, "transport_failed").catch(() => undefined);
            throw error;
          }
          const governance = await readGatewayGovernanceResponse(base, url, response, managed);
          if (tracked && owned) {
            await reportGovernance(owned, requestID, "finish", governance ?? undefined, Boolean(governance?.error.contribution_id === owned.messageID
              && response.headers.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER) === owned.messageID
              && response.headers.get(GATEWAY_GOVERNANCE_SESSION_HEADER) === owned.sessionID)).catch(() => undefined);
          } else if (governance && owned) {
            await reportGovernanceNotice({ directory: owned.directory, sessionID: owned.sessionID, requestID, agent: owned.agent, phase: "reject", error: governance }).catch(() => undefined);
          }
          if (governance) {
            void response.body?.cancel().catch(() => undefined);
            throw failure(governance, response);
          }
          // Managed Models keep their existing quota contract; only governance is shared.
          if (managed || !await isGatewayQuotaResponse(base, url, response)) return response;
          void response.body?.cancel().catch(() => undefined);
          throw new APICallError({
            message: GATEWAY_QUOTA_MESSAGE,
            url: `${url.origin}${url.pathname}`,
            requestBodyValues: undefined,
            statusCode: response.status,
            responseHeaders: Object.fromEntries(response.headers),
            responseBody: JSON.stringify({ error: {
              type: "usage_limit_error",
              code: GATEWAY_USAGE_LIMIT_ERROR_CODE,
              source: "openwork_gateway",
              message: GATEWAY_QUOTA_MESSAGE,
            } }),
            isRetryable: false,
          });
        };
      }
    },
  };
};
