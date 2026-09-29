import { describe, expect, test } from "bun:test";
import type { GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { createGovernanceRecovery, type GovernanceJournal, type GovernanceNativeSnapshot, type GovernanceNativeV2Snapshot, type GovernanceReport, type GovernanceV2Message } from "./governance-recovery.js";

const blocked: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked",
  message: "Blocked by organization policies", schema_version: 1, request_id: "req_test", decision_id: "decision_test",
  contribution_id: "msg_original", input_scope: "new_user_contribution", upstream_dispatched: false,
  retryable: false, evaluation_complete: true, violations: [{ policy_id: "policy_one", policy_revision: 1, policy_name: "Synthetic credentials" }],
} };
const outcome = (code: GatewayGovernanceError["error"]["code"], contribution = "msg_original"): GatewayGovernanceError =>
  ({ error: { ...blocked.error, code, contribution_id: contribution, evaluation_complete: false, violations: [] } });
const report: GovernanceReport = { directory: "/synthetic", sessionID: "ses_test", messageID: "msg_original", requestID: "req_call", phase: "begin", agent: "build", correlated: true };

function harness(automatic = true) {
  const persisted = new Map<string, GovernanceJournal>();
  let clock = 0;
  let gate: Promise<void> | null = null;
  let open = () => {};
  const waits: number[] = [];
  const deps = {
    load: async (scope: string) => structuredClone(persisted.get(scope) ?? null),
    save: async (scope: string, journal: GovernanceJournal) => { persisted.set(scope, structuredClone(journal)); },
    remove: async (scope: string) => { persisted.delete(scope); },
    list: async () => [...persisted.values()].map((journal) => structuredClone(journal)),
  };
  const autoCleanup = { wait: async (ms: number) => { waits.push(ms); clock += ms; if (gate) await gate; }, now: () => clock, deadlineMs: 60_000 };
  const create = (auto: boolean) => createGovernanceRecovery(auto ? { ...deps, autoCleanup } : deps);
  let host = create(automatic);
  return { persisted, waits, get host() { return host; }, restart: (auto = true) => { host = create(auto); },
    hold: () => { gate = new Promise((resolve) => { open = resolve; }); },
    release: () => { gate = null; open(); } };
}

function nativeV1() {
  const mutations: string[] = [];
  let busyPolls = 0;
  let uncertain = false;
  let unreachable = false;
  const state: GovernanceNativeSnapshot = { idle: true, reverted: false, title: "New session - synthetic", messages: [
    { id: "msg_original", sessionID: "ses_test", role: "user", created: 1, parts: [{ type: "text", text: "Synthetic blocked text" }] },
    { id: "msg_placeholder", sessionID: "ses_test", role: "assistant", created: 2, parentID: "msg_original", error: { name: "APIError" }, parts: [] },
  ] };
  return {
    state, mutations,
    busyFor: (polls: number) => { busyPolls = polls; },
    uncertain: () => { uncertain = true; },
    unreachable: (value: boolean) => { unreachable = value; },
    native: {
      snapshot: async () => {
        if (unreachable) throw new Error("engine starting");
        const snapshot = structuredClone(state);
        if (busyPolls > 0) { busyPolls -= 1; snapshot.idle = false; }
        return snapshot;
      },
      deleteMessage: async (messageID: string) => {
        mutations.push(messageID);
        if (uncertain) throw new Error("reply lost");
        state.messages = state.messages.filter((item) => item.id !== messageID);
      },
    },
  };
}

async function blockV1(h: ReturnType<typeof harness>, n: ReturnType<typeof nativeV1>, error = blocked, correlated = true, title = true) {
  await h.host.report("scope", report, n.native);
  if (title) {
    await h.host.report("scope", { ...report, requestID: "req_title", agent: "title" }, n.native);
    await h.host.report("scope", { ...report, requestID: "req_title", agent: "title", phase: "finish", error, correlated }, n.native);
  }
  await h.host.report("scope", { ...report, phase: "finish", error, correlated }, n.native);
}

