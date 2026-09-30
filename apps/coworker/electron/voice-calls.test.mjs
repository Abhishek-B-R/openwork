import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVoiceCalls, createCallHistory } from "./voice-calls.mjs";

test("call credentials stay main-only and failures never expose provider bodies", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coworker-calls-"));
  const key = "sk-synthetic-call-key-never-real"; let status = 200; const requests = [];
  const secure = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptStringAsync: async () => Buffer.from("sealed"), decryptStringAsync: async () => ({ result: key }) };
  const calls = createVoiceCalls({ directory, safeStorage: secure, requestKey: async () => key, fetch: async (url, input) => { requests.push({ url, input }); return new Response(JSON.stringify(status === 200 ? { value: "ek_synthetic", expires_at: 123 } : { error: { message: key } }), { status }); } });
  let permissions = 0;
  const requestPermission = async () => { permissions++; return { granted: true }; };
  try {
    const plaintext = createVoiceCalls({ directory, platform: "linux", safeStorage: { ...secure, getSelectedStorageBackend: () => "basic_text" }, requestKey: async () => assert.fail("Plaintext storage must not request a key") });
    await assert.rejects(plaintext.editKey(), /Secure storage is unavailable/);
    assert.equal((await calls.settings()).keySet, false);
    await assert.rejects(calls.microphone(requestPermission), /Add an OpenAI key/);
    assert.equal(permissions, 0);
    const settings = await calls.editKey(); assert.equal(settings.keySet, true); assert.equal(JSON.stringify(settings).includes(key), false);
    await assert.rejects(calls.microphone(requestPermission), /Enable Voice calls/);
    assert.equal(permissions, 0);
    await calls.enabled(true);
    assert.equal((await calls.microphone(requestPermission)).granted, true);
    assert.equal(permissions, 1);
    assert.equal((await readFile(path.join(directory, "voice-call-key.bin"))).includes(key), false);
    await calls.test();
    assert.equal(requests[0].url, "https://api.openai.com/v1/realtime/client_secrets");
    const config = JSON.parse(requests[0].input.body); assert.equal(config.session.model, "gpt-realtime-2.1"); assert.equal(config.session.audio.input.turn_detection.type, "semantic_vad");
    await calls.voice("cedar");
    await calls.clientSecret({ name: "Mira", role: "", mission: "", personality: "warm", realtimeVoice: "coral" });
    assert.equal(JSON.parse(requests.at(-1).input.body).session.audio.output.voice, "coral");
    await calls.clientSecret({ name: "Mira", role: "", mission: "", personality: "warm", realtimeVoice: "" });
    assert.equal(JSON.parse(requests.at(-1).input.body).session.audio.output.voice, "cedar");
    status = 401; await assert.rejects(calls.test(), (error) => error.message.includes("not accepted") && !error.message.includes(key));
    status = 429; await assert.rejects(calls.test(), /quota or rate limit/);
    assert.equal((await calls.remove()).keySet, false);
    await assert.rejects(calls.microphone(requestPermission), /Add an OpenAI key/);
    assert.equal(permissions, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("spoken transcripts survive reload, attach bounded replay audio and stay scoped", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coworker-voice-transcripts-"));
  const store = createCallHistory(async () => directory);
  const wav = Buffer.alloc(46); wav.write("RIFF"); wav.write("WAVE", 8);
  const entry = { kind: "transcript", id: "voice-one", callId: "call-one", speaker: "coworker", text: "Your answer is ready.", at: 10, final: true };
  try {
    await store.append("mira", "thread", entry);
    await store.append("mira", "thread", { ...entry, audioData: wav.toString("base64") });
    await store.append("mira", "thread", { ...entry, text: "Your", final: false });
    const history = await createCallHistory(async () => directory).read("mira", "thread");
    assert.equal(history.transcripts.length, 1); assert.equal(history.transcripts[0].text, entry.text); assert.equal(history.transcripts[0].audio, true);
    assert.equal((await store.audio("mira", "thread", entry.id)).data, wav.toString("base64"));
    await assert.rejects(store.audio("mira", "other-thread", entry.id), /no longer available/);
    await assert.rejects(store.append("mira", "thread", { ...entry, audioData: "not-an-audio-file" }), /Invalid audio/);
    await assert.rejects(store.append("mira", "thread", { ...entry, audioData: "A".repeat(4 * 1024 * 1024 + 1) }), /Invalid audio/);
    for (let i = 0; i < 50; i++) await store.append("mira", "thread", { ...entry, id: `clip-${i}`, at: 20 + i, audioData: wav.toString("base64") });
    const kept = await store.read("mira", "thread");
    assert.equal(kept.transcripts.filter((turn) => turn.audio).length, 50);
    assert.equal(kept.transcripts.find((turn) => turn.id === entry.id).text, entry.text);
    await assert.rejects(store.audio("mira", "thread", entry.id), /no longer available/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("call bookkeeping is durable and repeated delivery never duplicates a line", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coworker-call-history-"));
  const store = createCallHistory(async () => directory);
  try {
    const entry = { kind: "call", id: "call-one", name: "Mira", startedAt: 1000, endedAt: 2000 };
    await Promise.all([store.append("mira", "thread", entry), store.append("mira", "thread", entry)]);
    await store.append("mira", "thread", { kind: "spoken", id: "msg_one", text: "A request", at: 1200 });
    const history = await createCallHistory(async () => directory).read("mira", "thread");
    assert.equal(history.calls.length, 1); assert.equal(history.spoken.length, 1);
    assert.equal((await store.read("mira", "other-thread")).calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
