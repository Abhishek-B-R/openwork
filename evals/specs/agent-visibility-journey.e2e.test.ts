import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { agentVisibility } from "../worlds/agent-visibility.ts";

const test = spec.world(agentVisibility, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

type Sample = { at: number; working: string | null; liveHeight: number | null; helperRow: boolean };

test(`AGENT-VIS-01 ${resolveEvalEngine()}: a person asks a research question and can always tell the agent is still working`, async ({ world, user, probe, step, evidence }) => {
  const samples: Sample[] = [];
  // TODO(primitive): no probe reads "is any Working line visible" plus the live-steps height
  // in one glance; sampling both together is the only way to catch a flicker between steps.
  const readScreen = () => probe.eval(() => {
    // The turn's own "Working 12s" line. A helper row carries its own timer, which is not
    // the turn's, so text inside helper rows is removed before looking.
    const candidates = [...document.querySelectorAll<HTMLElement>("[data-loading-message], [data-live-steps], [data-message-id]")];
    const turnText = (node: HTMLElement) => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("[data-subagent-run]").forEach((row) => row.remove());
      return copy.textContent?.match(/Working\s*\d+(?:m\s*\d+)?s/)?.[0] ?? null;
    };
    const working = candidates.map(turnText).find((text) => text !== null) ?? null;
    const live = document.querySelector<HTMLElement>("[data-live-steps]");
    return {
      working,
      liveHeight: live ? Math.round(live.getBoundingClientRect().height) : null,
      helperRow: Boolean(document.querySelector("[data-subagent-run]")),
    };
  });

  await step("the person asks why nobody can tell when agents are running", async () => {
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.prompt });
    await user.screenshot();
  });

  await step("while the agent reads, runs a slow command and starts a helper, a Working line never leaves the screen", async () => {
    const started = Date.now();
    // Sample like a person glancing at the screen: every 150 ms, until the helper is running.
    while (Date.now() - started < 60_000) {
      const screen = await readScreen();
      samples.push({ at: Date.now() - started, ...screen });
      if (screen.helperRow && samples.filter((sample) => sample.helperRow).length >= 10) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const firstWorking = samples.findIndex((sample) => sample.working !== null);
    const afterStart = firstWorking >= 0 ? samples.slice(firstWorking) : samples;
    const gaps = afterStart.filter((sample) => sample.working === null);
    evidence.recordJsonArtifact("What the person saw every 150 ms", samples);
    evidence.recordAssertionEvidence(
      "Working stays on screen for the whole run",
      `${afterStart.length - gaps.length} of ${afterStart.length} glances showed a Working line; missing at ${gaps.map((gap) => `${gap.at}ms`).join(", ") || "none"}`,
      firstWorking >= 0 && gaps.length === 0,
    );
    await user.screenshot();
    expect(firstWorking, "a Working line appears after sending").toBeGreaterThanOrEqual(0);
    expect.soft(gaps.map((gap) => gap.at), "glances where Working had disappeared").toEqual([]);
  });

  await step("the turn's timer only counts up while it runs", async () => {
    const seconds = samples.map((sample) => sample.working?.match(/(?:(\d+)m\s*)?(\d+)s/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => Number(match[1] ?? 0) * 60 + Number(match[2]));
    const backwards = seconds.slice(1).map((value, index) => ({ from: seconds[index]!, to: value })).filter((pair) => pair.to < pair.from);
    evidence.recordAssertionEvidence(
      "The Working timer never jumps back",
      `${seconds.length} readings from ${seconds[0] ?? "-"}s to ${seconds.at(-1) ?? "-"}s; ${backwards.length} jumps back (${backwards.map((pair) => `${pair.from}→${pair.to}`).join(", ") || "none"})`,
      backwards.length === 0,
    );
    expect.soft(backwards, "Working timer jumps back").toEqual([]);
  });

  await step("the running steps never shrink under the person's eyes", async () => {
    const heights = samples.map((sample) => sample.liveHeight).filter((height): height is number => height !== null);
    const shrinks = heights.slice(1).map((height, index) => heights[index]! - height).filter((drop) => drop > 8);
    evidence.recordAssertionEvidence(
      "The live steps area only grows while the turn runs",
      `${heights.length} measurements, ${shrinks.length} drops over 8px (${shrinks.join(", ") || "none"})`,
      shrinks.length === 0,
    );
    expect.soft(shrinks, "height drops of the live steps area").toEqual([]);
  });

  await step("the helper shows as its own row the person can open", async () => {
    await user.see({ text: "Check the error log" }, { timeoutMs: 30_000 });
    const rows = await probe.dom("[data-subagent-run]");
    evidence.recordAssertionEvidence("One helper row is visible", `${rows.elements.length} helper row(s)`, rows.elements.length === 1);
    expect(rows.elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: the helper finishes, the answer arrives, and the steps fold into one line with the time taken", async () => {
    await world.releaseHelper();
    await world.releaseAnswer();
    await user.see({ text: world.answer }, { timeoutMs: 90_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.notSee({ text: /Working\s*\d/ });
    evidence.recordAssertionEvidence("The turn ends cleanly", "answer shown, composer back to Run task, no Working line left", true);
    // DESIGN.md T1: a finished turn folds to one "Worked for …" line, however short it was.
    const folded = await probe.eventually(() => probe.text(), { within: 10_000, intervalMs: 250, label: "finished steps fold",
      until: (text) => /Worked for \d/.test(text) }).then(() => true, () => false);
    evidence.recordAssertionEvidence("The finished steps fold into one line with the time taken",
      folded ? "shows 'Worked for …'" : "steps stay listed; no 'Worked for …' line after 10 s", folded);
    expect.soft(folded, "finished steps fold to 'Worked for …'").toBe(true);
    await user.screenshot();
  });

  await step("the agent really did what the person watched: read, command, helper", async () => {
    const tools = (await world.requests()).filter((request) => request.kind === "tool").map((request) => request.toolName);
    const helperTools = (await world.helperRequests()).filter((request) => request.kind === "tool").map((request) => request.toolName);
    const expected = ["read", world.shell, world.engine === "v2" ? "subagent" : "task"];
    evidence.recordAssertionEvidence("Model calls match the screen", `parent: ${tools.join(" → ")}; helper: ${helperTools.join(" → ")}`,
      JSON.stringify(tools) === JSON.stringify(expected) && helperTools.length === 1);
    expect(tools).toEqual(expected);
    expect(helperTools).toEqual([world.shell]);
  });
});
