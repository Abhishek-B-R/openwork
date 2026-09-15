import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVAL_COWORKER_MODEL, browserScript, clickButton, coworker, evalIn, fill, needs, spec, test, waitFor, waitForText, type Target } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";
import { nativePackagedDiscussion } from "../worlds/coworker.ts";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker keeps one native discussion honest across replies, reloads, and model failure"
  : "Open Coworker discussion journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(
    app,
    browserScript((command, payload) => window.__COWORKER__.invoke(command, payload), [command, payload]),
    { awaitPromise: true, timeoutMs: 120_000 },
  );
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

/** The discussion surface for Editor: the header names the coworker once; the thread row below carries the discussion. */
async function waitForDiscussionView(app: Awaited<ReturnType<typeof coworker>>, timeoutMs: number): Promise<void> {
  await waitFor(app, () => {
    const view = document.querySelector('[data-testid="coworker-discussion-view"]');
    const named = [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Editor");
    return Boolean(view) && named;
  }, { timeoutMs, label: "Editor discussion view" });
}

async function openDiscussionMenu(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await evalIn(app, () => { document.querySelector<HTMLElement>('[data-testid="coworker-discussion-switcher"]')!.click(); return true; });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-menu"]')), { timeoutMs: 10_000, label: "discussion menu" });
}

async function reload(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await evalIn(app, () => { location.reload(); return true; });
  await waitForDiscussionView(app, 120_000);
  await waitFor(app, () => Boolean(document.querySelector('textarea[aria-label="Message Editor"]')), {
    timeoutMs: 60_000,
    label: "Editor discussion composer",
  });
}

async function beginStatusTrace(app: Awaited<ReturnType<typeof coworker>>, prompt: string): Promise<void> {
  await evalIn(app, browserScript((prompt) => {
    window.__COWORKER_CHAT_TRACE__?.observer.disconnect();
    const trace: NonNullable<Window["__COWORKER_CHAT_TRACE__"]>["trace"] = [];
    const record = () => {
      const userMessages = [...document.querySelectorAll('[data-message-role="user"]')];
      const assistantMessages = [...document.querySelectorAll('[data-message-role="assistant"]')];
      trace.push({
        userVisible: userMessages.some((message) => (message.textContent ?? "").includes(prompt)),
        assistantReady: assistantMessages.some((message) => (message.textContent ?? "").includes("COWORKER CHAT READY")),
        threadStatus: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "",
        topStatus: document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
        working: Boolean(document.querySelector('[data-testid="coworker-working"]')),
      });
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__COWORKER_CHAT_TRACE__ = { trace, observer };
    record();
    return true;
  }, [prompt]));
}

async function sendDiscussionMessage(
  app: Awaited<ReturnType<typeof coworker>>,
  prompt: string,
  expected: string,
): Promise<unknown> {
  await fill(app, 'textarea[aria-label="Message Editor"]', prompt);
  await clickButton(app, "Send");
  await waitFor(app, browserScript((prompt) => {
    const message = [...document.querySelectorAll('[data-message-role="user"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(prompt));
    return message?.textContent ?? false;
  }, [prompt]), { timeoutMs: 30_000, label: `visible user message ${json(prompt)}` });
  return waitFor(app, browserScript((expected) => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(expected));
    return message?.textContent ?? false;
  }, [expected]), { timeoutMs: 300_000, label: `assistant response ${json(expected)}` });
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  // Keep the profile outside this repository: OpenCode walks parent directories for project
  // configuration, and a profile under evals/results would inherit this checkout's own plugins and
  // MCPs — a slow first start that has nothing to do with a person's first launch.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-discussion-profile-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  await using app = await coworker({ name: "persistent-discussion", profileDir });

  await waitFor(app, () => (document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker"), {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const created = resultRecord(await invokeCoworker(app, "coworkers.create", {
    name: "Editor",
    role: "Writing partner",
    mission: "Help shape clear product writing.",
    avatarColor: "blue",
    avatarGlasses: "round",
  }));
  expect(created.workspaceId).toEqual(expect.any(String));
  expect(created.workspaceId).not.toBe("");
  await invokeCoworker(app, "coworkers.update", {
    slug: "editor",
    patch: { model: EVAL_COWORKER_MODEL, modelVariant: "" },
  });
  await reload(app);
  // The first coworker's AI service restarts to pick up the new workspace; a person waits for
  // "Ready" in the header before typing, so the journey does too.
  await waitFor(app, () => {
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(status instanceof HTMLElement)) return false;
    return status.textContent?.trim() === "Ready";
  }, { timeoutMs: 240_000, label: "coworker AI ready before the first discussion" });

  const firstPrompt = "Reply with exactly COWORKER CHAT READY.";
  await beginStatusTrace(app, firstPrompt);
  const firstReply = await sendDiscussionMessage(app, firstPrompt, "COWORKER CHAT READY");
  expect(firstReply).toContain("COWORKER CHAT READY");

  const traceValue = await evalIn(app, () => {
    window.__COWORKER_CHAT_TRACE__?.observer.disconnect();
    return window.__COWORKER_CHAT_TRACE__?.trace ?? [];
  });
  if (!Array.isArray(traceValue) || !traceValue.every(isRecord)) {
    throw new Error("The discussion status trace was unavailable.");
  }
  const afterUser = traceValue.filter((entry) => entry.userVisible === true);
  const replyIndex = afterUser.findIndex((entry) => entry.assistantReady === true);
  expect(replyIndex).toBeGreaterThan(0);
  const beforeReply = afterUser.slice(0, replyIndex);
  expect(beforeReply.some((entry) => entry.working === true)).toBe(true);
  expect(beforeReply.every((entry) => entry.threadStatus !== "Ready")).toBe(true);
  expect(
    beforeReply.every((entry) => entry.topStatus !== "Ready"),
    `status trace before the matched reply: ${JSON.stringify(beforeReply)}`,
  ).toBe(true);
  await waitFor(app, () => document.querySelector<HTMLElement>('[data-testid="coworker-thread-status"]')?.dataset.state === "idle" && !document.querySelector('[data-testid="coworker-working"]'), { timeoutMs: 180_000, label: "discussion settled after the first reply" });

  const storedAfterFirst = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  expect(storedAfterFirst.conversationThreadId).toEqual(expect.stringMatching(/^ses_/));
  const discussionThreadId = storedAfterFirst.conversationThreadId;

  await reload(app);
  await waitForText(app, "COWORKER CHAT READY", { timeoutMs: 60_000 });
  const storedAfterReload = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  expect(storedAfterReload.conversationThreadId).toBe(discussionThreadId);

  const secondReply = await sendDiscussionMessage(
    app,
    "Reply with exactly SECOND CHAT READY.",
    "SECOND CHAT READY",
  );
  expect(secondReply).toContain("SECOND CHAT READY");
  const storedAfterSecond = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  expect(storedAfterSecond.conversationThreadId).toBe(discussionThreadId);

  // The reply's text lands a moment before its turn closes; let the live row go before reading the surface.
  await waitFor(app, () => document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() === "Ready" && document.querySelectorAll('[data-testid="coworker-working"]').length === 0, {
    timeoutMs: 120_000,
    label: "second turn settled",
  });
  evidence.recordAssertionEvidence(
    "A coworker's discussion waits for a matched reply and preserves its native thread across reload",
    `The first user message became visible with a working interval and no Ready status before the matched reply. Native discussion ${discussionThreadId} persisted across reload and a second turn.`,
    true,
  );

  // A second discussion runs beside the first: start it, send, leave while the reply is
  // still coming, return to the first, then come back to find the reply waiting.
  await openDiscussionMenu(app);
  await waitFor(app, () => {
    const item = document.querySelector('[data-testid="coworker-new-discussion"]');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  }, { timeoutMs: 30_000, label: "New discussion menu item" });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-empty"]')), { timeoutMs: 30_000, label: "fresh discussion" });
  const storedAfterNew = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" }));
  const secondDiscussionId = String(storedAfterNew.conversationThreadId);
  expect(secondDiscussionId).toEqual(expect.stringMatching(/^ses_/));
  expect(secondDiscussionId).not.toBe(discussionThreadId);
  await waitFor(app, () => (document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent ?? "").includes("New discussion"), {
    timeoutMs: 30_000,
    label: "fresh discussion labelled New discussion",
  });

  const parallelPrompt = "Reply with exactly PARALLEL CHAT READY.";
  await fill(app, 'textarea[aria-label="Message Editor"]', parallelPrompt);
  await clickButton(app, "Send");
  const statusWhenLeaving = await waitFor(app, browserScript((parallelPrompt) => {
    const visible = [...document.querySelectorAll('[data-message-role="user"]')]
      .some((candidate) => (candidate.textContent ?? "").includes(parallelPrompt));
    const status = document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "";
    return visible && status !== "Sending" ? status : false;
  }, [parallelPrompt]), { timeoutMs: 60_000, label: "second discussion accepted its message" });

  await openDiscussionMenu(app);
  const menuBeforeReturn = await evalIn(app, () => [...document.querySelectorAll('[data-testid="coworker-discussion-menu"] [role="menuitemradio"]')]
    .map((item) => ({ id: item.getAttribute("data-thread-id"), checked: item.getAttribute("aria-checked"), text: item.textContent?.trim() ?? "" })));
  expect(menuBeforeReturn).toHaveLength(2);
  expect(menuBeforeReturn).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: discussionThreadId, checked: "false", text: expect.stringContaining(firstPrompt) }),
    expect.objectContaining({ id: secondDiscussionId, checked: "true" }),
  ]));
  await evalIn(app, browserScript((id) => { document.querySelector<HTMLElement>(`[data-testid="coworker-discussion-menu"] [data-thread-id="${CSS.escape(String(id))}"]`)!.click(); return true; }, [discussionThreadId]));
  await waitForText(app, "SECOND CHAT READY", { timeoutMs: 30_000 });
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(discussionThreadId);
  // The thread area shows only the first discussion; the sidebar may truthfully report the other one still working.
  expect(await evalIn(app, browserScript((parallelPrompt) => (document.querySelector("main")?.innerText ?? "").includes(parallelPrompt), [parallelPrompt]))).toBe(false);

  await openDiscussionMenu(app);
  await evalIn(app, browserScript((id) => { document.querySelector<HTMLElement>(`[data-testid="coworker-discussion-menu"] [data-thread-id="${CSS.escape(id)}"]`)!.click(); return true; }, [secondDiscussionId]));
  const parallelReply = await waitFor(app, () => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes("PARALLEL CHAT READY"));
    return message?.textContent ?? false;
  }, { timeoutMs: 300_000, label: "reply that continued in the second discussion" });
  expect(parallelReply).toContain("PARALLEL CHAT READY");
  expect(await evalIn(app, () => document.querySelector('[data-testid="coworker-discussion-switcher"]')?.textContent?.trim())).toContain(parallelPrompt);
  expect(await evalIn(app, () => (document.querySelector("main")?.innerText ?? "").includes("SECOND CHAT READY"))).toBe(false);

  // Both discussions are registered beside the coworker record, and neither counts as an assignment.
  const registry = resultRecord(await invokeCoworker(app, "coworkers.files.read", { slug: "editor", path: "discussions.json" }));
  const registered = JSON.parse(String(registry.content)) as { threadIds?: string[] };
  expect(registered.threadIds).toEqual(expect.arrayContaining([discussionThreadId, secondDiscussionId]));
  expect(await evalIn(app, () => [...document.querySelectorAll('[data-testid^="summary-part-"]')].map((part) => part.getAttribute("data-testid")))).toEqual([]);

  evidence.recordAssertionEvidence(
    "A coworker holds parallel discussions that can be left, revisited, and resumed",
    `New discussion opened native thread ${secondDiscussionId}; its message was accepted (status "${String(statusWhenLeaving)}" when leaving). Returning to ${discussionThreadId} showed that discussion alone; coming back found the matched reply in ${secondDiscussionId} without the first discussion's reply. discussions.json registered both ids and the summary counted no assignment.`,
    true,
  );

  await invokeCoworker(app, "coworkers.update", {
    slug: "editor",
    patch: { model: "missing-provider/missing-model", modelVariant: "" },
  });
  await reload(app);
  const failurePrompt = "Reply with exactly THIS MUST FAIL.";
  await fill(app, 'textarea[aria-label="Message Editor"]', failurePrompt);
  await clickButton(app, "Send");
  // A missing saved model fails visibly without replacing the discussion.
  const failureText = await waitFor(app, () => {
    const failure = document.querySelector('[data-testid="coworker-turn-failed"]');
    if (!failure) return false;
    const technical = failure.querySelector('[data-testid="coworker-turn-technical"]');
    return (failure.textContent ?? "").replace(technical?.textContent ?? "", "");
  }, { timeoutMs: 120_000, label: "actionable failed discussion turn" });
  expect(await evalIn(app, () => document.querySelector('[data-testid="coworker-turn-headline"]')?.textContent?.trim())).toBe("Editor's AI model is not available.");
  expect(failureText).toContain("missing-provider/missing-model");
  expect(failureText).toContain("Choose AI model");
  expect(failureText).toContain("Continue with OpenWork");
  expect(String(failureText)).not.toMatch(/engine|APIError|stack/i);
  expect(await evalIn(app, () => document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim())).toBe("Reply failed");
  expect(await evalIn(app, () => document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim())).toBe("Reply failed");
  expect(await evalIn(app, () => document.querySelector('[data-testid="coworker-rail-line"]')?.textContent?.trim())).toBe("Editor's AI model is not available.");
  expect(await evalIn(app, browserScript((failurePrompt) => [...document.querySelectorAll('[data-message-role="user"]')]
    .some((message) => (message.textContent ?? "").includes(failurePrompt)), [failurePrompt]))).toBe(true);
  expect(resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "editor" })).conversationThreadId).toBe(secondDiscussionId);
  await evalIn(app, () => { document.querySelector<HTMLElement>('[data-testid="coworker-turn-choice"][data-choice="choose-model"]')!.click(); return true; });
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-model-settings"]')), { timeoutMs: 30_000, label: "AI model section" });
  await waitForText(app, "This saved model is not currently available from a connected provider.", { timeoutMs: 30_000 });

  evidence.recordAssertionEvidence(
    "An invalid coworker model becomes a plain, actionable message in the conversation instead of a silent Ready thread",
    "The failed turn kept the user's prompt and native discussion id, named the unavailable model, and reported failure rather than Ready. Choose AI model opened Coworker settings at the unavailable saved model.",
    true,
  );
});

