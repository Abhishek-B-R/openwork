import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOpenAICredential } from "./openai-credential.mjs";
import { CALL_MODEL, CALL_TOOLS, CALL_VOICES, callInstructions } from "../src/lib/call.ts";

const ERROR_MESSAGES = {
  key: "Your OpenAI key was not accepted. Replace it in Settings › OpenAI.",
  quota: "Your OpenAI account has reached its quota or rate limit. Check billing and try again.",
  network: "The call could not connect. Check your connection and try again.",
  storage: "Secure storage is unavailable. Enable your system password store and try again.",
  missing: "Add an OpenAI key in Settings › OpenAI to start a call.",
};
const failure = (code) => new Error(ERROR_MESSAGES[code]);
async function atomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, file); await chmod(file, 0o600); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
/** Calls use a main-owned encrypted credential; fast decisions use the native model connection. */
export function createVoiceCalls({ directory, credential, safeStorage, requestKey, fetch: request = fetch, platform = process.platform }) {
  credential ??= createOpenAICredential({ directory, safeStorage, requestKey, platform });
  const configFile = path.join(directory, "voice-call-settings.json");
  let pending = null;
  let writes = Promise.resolve();
  credential.onChange(() => pending?.abort());
  async function settings() {
    await writes;
    const { keySet } = await credential.settings();
    let config = {};
    try { config = JSON.parse(await readFile(configFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw failure("storage"); }
    return { keySet, voice: CALL_VOICES.includes(config.voice) ? config.voice : "marin", model: CALL_MODEL,
      // Existing Call-only users retain their prior consent; fast decisions never inherit it.
      enabled: typeof config.enabled === "boolean" ? config.enabled : keySet };
  }
  function save(patch) {
    const result = writes.catch(() => {}).then(async () => {
      let config = {};
      try { config = JSON.parse(await readFile(configFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw failure("storage"); }
      await atomic(configFile, JSON.stringify({ ...config, ...patch }));
    });
    writes = result.then(() => undefined, () => undefined);
    return result;
  }
  async function clientSecret(person) {
    if (pending) throw failure("network");
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const config = await settings();
      if (!config.enabled) throw new Error("Enable Voice calls in Settings › OpenAI to start a call.");
      return await credential.withKey(async (key) => {
        const response = await request("https://api.openai.com/v1/realtime/client_secrets", {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: {
            type: "realtime", model: CALL_MODEL, instructions: callInstructions(person), tools: CALL_TOOLS,
            output_modalities: ["audio"], max_output_tokens: 512, tracing: null,
            audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" }, noise_reduction: { type: "near_field" }, turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true } }, output: { voice: config.voice } },
          } }),
        });
        if (!response.ok) { await response.body?.cancel(); throw failure(response.status === 401 || response.status === 403 ? "key" : response.status === 429 ? "quota" : "network"); }
        const result = await response.json();
        if (controller.signal.aborted || typeof result.value !== "string" || !result.value.startsWith("ek_")) throw failure("network");
        return { value: result.value, expiresAt: result.expires_at };
      }, controller.signal);
    } catch (error) {
      // No provider bodies, headers, secret values or transport errors reach IPC/logs.
      if (Object.values(ERROR_MESSAGES).includes(error?.message) || error?.message === "Enable Voice calls in Settings › OpenAI to start a call.") throw error;
      throw failure("network");
    } finally { clearTimeout(timer); if (pending === controller) pending = null; }
  }
  return {
    settings, clientSecret,
    async microphone(requestPermission) {
      const config = await settings();
      if (!config.keySet) throw failure("missing");
      if (!config.enabled) throw new Error("Enable Voice calls in Settings › OpenAI to start a call.");
      return requestPermission();
    },
    cancel() { pending?.abort(); },
    async test() { await clientSecret({ name: "Coworker", role: "Call connection test", mission: "", personality: "warm" }); return { ok: true, message: "Connected. OpenAI accepted your key and created a short-lived call secret." }; },
    async editKey() { const before = await settings(); await save({ enabled: before.enabled }); await credential.editKey(); return settings(); },
    async remove() { await credential.remove(); return settings(); },
    async enabled(value) { if (typeof value !== "boolean") throw new Error("Choose whether Voice calls are enabled."); pending?.abort(); await save({ enabled: value }); return settings(); },
    async voice(value) { if (!CALL_VOICES.includes(value)) throw new Error("Choose an available call voice."); await save({ voice: value }); return settings(); },
  };
}

export function createCallHistory(getDirectory) {
  let writes = Promise.resolve();
  async function read(slug, threadId) {
    const directory = await getDirectory(slug); let records = {};
    try { records = JSON.parse(await readFile(path.join(directory, "call-history.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw new Error("Call history could not be read. The saved record is kept."); }
    return { directory, records, history: records[threadId] ?? { spoken: [], calls: [] } };
  }
  return {
    async read(slug, threadId) { await writes; return (await read(slug, threadId)).history; },
    append(slug, threadId, entry) {
      if (typeof threadId !== "string" || !threadId || threadId.length > 256 || typeof entry?.id !== "string" || !entry.id || entry.id.length > 256) throw new Error("Invalid call record.");
      const operation = writes.catch(() => {}).then(async () => {
        const { directory, records, history } = await read(slug, threadId);
        if (entry.kind === "spoken") {
          if (typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > 16000 || !Number.isFinite(entry.at)) throw new Error("Invalid spoken request.");
          if (!history.spoken.some((item) => item.id === entry.id)) history.spoken.push({ id: entry.id, text: entry.text, at: entry.at });
        } else if (entry.kind === "call") {
          if (typeof entry.name !== "string" || entry.name.length > 80 || !Number.isFinite(entry.startedAt) || !Number.isFinite(entry.endedAt) || entry.endedAt < entry.startedAt) throw new Error("Invalid call record.");
          if (!history.calls.some((item) => item.id === entry.id)) history.calls.push({ id: entry.id, name: entry.name, startedAt: entry.startedAt, endedAt: entry.endedAt });
        } else throw new Error("Invalid call record.");
        records[threadId] = { spoken: history.spoken.slice(-500), calls: history.calls.slice(-100) };
        await atomic(path.join(directory, "call-history.json"), JSON.stringify(records)); return records[threadId];
      });
      writes = operation.then(() => undefined, () => undefined); return operation;
    },
  };
}
