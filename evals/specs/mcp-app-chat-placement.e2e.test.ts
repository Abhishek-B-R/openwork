import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { mcpAppChatPlacement, placementPrompt, placementLeadIn, placementReply, placementResourceUri } from "../worlds/mcp-app-chat-placement.ts";

const test = spec.world(mcpAppChatPlacement, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun", "pnpm", "opencode"] }, timeout: 300_000,
});

test("Connected MCP Apps follow preceding prose and remain above the final reply", async ({ world, agent, user, probe, evidence, step }) => {
  const sinceIso = new Date().toISOString();
  await step("before: the assistant starts opening the calculator", async () => {
    await agent.send(placementPrompt);
    await user.see({ text: placementLeadIn }, { timeoutMs: 120_000 });
    await user.notSee({ text: placementReply });
    await user.screenshot();
  });
  await step("after: preceding prose, connected App, and reply retain their order", async () => {
    await user.see({ text: placementReply }, { timeoutMs: 120_000 });
    const transcript = await probe.eventually(async () => (await probe.dom(`[data-message-role="assistant"], [data-mcp-app-resource="${placementResourceUri}"] iframe`)).elements, {
      within: 30_000, label: "connected calculator frame", until: elements => elements.some(element => element.tag === "iframe"),
    });
    const said = (text: string) => transcript.findIndex(element => element.tag !== "iframe" && element.text.includes(text));
    const frames = transcript.flatMap((element, index) => element.tag === "iframe" ? [index] : []);
    expect(frames).toHaveLength(1);
    expect(said(placementLeadIn)).toBeGreaterThanOrEqual(0);
    expect(said(placementLeadIn)).toBeLessThan(frames[0]);
    expect(said(placementReply)).toBeGreaterThan(frames[0]);
    expect(await world.mock.toolCalls({ name: "open_calculator", sinceIso, atLeast: 1 })).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence("Connected App follows preceding prose", "The mock model wrote a sentence and called the real connected App tool in the same response. The conversation renders that sentence, one calculator frame, then the final reply, without a Den organization or authored-App capability.", true);
  });
});
