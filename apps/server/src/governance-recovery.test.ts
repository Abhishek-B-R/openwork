import { describe, expect, test } from "bun:test";
import type { GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { createGovernanceRecovery, type GovernanceJournal, type GovernanceNativeSnapshot, type GovernanceReport } from "./governance-recovery.js";

const error: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked",
  message: "Blocked by organization policies", schema_version: 1, request_id: "req_test", decision_id: "decision_test",
  contribution_id: "msg_original", input_scope: "new_user_contribution", upstream_dispatched: false,
  retryable: false, evaluation_complete: true, violations: [
    { policy_id: "policy_one", policy_revision: 1, policy_name: "Synthetic credentials" },
    { policy_id: "policy_two", policy_revision: 2, policy_name: "Synthetic personal data" },
  ],
} };
const report: GovernanceReport = { directory: "/synthetic", sessionID: "ses_test", messageID: "msg_original", requestID: "req_call", phase: "begin", agent: "build", correlated: true };

function fixture() {
  const persisted = new Map<string, GovernanceJournal>();
  const mutations: string[] = [];
  let saveFails = false;
  let loseDeleteReply = false;
  let performDelete = true;
  const state: GovernanceNativeSnapshot = { idle: false, reverted: false, title: "New session - synthetic", messages: [
    { id: "msg_original", sessionID: "ses_test", role: "user", created: 1, parts: [{ type: "text", text: "Synthetic blocked text" }] },
    { id: "msg_placeholder", sessionID: "ses_test", role: "assistant", created: 2, parentID: "msg_original", error: { name: "APIError" }, parts: [] },
  ] };
  const deps = {
    load: async (scope: string) => structuredClone(persisted.get(scope) ?? null),
    save: async (scope: string, journal: GovernanceJournal) => {
      if (saveFails) throw new Error("disk unavailable");
      persisted.set(scope, structuredClone(journal));
    },
    remove: async (scope: string) => { persisted.delete(scope); },
  };
  let host = createGovernanceRecovery(deps);
  const native = {
    snapshot: async () => structuredClone(state),
    deleteMessage: async (messageID: string) => {
      expect(persisted.get("scope")?.entries[0].deleteAttempted).toContain(messageID);
      expect(persisted.get("scope")?.entries[0].text).toBe("Synthetic blocked text");
      mutations.push(messageID);
      if (performDelete) state.messages = state.messages.filter((item) => item.id !== messageID);
      if (loseDeleteReply) throw new Error("reply lost");
    },
  };
  return { state, mutations, persisted, native, get host() { return host; },
    restart: () => { host = createGovernanceRecovery(deps); },
    saveFails: () => { saveFails = true; },
    uncertain: (deleted: boolean) => { loseDeleteReply = true; performDelete = deleted; },
    block: async (override?: GatewayGovernanceError) => {
      await host.report("scope", report, native);
      await host.report("scope", { ...report, requestID: "req_title", agent: "title" }, native);
      await host.report("scope", { ...report, requestID: "req_title", agent: "title", phase: "finish", error: override ?? error }, native);
      await host.report("scope", { ...report, phase: "finish", error: override ?? error }, native);
    },
  };
}

