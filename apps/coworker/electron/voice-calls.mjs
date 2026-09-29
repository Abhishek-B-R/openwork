import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CALL_MODEL, CALL_TOOLS, CALL_VOICES, callInstructions } from "../src/lib/call.ts";

const ERROR_MESSAGES = {
  key: "Your OpenAI key was not accepted. Replace it in Voice calls settings.",
  quota: "Your OpenAI account has reached its quota or rate limit. Check billing and try again.",
  network: "The call could not connect. Check your connection and try again.",
  storage: "Secure storage is unavailable. Enable your system password store and try again.",
  missing: "Add an OpenAI key in Settings › Voice calls to start a call.",
};
const failure = (code) => new Error(ERROR_MESSAGES[code]);
async function atomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, data, { mode: 0o600 }); await rename(temporary, file); await chmod(file, 0o600); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
/** Follow Electron's existing async safeStorage contract; fail closed on Linux basic_text. */
export function createVoiceCalls({ directory, safeStorage, requestKey, fetch: request = fetch, platform = process.platform }) {
  const keyFile = path.join(directory, "voice-call-key.bin");
  const configFile = path.join(directory, "voice-call-settings.json");
  let editing = false;
  let pending = null;
  async function secure() {
    if (!await safeStorage.isAsyncEncryptionAvailable() || (platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw failure("storage");
  }
  async function settings() {
    let voice = "marin";
    try { const value = JSON.parse(await readFile(configFile, "utf8")); if (CALL_VOICES.includes(value.voice)) voice = value.voice; } catch (error) { if (error.code !== "ENOENT") throw failure("storage"); }
    let keySet = false;
    try { keySet = (await readFile(keyFile)).length > 0; } catch (error) { if (error.code !== "ENOENT") throw failure("storage"); }
    return { keySet, voice, model: CALL_MODEL };
  }
  async function clientSecret(person) {
    if (pending) throw failure("network");
    const controller = new AbortController(); pending = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      await secure();
      let sealed;
      try { sealed = await readFile(keyFile); } catch { throw failure("missing"); }
      let key;
      try { const decrypted = await safeStorage.decryptStringAsync(sealed); key = decrypted.result; if (decrypted.shouldReEncrypt) await atomic(keyFile, await safeStorage.encryptStringAsync(key)); } catch { throw failure("storage"); }
      const config = await settings();
      const response = await request("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 60 }, session: {
          type: "realtime", model: CALL_MODEL, instructions: callInstructions(person), tools: CALL_TOOLS,
          output_modalities: ["audio"], max_output_tokens: 512, tracing: null,
          audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" }, noise_reduction: { type: "near_field" }, turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true } }, output: { voice: config.voice } },
        } }),
      });
      key = undefined;
      if (!response.ok) { await response.body?.cancel(); throw failure(response.status === 401 || response.status === 403 ? "key" : response.status === 429 ? "quota" : "network"); }
      const result = await response.json();
      if (controller.signal.aborted || typeof result.value !== "string" || !result.value.startsWith("ek_")) throw failure("network");
      return { value: result.value, expiresAt: result.expires_at };
    } catch (error) {
      // No provider bodies, headers, secret values or transport errors reach IPC/logs.
      if (Object.values(ERROR_MESSAGES).includes(error?.message)) throw error;
      throw failure("network");
    } finally { clearTimeout(timer); if (pending === controller) pending = null; }
  }
  return {
    settings, clientSecret,
    async microphone(requestPermission) {
      if (!(await settings()).keySet) throw failure("missing");
      return requestPermission();
    },
    cancel() { pending?.abort(); },
    async test() { await clientSecret({ name: "Coworker", role: "Call connection test", mission: "", personality: "warm" }); return { ok: true, message: "Connected. OpenAI accepted your key and created a short-lived call secret." }; },
    async editKey() {
      if (editing) return settings();
      editing = true;
      try { await secure(); const key = await requestKey(); if (key !== null) { if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) throw failure("key"); await atomic(keyFile, await safeStorage.encryptStringAsync(key)); } return settings(); }
      catch (error) { if (Object.values(ERROR_MESSAGES).includes(error?.message)) throw error; throw failure("storage"); }
      finally { editing = false; }
    },
    async remove() { pending?.abort(); await rm(keyFile, { force: true }); return settings(); },
    async voice(value) { if (!CALL_VOICES.includes(value)) throw new Error("Choose an available call voice."); await atomic(configFile, JSON.stringify({ voice: value })); return settings(); },
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