const nativeDiscussionTest = spec.world(nativePackagedDiscussion, {
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Exercise packaged Coworker main/preload, its embedded server and pinned native engine, not a renderer substitute.",
  },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ELECTRON_BINARY"] },
  timeout: 240_000,
});

nativeDiscussionTest("native-v2 packaged discussion preserves streaming, drafts, Next, Stop, and reload", { timeout: 360_000 }, async ({ world, user, probe, step, evidence }) => {
  await using nativeEvidence = {
    async [Symbol.asyncDispose]() {
      const capture = async (read: () => Promise<unknown>) => {
        try { return await read(); }
        catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      };
      const [ui, native, engine, configuration, preparation, events] = await Promise.all([
        capture(world.uiState),
        capture(async () => Promise.all((await world.sessionIds()).map((id) => world.state(id)))),
        capture(world.engineState), capture(world.configuration), capture(world.preparation), capture(async () => world.events.read()),
      ]);
      evidence.recordJsonArtifact("Native discussion before cleanup", { engine, configuration, preparation, events, requests: world.model.requests(), fixtureErrors: world.model.errors(), ui, native, streamScope: "User reload opens a new SSE subscription; automatic reconnect after an injected disconnect is not covered." });
    },
  };
  const composer = { role: "textbox", label: "Message Editor" } satisfies Target;
  const coldPrompt = "Help me turn a rough launch idea into a short plan.";
  const prompt = "What should I consider before sharing that plan?";
  const original = "Suggest a next step for that plan.";
  const edited = "Suggest a smaller next step for that plan.";
  const removed = "Also draft a launch announcement.";
  const draft = "Keep this thought for my next message.";
  const texts = async (selector: string) => (await probe.dom(selector)).elements.map((element) => element.text);
  const seeStream = async (prefix: string) => {
    await user.see({ text: prefix.trim() }, { text: prefix.trim(), timeoutMs: 30_000 });
    expect((await texts('[data-message-role="assistant"]')).join("\n").split(prefix.trim()).length - 1).toBe(1);
  };
  const next = () => texts('[data-testid="coworker-next-row"] > span[title]');
  const expectNext = async (expected: string[]) => expect(await probe.eventually(next, {
    within: 15_000, label: "Next reflects only the saved queue", until: (items) => JSON.stringify(items) === JSON.stringify(expected),
  })).toEqual(expected);
  const expectWorking = async () => {
    expect(await texts('[data-testid="coworker-composer"][data-working="true"]')).toHaveLength(1);
    expect(await texts('[data-testid="coworker-thread-status"][data-state="working"]')).toHaveLength(1);
    expect(await texts('[data-testid="coworker-top-status"]')).not.toEqual(["Ready"]);
    expect(await texts('[data-testid="coworker-turn-failed"], [data-outcome="failed"]')).toEqual([]);
    expect(world.model.errors()).toEqual([]);
  };

  await step("cold UI creation prepares the selected workspace without fixture reload or inference", async () => {
    expect(world.cold).toEqual({ packaged: true, electron: true, welcome: true });
    expect(world.engine).toMatchObject({ enabled: true, chatRouting: true, running: true, version: "0.0.0-beta-19271", binSource: "explicit" });
    expect(world.engine.pid).toEqual(expect.any(Number));
    expect(world.engine.pid).not.toBe(world.app.handle.pid);
    expect(world.app.handle).toMatchObject({ kind: "electron", hostKind: "local" });
    await user.click({ testId: "onboarding-local-choice" });
    await user.click({ testId: "local-mode-continue" });
    await user.click({ testId: "onboarding-intents-own" });
    await user.type({ placeholder: "Scout" }, "Editor");
    await user.click({ testId: "new-coworker-details-step" });
    await user.type({ placeholder: "Research partner" }, "Writing partner");
    await user.type({ placeholder: "What should this coworker own over time?" }, "Help shape clear product writing.");
    await user.click({ role: "button", text: /^Add coworker$/ });
    await user.see(composer, { editable: true, value: "", timeoutMs: 120_000 });
    await user.see({ testId: "coworker-top-status" }, { text: "Ready", timeoutMs: 120_000 });
    const preparation = await world.preparation();
    expect(preparation.overflow).toBe(false);
    const starting = preparation.samples.filter(({ state }) => state.composer && (state.warming || state.top === "Starting AI"));
    expect(starting.length, "observe the actual cold preparation interval, not just its ready endpoint").toBeGreaterThan(0);
    expect(starting.every(({ state }) => state.top !== "Ready" && !state.problem)).toBe(true);
    evidence.recordJsonArtifact("Cold selected workspace preparation", preparation);
    expect(await world.availableModels()).toEqual(["eval-native-discussion/reply"]);
    expect(await world.sessionIds()).toEqual([]);
    expect(world.model.requests()).toEqual([]);
  });

  const requestCount = async (count: number) => {
    const calls = await probe.eventually(() => world.model.requests(), { within: 60_000, label: `exactly ${count} native provider admissions`, until: (items) => items.length >= count });
    expect(calls).toHaveLength(count);
    expect(world.model.errors()).toEqual([]);
    return calls[count - 1]!;
  };
  await user.type(composer, coldPrompt);
  await user.click({ testId: "coworker-send", label: "Send" });
  const coldReply = await requestCount(1);
  expect(coldReply).toMatchObject({ id: 1, model: "reply", stream: true, credential: "initial", released: 0, finished: false, aborted: false, expired: false });
  expect(coldReply.userTexts.at(-1)).toBe(coldPrompt);
  const sessionIds = await world.sessionIds();
  expect(sessionIds).toHaveLength(1);
  const sessionId = sessionIds[0]!;
  const workspaceId = (await world.workspaceInfo()).id;
  const expectIdle = async () => {
    const state = await probe.eventually(() => world.state(sessionId), { within: 30_000, label: "native idle confirmed independently of reply text", until: (value) => !value.running && value.inbox.length === 0 && value.messages.filter((message) => message.type === "assistant").at(-1)?.completed === true });
    await probe.eventually(() => texts('[data-testid="coworker-thread-status"][data-state="idle"]'), { within: 30_000, label: "UI agrees with confirmed idle", until: (items) => items.length === 1 });
    expect(await texts('[data-testid="coworker-composer"][data-working="true"]')).toEqual([]);
    return state;
  };
  await step("the cold first Send completes before an ordinary second Send", async () => {
    for (let count = 1; count <= coldReply.chunks.length; count++) {
      world.model.release(1);
      await seeStream(coldReply.chunks.slice(0, count).join(""));
      await expectWorking();
    }
    world.model.finish(1);
    const state = await expectIdle();
    expect(state.messages.filter((message) => message.type === "assistant" && message.completed)).toEqual([
      expect.objectContaining({ text: coldReply.chunks.join(""), finish: "stop", error: null }),
    ]);
    await user.see(composer, { editable: true, value: "" });
    expect(world.model.requests()).toHaveLength(1);
  });
  const stable = await world.configuration();
  const stableKey = await world.readinessKey();
  const expectStable = async () => {
    expect(await world.configuration(), "no native or selected-workspace config rewrite/replacement").toEqual(stable);
    expect((await world.engineState()).pid).toBe(world.engine.pid);
    expect(await world.readinessKey()).toBe(stableKey);
  };
  await step("reapplying the identical dummy provider is a no-op", async () => {
    expect(await world.configureCredential("initial")).toEqual({ changed: false, reload: "skipped" });
    await expectStable();
  });
  await user.type(composer, prompt);
  await user.see({ testId: "coworker-send", label: "Send" });
  await user.click({ testId: "coworker-send", label: "Send" });
  const second = await requestCount(2);
  expect(second).toMatchObject({ id: 2, model: "reply", stream: true, credential: "initial", released: 0, finished: false, aborted: false, expired: false });
  expect(second.userTexts.at(-1)).toBe(prompt);
  expect(await world.sessionIds()).toEqual([sessionId]);
  await expectStable();
  await user.see(composer, { editable: true, value: "" });
  await user.see({ testId: "coworker-send", label: "Stop" });
  world.model.release(2);
  await seeStream(second.chunks[0]!);
  await expectWorking();

  await step("Next can be edited and removed without admitting another turn", async () => {
    await user.type(composer, original);
    await user.click({ testId: "coworker-send", label: "Next" });
    await expectNext([original]);
    await user.click({ role: "button", label: "Actions for queued message 1" });
    await user.click({ testId: "coworker-next-edit" });
    await user.see(composer, { value: original });
    await expectNext([]);
    await user.type(composer, edited, { replace: true });
    await user.click({ testId: "coworker-send", label: "Next" });
    await expectNext([edited]);
    await user.see(composer, { value: "" });
    await user.type(composer, removed);
    await user.click({ testId: "coworker-send", label: "Next" });
    await expectNext([edited, removed]);
    await user.click({ role: "button", label: "Actions for queued message 2" });
    await user.click({ testId: "coworker-next-remove" });
    await expectNext([edited]);
    await user.see(composer, { value: "" });
    expect(world.model.requests()).toHaveLength(2);
    expect(await texts('[data-message-role="user"]')).toEqual([coldPrompt, prompt]);
  });

  await step("user reload opens a new SSE subscription and receives a later delta without resend", async () => {
    await user.type(composer, draft);
    const streams = await probe.eventually(() => world.events.read().filter((stream) => stream.workspaceId === workspaceId && !stream.closed && stream.observing && stream.status === 200), {
      within: 15_000, label: "active renderer SSE has the second turn's first delta", until: (items) => items.some((stream) => stream.deltas.some((delta) => delta.sessionId === sessionId && delta.text.includes(second.chunks[0]!.trim()))),
    });
    const oldIds = world.events.read().map((stream) => stream.id);
    const before = await world.state(sessionId);
    await user.reload();
    await user.see(composer, { editable: true, value: draft, timeoutMs: 60_000 });
    await seeStream(second.chunks[0]!);
    const replacement = await probe.eventually(() => world.events.read().filter((stream) => stream.workspaceId === workspaceId && !oldIds.includes(stream.id) && stream.status === 200 && stream.observing && !stream.closed), {
      within: 30_000, label: "reload established a genuinely new SSE subscription", until: (items) => items.length > 0,
    });
    await probe.eventually(() => world.events.read(), { within: 15_000, label: "reload closed the previous renderer subscription", until: (items) => streams.every((old) => items.some((item) => item.id === old.id && item.closed)) });
    expect((await world.state(sessionId)).messages).toEqual(before.messages);
    expect(world.model.requests()).toHaveLength(2);
    expect(await world.sessionIds()).toEqual([sessionId]);
    world.model.release(2);
    const received = await probe.eventually(() => world.events.read().filter((stream) => replacement.some((item) => item.id === stream.id)), {
      within: 30_000, label: "post-reload text delta arrived on the new SSE, not a history poll", until: (items) => items.some((stream) => stream.deltas.some((delta) => delta.sessionId === sessionId && delta.text.includes(second.chunks[1]!.trim()))),
    });
    await seeStream(second.chunks.slice(0, 2).join(""));
    await expectWorking();
    await user.see(composer, { value: draft });
    evidence.recordJsonArtifact("Reload-only SSE recovery", { before: streams, after: received });
    await expectStable();
  });

  await step("progressive text is not completion and a newer draft stays untouched", async () => {
    for (let count = 3; count <= second.chunks.length; count++) {
      world.model.release(2);
      await seeStream(second.chunks.slice(0, count).join(""));
      await expectWorking();
      await user.see(composer, { value: draft });
      const state = await world.state(sessionId);
      expect(state.running).toBe(true);
      expect(state.messages.filter((message) => message.type === "assistant" && message.completed)).toEqual([
        expect.objectContaining({ text: coldReply.chunks.join(""), finish: "stop", error: null }),
      ]);
      expect(world.model.requests()).toHaveLength(2);
    }
    expect(world.model.requests()[1]).toMatchObject({ released: 3, finished: false, aborted: false, expired: false });
  });

  await step("only a final stream receipt completes the ordinary second turn and drains edited Next once", async () => {
    world.model.finish(2);
    const calls = await probe.eventually(() => world.model.requests(), { within: 60_000, label: "edited Next admitted after completion", until: (items) => items.length >= 3 });
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.userTexts.at(-1))).toEqual([coldPrompt, prompt, edited]);
    expect(calls[2]).toMatchObject({ id: 3, model: "reply", stream: true, released: 0, finished: false });
    await user.see({ testId: "coworker-reply-bubble", nth: 1 }, { text: second.chunks.join(""), timeoutMs: 30_000 });
    await user.see(composer, { value: draft });
    await expectNext([]);
    expect(await texts('[data-message-role="user"]')).toEqual([coldPrompt, prompt, edited]);
    const state = await world.state(sessionId);
    expect(state.messages.filter((message) => message.type === "user").map((message) => message.text)).toEqual([coldPrompt, prompt, edited]);
    expect(state.messages.filter((message) => message.type === "assistant" && message.completed)).toEqual([
      expect.objectContaining({ text: coldReply.chunks.join(""), finish: "stop", error: null }),
      expect.objectContaining({ text: second.chunks.join(""), finish: "stop", error: null }),
    ]);
    world.model.release(3);
    await seeStream(calls[2]!.chunks[0]!);
    await expectWorking();
  });

  await step("Stop cancels the pending native stream, not the draft, and never starts another turn", async () => {
    await user.click({ testId: "coworker-stop" });
    await probe.eventually(() => world.model.requests()[2]?.aborted, { within: 30_000, label: "native Stop closes the provider stream" });
    const stopped = await probe.eventually(() => world.state(sessionId), { within: 30_000, label: "native Stop confirms idle", until: (state) => !state.running && state.session.outcome === "interrupted" });
    expect(stopped.inbox).toEqual([]);
    expect(stopped.messages.filter((message) => message.type === "user").map((message) => message.text)).toEqual([coldPrompt, prompt, edited]);
    expect(new Set(stopped.messages.map((message) => message.id)).size).toBe(stopped.messages.length);
    await user.see({ testId: "coworker-turn-line" }, { text: /^Stopped\./ });
    await user.see(composer, { editable: true, value: draft });
    expect(world.model.requests()[2]).toMatchObject({ finished: false, aborted: true, expired: false });
    expect((await texts('[data-message-role="assistant"]')).join("\n")).not.toContain(world.model.requests()[2]!.chunks[2]!.trim());
    await expectStable();
  });

  await step("reloading the stopped discussion restores history and draft without replay", async () => {
    const before = await world.state(sessionId);
    await user.reload();
    await user.see(composer, { editable: true, value: draft, timeoutMs: 60_000 });
    await user.see({ testId: "coworker-reply-bubble", nth: 0 }, { text: coldReply.chunks.join(""), timeoutMs: 30_000 });
    await user.see({ testId: "coworker-reply-bubble", nth: 1 }, { text: second.chunks.join(""), timeoutMs: 30_000 });
    expect(await texts('[data-message-role="user"]')).toEqual([coldPrompt, prompt, edited]);
    const replies = (await texts('[data-message-role="assistant"]')).join("\n");
    for (const text of [...coldReply.chunks, ...second.chunks]) expect(replies.split(text.trim()).length - 1).toBe(1);
    await expectNext([]);
    expect(await world.sessionIds()).toEqual([sessionId]);
    const after = await world.state(sessionId);
    expect(after.messages).toEqual(before.messages);
    expect(after).toMatchObject({ running: false, inbox: [], session: { id: sessionId, outcome: "interrupted" } });
    const quietUntil = Date.now() + 1_500;
    await probe.eventually(() => {
      expect(world.model.requests()).toHaveLength(3);
      expect(world.model.errors()).toEqual([]);
      return Date.now() >= quietUntil;
    }, { within: 5_000, intervalMs: 150, label: "no post-reload duplicate admission" });
    await expectStable();
  });

  await step("a real dummy credential rotation recovers readiness and sends the retained draft once", async () => {
    expect(await world.configureCredential("rotated")).toEqual({ changed: true, reload: "reloaded" });
    await probe.eventually(world.readinessKey, { within: 60_000, label: "native configuration generation changed", until: (key) => key !== stableKey });
    expect((await world.engineState()).pid).toBe(world.engine.pid);
    expect(await world.availableModels()).toEqual(["eval-native-discussion/reply"]);
    await user.see(composer, { editable: true, value: draft });
    await user.click({ testId: "coworker-send", label: "Send" });
    const recovered = await requestCount(4);
    expect(recovered).toMatchObject({ id: 4, credential: "rotated", model: "reply", stream: true, released: 0, finished: false });
    expect(recovered.userTexts.at(-1)).toBe(draft);
    expect(await world.sessionIds()).toEqual([sessionId]);
    await user.see(composer, { value: "" });
    for (let count = 1; count <= recovered.chunks.length; count++) {
      world.model.release(4);
      await seeStream(recovered.chunks.slice(0, count).join(""));
      await expectWorking();
    }
    world.model.finish(4);
    const state = await expectIdle();
    expect(state.messages.filter((message) => message.type === "user").map((message) => message.text)).toEqual([coldPrompt, prompt, edited, draft]);
    expect(state.messages.filter((message) => message.type === "assistant" && message.text === recovered.chunks.join(""))).toEqual([
      expect.objectContaining({ completed: true, finish: "stop", error: null }),
    ]);
    expect(await texts('[data-testid="coworker-workspace-problem"], [data-testid="coworker-turn-failed"], [data-outcome="failed"]')).toEqual([]);
    const rotated = await world.configuration();
    expect(rotated.find((file) => file.name === "native")?.digest).not.toBe(stable.find((file) => file.name === "native")?.digest);
    expect(rotated.filter((file) => file.name !== "native")).toEqual(stable.filter((file) => file.name !== "native"));
    const rotatedKey = await world.readinessKey();
    expect(await world.configureCredential("rotated")).toEqual({ changed: false, reload: "skipped" });
    const quietUntil = Date.now() + 1_500;
    await probe.eventually(async () => {
      expect(await world.configuration()).toEqual(rotated);
      expect((await world.engineState()).pid).toBe(world.engine.pid);
      expect(await world.readinessKey()).toBe(rotatedKey);
      expect(world.model.requests()).toHaveLength(4);
      expect(world.model.errors()).toEqual([]);
      return Date.now() >= quietUntil;
    }, { within: 10_000, intervalMs: 250, label: "same-key identical body leaves config metadata, PID and admissions unchanged" });
    evidence.recordJsonArtifact("Configuration identity across no-op and real provider changes", { before: stable, rotated, initialPid: world.engine.pid, finalPid: (await world.engineState()).pid });
  });
});