describe("host-owned governance recovery", () => {
  test("persists exact display identity before deleting only the idle rejected user and empty placeholder", async () => {
    const f = fixture();
    await f.block();
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual([]);
    f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual(["msg_placeholder", "msg_original"]);
    expect(f.state.messages).toEqual([]);
    const view = await f.host.view("scope", "ses_test");
    expect(view.held).toBe(false);
    expect(view.entries[0]).toMatchObject({ state: "excluded", messageID: "msg_original", text: "Synthetic blocked text", error });
  });

  test("a step-start-only assistant placeholder is metadata, not substantive output", async () => {
    const f = fixture(); await f.block(); f.state.idle = true;
    f.state.messages[1].parts = [{ type: "step-start" }];
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual(["msg_placeholder", "msg_original"]);
    expect((await f.host.view("scope", "ses_test")).entries[0].state).toBe("excluded");
  });

  test("reload and crash between saving the block and deletion keep the queue and task recovery paused", async () => {
    const f = fixture();
    await f.block();
    f.restart();
    expect((await f.host.view("scope", "ses_test")).held).toBe(true);
    await expect(f.host.assertAdmission("scope", "ses_test", "msg_new")).rejects.toThrow("recovery");
    f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    f.restart();
    expect((await f.host.view("scope", "ses_test")).entries[0].state).toBe("excluded");
    await f.host.assertAdmission("scope", "ses_test", "msg_new");
    await expect(f.host.assertAdmission("scope", "ses_test", "msg_original")).rejects.toThrow("recovery");
  });

  test("replacement is a new native identity and never restores a rejected original", async () => {
    const f = fixture();
    await f.block(); f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    f.state.messages.push({ id: "msg_new", sessionID: "ses_test", role: "user", created: 3, parts: [{ type: "text", text: "Edited contribution" }] });
    await f.host.report("scope", { ...report, messageID: "msg_new", requestID: "req_new" }, f.native);
    await f.host.report("scope", { ...report, messageID: "msg_new", requestID: "req_new", phase: "finish" }, f.native);
    expect(f.state.messages.map((item) => item.id)).toEqual(["msg_new"]);
    expect((await f.host.view("scope", "ses_test")).entries).toHaveLength(1);
  });

  test("failed persistence cannot lead to deletion", async () => {
    const f = fixture();
    await f.host.report("scope", report, f.native);
    f.saveFails();
    await expect(f.host.report("scope", { ...report, phase: "finish", error }, f.native)).rejects.toThrow();
    f.state.idle = true;
    await expect(f.host.cleanup("scope", "ses_test", f.native, "v1")).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });

  test("an uncertain delete is inspected and never automatically repeated, including after restart", async () => {
    for (const deleted of [true, false]) {
      const f = fixture(); await f.block(); f.state.idle = true; f.uncertain(deleted);
      await f.host.cleanup("scope", "ses_test", f.native, "v1");
      const calls = [...f.mutations];
      f.restart();
      await f.host.cleanup("scope", "ses_test", f.native, "v1");
      expect(f.mutations).toEqual(calls);
      expect((await f.host.view("scope", "ses_test")).held).toBe(!deleted);
    }
  });

  test("orphaned in-flight assessment survives restart without replaying or deleting", async () => {
    const f = fixture(); await f.host.report("scope", report, f.native); f.restart(); f.state.idle = true;
    await expect(f.host.assertAdmission("scope", "ses_test", "msg_new")).rejects.toThrow();
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual([]);
  });

  test("native v2 offers non-destructive unsupported recovery, never the files:true revert adapter", async () => {
    const f = fixture(); await f.block(); f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v2");
    expect(f.mutations).toEqual([]);
    expect((await f.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
  });

  test("rejects missing, cross-session, and mismatched contribution correlation", async () => {
    const f = fixture();
    await expect(f.host.report("scope", { ...report, messageID: "msg_missing" }, f.native)).rejects.toThrow("exact");
    await expect(f.host.report("different", { ...report, sessionID: "ses_other" }, f.native)).rejects.toThrow("exact");
    await f.block({ error: { ...error.error, contribution_id: "msg_other" } }); f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual([]);
  });

  test("substantive output, tools, summaries, later contributions, edited parts, and staged revert all prevent deletion", async () => {
    const changes: ((snapshot: GovernanceNativeSnapshot) => void)[] = [
      (snapshot) => { snapshot.messages[1].parts.push({ type: "text", text: "Output" }); },
      (snapshot) => { snapshot.messages[1].parts.push({ type: "tool" }); },
      (snapshot) => { snapshot.messages[1].summary = true; },
      (snapshot) => { snapshot.messages.push({ id: "msg_later", sessionID: "ses_test", role: "user", created: 3, parts: [] }); },
      (snapshot) => { snapshot.messages[0].parts[0].text = "Changed same identity"; },
      (snapshot) => { snapshot.reverted = true; },
      (snapshot) => { snapshot.title = "Derived from the contribution"; },
    ];
    for (const change of changes) {
      const f = fixture(); await f.block(); f.state.idle = true; change(f.state);
      await f.host.cleanup("scope", "ses_test", f.native, "v1");
      expect(f.mutations).toEqual([]);
    }
  });

  test("a first contribution without a correlated title request cannot be safely removed", async () => {
    const f = fixture();
    await f.host.report("scope", report, f.native);
    await f.host.report("scope", { ...report, phase: "finish", error }, f.native);
    f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual([]);
    expect((await f.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
  });

  test("title success, pending auxiliary request, and compaction use invalidate the safe boundary", async () => {
    for (const auxiliary of ["title_success", "title_pending", "compaction"]) {
      const f = fixture();
      await f.host.report("scope", report, f.native);
      const second = { ...report, requestID: "req_aux", agent: auxiliary === "compaction" ? "compaction" : "title" };
      await f.host.report("scope", second, f.native);
      if (auxiliary !== "title_pending") await f.host.report("scope", { ...second, phase: "finish", ...(auxiliary === "compaction" ? { error } : {}) }, f.native);
      await f.host.report("scope", { ...report, phase: "finish", error }, f.native); f.state.idle = true;
      await f.host.cleanup("scope", "ses_test", f.native, "v1");
      expect(f.mutations).toEqual([]);
    }
  });

  test("availability, uncertainty, and input restrictions retain the original without calling them violations", async () => {
    const codes: GatewayGovernanceError["error"]["code"][] = ["openwork_gateway_governance_unavailable", "openwork_gateway_governance_uncertain", "openwork_gateway_governance_unsupported_input", "openwork_gateway_governance_policy_changed"];
    for (const code of codes) {
      const f = fixture(); await f.block({ error: { ...error.error, code, evaluation_complete: false, violations: [] } }); f.state.idle = true;
      await f.host.cleanup("scope", "ses_test", f.native, "v1");
      expect(f.mutations).toEqual([]);
      expect((await f.host.view("scope", "ses_test")).entries[0].state).toBe("paused");
    }
  });

  test("native v2 persists a session-only fallback without guessing a native user identity", async () => {
    const f = fixture();
    await f.host.reportV2("scope", { directory: "/synthetic", sessionID: "ses_test", requestID: "req_v2", phase: "begin" });
    f.restart();
    await expect(f.host.assertAdmission("scope", "ses_test", "msg_next")).rejects.toThrow();
    await f.host.reportV2("scope", { directory: "/synthetic", sessionID: "ses_test", requestID: "req_v2", phase: "finish", error });
    f.restart();
    const view = await f.host.view("scope", "ses_test");
    expect(view.held).toBe(true);
    expect(view.entries[0]).toMatchObject({ correlation: "session", messageID: "local_req_v2", state: "unsupported", error });
    await f.host.cleanup("scope", "ses_test", f.native, "v2");
    expect(f.mutations).toEqual([]);
    expect(f.state.messages[0].id).toBe("msg_original");
  });

  test("a title-only input restriction does not prevent the primary request from being evaluated", async () => {
    const f = fixture();
    const title = { ...report, requestID: "req_title", agent: "title" };
    await f.host.report("scope", title, f.native);
    await f.host.report("scope", { ...title, phase: "finish", error: { error: {
      ...error.error, code: "openwork_gateway_governance_unsupported_input", evaluation_complete: false, violations: [],
    } } }, f.native);
    expect((await f.host.view("scope", "ses_test")).held).toBe(false);
    expect(await f.host.report("scope", report, f.native)).toEqual({ recorded: true });
    await f.host.report("scope", { ...report, phase: "finish" }, f.native);
    expect((await f.host.view("scope", "ses_test")).entries).toEqual([]);
    expect(f.mutations).toEqual([]);
  });

  test("a title policy block stops the primary dispatch and remains removable once idle", async () => {
    const f = fixture();
    const title = { ...report, requestID: "req_title", agent: "title" };
    await f.host.report("scope", title, f.native);
    await f.host.report("scope", { ...title, phase: "finish", error }, f.native);
    expect(await f.host.report("scope", report, f.native)).toEqual({ recorded: true, blocked: error });
    f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual(["msg_placeholder", "msg_original"]);
    expect((await f.host.view("scope", "ses_test")).entries[0].state).toBe("excluded");
  });

  test("a later auxiliary failure cannot overwrite a correlated primary policy block", async () => {
    const f = fixture();
    const title = { ...report, requestID: "req_title", agent: "title" };
    await f.host.report("scope", report, f.native);
    await f.host.report("scope", title, f.native);
    await f.host.report("scope", { ...report, phase: "finish", error }, f.native);
    await f.host.report("scope", { ...title, phase: "finish", error: { error: {
      ...error.error, code: "openwork_gateway_governance_unavailable", evaluation_complete: false, violations: [],
    } } }, f.native);
    expect((await f.host.view("scope", "ses_test")).entries[0].error).toEqual(error);
    f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual(["msg_placeholder", "msg_original"]);
  });

  test("a reported transport failure settles tracking without permanently holding an ordinary conversation", async () => {
    const f = fixture();
    await f.host.report("scope", report, f.native);
    await f.host.report("scope", { ...report, phase: "finish", outcome: "transport_failed" }, f.native);
    expect((await f.host.view("scope", "ses_test")).held).toBe(false);
    await f.host.assertAdmission("scope", "ses_test", "msg_retry");
    f.state.idle = true;
    await f.host.cleanup("scope", "ses_test", f.native, "v1");
    expect(f.mutations).toEqual([]);
  });

  test("session deletion clears all private display data", async () => {
    const f = fixture(); await f.block(); await f.host.clear("scope"); f.restart();
    expect(await f.host.view("scope", "ses_test")).toEqual({ held: false, recoveryHeld: false, entries: [] });
    expect(f.persisted.size).toBe(0);
  });
});
