import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenAICredential } from "./openai-credential.mjs";
import { createVoiceCalls } from "./voice-calls.mjs";
import { createFastDecisions, fastGroupObservation } from "./fast-decisions.mjs";
import { fastDecisionModel, nativeFastDecision } from "./fast-decisions-native.mjs";

const key = "sk-synthetic-shared-key-never-real";
const storage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptStringAsync: async () => Buffer.from("sealed"), decryptStringAsync: async () => ({ result: key }) };
const observation = fastGroupObservation({ message: "Who can test this release?", participants: [{ slug: "tester", name: "Private name", role: "Release tester", mission: "Private mission" }, { slug: "designer", role: "Designer" }], mentions: { everyone: false, slugs: [] } });
const model = { providerId: "connected-provider", modelId: "luna", variant: "none" };
const transport = { key: "native-generation", model, client: {} };
const ready = async () => transport;
const response = (choice = "member_0") => ({ text: JSON.stringify({ choice }), usage: { inputTokens: 250, outputTokens: 8, cost: 0.000029 } });
async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "coworker-fast-decisions-"));
  const credential = createOpenAICredential({ directory, platform: "linux", safeStorage: storage, requestKey: async () => key });
  try { await run({ directory, credential }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Luna uses the existing model connection with no Call key or separate credentials", async () => fixture(async ({ directory, credential }) => {
  let decisions = 0;
  const voice = createVoiceCalls({ directory, credential });
  const fast = createFastDecisions({ directory, ready, request: async (client, selected, input) => {
    decisions++; assert.equal(client, transport.client); assert.deepEqual(selected, model);
    assert.equal(input.deadlineMs, 2500);
    assert.doesNotMatch(input.prompt, /Private name|Private mission|"slug"|"name"|"mission"/);
    assert.deepEqual(Object.keys(input).sort(), ["deadlineMs", "prompt", "signal"]);
    return response();
  } });
  assert.equal((await voice.settings()).keySet, false);
  assert.equal((await fast.settings()).available, true);
  assert.equal(await fast.decide(observation), null); assert.equal(decisions, 0);
  await fast.configure({ enabled: true, deadlineMs: 2500 });
  assert.equal(await fast.decide(observation), "member_0");
  const settings = await fast.settings(); assert.equal(settings.last.costUsd, 0.000029);
  assert.equal(settings.keySet, undefined); assert.equal(settings.connection, "native");
  await assert.rejects(readFile(path.join(directory, "voice-call-key.bin")), { code: "ENOENT" });
  await voice.editKey(); assert.equal((await voice.settings()).enabled, false);
  await credential.remove();
  assert.equal(await fast.decide(observation), "member_0", "Call-key removal cannot disable native Luna");
  assert.equal((await voice.settings()).keySet, false);
  await writeFile(path.join(directory, "voice-call-key.bin"), "sealed");
  await writeFile(path.join(directory, "voice-call-settings.json"), JSON.stringify({ voice: "marin" }));
  await rm(path.join(directory, "fast-decision-settings.json"));
  assert.equal((await voice.settings()).enabled, true); assert.equal((await fast.settings()).enabled, false);
}));

test("invalid, unavailable, stale and collective decisions retain the existing fallback", async () => fixture(async ({ directory }) => {
  let choice = "not_a_member", available = true, fail = false, requests = 0;
  const fast = createFastDecisions({ directory, ready: async () => available ? transport : null, request: async () => {
    requests++; if (fail) throw new Error("private-provider-error-canary"); return response(choice);
  } });
  await fast.configure({ enabled: true, deadlineMs: 2500 });
  assert.equal(await fast.decide(observation), null); assert.equal((await fast.settings()).last.outcome, "invalid");
  choice = "defer"; assert.equal(await fast.decide(observation), null); assert.equal((await fast.settings()).last.outcome, "deferred");
  choice = "member_0"; assert.equal(await fast.decide(observation, { isCurrent: async () => false }), null); assert.equal((await fast.settings()).last.outcome, "stale");
  fail = true; assert.equal(await fast.decide(observation), null);
  await assert.rejects(fast.test(), (error) => !error.message.includes("canary") && /Available models/.test(error.message));
  assert.doesNotMatch(JSON.stringify(await fast.settings()), /canary/);
  available = false; const count = requests;
  assert.equal(await fast.decide(observation), null); assert.equal(requests, count); assert.equal((await fast.settings()).available, false);
  assert.equal(fastGroupObservation({ message: "@everyone respond", participants: [{ role: "A" }, { role: "B" }], mentions: { everyone: true, slugs: [] } }), null);
  assert.equal(fastGroupObservation({ message: "a".repeat(1201), participants: [{ role: "A" }, { role: "B" }], mentions: { everyone: false, slugs: [] } }), null);
}));

