import { APICallError } from "@ai-sdk/provider";
import {
  GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER,
  GATEWAY_GOVERNANCE_ENGINE_MESSAGE,
  GATEWAY_GOVERNANCE_ERROR_HEADER,
  GATEWAY_GOVERNANCE_SESSION_HEADER,
  encodeGatewayGovernanceEngineBody,
  gatewayGovernanceEngineStatus,
} from "@openwork/types/den/gateway-governance";
import { gatewayBase, isGatewayQuotaResponse, record } from "../gateway-quota.js";
import { GATEWAY_GOVERNANCE_ATTEMPT_HEADER, GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER, managedGatewayBase, readGatewayGovernanceResponse, withinGatewayRoute } from "../gateway-governance.js";
import { GovernanceRecoveryHeldError, reportGovernanceV2, type GovernanceReportReply } from "./governance-client.js";

type HttpResponse = {
  sessionID?: string;
  kind?: string;
  model: { providerID: string };
  request: Request;
  response?: Response;
};

/** Engines retry 5xx and transient-looking text regardless of retry flags, so a
 * governance decision reaches the engine only as a terminal, opaque envelope. */
function engineHeaders(response?: Response): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", [GATEWAY_GOVERNANCE_ERROR_HEADER]: "1", "x-should-retry": "false" };
  for (const name of [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, GATEWAY_GOVERNANCE_SESSION_HEADER]) {
    const value = response?.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

type Context = {
  location?: { directory: string };
  options: Record<string, unknown>;
  session: {
    hook: (
      name: "http.request" | "http.response",
      callback: (event: HttpResponse) => Promise<void>,
      options: { providerID: string },
    ) => Promise<{ dispose: () => Promise<void> }>;
  };
};

export default {
  id: "openwork.gateway-quota",
  setup: async (context: Context) => {
    const providers = record(context.options.providers) ? context.options.providers : {};
    const registrations: { dispose: () => Promise<void> }[] = [];
    const directory = context.location?.directory;
    for (const [id, baseURL] of Object.entries(providers)) {
      const providerBase = gatewayBase(id, baseURL);
      const managedBase = providerBase ? undefined : managedGatewayBase(id, baseURL);
      const base = providerBase ?? managedBase;
      const managed = managedBase !== undefined;
      if (!base) continue;
      if (directory) registrations.push(await context.session.hook("http.request", async (event) => {
        const url = new URL(event.request.url);
        if (event.model.providerID !== id || !withinGatewayRoute(base, url, managed)) return;
        const requestID = crypto.randomUUID();
        let admission: GovernanceReportReply = { recorded: false };
        if (event.sessionID) {
          try { admission = await reportGovernanceV2({ directory, sessionID: event.sessionID, requestID, agent: event.kind, phase: "check" }); }
          catch (error) {
            if (error instanceof GovernanceRecoveryHeldError) throw new APICallError({ message: error.message, url: `${url.origin}${url.pathname}`, requestBodyValues: undefined, isRetryable: false });
            throw error;
          }
        }
        if (admission.blocked) {
          // The same contribution was already rejected: never dispatch it again.
          throw new APICallError({
            message: GATEWAY_GOVERNANCE_ENGINE_MESSAGE, url: `${url.origin}${url.pathname}`, requestBodyValues: undefined,
            statusCode: gatewayGovernanceEngineStatus(admission.blocked), responseHeaders: engineHeaders(),
            responseBody: encodeGatewayGovernanceEngineBody(admission.blocked), isRetryable: false,
          });
        }
        const headers = new Headers(event.request.headers);
        headers.delete(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER);
        headers.delete(GATEWAY_GOVERNANCE_SESSION_HEADER);
        headers.delete(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER);
        headers.delete(GATEWAY_GOVERNANCE_ATTEMPT_HEADER);
        if (event.sessionID) headers.set(GATEWAY_GOVERNANCE_SESSION_HEADER, event.sessionID);
        if (event.kind) headers.set(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER, event.kind);
        if (event.sessionID && admission.contribution) {
          // Host-established identity of the exact submitted user message.
          headers.set(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, admission.contribution);
          headers.set(GATEWAY_GOVERNANCE_ATTEMPT_HEADER, requestID);
        }
        event.request = new Request(event.request, { headers });
      }, { providerID: id }));
      registrations.push(await context.session.hook("http.response", async (event) => {
        if (event.model.providerID !== id || !event.response) return;
        const url = new URL(event.request.url);
        const response = event.response;
        const governance = await readGatewayGovernanceResponse(base, url, response, managed);
        const attempt = event.request.headers.get(GATEWAY_GOVERNANCE_ATTEMPT_HEADER);
        const contribution = event.request.headers.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER);
        if (directory && event.sessionID && attempt && contribution && withinGatewayRoute(base, url, managed)) {
          const correlated = Boolean(governance?.error.contribution_id === contribution
            && response.headers.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER) === contribution
            && response.headers.get(GATEWAY_GOVERNANCE_SESSION_HEADER) === event.sessionID);
          await reportGovernanceV2({ directory, sessionID: event.sessionID, requestID: attempt, agent: event.kind, phase: "finish",
            correlated, outcome: "response", ...(governance ? { error: governance } : {}) }).catch(() => undefined);
        } else if (directory && event.sessionID && governance) {
          await reportGovernanceV2({ directory, sessionID: event.sessionID, requestID: crypto.randomUUID(), agent: event.kind, phase: "reject", error: governance }).catch(() => undefined);
        }
        if (governance) {
          void response.body?.cancel().catch(() => undefined);
          event.response = new Response(encodeGatewayGovernanceEngineBody(governance), {
            status: gatewayGovernanceEngineStatus(governance), headers: engineHeaders(response),
          });
          return;
        }
        if (managed || !await isGatewayQuotaResponse(base, url, response)) return;
        const headers = new Headers(response.headers);
        headers.set("x-should-retry", "false");
        event.response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }, { providerID: id }));
    }
    return async () => {
      for (const registration of registrations) await registration.dispose();
    };
  },
};
