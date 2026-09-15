import assert from "node:assert/strict";
import test from "node:test";
import { nativeV2PartId } from "@openwork/headless-threads/v2";
import { createLivePresentation, createLivePresentationStore } from "./live-presentation.mjs";
import { presentationStream, replyText } from "../src/lib/live-stream.ts";

const scope = { generation: "process-one", workspaceId: "ws_one", slug: "scout", createdAt: "original", directory: "/fixture/scout", serverUrl: "http://127.0.0.1:1" };
const event = (id, phase, value = "", kind = "text") => ({ id, type: `session.${kind}.${phase}`, location: { directory: scope.directory },
  data: { sessionID: "ses_one", assistantMessageID: "msg_assistant", ordinal: 0, ...(phase === "delta" ? { delta: value } : phase === "ended" ? { text: value } : {}) } });
const canonical = () => ({ threadId: "ses_one", directory: scope.directory, status: { type: "busy" }, native: { engine: "v2", pendingInputIds: ["msg_future"], turnOutcomes: {} },
  messages: [
    { id: "msg_current", role: "user", parts: [], completedAt: null, error: null },
    { id: "msg_assistant", role: "assistant", parentId: "msg_current", completedAt: null, error: null,
      parts: [{ id: nativeV2PartId("msg_assistant", 0, "text"), type: "text", text: "" }] },
  ] });

test("reload hydrates an absolute partial once and later chunks cannot double-append or invent completion", () => {
  const store = createLivePresentationStore(scope);
  const snapshot = canonical();
  const unchanged = structuredClone(snapshot);
  store.ingest(event("evt_start", "started"));
  store.ingest(event("evt_first", "delta", "First chunk"));
  const first = store.snapshot(snapshot);
  assert.equal(replyText(presentationStream(snapshot, first, "msg_current"), null), "First chunk");
  assert.equal(replyText(presentationStream(snapshot, first, "msg_current"), null), "First chunk");
  store.ingest(event("evt_first", "delta", "First chunk"));
  store.ingest(event("evt_second", "delta", " and next"));
  assert.equal(replyText(presentationStream(snapshot, store.snapshot(snapshot), "msg_current"), null), "First chunk and next");
  assert.equal(presentationStream(snapshot, store.snapshot(snapshot), "msg_future"), null);
  store.ingest(event("evt_reasoning_start", "started", "", "reasoning"));
  store.ingest(event("evt_reasoning", "delta", "Separate transient reasoning", "reasoning"));
  assert.equal(store.snapshot(snapshot).parts.length, 2);
  assert.equal(replyText(presentationStream(snapshot, store.snapshot(snapshot), "msg_current"), null), "First chunk and next");
  store.ingest(event("evt_end", "ended", "Authoritative full value"));
  assert.equal(replyText(presentationStream(snapshot, store.snapshot(snapshot), "msg_current"), null), "Authoritative full value");
  store.ingest(event("evt_late", "delta", "must not append"));
  assert.equal(store.snapshot(snapshot).parts.find((part) => part.type === "text").text, "Authoritative full value");
  assert.deepEqual(snapshot, unchanged);
  snapshot.messages[1].parts[0].text = "Authoritative full value";
  assert.equal(store.snapshot(snapshot).parts.some((part) => part.type === "text"), false);
  snapshot.native.turnOutcomes.msg_current = "interrupted";
  assert.deepEqual(store.snapshot(snapshot).parts, []);
  assert.equal(snapshot.messages[1].completedAt, null);
});

