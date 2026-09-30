import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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
            audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" }, noise_reduction: { type: "near_field" }, turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true } }, output: { voice: CALL_VOICES.includes(person.realtimeVoice) ? person.realtimeVoice : config.voice } },
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
  const audioFile = (directory, threadId, id) => path.join(directory, "call-audio", `${createHash("sha256").update(`${threadId}\0${id}`).digest("hex")}.wav`);
  async function read(slug, threadId, createdAt) {
    const directory = await getDirectory(slug, threadId, createdAt); let records = {};
    try { records = JSON.parse(await readFile(path.join(directory, "call-history.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw new Error("Call history could not be read. The saved record is kept."); }
    const history = records[threadId] ?? { spoken: [], calls: [] };
    history.transcripts ??= [];
    return { directory, records, history };
  }
  return {
    async read(slug, threadId) { await writes; return (await read(slug, threadId)).history; },
    async audio(slug, threadId, id) {
      await writes;
      const { directory, history } = await read(slug, threadId);
      if (!history.transcripts.some((turn) => turn.id === id && turn.audio)) throw new Error("This audio recording is no longer available. The transcript is kept.");
      const bytes = await readFile(audioFile(directory, threadId, id));
      if (bytes.length > 3 * 1024 * 1024) throw new Error("This recording is too large to play.");
      return { data: bytes.toString("base64"), mimeType: "audio/wav" };
    },
    append(slug, threadId, entry, createdAt) {
      if (typeof threadId !== "string" || !threadId || threadId.length > 256 || typeof entry?.id !== "string" || !entry.id || entry.id.length > 256) throw new Error("Invalid call record.");
      const operation = writes.catch(() => {}).then(async () => {
        const { directory, records, history } = await read(slug, threadId, createdAt);
        if (entry.kind === "spoken") {
          if (typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > 16000 || !Number.isFinite(entry.at)) throw new Error("Invalid spoken request.");
          if (!history.spoken.some((item) => item.id === entry.id)) history.spoken.push({ id: entry.id, text: entry.text, at: entry.at });
        } else if (entry.kind === "transcript") {
          if (!["you", "coworker"].includes(entry.speaker) || typeof entry.callId !== "string" || !entry.callId || entry.callId.length > 256 || typeof entry.text !== "string" || entry.text.length > 16000 || !Number.isFinite(entry.at) || typeof entry.final !== "boolean") throw new Error("Invalid voice transcript.");
          const previous = history.transcripts.find((turn) => turn.id === entry.id);
          if (previous && (previous.callId !== entry.callId || previous.speaker !== entry.speaker)) throw new Error("Invalid voice transcript.");
          const turn = { id: entry.id, callId: entry.callId, speaker: entry.speaker, name: typeof entry.name === "string" ? entry.name.slice(0, 80) : previous?.name, text: previous?.final && !entry.final ? previous.text : entry.text, at: previous?.at ?? entry.at, final: entry.final || previous?.final === true, interrupted: entry.interrupted === true || previous?.interrupted === true, audio: previous?.audio === true };
          if (entry.audioData !== undefined) {
            if (typeof entry.audioData !== "string" || entry.audioData.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.audioData)) throw new Error("Invalid audio recording.");
            const bytes = Buffer.from(entry.audioData, "base64");
            if (bytes.length < 44 || bytes.length > 3 * 1024 * 1024 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid audio recording.");
            await atomic(audioFile(directory, threadId, entry.id), bytes);
            turn.audio = true;
          }
          history.transcripts = [...history.transcripts.filter((item) => item.id !== turn.id), turn].sort((a, b) => a.at - b.at);
          // At most 50 one-minute clips per discussion; keep older words after pruning audio.
          const recordings = history.transcripts.filter((item) => item.audio);
          for (const old of recordings.slice(0, Math.max(0, recordings.length - 50))) {
            await rm(audioFile(directory, threadId, old.id), { force: true }); old.audio = false;
          }
        } else if (entry.kind === "call") {
          if (typeof entry.name !== "string" || entry.name.length > 80 || !Number.isFinite(entry.startedAt) || !Number.isFinite(entry.endedAt) || entry.endedAt < entry.startedAt) throw new Error("Invalid call record.");
          if (!history.calls.some((item) => item.id === entry.id)) history.calls.push({ id: entry.id, name: entry.name, startedAt: entry.startedAt, endedAt: entry.endedAt });
        } else throw new Error("Invalid call record.");
        for (const old of history.transcripts.slice(0, Math.max(0, history.transcripts.length - 500))) if (old.audio) await rm(audioFile(directory, threadId, old.id), { force: true });
        records[threadId] = { spoken: history.spoken.slice(-500), calls: history.calls.slice(-100), transcripts: history.transcripts.slice(-500) };
        await atomic(path.join(directory, "call-history.json"), JSON.stringify(records)); return records[threadId];
      });
      writes = operation.then(() => undefined, () => undefined); return operation;
    },
  };
}
