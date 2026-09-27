import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { localMcpLateStart } from "../worlds/local-mcp-late-start.ts";

const test = spec.world(localMcpLateStart, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

// OpenWork retries a connection that failed to start after this back-off
// (ENGINE_V2_UPKEEP_WAITS.mcpRetryMs = 60 s), plus a margin for the engine's
// own connect attempt.
const RETRY_AFTER_MS = 65_000;

test("a member whose local design app was closed when OpenWork started gets its tools in chat once the app is open", { tags: ["agent-flow"] }, async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "starter model ready", until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  let failedAt = 0;

  await step("given the design app connection is added while the app is closed, the engine marks it failed", async () => {
    await user.see("Run task");
    expect((await world.connect()).status).toBe(200);
    const status = await probe.eventually(() => world.liveStatus(), { within: 30_000, intervalMs: 250, label: "the engine tried to connect", until: (value) => value === "failed" });
    failedAt = Date.now();
    evidence.recordAssertionEvidence("the connection failed to start", `${world.appUrl} had nothing listening; engine live status for "${world.name}" → ${status}`, status === "failed");
    expect(status).toBe("failed");
  });

  await step("when the member opens the design app, the engine still reports it failed on its own", async () => {
    const health = await world.startApp();
    await user.see("Run task");
    const status = await world.liveStatus();
    evidence.recordAssertionEvidence("the engine does not retry by itself", `design app now answers on ${world.appUrl} (health ${health.status}); engine live status still → ${status}`, status === "failed");
    expect(health.ok).toBe(true);
    expect(status).toBe("failed");
  });

  await step("then the member keeps working past OpenWork's one-minute retry back-off", async () => {
    await user.see("Run task");
    const elapsed = await probe.eventually(async () => Date.now() - failedAt, { within: RETRY_AFTER_MS + 15_000, intervalMs: 1_000, label: "retry back-off elapsed", until: (ms) => ms >= RETRY_AFTER_MS });
    const status = await world.liveStatus();
    evidence.recordAssertionEvidence("back-off elapsed with no chat turn", `${Math.round(elapsed / 1000)} s since the failed start; engine live status → ${status}`, elapsed >= RETRY_AFTER_MS);
    expect(elapsed).toBeGreaterThanOrEqual(RETRY_AFTER_MS);
  });

  await step("after: the member's next chat reads the canvas through the design app", async () => {
    const prompt = "What is on my design canvas right now?";
    await world.prepareCanvasTurn(prompt);
    expect(prompt).not.toContain(world.proof);
    const sinceIso = new Date().toISOString();
    await user.type("composer", prompt);
    await user.click("Run task");
    const shown = await user.see({ text: world.proof }, { timeoutMs: 90_000 }).then(() => true, () => false);
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.screenshot();
    const calls = await world.toolCalls(sinceIso);
    const status = await world.liveStatus();
    evidence.recordAssertionEvidence("the design app served the chat's tool call",
      `${calls.length} ${world.tool} call(s) served by the design app; engine live status → ${status}; reply ${shown ? "shows" : "does not show"} "${world.proof}"`,
      shown && calls.length > 0 && status === "connected");
    expect(shown).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(status).toBe("connected");
  });
});
