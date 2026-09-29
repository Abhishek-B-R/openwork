import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, GATEWAY_GOVERNANCE_SESSION_HEADER, decodeGatewayGovernanceEngineBody, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER, readGatewayGovernanceResponse } from "../gateway-governance.js";
import { OpenWorkGatewayQuota } from "./openwork-gateway-quota.js";
import quotaV2 from "./openwork-gateway-quota-v2.js";

const baseURL = "https://gateway.example/api/v1/providers/ipr_test";
const originalFetch = globalThis.fetch;
const originalBase = process.env.OPENWORK_SERVER_URL;
const originalToken = process.env.OPENWORK_GOVERNANCE_TOKEN;
const body: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked", message: "Blocked by organization policies",
  schema_version: 1, request_id: "req_test", decision_id: "decision_test", contribution_id: "msg_test",
  input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false, evaluation_complete: true,
  violations: Array.from({ length: 20 }, (_, index) => ({ policy_id: `policy_${index}`, policy_revision: 1, policy_name: `Synthetic policy ${index}` })),
} };
const headers = { "x-openwork-governance-error": "1", "x-should-retry": "false", [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER]: "msg_test", [GATEWAY_GOVERNANCE_SESSION_HEADER]: "ses_test" };
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.OPENWORK_SERVER_URL; else process.env.OPENWORK_SERVER_URL = originalBase;
  if (originalToken === undefined) delete process.env.OPENWORK_GOVERNANCE_TOKEN; else process.env.OPENWORK_GOVERNANCE_TOKEN = originalToken;
});

async function transport(context?: { directory: string }) {
  const options: { baseURL: string; fetch?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> } = { baseURL };
  const hooks = await OpenWorkGatewayQuota(context);
  await hooks.config({ provider: { ipr_test: { options } } });
  if (!options.fetch) throw new Error("Transport missing");
  return { hooks, send: options.fetch };
}

