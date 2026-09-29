import { afterEach, describe, expect, test } from "bun:test";
import { APICallError } from "@ai-sdk/provider";
import { GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, GATEWAY_GOVERNANCE_SESSION_HEADER, decodeGatewayGovernanceEngineBody, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { GATEWAY_GOVERNANCE_ATTEMPT_HEADER, GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER, managedGatewayBase, readGatewayGovernanceResponse } from "../gateway-governance.js";
import { renderOpencodeV2Config } from "../managed-opencode-v2.js";
import { OpenWorkGatewayQuota } from "./openwork-gateway-quota.js";
import quotaV2 from "./openwork-gateway-quota-v2.js";

const managedBase = "https://models.example/api/v1";
const chat = `${managedBase}/chat/completions`;
const originalFetch = globalThis.fetch;
const originalBase = process.env.OPENWORK_SERVER_URL;
const originalToken = process.env.OPENWORK_GOVERNANCE_TOKEN;
const body: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked", message: "Blocked by organization policies",
  schema_version: 1, request_id: "req_test", decision_id: "decision_test", contribution_id: "msg_test",
  input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false, evaluation_complete: true,
  violations: [{ policy_id: "policy_one", policy_revision: 1, policy_name: "Synthetic policy" }],
} };
const headers = { "x-openwork-governance-error": "1", "x-should-retry": "false", [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER]: "msg_test", [GATEWAY_GOVERNANCE_SESSION_HEADER]: "ses_test" };
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.OPENWORK_SERVER_URL; else process.env.OPENWORK_SERVER_URL = originalBase;
  if (originalToken === undefined) delete process.env.OPENWORK_GOVERNANCE_TOKEN; else process.env.OPENWORK_GOVERNANCE_TOKEN = originalToken;
});

async function transport(baseURL = managedBase, providerId = "openwork", context?: { directory: string }) {
  const options: { baseURL: string; fetch?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> } = { baseURL };
  const hooks = await OpenWorkGatewayQuota(context);
  await hooks.config({ provider: { [providerId]: { options } } });
  return { hooks, send: options.fetch };
}

describe("managed OpenWork Models governance (native v1)", () => {
  test("only the managed provider's own configured Gateway base is recognized", () => {
    expect(managedGatewayBase("openwork", managedBase)?.href).toBe(managedBase);
    expect(managedGatewayBase("openwork", `${managedBase}/`)?.href).toBe(managedBase);
    for (const [id, url] of [["ipr_other", managedBase], ["lpr_custom", managedBase], ["openwork", "https://models.example/v1"],
      ["openwork", `${managedBase}?key=secret`], ["openwork", "https://user:secret@models.example/api/v1"], ["openwork", "ftp://models.example/api/v1"]]) {
      expect(managedGatewayBase(id, url)).toBeUndefined();
    }
  });

  test("a trusted managed rejection is a nonretryable, correlated, host-reported governance error", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    const reports: unknown[] = [];
    const outgoing: Headers[] = [];
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/gateway-governance/report")) { reports.push(JSON.parse(String(init?.body))); return Response.json({ recorded: true }); }
      outgoing.push(new Headers(init?.headers));
      return Response.json(body, { status: 403, headers });
    }, originalFetch);
    const { hooks, send } = await transport(managedBase, "openwork", { directory: "/synthetic" });
    if (!send) throw new Error("Managed transport missing");
    const output = { headers: {} };
    await hooks["chat.headers"]({ sessionID: "ses_test", agent: "build", model: { providerID: "openwork" }, message: { role: "user", id: "msg_test", sessionID: "ses_test" } }, output);
    try {
      await send(chat, { method: "POST", headers: output.headers, body: "not retained" });
      throw new Error("Expected rejection");
    } catch (error) {
      if (!APICallError.isInstance(error)) throw error;
      expect(error.isRetryable).toBe(false);
      expect(decodeGatewayGovernanceEngineBody(error.responseBody ?? "")).toEqual(body);
    }
    expect(outgoing[0]?.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER)).toBe("msg_test");
    expect(outgoing[0]?.get(GATEWAY_GOVERNANCE_SESSION_HEADER)).toBe("ses_test");
    expect(outgoing[0]?.get(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER)).toBe("primary");
    expect(reports).toEqual([
      expect.objectContaining({ phase: "begin", messageID: "msg_test" }),
      expect.objectContaining({ phase: "finish", error: body, correlated: true }),
    ]);
  });

  test("foreign origins, sibling managed paths, provider routes, and redirects cannot forge a managed decision", async () => {
    const base = new URL(managedBase);
    for (const url of ["https://attacker.example/api/v1/chat/completions", `${managedBase}/chat/completions/extra`, `${managedBase}/responses`,
      `${managedBase}/providers/ipr_x/chat/completions`, "https://models.example/api/v2/chat/completions"]) {
      expect(await readGatewayGovernanceResponse(base, new URL(url), Response.json(body, { status: 403, headers }), true)).toBeNull();
    }
    const redirected = Response.json(body, { status: 403, headers });
    Object.defineProperty(redirected, "url", { value: "https://attacker.example/api/v1/chat/completions" });
    expect(await readGatewayGovernanceResponse(base, new URL(chat), redirected, true)).toBeNull();
    expect(await readGatewayGovernanceResponse(base, new URL(chat), Response.json(body, { status: 403 }), true)).toBeNull();
    expect(await readGatewayGovernanceResponse(base, new URL(chat), Response.json(body, { status: 403, headers }), true)).toEqual(body);

    let calls = 0;
    globalThis.fetch = Object.assign(async () => { calls += 1; return Response.json(body, { status: 403, headers }); }, originalFetch);
    const { send } = await transport();
    if (!send) throw new Error("Managed transport missing");
    const foreign = await send("https://attacker.example/api/v1/chat/completions", { headers: { [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER]: "msg_spoof" } });
    expect(foreign.status).toBe(403);
    expect(calls).toBe(1);
    expect((await transport(managedBase, "lpr_lookalike")).send).toBeUndefined();
  });

  test("managed quota responses keep their existing contract", async () => {
    const quota = Response.json({ error: { type: "usage_limit_error", code: "openwork_gateway_usage_limit_exceeded", source: "openwork_gateway", message: "You have reached your AI Gateway usage limit." } },
      { status: 429, headers: { "X-OpenWork-Error-Code": "openwork_gateway_usage_limit_exceeded", "X-OpenWork-Usage-State": "blocked" } });
    globalThis.fetch = Object.assign(async () => quota, originalFetch);
    const { send } = await transport();
    if (!send) throw new Error("Managed transport missing");
    expect(await send(chat)).toBe(quota);
  });
});

