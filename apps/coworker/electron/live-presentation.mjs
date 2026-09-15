import path from "node:path";
import { nativeV2PartId } from "@openwork/headless-threads/v2";

const DEFAULT_LIMITS = Object.freeze({ workspaces: 16, parts: 64, bytes: 256 * 1024, partBytes: 64 * 1024, events: 4096, ttlMs: 15 * 60_000 });
const identity = (scope) => JSON.stringify([scope.generation, scope.serverUrl, scope.workspaceId, scope.slug, scope.createdAt, scope.directory]);
const partKey = (sessionId, messageId, kind, ordinal) => JSON.stringify([sessionId, messageId, kind, ordinal]);

export function createLivePresentationStore(scope, { limits: overrides, now = Date.now } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const parts = new Map();
  const seen = new Map();
  const retired = new Set();
  let revision = 0;
  let bytes = 0;
  const retire = (key) => {
    const part = parts.get(key);
    if (part) { bytes -= Buffer.byteLength(part.text); parts.delete(key); }
    for (const [id, target] of seen) if (target === key) seen.delete(id);
    retired.add(key);
    if (retired.size > limits.parts * 4) retired.delete(retired.values().next().value);
  };
  const expire = () => {
    for (const [key, part] of parts) if (now() - part.at > limits.ttlMs) retire(key);
  };
  const gap = () => {
    for (const part of parts.values()) if (!part.sealed) part.gap = true;
  };
  return {
    gap,
    clear() { parts.clear(); seen.clear(); retired.clear(); bytes = 0; revision++; },
    ingest(event, origin = scope) {
      if (identity(origin) !== identity(scope) || !event || typeof event.id !== "string" || event.id.length > 256) return;
      const match = /^session\.(text|reasoning)\.(started|delta|ended)$/.exec(event.type ?? "");
      const data = event.data;
      if (!match || !data || typeof data.sessionID !== "string" || typeof data.assistantMessageID !== "string"
        || data.sessionID.length > 256 || data.assistantMessageID.length > 256 || !Number.isSafeInteger(data.ordinal) || data.ordinal < 0) return;
      const directory = event.location?.directory;
      if (typeof directory !== "string" || ![scope.directory, scope.sourceDirectory].filter(Boolean).includes(path.resolve(directory))) return;
      const key = partKey(data.sessionID, data.assistantMessageID, match[1], data.ordinal);
      expire();
      if (seen.has(event.id) || retired.has(key)) return;
      if (seen.size >= limits.events) { gap(); seen.clear(); }
      seen.set(event.id, key);
      let part = parts.get(key);
      if (match[2] === "started") {
        if (part) return;
        part = { threadId: data.sessionID, messageId: data.assistantMessageID, ordinal: data.ordinal, kind: match[1], text: "", sealed: false, gap: false, at: now(), revision: ++revision };
        parts.set(key, part);
      } else {
        if (!part || part.sealed || (part.gap && match[2] === "delta")) return;
        const text = match[2] === "ended" ? data.text : typeof data.delta === "string" ? part.text + data.delta : undefined;
        if (typeof text !== "string") return;
        const size = Buffer.byteLength(text);
        if (size > limits.partBytes) { part.gap = true; return; }
        bytes += size - Buffer.byteLength(part.text);
        Object.assign(part, { text, sealed: match[2] === "ended", gap: false, at: now(), revision: ++revision });
      }
      while (parts.size > limits.parts || bytes > limits.bytes) retire(parts.keys().next().value);
      return true;
    },
    snapshot(canonical, origin = scope) {
      if (identity(origin) !== identity(scope) || typeof canonical.threadId !== "string" || typeof canonical.directory !== "string"
        || ![scope.directory, scope.sourceDirectory].filter(Boolean).includes(path.resolve(canonical.directory))) return { generation: scope.generation, revision, parts: [] };
      expire();
      const messages = new Map(canonical.messages.map((message) => [message.id, message]));
      const result = [];
      for (const [key, part] of parts) {
        if (part.threadId !== canonical.threadId) continue;
        const message = messages.get(part.messageId);
        const parent = message?.parentId ? messages.get(message.parentId) : null;
        if (message?.role !== "assistant" || parent?.role !== "user") continue;
        if (part.parentId && part.parentId !== parent.id) { retire(key); continue; }
        part.parentId = parent.id;
        const id = nativeV2PartId(part.messageId, part.ordinal, part.kind);
        const stored = message.parts.find((entry) => entry.id === id);
        if (message.completedAt != null || message.error != null || canonical.native?.turnOutcomes?.[parent.id]
          || stored?.synthetic || stored?.ignored) { retire(key); continue; }
        if (stored?.type === part.kind && typeof stored.text === "string" && stored.text.length >= part.text.length
          && stored.text.startsWith(part.text) && (part.sealed || stored.text.length > 0)) { retire(key); continue; }
        result.push({ messageId: part.messageId, parentId: parent.id, partId: id, type: part.kind, text: part.text, ended: part.sealed, revision: part.revision, gap: part.gap });
      }
      return { generation: scope.generation, revision, parts: result };
    },
  };
}