describe("automatic removal of a trusted policy block (native v1)", () => {
  test("removes the correlated rejected contribution once idle, without a user action", async () => {
    const h = harness(); const n = nativeV1(); n.busyFor(3);
    h.hold();
    await blockV1(h, n);
    const pending = await h.host.view("scope", "ses_test");
    expect(pending.entries[0]).toMatchObject({ state: "cleanup_pending", autoCleanup: true });
    h.release();
    await h.host.settled("scope");
    expect(n.mutations).toEqual(["msg_placeholder", "msg_original"]);
    const view = await h.host.view("scope", "ses_test");
    expect(view.held).toBe(false);
    expect(view.entries[0]).toMatchObject({ state: "excluded", text: "Synthetic blocked text", autoCleanup: false });
    expect(h.waits.slice(0, 2)).toEqual([250, 500]);
  });

  test("a first contribution waits for its title request instead of giving up", async () => {
    const h = harness(); const n = nativeV1();
    await blockV1(h, n, blocked, true, false);
    await Promise.resolve();
    expect(n.mutations).toEqual([]);
    await h.host.report("scope", { ...report, requestID: "req_title", agent: "title" }, n.native);
    await h.host.settled("scope");
    expect(n.mutations).toEqual(["msg_placeholder", "msg_original"]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("excluded");
  });

  test("unsafe history is never removed automatically and is reported as unsupported", async () => {
    const h = harness(); const n = nativeV1();
    n.state.messages[1].parts.push({ type: "text", text: "Output" });
    await blockV1(h, n);
    await h.host.settled("scope");
    expect(n.mutations).toEqual([]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
  });

  test("an uncorrelated block keeps the manual fallback and deletes nothing", async () => {
    const h = harness(); const n = nativeV1();
    await blockV1(h, n, blocked, false);
    await h.host.settled("scope");
    expect(n.mutations).toEqual([]);
    expect((await h.host.view("scope", "ses_test")).entries[0]).toMatchObject({ state: "cleanup_pending", autoCleanup: false });
  });

  test("an uncertain automatic delete is never repeated automatically, including after restart", async () => {
    const h = harness(); const n = nativeV1(); n.uncertain();
    await blockV1(h, n);
    await h.host.settled("scope");
    expect(n.mutations).toEqual(["msg_placeholder"]);
    h.restart();
    await h.host.resumeAll(async () => ({ native: n.native, engine: "v1" }));
    await h.host.resumeAutomatic("scope", "ses_test", () => n.native, "v1");
    await h.host.settled("scope");
    expect(n.mutations).toEqual(["msg_placeholder"]);
    expect((await h.host.view("scope", "ses_test")).entries[0]).toMatchObject({ state: "cleanup_pending", deleteAttempted: ["msg_placeholder"], autoCleanup: false });
  });

  test("a conversation that stays busy stops being automatic and exposes the manual fallback", async () => {
    const h = harness(); const n = nativeV1(); n.busyFor(1_000);
    await blockV1(h, n);
    await h.host.settled("scope");
    expect(n.mutations).toEqual([]);
    const view = await h.host.view("scope", "ses_test");
    expect(view.entries[0]).toMatchObject({ state: "cleanup_pending", autoStopped: true, autoCleanup: false });
    await h.host.resumeAutomatic("scope", "ses_test", () => n.native, "v1");
    expect((await h.host.view("scope", "ses_test")).entries[0].autoCleanup).toBe(false);
  });

  test("an engine that never answered is retried on resume rather than stopped", async () => {
    const h = harness(false); const n = nativeV1();
    await blockV1(h, n);
    n.unreachable(true);
    h.restart();
    await h.host.resumeAll(async () => ({ native: n.native, engine: "v1" }));
    await h.host.settled("scope");
    expect((await h.host.view("scope", "ses_test")).entries[0].autoStopped).toBe(false);
    n.unreachable(false);
    await h.host.resumeAll(async () => ({ native: n.native, engine: "v1" }));
    await h.host.settled("scope");
    expect(n.mutations).toEqual(["msg_placeholder", "msg_original"]);
  });

  test("restart resumes a pending removal from the persisted journal", async () => {
    const h = harness(false); const n = nativeV1();
    await blockV1(h, n);
    expect(n.mutations).toEqual([]);
    h.restart();
    await h.host.resumeAll(async (scope, sessionID) => scope === "scope" && sessionID === "ses_test" ? { native: n.native, engine: "v1" } : null);
    await h.host.settled("scope");
    expect(n.mutations).toEqual(["msg_placeholder", "msg_original"]);
  });
});

describe("in-place retry for outcomes that are not policy violations (native v1)", () => {
  test("availability outcomes remove only the paused attempt and release the conversation", async () => {
    for (const code of ["openwork_gateway_governance_unavailable", "openwork_gateway_governance_policy_changed", "openwork_gateway_governance_uncertain", "openwork_gateway_governance_unsupported_input"] satisfies GatewayGovernanceError["error"]["code"][]) {
      const h = harness(); const n = nativeV1();
      await blockV1(h, n, outcome(code));
      await h.host.settled("scope");
      expect(n.mutations).toEqual([]);
      expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("paused");
      await h.host.cleanup("scope", "ses_test", n.native, "v1", { intent: "retry", messageID: "msg_original" });
      expect(n.mutations).toEqual(["msg_placeholder", "msg_original"]);
      const view = await h.host.view("scope", "ses_test");
      expect(view).toMatchObject({ held: false, entries: [] });
      await h.host.assertAdmission("scope", "ses_test", "msg_replacement");
      await expect(h.host.assertAdmission("scope", "ses_test", "msg_original")).rejects.toThrow("recovery");
      expect(JSON.stringify(h.persisted.get("scope"))).not.toContain("Synthetic blocked text");
    }
  });

  test("unsafe history falls back to a new conversation without deleting", async () => {
    const h = harness(); const n = nativeV1();
    n.state.messages[1].parts.push({ type: "tool" });
    await blockV1(h, n, outcome("openwork_gateway_governance_unavailable"));
    await h.host.cleanup("scope", "ses_test", n.native, "v1", { intent: "retry", messageID: "msg_original" });
    expect(n.mutations).toEqual([]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
  });

  test("an uncorrelated outcome, a policy block, and an unknown message cannot be retried in place", async () => {
    const h = harness(); const n = nativeV1();
    await blockV1(h, n, outcome("openwork_gateway_governance_unavailable", "msg_other"));
    await h.host.cleanup("scope", "ses_test", n.native, "v1", { intent: "retry", messageID: "msg_original" });
    expect(n.mutations).toEqual([]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
    const policy = harness(false); const other = nativeV1();
    await blockV1(policy, other);
    await expect(policy.host.cleanup("scope", "ses_test", other.native, "v1", { intent: "retry", messageID: "msg_original" })).rejects.toThrow("retried");
    await expect(policy.host.cleanup("scope", "ses_test", other.native, "v1", { intent: "retry", messageID: "msg_missing" })).rejects.toThrow("retried");
    expect(other.mutations).toEqual([]);
  });

  test("an uncertain retry removal is inspected, never repeated", async () => {
    const h = harness(); const n = nativeV1(); n.uncertain();
    await blockV1(h, n, outcome("openwork_gateway_governance_unavailable"));
    await h.host.cleanup("scope", "ses_test", n.native, "v1", { intent: "retry", messageID: "msg_original" });
    await h.host.cleanup("scope", "ses_test", n.native, "v1", { intent: "retry", messageID: "msg_original" });
    expect(n.mutations).toEqual(["msg_placeholder"]);
    expect((await h.host.view("scope", "ses_test")).entries[0]).toMatchObject({ state: "paused", deleteAttempted: ["msg_placeholder"] });
  });
});

function v2Message(id: string, type: string, extra: Partial<GovernanceV2Message> = {}): GovernanceV2Message {
  return { id, type, digest: `digest_${id}`, text: type === "user" ? "Synthetic v2 text" : "", files: [], contentCount: 0, changedFiles: 0, ...extra };
}

function nativeV2() {
  const calls: string[] = [];
  let staged: string | null = null;
  let loseStage = false;
  let loseCommit = false;
  let busyPolls = 0;
  const state: Omit<GovernanceNativeV2Snapshot, "revert"> = { idle: true, title: "", inboxEmpty: true, historyComplete: true, messages: [
    v2Message("msg_before", "user"), v2Message("msg_answer", "assistant", { contentCount: 1 }),
    v2Message("msg_original", "user"),
  ] };
  return {
    state, calls,
    busyFor: (polls: number) => { busyPolls = polls; },
    stage: (value: string | null) => { staged = value; },
    loseStage: () => { loseStage = true; },
    loseCommit: () => { loseCommit = true; },
    native: {
      snapshot: async (): Promise<GovernanceNativeV2Snapshot> => {
        const snapshot = { ...structuredClone(state), revert: staged };
        if (busyPolls > 0) { busyPolls -= 1; snapshot.idle = false; }
        return snapshot;
      },
      stageRevert: async (messageID: string) => {
        calls.push(`stage:${messageID}:files=false`);
        staged = messageID;
        if (loseStage) throw new Error("reply lost");
      },
      commitRevert: async () => {
        calls.push("commit");
        if (!staged) return;
        const index = state.messages.findIndex((message) => message.id === staged);
        if (index >= 0) state.messages = state.messages.slice(0, index);
        staged = null;
        if (loseCommit) throw new Error("reply lost");
      },
    },
  };
}

const v2: { directory: string; sessionID: string } = { directory: "/synthetic", sessionID: "ses_test" };
async function blockV2(h: ReturnType<typeof harness>, n: ReturnType<typeof nativeV2>, options: { error?: GatewayGovernanceError; correlated?: boolean } = {}) {
  h.host.noteV2Prompt("scope", "msg_original");
  const check = await h.host.reportV2("scope", { ...v2, requestID: "req_primary", agent: "primary", phase: "check" }, n.native);
  n.state.messages.push(v2Message("msg_assistant_error", "assistant"));
  await h.host.reportV2("scope", { ...v2, requestID: "req_primary", agent: "primary", phase: "finish", outcome: "response",
    correlated: options.correlated ?? true, error: options.error ?? blocked }, n.native);
  return check;
}

describe("native v2 history-only removal", () => {
  test("establishes the exact submitted message and removes it with a files:false revert, never touching files", async () => {
    const h = harness(); const n = nativeV2(); n.busyFor(2);
    const check = await blockV2(h, n);
    expect(check).toEqual({ recorded: true, contribution: "msg_original" });
    await h.host.settled("scope");
    expect(n.calls).toEqual(["stage:msg_original:files=false", "commit"]);
    expect(n.state.messages.map((message) => message.id)).toEqual(["msg_before", "msg_answer"]);
    expect((await h.host.view("scope", "ses_test")).entries[0]).toMatchObject({ state: "excluded", correlation: "message", text: "Synthetic v2 text" });
  });

  test("a model request that starts before the prompt reply is read waits for the admitted identity", async () => {
    const h = harness(false); const n = nativeV2();
    const settle = h.host.trackV2Prompt("scope");
    const check = h.host.reportV2("scope", { ...v2, requestID: "req_primary", agent: "primary", phase: "check" }, n.native);
    await Promise.resolve();
    h.host.noteV2Prompt("scope", "msg_original");
    settle();
    expect(await check).toEqual({ recorded: true, contribution: "msg_original" });
  });

  test("never names a contribution the host did not submit, a continuation, a compaction, or a later title", async () => {
    const cases: ((n: ReturnType<typeof nativeV2>, h: ReturnType<typeof harness>) => { agent: string })[] = [
      () => ({ agent: "primary" }),
      (n, h) => { h.host.noteV2Prompt("scope", "msg_original"); n.state.messages.push(v2Message("msg_step", "assistant", { contentCount: 1 })); return { agent: "primary" }; },
      (_n, h) => { h.host.noteV2Prompt("scope", "msg_original"); return { agent: "compaction" }; },
      (_n, h) => { h.host.noteV2Prompt("scope", "msg_original"); return { agent: "title" }; },
      (n, h) => { h.host.noteV2Prompt("scope", "msg_original"); n.stage("msg_before"); return { agent: "primary" }; },
    ];
    for (const setup of cases) {
      const h = harness(); const n = nativeV2();
      const { agent } = setup(n, h);
      expect(await h.host.reportV2("scope", { ...v2, requestID: "req_x", agent, phase: "check" }, n.native)).toEqual({ recorded: true });
    }
  });

  test("a later message, output, file change, staged revert, queued input, or changed title prevents any revert", async () => {
    const changes: ((n: ReturnType<typeof nativeV2>) => void)[] = [
      (n) => { n.state.messages.push(v2Message("msg_later", "user")); },
      (n) => { n.state.messages.push(v2Message("msg_output", "assistant", { contentCount: 1 })); },
      (n) => { n.state.messages.push(v2Message("msg_files", "assistant", { changedFiles: 1 })); },
      (n) => { n.state.messages.push(v2Message("msg_system", "system")); },
      (n) => { n.stage("msg_before"); },
      (n) => { n.state.inboxEmpty = false; },
      (n) => { n.state.title = "Derived from the contribution"; },
      (n) => { const user = n.state.messages.find((message) => message.id === "msg_original"); if (user) user.digest = "changed"; },
    ];
    for (const change of changes) {
      const h = harness(false); const n = nativeV2(); n.state.messages.unshift(v2Message("msg_first", "user"));
      await blockV2(h, n);
      change(n);
      await h.host.cleanup("scope", "ses_test", n.native, "v2");
      expect(n.calls).toEqual([]);
      expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
    }
  });

  test("an uncorrelated request after admission makes the contribution non-removable", async () => {
    const h = harness(false); const n = nativeV2();
    h.host.noteV2Prompt("scope", "msg_original");
    await h.host.reportV2("scope", { ...v2, requestID: "req_primary", agent: "primary", phase: "check" }, n.native);
    await h.host.reportV2("scope", { ...v2, requestID: "req_generate", agent: "generate", phase: "check" }, n.native);
    await h.host.reportV2("scope", { ...v2, requestID: "req_primary", agent: "primary", phase: "finish", correlated: true, error: blocked }, n.native);
    await h.host.cleanup("scope", "ses_test", n.native, "v2");
    expect(n.calls).toEqual([]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
  });

  test("uncorrelated rejection keeps the non-destructive fallback", async () => {
    const h = harness(); const n = nativeV2();
    await blockV2(h, n, { correlated: false });
    await h.host.settled("scope");
    await h.host.cleanup("scope", "ses_test", n.native, "v2");
    expect(n.calls).toEqual([]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("unsupported");
  });

  test("a first contribution requires a rejected title request; the title is recorded as not dispatched", async () => {
    const h = harness(); const n = nativeV2();
    n.state.messages = [v2Message("msg_original", "user")];
    await blockV2(h, n);
    const title = await h.host.reportV2("scope", { ...v2, requestID: "req_title", agent: "title", phase: "check" }, n.native);
    expect(title).toEqual({ recorded: true, blocked });
    await h.host.settled("scope");
    expect(n.calls).toEqual(["stage:msg_original:files=false", "commit"]);
  });

  test("a lost stage reply commits only an observed staged boundary; a lost commit reply is never retried", async () => {
    const h = harness(); const n = nativeV2(); n.loseStage();
    await blockV2(h, n);
    await h.host.settled("scope");
    expect(n.calls).toEqual(["stage:msg_original:files=false", "commit"]);
    expect((await h.host.view("scope", "ses_test")).entries[0].state).toBe("excluded");

    const lost = harness(); const other = nativeV2(); other.loseCommit();
    other.native.commitRevert = async () => { other.calls.push("commit"); throw new Error("reply lost"); };
    await blockV2(lost, other);
    await lost.host.settled("scope");
    await lost.host.cleanup("scope", "ses_test", other.native, "v2");
    expect(other.calls).toEqual(["stage:msg_original:files=false", "commit"]);
    expect((await lost.host.view("scope", "ses_test")).entries[0]).toMatchObject({ state: "cleanup_pending", revertCommitAttempted: true });
  });

  test("retry intent withdraws a paused v2 attempt the same guarded way", async () => {
    const h = harness(); const n = nativeV2();
    await blockV2(h, n, { error: outcome("openwork_gateway_governance_unavailable") });
    await h.host.cleanup("scope", "ses_test", n.native, "v2", { intent: "retry", messageID: "msg_original" });
    expect(n.calls).toEqual(["stage:msg_original:files=false", "commit"]);
    expect(await h.host.view("scope", "ses_test")).toMatchObject({ held: false, entries: [] });
  });
});