type Callback = Parameters<Parameters<typeof quotaV2.setup>[0]["session"]["hook"]>[1];
async function nativeHooks(providers: Record<string, string>) {
  const callbacks = new Map<string, Callback>();
  await quotaV2.setup({ location: { directory: "/synthetic" }, options: { providers }, session: { hook: async (name, callback) => {
    callbacks.set(name, callback); return { dispose: async () => {} };
  } } });
  const request = callbacks.get("http.request"); const response = callbacks.get("http.response");
  if (!request || !response) throw new Error("Missing native hooks");
  return { request, response };
}

describe("native v2 governance identity and managed route", () => {
  test("the managed provider is registered for native v2 governance without credentials", () => {
    const managed = { id: "openwork", name: "OpenWork", baseUrl: managedBase, apiKey: "never-in-plugin-options", models: [] };
    const config = renderOpencodeV2Config({ providers: [managed], skills: [], gatewayQuotaPluginDirectory: "/runtime/gateway-quota-plugin" });
    expect(config.plugins).toEqual([{ package: "file:///runtime/gateway-quota-plugin", options: { providers: { openwork: managedBase } } }]);
    expect(renderOpencodeV2Config({ providers: [{ ...managed, baseUrl: "https://models.example/v1" }], skills: [] }).plugins).toBeUndefined();
  });

  test("a host-established contribution is sent and its trusted outcome reported with exact correlation", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    const reports: Record<string, unknown>[] = [];
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const report: unknown = JSON.parse(String(init?.body));
      if (typeof report === "object" && report !== null && !Array.isArray(report)) reports.push(Object.fromEntries(Object.entries(report)));
      return Response.json(reports.length === 1 ? { recorded: true, contribution: "msg_test" } : { recorded: true });
    }, originalFetch);
    const hooks = await nativeHooks({ openwork: managedBase });
    const event = { sessionID: "ses_test", kind: "primary", model: { providerID: "openwork" }, request: new Request(chat, { headers: {
      [GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER]: "msg_spoof", [GATEWAY_GOVERNANCE_ATTEMPT_HEADER]: "spoof" } }) };
    await hooks.request(event);
    expect(event.request.headers.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER)).toBe("msg_test");
    const attempt = event.request.headers.get(GATEWAY_GOVERNANCE_ATTEMPT_HEADER);
    expect(attempt).toBe(String(reports[0]?.requestID));
    const response = { ...event, request: new Request(event.request), response: Response.json(body, { status: 403, headers }) };
    await hooks.response(response);
    expect(response.response.headers.get("x-should-retry")).toBe("false");
    expect(reports[1]).toMatchObject({ phase: "finish", requestID: attempt, correlated: true, error: body, agent: "primary" });
  });

  test("a response for a different contribution is reported as uncorrelated", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    const reports: unknown[] = [];
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      reports.push(JSON.parse(String(init?.body)));
      return Response.json(reports.length === 1 ? { recorded: true, contribution: "msg_other" } : { recorded: true });
    }, originalFetch);
    const hooks = await nativeHooks({ openwork: managedBase });
    const event = { sessionID: "ses_test", kind: "primary", model: { providerID: "openwork" }, request: new Request(chat) };
    await hooks.request(event);
    await hooks.response({ ...event, response: Response.json(body, { status: 403, headers }) });
    expect(reports[1]).toMatchObject({ phase: "finish", correlated: false });
  });

  test("an already rejected contribution is never dispatched again", async () => {
    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:12345";
    process.env.OPENWORK_GOVERNANCE_TOKEN = "synthetic-token";
    globalThis.fetch = Object.assign(async () => Response.json({ recorded: true, blocked: body }), originalFetch);
    const hooks = await nativeHooks({ openwork: managedBase });
    await expect(hooks.request({ sessionID: "ses_test", kind: "title", model: { providerID: "openwork" }, request: new Request(chat) }))
      .rejects.toMatchObject({ isRetryable: false });
  });
});
