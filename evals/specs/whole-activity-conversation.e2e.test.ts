import { expect } from "vitest";
import { observeActivity, observeSessionCommands, resolveEvalEngine, spec } from "@openwork/testkit";
import { wholeActivity } from "../worlds/whole-activity.ts";

const test = spec.world(wholeActivity, { timeout: 600_000, resources: { surfaces: ["desktop"], services: ["den", "mock"],
  nativeReason: "One native Desktop conversation exercises composer keys, child navigation, connected results and the tray above the editor." } });

test(`ACT-WHOLE ${resolveEvalEngine()}: a person follows a whole conversation from a short reply through tools, decisions, children and Stop`, async ({ world, user, probe, step, evidence }) => {
  const send = async (text: string) => {
    await user.type("composer", text, { verify: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the composer admits this turn", until: state => state.runTaskEnabled });
    await user.press("Enter");
  };
  await step("before: even a short answer has a finished activity summary", async () => {
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the new fixture chat and its model have loaded",
      until: state => state.route.includes(world.session.sessionId) && state.composerEditable && state.selectedModelLabel.includes("First fixture model"),
    });
    await send(world.shortPrompt);
    await user.see({ text: "Version three." });
    await user.see({ role: "button", label: /Worked for.*0 steps.*Show steps/ });
    await user.screenshot();
  });
  await step("one steady run reads, runs a command and uses a connected service before delegating", async () => {
    await send(world.prompt);
    await user.click({ role: "button", label: /Earlier steps.*Show steps/ });
    await using activity = await observeActivity(probe);
    await user.see({ text: "Confirm fixture format" }, { timeoutMs: 90_000 });
    const delegation = await probe.eventually(async () => ({ failures: (await world.nativeTools()).filter(tool => tool.state?.status === "error"), needs: (await probe.dom("[data-agent-tray]")).elements.some(element => element.text.includes("needs you")) }), {
      within: 60_000, label: "the native child reaches its decision", until: state => state.needs || state.failures.length > 0,
    });
    evidence.recordJsonArtifact("Native fixture delegation", delegation);
    expect(delegation.failures).toEqual([]);
    await user.see({ role: "button", label: /1 needs you/ }, { timeoutMs: 60_000 });
    const before = (await probe.dom("[data-working-line]")).elements.map(element => element.text);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    const after = (await probe.dom("[data-working-line]")).elements.map(element => element.text);
    expect(after).toEqual(before);
    expect(before.join(" ")).toMatch(/Waiting for your action/);
    const tray = await probe.dom("[data-agent-tray], [contenteditable='true']");
    expect(tray.elements[0]!.rect.bottom).toBeLessThanOrEqual(tray.elements[1]!.rect.top);
    evidence.recordJsonArtifact("Tray placement and paused decision time", { tray, before, after });
    const trace = (await activity.finish()).filter(sample => sample.liveHeight !== null);
    evidence.recordJsonArtifact("Native activity continuity sampled every 50 ms", trace);
    expect(trace.length).toBeGreaterThan(20);
    expect(trace.flatMap(sample => sample.replacements), "native step rows stay mounted during streaming").toEqual([]);
    expect(trace.slice(1).filter((sample, index) => sample.liveHeight! < trace[index]!.liveHeight! - 1), "automatic updates do not shrink the opened rail").toEqual([]);
    await user.screenshot();
  });
  await step("the tray opens the correct child decision, and the child can receive a message while working", async () => {
    await user.click({ role: "button", label: "1 needs you" });
    await user.click({ role: "button", label: "Answer" });
    await user.see({ text: "Task from the main chat" });
    await user.see({ text: world.childPrompt });
    await user.see({ text: "Which fixture format should I use?" });
    await user.click({ role: "button", label: /^Fixture checklist/ });
    await probe.eventually(() => world.childState(), { within: 30_000, label: "the answered child resumes work", until: state => state.deliveredChunks === 1 });
    await using commands = await observeSessionCommands(probe);
    await user.type("composer", world.followup, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.followup });
    expect((await commands.read()).filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
    await user.click({ role: "button", label: "Change model" });
    await user.press("Escape");
    await user.see({ text: "Task from the main chat" });
    await probe.eventually(() => probe.dom('[role="dialog"]:not([data-closed]):not([data-state="closed"]), [role="menu"]:not([data-closed]):not([data-state="closed"]), [role="listbox"]:not([data-closed]):not([data-state="closed"])'), {
      within: 5_000, label: "Escape closes the model menu before returning", until: value => value.elements.every(element => element.rect.width === 0 || element.rect.height === 0),
    });
    await world.finishChild();
    await user.press(process.platform === "darwin" ? "Meta+[" : "Escape");
    await user.see({ text: world.answer }, { timeoutMs: 90_000 });
    await user.see("Run task");
  });
  await step("finished tools fold while the answer and exact service result stay accessible", async () => {
    await user.click({ role: "button", label: /Worked for.*[1-9] steps.*Show steps/ });
    if (world.engine === "v2") await user.click({ role: "button", label: /Looked up.*Show steps/ });
    const results = await probe.dom("[data-tool-result-preview]");
    evidence.recordJsonArtifact("Recorded tool results", { native: await world.nativeTools(), rendered: results });
    expect(results.elements.some(element => element.text.includes(world.proof))).toBe(true);
    await user.see({ text: world.answer });
    await user.screenshot();
  });
  await step("a model switch keeps historical model identity, and Stop leaves an ordinary composer", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+First fixture model/ });
    await user.type({ placeholder: "Search models..." }, "Second fixture model");
    await user.click({ role: "option", label: /^Second fixture model/ });
    await user.press("Escape");
    await send(world.stopPrompt);
    await probe.eventually(() => world.nativeTools(), { within: 30_000, label: "the long command is actively running before Stop",
      until: tools => tools.some(tool => (tool.tool === "shell" || tool.tool === "bash") && tool.state?.status === "running"),
    });
    await user.click({ role: "button", label: "Stop" });
    await user.see("Run task");
    await user.see({ role: "button", label: /Stopped after.*Show steps/ });
    await user.notSee({ role: "button", label: /^(Continue|Resume)$/ });
    await send(world.continuePrompt);
    await user.see({ text: "The fixture version is 3." });
    const summaries = (await probe.dom("[data-steady-activity] > div > button")).elements.map(element => element.text);
    expect(summaries.some(text => text.includes("First fixture model"))).toBe(true);
    expect(summaries.some(text => text.includes("Second fixture model"))).toBe(true);
  });
  if (world.engine === "v2") await step("native background completion resumes the idle parent and Stop all reaches an active background child", async () => {
    await send(world.backgroundPrompt);
    await user.see({ text: "The fixture helper is checking in the background." });
    await probe.eventually(() => world.backgroundState(), { within: 30_000, label: "background work continues after the parent finishes", until: state => state.deliveredChunks === 1 });
    await user.see("Run task");
    await world.finishBackground();
    await user.see({ text: world.backgroundWake }, { timeoutMs: 60_000 });
    expect((await probe.dom("[data-session-notice]")).elements.length).toBeGreaterThan(0);
    await send(world.backgroundStopPrompt);
    await user.see({ text: "Another fixture helper is checking in the background." });
    await probe.eventually(() => world.stoppedBackgroundState(), { within: 30_000, label: "another background child holds its own reply", until: state => state.deliveredChunks === 1 });
    await user.click({ role: "button", label: "Stop all" });
    await probe.eventually(() => world.stoppedBackgroundState(), { within: 30_000, label: "Stop all is acknowledged by the active background child", until: state => state.aborted });
  });
  await step("after: reload preserves readable results, finished turns and the final answer", async () => {
    await user.reload();
    await user.see({ text: "The fixture version is 3." }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: /^(Continue|Resume)$/ });
    await user.screenshot();
  });
});