test("presentation joins only canonical parents and isolates same IDs across workspace, coworker and process", () => {
  const store = createLivePresentationStore(scope);
  store.ingest(event("evt_foreign", "started"), { ...scope, workspaceId: "ws_foreign" });
  store.ingest({ ...event("evt_location", "started"), location: { directory: "/foreign" } });
  store.ingest(event("evt_start", "started"));
  store.ingest(event("evt_delta", "delta", "Owned"));
  const snapshot = canonical();
  snapshot.messages[1].parentId = "msg_future";
  assert.deepEqual(store.snapshot(snapshot).parts, []);
  snapshot.messages[1].parentId = "msg_current";
  assert.equal(store.snapshot(snapshot).parts[0].parentId, "msg_current");
  assert.deepEqual(store.snapshot(snapshot, { ...scope, generation: "process-two" }).parts, []);
  assert.deepEqual(store.snapshot(snapshot, { ...scope, createdAt: "replacement" }).parts, []);
  assert.deepEqual(store.snapshot({ ...snapshot, directory: "/foreign" }).parts, []);
  snapshot.messages.push({ id: "msg_future", role: "user", parts: [], completedAt: null, error: null });
  snapshot.messages[1].parentId = "msg_future";
  assert.deepEqual(store.snapshot(snapshot).parts, []);
});

test("display gaps retain only the known prefix, full native values repair gaps, and limits evict without completion", () => {
  let now = 0;
  const store = createLivePresentationStore(scope, { now: () => now, limits: { parts: 2, partBytes: 12, bytes: 16, events: 8, ttlMs: 100 } });
  store.ingest(event("evt_start", "started"));
  store.ingest(event("evt_first", "delta", "Known"));
  store.gap();
  store.ingest(event("evt_missed", "delta", " suffix"));
  assert.equal(store.snapshot(canonical()).parts[0].text, "Known");
  assert.equal(store.snapshot(canonical()).parts[0].gap, true);
  store.ingest(event("evt_end", "ended", "Full repair"));
  assert.equal(store.snapshot(canonical()).parts[0].text, "Full repair");
  now = 101;
  assert.deepEqual(store.snapshot(canonical()).parts, []);
  store.clear();
  store.ingest(event("evt_next_start", "started"));
  store.ingest(event("evt_large", "delta", "This exceeds the display budget"));
  assert.equal(store.snapshot(canonical()).parts[0].text, "");
  assert.equal(store.snapshot(canonical()).parts[0].ended, false);
});

test("one host observer attaches before concurrent inputs and survives renderer snapshot replacement", { timeout: 5000 }, async () => {
  const connected = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const firstRead = Promise.withResolvers();
  const more = Promise.withResolvers();
  const nextRead = Promise.withResolvers();
  let connections = 0, providerRequests = 0, stopped = false;
  const host = createLivePresentation({ isCurrent: (candidate) => candidate.generation === scope.generation,
    createClient: (_scope, ready) => ({ events: async function* (signal) {
      connections++; entered.resolve(); await connected.promise;
      ready(new Response(new ReadableStream()));
      yield event("evt_start", "started");
      yield event("evt_first", "delta", "First chunk");
      firstRead.resolve();
      await more.promise;
      yield event("evt_second", "delta", " next");
      nextRead.resolve();
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", resolve, { once: true }); });
      stopped = true;
    } }),
  });
  host.register(scope);
  const first = host.beforeInput(scope.workspaceId, scope.generation, scope.directory).then(() => { providerRequests++; });
  const second = host.beforeInput(scope.workspaceId, scope.generation, scope.directory).then(() => { providerRequests++; });
  await entered.promise;
  assert.equal(providerRequests, 0);
  connected.resolve();
  await Promise.all([first, second]);
  await firstRead.promise;
  assert.equal(connections, 1);
  const hydrated = host.snapshot(scope, canonical());
  assert.equal(replyText(presentationStream(canonical(), hydrated, "msg_current"), null), "First chunk");
  assert.equal(replyText(presentationStream(canonical(), host.snapshot(scope, canonical()), "msg_current"), null), "First chunk");
  more.resolve();
  await nextRead.promise;
  assert.equal(replyText(presentationStream(canonical(), host.snapshot(scope, canonical()), "msg_current"), null), "First chunk next");
  assert.equal(providerRequests, 2);
  host.stop(scope.generation);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.deepEqual(host.snapshot(scope, canonical()).parts, []);
});