test("deadline, cancellation and provider changes discard late decisions with one request in flight", async () => fixture(async ({ directory }) => {
  let resolveRequest, requestSignal, started, connection = transport;
  let begin = new Promise((resolve) => { started = resolve; });
  const fast = createFastDecisions({ directory, ready: async () => connection, request: (_client, _model, input) => {
    requestSignal = input.signal; started(); return new Promise((resolve) => { resolveRequest = resolve; });
  } });
  await fast.configure({ enabled: true, deadlineMs: 1000 });
  const pending = fast.decide(observation); await begin;
  assert.equal(await fast.decide(observation), null);
  assert.equal(await pending, null); assert.equal(requestSignal.aborted, true); assert.equal((await fast.settings()).last.outcome, "timeout");
  assert.equal(await fast.decide(observation), null, "unsettled transport retains the slot");
  resolveRequest(response()); await new Promise((resolve) => setImmediate(resolve));
  begin = new Promise((resolve) => { started = resolve; });
  const stale = fast.decide(observation); await begin;
  connection = { ...transport, key: "replacement-generation" }; resolveRequest(response());
  assert.equal(await stale, null); assert.equal((await fast.settings()).last.outcome, "stale");
  begin = new Promise((resolve) => { started = resolve; });
  const cancelled = fast.decide(observation); await begin; fast.cancel();
  assert.equal(await cancelled, null); assert.equal(requestSignal.aborted, true); resolveRequest(response());
  await new Promise((resolve) => setImmediate(resolve));
  begin = new Promise((resolve) => { started = resolve; });
  const changed = fast.decide(observation); await begin;
  await fast.configure({ enabled: false, deadlineMs: 1000 }); assert.equal(await changed, null); resolveRequest(response());
  assert.equal((await fast.settings()).last, null);
}));

test("removing a credential during secure entry cannot resurrect it", async () => fixture(async ({ directory }) => {
  let resolveKey, entryStarted;
  const entered = new Promise((resolve) => { entryStarted = resolve; });
  const credential = createOpenAICredential({ directory, platform: "linux", safeStorage: storage, requestKey: () => { entryStarted(); return new Promise((resolve) => { resolveKey = resolve; }); } });
  const editing = credential.editKey(); await entered; await credential.remove(); resolveKey(key);
  await assert.rejects(editing, /connection changed/); assert.equal((await credential.settings()).keySet, false);
}));


test("catalog selection uses only connected Luna, including a managed provider alias", () => {
  const luna = { id: "managed-luna", providerID: "existing", modelID: "gateway-alias", upstreamModelId: "gpt-6-luna", enabled: true, status: "active", capabilities: { input: ["text"], output: ["text", "reasoning"] }, variants: [{ id: "none" }, { id: "low" }], cost: [{ input: 0.1, output: 0.5 }] };
  const catalog = { providers: [{ id: "existing", activation: "enabled", package: "@opencode-ai/ai/providers/openai-compatible" }], models: [luna], connectedProviderIds: ["existing"] };
  assert.deepEqual(fastDecisionModel(catalog), { providerId: "existing", modelId: "managed-luna", variant: "none" });
  assert.equal(fastDecisionModel({ ...catalog, connectedProviderIds: [] }), null);
  for (const update of [{ upstreamModelId: "another-model" }, { enabled: false }, { status: "deprecated" }, { cost: [] }, { cost: [{ input: 10, output: 50 }] }]) {
    assert.equal(fastDecisionModel({ ...catalog, models: [{ ...luna, ...update }] }), null);
  }
});

test("native decision accepts one correlated text reply and aborts its helper session", async () => {
  let messageId, stopped = 0, reply = {}, lateCreate;
  const client = {
    createThread: async (input) => { assert.equal(input.agent, "fast-decision"); assert.deepEqual(input.model, model); return { id: "helper-session" }; },
    sendTurn: async (_thread, input) => { messageId = input.messageId; assert.equal(input.agent, "fast-decision"); return { messageId }; },
    getThreadSnapshot: async () => ({ status: { type: "idle" }, native: { engine: "v2", turnOutcomes: { [messageId]: "succeeded" } }, messages: [{ role: "assistant", parentId: messageId, completedAt: 1, parts: [{ type: "text", text: response().text }], usage: { inputTokens: 250, outputTokens: 8, reasoningTokens: 0 }, ...reply }] }),
    abortThread: async (id) => { assert.equal(id, "helper-session"); stopped++; },
  };
  const input = { prompt: JSON.stringify(observation.context), signal: new AbortController().signal, deadlineMs: 1000 };
  assert.equal((await nativeFastDecision(client, model, input)).text, response().text); assert.equal(stopped, 1);
  for (const invalid of [{ parentId: "wrong" }, { parts: [{ type: "tool", name: "shell" }] }, { usage: { reasoningTokens: 1 } }, { usage: { outputTokens: 65 } }, { error: {} }]) {
    reply = invalid; await assert.rejects(nativeFastDecision(client, model, input), /refused/);
  }
  const controller = new AbortController();
  const delayed = nativeFastDecision({ ...client, createThread: () => new Promise((resolve) => { lateCreate = resolve; }) }, model, { ...input, signal: controller.signal });
  controller.abort(); lateCreate({ id: "helper-session" });
  await assert.rejects(delayed); assert.equal(stopped, 7, "a late session receipt is stopped before the slot is released");
});
