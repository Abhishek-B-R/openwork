import { expect } from "vitest";
import { observeSessionCommands, resolveEvalEngine, spec } from "@openwork/testkit";
import { agentChildSplitDesktop } from "../worlds/agent-child-split.ts";

const test = spec.world(agentChildSplitDesktop, { timeout: 420_000, resources: { surfaces: ["desktop"], services: ["den", "mock"],
  nativeReason: "Native Desktop split panes and keyboard return must preserve the originating side pane and each composer draft." } });

test(`AGENT-CHILD-SPLIT ${resolveEvalEngine()}: returning from a helper restores its side-pane card and leaves the main draft alone`, async ({ world, user, probe, step, evidence }) => {
  const editor = (nth: number) => ({ placeholder: "Describe your task...", nth });
  await using commands = await observeSessionCommands(probe);
  await step("before: a separate main chat opens the delegated chat beside it", async () => {
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the independent main chat is mounted",
      until: state => state.route.includes(world.primary.sessionId) && state.composerEditable,
    });
    await user.type("composer", "Keep this main-pane draft", { verify: true });
    await user.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await user.type({ placeholder: "Search actions and settings…" }, "Open as side chat");
    await user.click({ role: "option", label: /^Open as side chat/ });
    await user.type({ placeholder: "Search sessions and workspaces..." }, "Fixture review");
    await user.click({ role: "option", label: /^Fixture review/ });
    await probe.eventually(() => probe.dom("[data-workbench-pane='secondary'] [contenteditable='true']"), {
      within: 30_000, label: "the side chat has its own composer", until: value => value.elements.length === 1,
    });
    await user.type(editor(1), world.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: "Review fixture" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: /Earlier steps.*Show steps/ });
    await user.screenshot();
  });
  await step("the helper opens inside the originating pane, and Escape returns to its card", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.see({ text: "Task from the main chat" });
    const child = await probe.dom("[data-workbench-pane='secondary'] [data-session-surface-id]");
    expect(child.elements).toHaveLength(1);
    await user.type(editor(1), "Keep this helper draft", { verify: true });
    await user.press("Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    const panes = await probe.dom("[data-workbench-pane='primary'] [contenteditable='true'], [data-workbench-pane='secondary'] [contenteditable='true']");
    expect(panes.elements[0]?.text).toBe("Keep this main-pane draft");
    expect(panes.elements[1]?.text).not.toContain("helper draft");
    evidence.recordJsonArtifact("Independent pane drafts after return", panes);
    expect((await commands.read()).filter(request => /\/(?:abort|interrupt)$/.test(request.path))).toEqual([]);
  });
  await step("after: reopening the helper restores its draft, and Cmd+[ returns to the same pane", async () => {
    await user.click({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await probe.eventually(() => probe.dom("[data-workbench-pane='secondary'] [contenteditable='true']"), {
      within: 10_000, label: "the helper draft belongs to the side pane", until: value => value.elements[0]?.text === "Keep this helper draft",
    });
    await user.press(process.platform === "darwin" ? "Meta+[" : "Escape");
    await user.see({ role: "button", label: "Review fixture. Open sub-agent chat" });
    await user.screenshot();
  });
});