export function createLivePresentation({ createClient, isCurrent, onChange = () => {}, now = Date.now, limits: overrides } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const scopes = new Map();
  const remove = (workspaceId) => {
    const entry = scopes.get(workspaceId);
    if (!entry) return;
    scopes.delete(workspaceId);
    clearTimeout(entry.notifyTimer);
    entry.controller?.abort();
    entry.store.clear();
  };
  const ensure = async (entry, signal) => {
    if (!entry.task) {
      const controller = new AbortController();
      const ready = Promise.withResolvers();
      entry.ready = ready.promise;
      entry.controller = controller;
      const timer = setTimeout(() => { controller.abort(); ready.reject(new Error("Display stream unavailable")); }, 5000);
      timer.unref?.();
      let connections = 0;
      const task = Promise.resolve().then(async () => {
        try {
          const client = createClient(entry.scope, (response) => {
            if (connections++ > 0) entry.store.gap();
            if (!response.ok || !response.body) throw new Error("Display stream unavailable");
            clearTimeout(timer);
            ready.resolve();
          });
          for await (const event of client.events(controller.signal)) {
            if (controller.signal.aborted || scopes.get(entry.scope.workspaceId) !== entry || !isCurrent(entry.scope)) break;
            if (entry.store.ingest(event) && !entry.notifyTimer) {
              entry.notifyTimer = setTimeout(() => {
                entry.notifyTimer = null;
                try {
                  if (scopes.get(entry.scope.workspaceId) === entry && isCurrent(entry.scope)) onChange(entry.scope);
                } catch {}
              }, 250);
              entry.notifyTimer.unref?.();
            }
          }
        } catch { ready.reject(new Error("Display stream unavailable")); }
        finally {
          clearTimeout(timer);
          ready.resolve();
          entry.store.gap();
          if (entry.task === task) entry.task = null;
        }
      });
      entry.task = task;
    }
    const deadline = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
    let cancel;
    try {
      await Promise.race([entry.ready, new Promise((_, reject) => {
        cancel = () => reject(new Error("Display observation unavailable"));
        if (deadline.aborted) cancel(); else deadline.addEventListener("abort", cancel, { once: true });
      })]);
    } catch { if (!signal?.aborted) entry.controller?.abort(); entry.store.gap(); }
    finally { if (cancel) deadline.removeEventListener("abort", cancel); }
  };
  return {
    register(scope) {
      let entry = scopes.get(scope.workspaceId);
      if (entry && identity(entry.scope) === identity(scope)) return;
      remove(scope.workspaceId);
      while (scopes.size >= limits.workspaces) remove(scopes.keys().next().value);
      entry = { scope, store: createLivePresentationStore(scope, { limits, now }), task: null, controller: null };
      scopes.set(scope.workspaceId, entry);
    },
    async beforeInput(workspaceId, generation, directory, signal) {
      const entry = scopes.get(workspaceId);
      if (!entry || entry.scope.generation !== generation || ![entry.scope.directory, entry.scope.sourceDirectory].includes(path.resolve(directory)) || !isCurrent(entry.scope)) return;
      await ensure(entry, signal);
    },
    snapshot(scope, canonical) {
      const entry = scopes.get(scope.workspaceId);
      if (!entry || !isCurrent(entry.scope)) return { generation: scope.generation, revision: 0, parts: [] };
      return entry.store.snapshot(canonical, scope);
    },
    remove,
    stop(generation) { for (const [id, entry] of [...scopes]) if (generation === undefined || entry.scope.generation === generation) remove(id); },
  };
}
