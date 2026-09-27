import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { localMcpAddedWhileClosed } from "../worlds/local-mcp-late-start.ts";

const test = spec.world(localMcpAddedWhileClosed, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

// OpenWork tries a connection that failed to start again after a one-minute
// back-off (ENGINE_V2_UPKEEP_WAITS.mcpRetryMs), counted from its last attempt,
// which is at the latest the member's first ask. The margin covers the
// engine's own connect attempt.
const RETRY_AFTER_MS = 65_000;

test("a member asks chat to read the canvas while the design app is closed, opens the app, and the next ask works", { tags: ["user-flow"] }, async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "starter model ready", until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  let askedAt = 0;

  await step("before: with the design app closed, chat cannot read the canvas", async () => {
    const prompt = "What is on my design canvas right now?";
    await world.prepareCanvasTurn(prompt);
    askedAt = Date.now();
    await user.type("composer", prompt);
    await user.click("Run task");
    const refused = await user.see({ text: "Unknown tool" }, { timeoutMs: 90_000 }).then(() => true, () => false);
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: world.proof });
    await user.screenshot();
    evidence.recordAssertionEvidence("the chat shows the design app tool is unavailable",
      `reply ${refused ? "shows" : "does not show"} "Unknown tool" for ${world.name}.${world.tool}; the canvas was not read`, refused);
    expect(refused).toBe(true);
  });

  await step("the member opens the design app on their computer", async () => {
    const health = await world.startApp();
    await user.see("Run task");
    await user.screenshot();
    evidence.recordAssertionEvidence("the design app is running", `the design app answers on ${world.appUrl} (health ${health.status})`, health.ok);
    expect(health.ok).toBe(true);
  });

  await step("a minute later the member is still in the same chat", async () => {
    const elapsed = await probe.eventually(async () => Date.now() - askedAt, { within: RETRY_AFTER_MS + 15_000, intervalMs: 1_000, label: "a minute passed", until: (ms) => ms >= RETRY_AFTER_MS });
    await user.see("Run task");
    await user.screenshot();
    evidence.recordAssertionEvidence("a minute passed without reloading or reconnecting anything", `${Math.round(elapsed / 1000)} s since the first ask; nothing was reloaded or reconnected by hand`, elapsed >= RETRY_AFTER_MS);
    expect(elapsed).toBeGreaterThanOrEqual(RETRY_AFTER_MS);
  });

  await step("after: the member asks again and chat reads the canvas through the design app", async () => {
    const prompt = "Please check my design canvas again.";
    await world.prepareCanvasTurn(prompt);
    expect(prompt).not.toContain(world.proof);
    const sinceIso = new Date().toISOString();
    await user.type("composer", prompt);
    await user.click("Run task");
    const shown = await user.see({ text: world.proof }, { timeoutMs: 90_000 }).then(() => true, () => false);
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.screenshot();
    const calls = await world.toolCalls(sinceIso);
    evidence.recordAssertionEvidence("the design app served the chat's canvas read",
      `${calls.length} ${world.tool} call(s) served by the design app; reply ${shown ? "shows" : "does not show"} "${world.proof}"`,
      shown && calls.length > 0);
    expect(shown).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });
});
