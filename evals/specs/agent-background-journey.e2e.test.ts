import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentBackground } from "../worlds/agent-background.ts";

const test = spec.world(agentBackground, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("AGENT-VIS-03 v2: a person keeps chatting while a background helper works, and the chat tells them when it's done", async ({ world, user, probe, step, evidence }) => {
  await step("the person hands a long comparison to a background helper", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.started }, { timeoutMs: 60_000 });
    await user.screenshot();
  });

  await step("the chat is free again while the helper keeps working, and says so", async () => {
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: /1 agent running/ }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The helper keeps working after the reply", "composer shows Run task; '1 agent running' is visible", true);
    await user.screenshot();
  });

  await step("they ask something else and get an answer without waiting for the helper", async () => {
    await user.type("composer", world.quickQuestion);
    await user.click("Run task");
    await user.see({ text: world.quickAnswer }, { timeoutMs: 60_000 });
    const helperStillRunning = !(await world.helperState()).complete;
    evidence.recordAssertionEvidence("A second question is answered while the helper runs", `answer "${world.quickAnswer}" shown; helper still running: ${helperStillRunning}`, helperStillRunning);
    expect(helperStillRunning).toBe(true);
    await user.screenshot();
  });

  await step("the running helper can be stopped from where it is shown", async () => {
    // TODO(primitive): no probe finds a Stop control scoped to the running-agents area.
    const canStop = await probe.eval(() => {
      const areas = [...document.querySelectorAll<HTMLElement>("[data-subagent-run], [data-testid='active-subagents']")];
      return areas.some((area) => [...area.querySelectorAll<HTMLElement>("button, [role=button]")]
        .some((button) => /stop/i.test(button.getAttribute("aria-label") ?? button.textContent ?? "")));
    });
    evidence.recordAssertionEvidence("A background helper can be stopped", canStop ? "a Stop control is next to the running helper" : "no way to stop the background helper", canStop);
    expect.soft(canStop, "Stop control for the background helper").toBe(true);
  });

  await step("the sidebar shows this chat still has work going on", async () => {
    const row = `[data-testid="sidebar-session-${world.session.sessionId}"]`;
    const busySelectors = [
      `${row}[aria-label*="Thinking"]`, `${row}[aria-label*="Responding"]`, `${row}[aria-label*="Waiting"]`,
      `${row} [data-session-attention-indicator]`, `${row} [aria-label="Session streaming"]`,
    ];
    const rowCount = (await probe.dom(row)).elements.length;
    const busy = (await probe.dom(busySelectors.join(", "))).elements.length > 0;
    expect(rowCount, "the chat has a sidebar row").toBe(1);
    evidence.recordAssertionEvidence("The sidebar shows the chat is busy while its helper runs", busy ? "the chat's sidebar row shows it is working" : "the sidebar row looks idle", busy);
    expect.soft(busy, "sidebar row shows background work").toBe(true);
    await user.screenshot();
  });

  await step("after: the helper finishes and the chat picks back up by itself with the result", async () => {
    // Leave a clear gap since the last message, so a timer counting from it would read 15 s or more.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    await world.finishHelper();
    const readings: string[] = [];
    const result = await probe.eventually(async () => {
      const text = await probe.text();
      // Only the turn's own Working line, not a helper row's timer.
      const turnLine = (await probe.dom("[data-loading-message]")).elements.map((element) => element.text).join(" ");
      const working = turnLine.match(/Working\s*\d+(?:m\s*\d+)?s/)?.[0];
      if (working) readings.push(working);
      return text;
    }, { within: 60_000, intervalMs: 150, label: "the chat reports the helper's result", until: (text) => text.includes(world.wakeReply) });
    expect(result).toContain(world.wakeReply);
    await user.notSee({ text: /1 agent running/ }, { timeoutMs: 15_000 });
    evidence.recordAssertionEvidence("The chat reports the helper's result on its own", `"${world.wakeReply}" appeared; Working readings while it picked back up: ${readings.join(", ") || "none"}`, true);
    const first = readings[0]?.match(/(?:(\d+)m\s*)?(\d+)s/);
    const firstSeconds = first ? Number(first[1] ?? 0) * 60 + Number(first[2]) : 0;
    evidence.recordAssertionEvidence("The timer counts from when the chat picked back up, not from the old message",
      readings.length ? `first reading ${readings[0]}` : "no Working line was shown while it picked back up", readings.length > 0 && firstSeconds < 5);
    expect.soft(readings.length > 0 && firstSeconds < 5, "timer restarts when the chat wakes").toBe(true);
    await user.screenshot();
  });

  await step("the chat says why it started talking again", async () => {
    const text = await probe.text();
    const explained = /helper (?:has )?finished|agent finished|background (?:helper|agent) finished/i.test(text.replace(world.wakeReply, ""));
    evidence.recordAssertionEvidence("A self-started reply is labelled with its reason", explained ? "a note says the helper finished" : "the reply just appears with no reason shown", explained);
    expect.soft(explained, "reason shown for the chat picking back up").toBe(true);
  });
});