describe("Gateway governance trust and nonretry transport", () => {
  test("preserves every bounded policy name and revision in a nonretryable APICallError", async () => {
    globalThis.fetch = Object.assign(async () => Response.json(body, { status: 403, headers }), originalFetch);
    const { send } = await transport();
    try {
      await send(`${baseURL}/messages`, { method: "POST", body: "not retained" });
      throw new Error("Expected rejection");
    } catch (error) {
      if (!APICallError.isInstance(error)) throw error;
      expect(error.isRetryable).toBe(false);
      expect(decodeGatewayGovernanceEngineBody(error.responseBody ?? "")).toEqual(body);
      expect(error.requestBodyValues).toBeUndefined();
    }
  });

  // Pinned OpenCode v1.18.30 session/retry.ts: an API error is retried when its
  // status is 5xx or its message/body text matches any of these, regardless of
  // isRetryable. Governance errors must never satisfy either rule.
  const ENGINE_RETRY_PATTERNS = [
    /429|500|502|503|504|524/i,
    /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
    /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
    /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
    /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
    /try your request again|retry your request|resource exhausted|resource_exhausted/i,
    /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
  ];
  const hostile: GatewayGovernanceError[] = [
    { error: { ...body.error, request_id: "cac9d502b4e2e78d", decision_id: "3641a4b5-e463-4500-814b-1cca86d31a41",
      violations: [{ policy_id: "policy_503", policy_revision: 429, policy_name: "Rate limit: try again later (503 service unavailable)" }] } },
    { error: { source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_unavailable",
      message: "Service unavailable, please try again later.", schema_version: 1, request_id: "req_500502503", decision_id: "decision_503524",
      contribution_id: "msg_504524", input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false,
      evaluation_complete: false, violations: [] } },
  ];

  test("governance errors never satisfy the engine's automatic retry rules", async () => {
    for (const governance of hostile) {
      const status = governance.error.code === "openwork_gateway_governance_blocked" ? 403 : 503;
      globalThis.fetch = Object.assign(async () => Response.json(governance, { status, headers: { ...headers, "retry-after": "1" } }), originalFetch);
      const { send } = await transport();
      const error = await send(`${baseURL}/messages`, { method: "POST" }).then(() => null, (failure: unknown) => failure);
      if (!APICallError.isInstance(error)) throw new Error("Expected an APICallError");
      expect(error.isRetryable).toBe(false);
      expect(error.statusCode).toBeLessThan(500);
      for (const pattern of ENGINE_RETRY_PATTERNS) {
        expect(error.message).not.toMatch(pattern);
        expect(error.responseBody ?? "").not.toMatch(pattern);
      }
      expect(error.responseHeaders?.["retry-after"]).toBeUndefined();
      expect(decodeGatewayGovernanceEngineBody(error.responseBody ?? "")).toEqual(governance);
    }
  });

  test("native v2 presents governance responses to the engine as the same terminal envelope", async () => {
    const callbacks: Parameters<Parameters<typeof quotaV2.setup>[0]["session"]["hook"]>[1][] = [];
    await quotaV2.setup({ options: { providers: { ipr_test: baseURL } }, session: { hook: async (name, callback) => {
      if (name === "http.response") callbacks.push(callback);
      return { dispose: async () => undefined };
    } } });
    const callback = callbacks[0];
    if (!callback) throw new Error("Missing native response hook");
    for (const governance of hostile) {
      const status = governance.error.code === "openwork_gateway_governance_blocked" ? 403 : 503;
      const event = { model: { providerID: "ipr_test" }, request: new Request(`${baseURL}/messages`), response: Response.json(governance, { status, headers }) };
      await callback(event);
      expect(event.response.status).toBeLessThan(500);
      expect(event.response.headers.get("x-should-retry")).toBe("false");
      const text = await event.response.text();
      for (const pattern of ENGINE_RETRY_PATTERNS) expect(text).not.toMatch(pattern);
      expect(decodeGatewayGovernanceEngineBody(text)).toEqual(governance);
    }
  });

  test("foreign origins, sibling paths, missing markers, raw tool strings, and invalid schemas are not authoritative", async () => {
    const cases = [
      { url: "https://provider.example/messages", response: Response.json(body, { status: 403, headers }) },
      { url: `${baseURL}-spoof/messages`, response: Response.json(body, { status: 403, headers }) },
      { url: `${baseURL}/messages`, response: Response.json(body, { status: 403 }) },
      { url: `${baseURL}/messages`, response: new Response(`tool output: ${JSON.stringify(body)}`, { status: 403, headers }) },
      { url: `${baseURL}/messages`, response: Response.json({ error: { ...body.error, source: "upstream" } }, { status: 403, headers }) },
      { url: `${baseURL}/messages`, response: Response.json({ error: { ...body.error, upstream_dispatched: true } }, { status: 403, headers }) },
      { url: `${baseURL}/messages`, response: new Response(" ".repeat(65_537) + JSON.stringify(body), { status: 403, headers }) },
    ];
    for (const item of cases) expect(await readGatewayGovernanceResponse(new URL(baseURL), new URL(item.url), item.response)).toBeNull();
  });

  test("forwards the hook's exact native identity for title and compaction, never an inferred latest message", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-engine-token";
    const reports: unknown[] = [];
    const outgoing: Headers[] = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/gateway-governance/report")) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json({ recorded: true });
      }
      outgoing.push(new Headers(init?.headers));
      return Response.json(body, { status: 403, headers });
    }, originalFetch);
    const { hooks, send } = await transport({ directory: "/synthetic" });
    for (const agent of ["build", "title", "compaction"]) {
      const output = { headers: {} };
      await hooks["chat.headers"]({ sessionID: "ses_test", agent, model: { providerID: "ipr_test" }, message: { role: "user", id: "msg_test", sessionID: "ses_test" } }, output);
      await expect(send(`${baseURL}/messages`, { headers: output.headers })).rejects.toMatchObject({ isRetryable: false });
    }
    expect(reports).toHaveLength(6);
    expect(reports[0]).toMatchObject({ phase: "begin", messageID: "msg_test", sessionID: "ses_test", agent: "build" });
    expect(reports[1]).toMatchObject({ phase: "finish", error: body, correlated: true });
    expect(reports[2]).toMatchObject({ agent: "title", messageID: "msg_test" });
    expect(reports[4]).toMatchObject({ agent: "compaction", messageID: "msg_test" });
    expect(outgoing.every((item) => item.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER) === "msg_test" && !item.has("x-openwork-local-governance-attempt"))).toBe(true);
    expect(outgoing.map((item) => item.get(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER))).toEqual(["primary", "title", "compaction"]);
    const missing = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_test", agent: "title", model: { providerID: "ipr_test" } }, missing);
    expect(new Headers(missing.headers).has(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER)).toBe(false);
    expect(new Headers(missing.headers).get(GATEWAY_GOVERNANCE_SESSION_HEADER)).toBe("ses_test");
    const mismatched = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_other", agent: "build", model: { providerID: "ipr_test" }, message: { id: "msg_test", sessionID: "ses_test", role: "user" } }, mismatched);
    expect(new Headers(mismatched.headers).has(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER)).toBe(false);
  });

  test("ordinary uncorrelated Gateway requests still forward without creating a recovery hold", async () => {
    let calls = 0;
    let outgoing: Headers | undefined;
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls++;
      outgoing = new Headers(init?.headers);
      return Response.json({ ordinary: true });
    }, originalFetch);
    const { send } = await transport({ directory: "/synthetic" });
    const response = await send(`${baseURL}/messages`, { headers: { [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER]: "untrusted" } });
    expect(await response.json()).toEqual({ ordinary: true });
    expect(calls).toBe(1);
    expect(outgoing?.has(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER)).toBe(false);
  });

  test("a network failure reports settled unsafe tracking without converting the original error into a policy block", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    const reports: unknown[] = [];
    const networkError = new Error("synthetic connection failure");
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/gateway-governance/report")) {
        reports.push(JSON.parse(String(init?.body)));
        return Response.json({ recorded: true });
      }
      throw networkError;
    }, originalFetch);
    const { hooks, send } = await transport({ directory: "/synthetic" });
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_test", agent: "build", model: { providerID: "ipr_test" }, message: { id: "msg_test", sessionID: "ses_test", role: "user" } }, output);
    await expect(send(`${baseURL}/messages`, output)).rejects.toBe(networkError);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ phase: "finish", outcome: "transport_failed" });
  });

  test("a pre-existing host recovery hold prevents upstream calls and native retry", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input)); return new Response(null, { status: 409 });
    }, originalFetch);
    const { hooks, send } = await transport({ directory: "/synthetic" });
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_test", agent: "build", model: { providerID: "ipr_test" }, message: { id: "msg_test", sessionID: "ses_test", role: "user" } }, output);
    await expect(send(`${baseURL}/messages`, output)).rejects.toMatchObject({ isRetryable: false });
    expect(urls).toEqual(["http://127.0.0.1:12345/gateway-governance/report"]);
  });

  test("native v2 persists only exact session correlation across cloned request objects", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    const reports: unknown[] = [];
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      reports.push(JSON.parse(String(init?.body))); return Response.json({ recorded: true });
    }, originalFetch);
    type Callback = Parameters<Parameters<typeof quotaV2.setup>[0]["session"]["hook"]>[1];
    const callbacks = new Map<string, Callback>();
    await quotaV2.setup({ location: { directory: "/synthetic" }, options: { providers: { ipr_test: baseURL } }, session: { hook: async (name, callback) => {
      callbacks.set(name, callback); return { dispose: async () => {} };
    } } });
    const request = callbacks.get("http.request"); const response = callbacks.get("http.response");
    if (!request || !response) throw new Error("Missing native hooks");
    const event = { sessionID: "ses_test", model: { providerID: "ipr_test" }, request: new Request(`${baseURL}/messages`, { headers: { [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER]: "untrusted" } }) };
    await request(event);
    expect(event.request.headers.get(GATEWAY_GOVERNANCE_SESSION_HEADER)).toBe("ses_test");
    expect(event.request.headers.has(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER)).toBe(false);
    await response({ ...event, request: new Request(event.request), response: Response.json(body, { status: 403, headers }) });
    expect(reports[0]).toMatchObject({ sessionID: "ses_test", phase: "check" });
    expect(reports[1]).toMatchObject({ sessionID: "ses_test", phase: "reject", error: body });
    expect(reports.every((item) => typeof item === "object" && item !== null && !("messageID" in item))).toBe(true);
  });

  test("v2 native response hook keeps the exact governance decision and disables automatic retry for outage as well as block", async () => {
    type Callback = Parameters<Parameters<typeof quotaV2.setup>[0]["session"]["hook"]>[1];
    let callback: Callback | undefined;
    await quotaV2.setup({ options: { providers: { ipr_test: baseURL } }, session: { hook: async (_name, handle) => {
      callback = handle; return { dispose: async () => {} };
    } } });
    if (!callback) throw new Error("Missing hook");
    for (const status of [403, 503]) {
      const outage: GatewayGovernanceError = { error: { ...body.error, code: "openwork_gateway_governance_unavailable", violations: [], evaluation_complete: false } };
      const payload = status === 403 ? body : outage;
      const event = { model: { providerID: "ipr_test" }, request: new Request(`${baseURL}/messages`), response: Response.json(payload, { status, headers }) };
      await callback(event);
      expect(event.response.headers.get("x-should-retry")).toBe("false");
      expect(event.response.status).toBeLessThan(500);
      expect(decodeGatewayGovernanceEngineBody(await event.response.text())).toEqual(payload);
    }
  });
});
