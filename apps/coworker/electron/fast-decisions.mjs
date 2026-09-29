import { readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivateJson } from "./openai-credential.mjs";
import { FAST_DECISION_MODEL, nativeFastDecision } from "./fast-decisions-native.mjs";

const DEFAULTS = { enabled: false, deadlineMs: 2500 };
const MESSAGE = "Luna could not return a decision through your connected models. Check Available models, then test again. Group replies keep using the existing facilitator.";

/** Bounded text-only observation: no history, names, memory, tools or screenshots. */
export function fastGroupObservation({ message, participants, mentions }) {
  if (typeof message !== "string" || !message.trim() || Buffer.byteLength(message) > 1200
    || mentions.everyone || mentions.slugs.length || participants.length < 2 || participants.length > 8) return null;
  const choices = participants.map((_, index) => `member_${index}`);
  const context = { request: message, members: participants.map((member, index) => ({ choice: choices[index], role: member.role.slice(0, 160) })) };
  if (Buffer.byteLength(JSON.stringify(context)) > 3000) return null;
  return { context, choices: [...choices, "defer"] };
}

function abortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function validatedChoice(text, choices) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 128) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return value && !Array.isArray(value) && Object.keys(value).length === 1 && choices.includes(value.choice) ? value.choice : null;
}

/** A single helper call returns data to the existing group workflow, never admits work. */
export function createFastDecisions({ directory, ready, request = nativeFastDecision }) {
  const file = path.join(directory, "fast-decision-settings.json");
  let revision = 0;
  let pending = null;
  let writes = Promise.resolve();
  let last = null;
  const cancel = () => { revision++; pending?.abort(); last = null; };
  async function config() {
    await writes;
    let value = {};
    try { value = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Fast decision settings could not be read. Try reopening Settings."); }
    return { enabled: value.enabled === true, deadlineMs: [1000, 2500, 5000].includes(value.deadlineMs) ? value.deadlineMs : DEFAULTS.deadlineMs };
  }
  async function settings() {
    const transport = await ready({ signal: AbortSignal.timeout(1000) }).catch(() => null);
    return { ...await config(), available: Boolean(transport?.model), model: FAST_DECISION_MODEL, connection: "native", last };
  }
  async function configure(value) {
    if (typeof value.enabled !== "boolean" || ![1000, 2500, 5000].includes(value.deadlineMs)) throw new Error("Choose an available fast decision setting.");
    cancel();
    const work = writes.catch(() => {}).then(() => writePrivateJson(file, { enabled: value.enabled, deadlineMs: value.deadlineMs }));
    writes = work.then(() => undefined, () => undefined);
    await work;
    return settings();
  }
  async function decide(observation, { signal, isCurrent = async () => true } = {}) {
    const started = performance.now();
    const version = revision;
    const selected = await config();
    if (version !== revision || !selected.enabled || pending || signal?.aborted) return null;
    const remainingMs = selected.deadlineMs - (performance.now() - started);
    if (remainingMs <= 0) { last = { outcome: "timeout", elapsedMs: Math.round(performance.now() - started) }; return null; }
    const controller = new AbortController(); pending = controller;
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let outcome = "unavailable";
    let usage = null;
    const work = (async () => {
      const transport = await ready({ signal: combined });
      combined.throwIfAborted();
      if (!transport?.model) return null;
      const fingerprint = JSON.stringify([transport.key, transport.model]);
      const result = await request(transport.client, transport.model, { prompt: JSON.stringify(observation.context), signal: combined, deadlineMs: selected.deadlineMs });
      combined.throwIfAborted();
      const choice = validatedChoice(result.text, observation.choices);
      if (Number.isSafeInteger(result.usage?.inputTokens) && result.usage.inputTokens >= 0 && Number.isSafeInteger(result.usage?.outputTokens) && result.usage.outputTokens >= 0) {
        usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
          ...(Number.isFinite(result.usage.cost) && result.usage.cost >= 0 ? { costUsd: result.usage.cost } : {}) };
      }
      const current = await ready({ signal: combined });
      if (version !== revision || JSON.stringify([current?.key, current?.model]) !== fingerprint || !await isCurrent()) { outcome = "stale"; return null; }
      combined.throwIfAborted();
      if (!choice) { outcome = "invalid"; return null; }
      outcome = choice === "defer" ? "deferred" : "selected";
      return choice === "defer" ? null : choice;
    })();
    // Keep the concurrency slot until the underlying request settles, even when
    // a transport ignores cancellation. Late results never enter the workflow.
    void work.finally(() => { if (pending === controller) pending = null; }).catch(() => {});
    try { return await abortable(work, combined); }
    catch { if (combined.aborted) outcome = signal?.aborted || version !== revision ? "cancelled" : "timeout"; return null; }
    finally {
      clearTimeout(timer); controller.abort();
      if (version === revision) last = { outcome, elapsedMs: Math.round(performance.now() - started), ...(usage ?? {}) };
    }
  }
  return {
    settings, configure, decide, cancel,
    async test() {
      const observation = { context: { request: "Which member owns release testing?", members: [{ choice: "member_0", role: "Release tester" }, { choice: "member_1", role: "Designer" }] }, choices: ["member_0", "member_1", "defer"] };
      const choice = await decide(observation);
      if (choice !== "member_0") throw new Error(MESSAGE);
      return { ok: true, message: "Connected. Luna returned the expected bounded decision through your model connection.", ...await settings() };
    },
  };
}
