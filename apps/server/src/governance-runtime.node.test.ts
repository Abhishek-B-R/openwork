import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "@ai-sdk/provider";
import { decodeGatewayGovernanceEngineBody, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { createGovernanceRecovery, type GovernanceJournal, type GovernanceNativeSnapshot } from "./governance-recovery.js";
import { OpenWorkGatewayQuota } from "./opencode-plugins/openwork-gateway-quota.js";

const blocked: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked",
  schema_version: 1, request_id: "req_fixture", decision_id: "decision_fixture", contribution_id: "msg_fixture",
  message: "Blocked by organization policy", input_scope: "new_user_contribution", upstream_dispatched: false,
  retryable: false, evaluation_complete: true, violations: [{ policy_id: "policy_fixture", policy_revision: 1, policy_name: "Credentials" }],
} };

test("verification runs in the shipping Electron Node runtime", { skip: process.versions.electron ? false : "needs: Electron with ELECTRON_RUN_AS_NODE=1" }, () => {
  assert.ok(process.versions.electron, "Use ELECTRON_RUN_AS_NODE=1 and the desktop Electron executable");
  assert.equal(process.versions.bun, undefined);
});

test("Electron preserves policy errors as nonretryable without sending request data into exceptions", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json(blocked, { status: 403, headers: { "x-openwork-governance-error": "1", "x-should-retry": "false" } }), original);
  try {
    const hooks = await OpenWorkGatewayQuota();
    const options: { baseURL: string; fetch?: typeof fetch } = { baseURL: "https://gateway.example/api/v1/providers/ipr_fixture" };
    await hooks.config({ provider: { ipr_fixture: { options } } });
    assert.ok(options.fetch);
    await assert.rejects(options.fetch(`${options.baseURL}/chat/completions`, { method: "POST", body: "synthetic-private-input" }), (error: unknown) => {
      assert.ok(APICallError.isInstance(error));
      assert.equal(error.isRetryable, false);
      assert.equal(error.requestBodyValues, undefined);
      assert.deepEqual(decodeGatewayGovernanceEngineBody(error.responseBody ?? ""), blocked);
      return true;
    });
  } finally { globalThis.fetch = original; }
});

test("Electron persists exclusion before removal and restores the display record after restart", async () => {
  const stored = new Map<string, GovernanceJournal>();
  const mutations: string[] = [];
  const snapshot: GovernanceNativeSnapshot = { idle: true, reverted: false, title: "New session - synthetic", messages: [
    { id: "msg_fixture", sessionID: "ses_fixture", role: "user", created: 1, parts: [{ type: "text", text: "Synthetic blocked contribution" }] },
  ] };
  const dependencies = {
    load: async (scope: string) => structuredClone(stored.get(scope) ?? null),
    save: async (scope: string, journal: GovernanceJournal) => { stored.set(scope, structuredClone(journal)); },
    remove: async (scope: string) => { stored.delete(scope); },
  };
  const native = {
    snapshot: async () => structuredClone(snapshot),
    deleteMessage: async (id: string) => {
      assert.ok(stored.get("scope")?.entries[0].deleteAttempted.includes(id));
      mutations.push(id);
      snapshot.messages = snapshot.messages.filter((message) => message.id !== id);
    },
  };
  const host = createGovernanceRecovery(dependencies);
  for (const agent of ["title", "build"]) {
    const report = { directory: "/synthetic", sessionID: "ses_fixture", messageID: "msg_fixture", requestID: `req_${agent}`, agent, correlated: true };
    const result = await host.report("scope", { ...report, phase: "begin" }, native);
    if (!result.blocked) await host.report("scope", { ...report, phase: "finish", error: blocked }, native);
  }
  await host.cleanup("scope", "ses_fixture", native, "v1");
  assert.deepEqual(mutations, ["msg_fixture"]);
  assert.deepEqual(snapshot.messages, []);
  const restarted = createGovernanceRecovery(dependencies);
  const view = await restarted.view("scope", "ses_fixture");
  assert.equal(view.held, false);
  assert.equal(view.entries[0].state, "excluded");
  assert.equal(view.entries[0].text, "Synthetic blocked contribution");
  await restarted.assertAdmission("scope", "ses_fixture", "msg_replacement");
});
