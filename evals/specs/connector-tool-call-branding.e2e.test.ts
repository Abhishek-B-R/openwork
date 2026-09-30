import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/library.ts";
import { connectorActivity } from "../worlds/connector-activity.ts";

const test = spec.world(connectorActivity, { timeout: 420_000, resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "The connector fixture uses a native Desktop conversation and Den connection catalog to verify service assets and exact MCP results." } });

test("connector-backed tool calls show first-class branding and human-readable labels", async ({ world, user, probe, step, evidence }) => {
  const seeReply = async (text: string) => {
    // Recorded results may repeat the answer inside a retained, collapsed rail.
    // Wait for the visible reply rather than the first matching hidden preview.
    await probe.eventually(() => probe.dom('[data-message-role="assistant"] p'), {
      within: 60_000, label: "the final connector reply is visible outside the folded steps",
      until: result => result.elements.some(element => element.text.includes(text) && element.rect.width > 0 && element.rect.height > 0),
    }).catch(async error => {
      evidence.recordJsonArtifact("Composer before the missing connector reply", await probe.composer());
      evidence.recordJsonArtifact("Activity before the missing connector reply", await probe.dom("[data-steady-activity], [data-message-role]"));
      await user.screenshot();
      throw error;
    });
  };
  let firstSend = true;
  const send = async (text: string) => {
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the connector fixture's composer and model have loaded",
      until: state => state.route.includes(world.session.sessionId) && state.composerEditable && state.draftText === "" && state.selectedModelLabel.includes("Connector display model"),
    });
    if (firstSend) {
      evidence.recordJsonArtifact("Initial native input focus", await world.inputFocus());
      await user.screenshot();
      firstSend = false;
    }
    try { await user.type("composer", text, { verify: true }); }
    catch (error) {
      evidence.recordJsonArtifact("Fixture composer after typing", await probe.composer());
      evidence.recordJsonArtifact("Native focus after typing", await world.inputFocus());
      await user.screenshot();
      throw error;
    }
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "the composer admits a connector turn", until: state => state.runTaskEnabled });
    await user.click("Run task");
  };
  const openTurn = async (index: number) => {
    const all = await probe.dom('[data-steady-activity] > div > button > span:first-of-type');
    const closed = await probe.dom('[data-steady-activity] > div > button[aria-expanded="false"] > span:first-of-type');
    const text = all.elements[index]?.text;
    if (!text || !closed.elements.some(element => element.text === text)) return;
    const label = text.includes("earlier steps") ? "Earlier steps" : text;
    await user.click({ role: "button", label: `${label}. Show steps` });
  };
  const sinceIso = new Date().toISOString();
  await send(world.prompt);

  await step("before: the search and connector action stay readable", async () => {
    await seeReply(world.proof);
    await user.see("Run task");
    await openTurn(0);
    if (world.engine === "v2" && (await probe.dom('[data-code-mode-call] > button[aria-expanded="false"]')).elements.length) await user.click({ role: "button", label: /(?:Looking|Looked) up.*Show steps/ });
    await user.see({ text: /Searched your connections for.*Slack list_channels/ }, { timeoutMs: 60_000 });
    await user.see({ text: /^(Listing|Listed) channels$/ }, { timeoutMs: 30_000 });
    await user.notSee({ text: /openwork-cloud_execute_capability/ });
    evidence.recordAssertionEvidence("connector action", "Listing or Listed channels is visible; raw tool names are absent", true);
    await user.screenshot();
  });

  await step("the completed connector action exposes its arguments and survives reload", async () => {
    await seeReply(world.proof);
    await user.see("Run task");
    await openTurn(0);
    if (world.engine === "v2" && (await probe.dom('[data-code-mode-call] > button[aria-expanded="false"]')).elements.length) await user.click({ role: "button", label: /Looked up.*Show steps/ });
    expect(await world.den.mocks.connector.toolCalls({ name: "list_channels", sinceIso, atLeast: 1 }))
      .toMatchObject([{ name: "list_channels", args: { limit: 3 } }]);
    // TODO(primitive): probe.connectorBranding
    const inspect = () => probe.eval(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-capability-call]')];
      const matching = rows.filter(row => row.textContent.includes('Listed channels'));
      const mark = matching[0]?.querySelector<HTMLElement>('[data-connector-name="Slack"]');
      const image = mark?.querySelector('img');
      return { count: matching.length, connector: mark?.getAttribute('data-connector-name'),
        imageLoaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 };
    });
    const branded = await probe.eventually(inspect, { within: 15_000, label: "Slack tool icon and one completed row",
      until: (value) => isRecord(value) && value.imageLoaded === true });
    expect(branded).toMatchObject({ count: 1, connector: "Slack", imageLoaded: true });
    const preview = await probe.dom('[data-tool-result-preview]');
    expect(preview.elements.some(element => element.text.includes(world.proof))).toBe(true);
    await user.click({ role: "button", label: "Listed channels. Show technical details" });
    await user.see({ text: /mcp:.*:list_channels/ });
    await user.see({ text: /"limit":\s*3/ });
    await user.screenshot();
    await user.reload();
    await seeReply(world.proof);
    await openTurn(0);
    if (world.engine === "v2" && (await probe.dom('[data-code-mode-call] > button[aria-expanded="false"]')).elements.length) await user.click({ role: "button", label: /Looked up.*Show steps/ });
    await user.see({ text: /^Listed channels$/ }, { timeoutMs: 30_000 });
    expect(await inspect()).toMatchObject({ count: 1, connector: "Slack" });
    await user.notSee({ text: /openwork-cloud_execute_capability/ });
    await user.click({ role: "button", label: "Listed channels. Show technical details" });
    await user.see({ text: /"limit":\s*3/ });
    await user.click({ role: "button", label: "Listed channels. Hide technical details" });
    evidence.recordAssertionEvidence("connector action after reload", "One branded Slack row; limit 3 is available under technical details", true);
  });

  await step("before: a note has not yet been created", async () => {
    await user.notSee({ text: world.mutationProof });
    evidence.recordAssertionEvidence("note before creation", "The new note is not in the conversation", true);
    await user.screenshot();
  });

  await step("a member sees the note being created rather than the last lookup", async () => {
    await send(world.mutationPrompt);
    await seeReply(world.mutationProof);
    await user.see("Run task");
    await openTurn(1);
    if (world.engine === "v2") {
      await user.see({ role: "button", label: /(?:Creating|Created) a note in Slack/ }, { timeoutMs: 60_000 });
      await user.notSee({ text: /Tool activity|Task step|Completed with errors/ });
    } else {
      await user.see({ text: /(?:Creating|Created) note/ }, { timeoutMs: 60_000 });
    }
    evidence.recordAssertionEvidence("creation in progress", world.engine === "v2" ? "Creating or Created a note in Slack, not Tool activity" : "Creating or Created note is visible", true);
    await user.screenshot();
  });

  await step("after: the created note is visible and the result survives reload", async () => {
    await seeReply(world.mutationProof);
    await user.see("Run task");
    expect(await world.den.mocks.connector.toolCalls({ name: "create_note", sinceIso, atLeast: 1 }))
      .toMatchObject([{ name: "create_note", args: { limit: 3 } }]);
    await openTurn(1);
    if (world.engine === "v2") {
      await user.see({ role: "button", label: /Created a note in Slack/ });
    } else {
      await user.see({ text: /Created note/ });
    }
    await user.screenshot();
    await user.reload();
    await seeReply(world.mutationProof);
    evidence.recordAssertionEvidence("created note after reload", `create_note received limit 3; ${world.mutationProof} remains visible`, true);
    await user.screenshot();
  });

  await step("a failed connector action stays identifiable and is not shown as successful", async () => {
    await send(world.failurePrompt);
    await seeReply("The history lookup failed.");
    await user.see("Run task");
    await openTurn(2);
    if (world.engine === "v2") {
      await user.see({ role: "button", label: /Reading history|Couldn.t finish this step/ }, { timeoutMs: 30_000 });
      await user.notSee({ text: /Completed with errors|Tool activity/ });
    } else {
      await user.see({ text: /^Read history$/ }, { timeoutMs: 60_000 });
      await user.see({ role: "button", label: /Read history failed/ }, { timeoutMs: 60_000 });
    }
    await user.see("Run task");
    await seeReply("The history lookup failed.");
    await user.notSee({ role: "button", label: "Read history. Show technical details" });
    await user.notSee({ role: "button", label: /^Ran(?:\s|\.|[0-9]|$)/ });
    expect(await world.den.mocks.connector.toolCalls({ name: "read_history", sinceIso, atLeast: 1 }))
      .toMatchObject([{ name: "read_history", args: { limit: 3 } }]);
    evidence.recordAssertionEvidence("history lookup failed without claiming success", "read_history received limit 3; the reply says the lookup failed", true);
    await user.screenshot();
    await user.reload();
    await seeReply("The history lookup failed.");
    await openTurn(2);
    if (world.engine === "v2") {
      await user.notSee({ text: /Completed with errors|Tool activity/ });
    } else {
      await user.see({ role: "button", label: /Read history failed/ }, { timeoutMs: 30_000 });
    }
    await seeReply("The history lookup failed.");
    await user.notSee({ role: "button", label: "Read history. Show technical details" });
    await user.notSee({ role: "button", label: /^Ran(?:\s|\.|[0-9]|$)/ });
  });
});
