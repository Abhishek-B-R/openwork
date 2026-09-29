import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { gatewayGovernanceErrorSchema } from "@openwork/types/den/gateway-governance";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const entrySchema = z.object({
  messageID: id, created: z.number(), text: z.string(), fingerprint: z.string(), title: z.string(), correlation: z.enum(["message", "session"]).optional(),
  files: z.array(z.object({ filename: z.string(), mime: z.string(), url: z.string() })),
  state: z.enum(["checking", "allowed", "cleanup_pending", "excluded", "paused", "unsupported", "withdrawn"]),
  requests: z.record(z.string(), z.enum(["pending", "rejected", "exposed", "transport_failed", "not_dispatched"])),
  requestRoles: z.record(z.string(), z.enum(["primary", "title", "compaction"])).default({}),
  auxiliaryError: gatewayGovernanceErrorSchema.nullable().default(null),
  decisionCorrelated: z.boolean().default(false),
  unsafe: z.boolean(), error: gatewayGovernanceErrorSchema.nullable(),
  deleteAttempted: z.array(id), placeholderIDs: z.array(id), requiresTitleProof: z.boolean(), titleRequestIDs: z.array(id),
  autoStopped: z.boolean().default(false),
  revertCommitAttempted: z.boolean().default(false),
});
const journalSchema = z.object({ entries: z.array(entrySchema), sessionID: id, scope: z.string().optional() });
export type GovernanceEntry = z.infer<typeof entrySchema>;
export type GovernanceJournal = z.infer<typeof journalSchema>;
export type GovernanceNativeSnapshot = {
  idle: boolean; reverted: boolean; title: string;
  messages: { id: string; sessionID: string; role: string; parentID?: string; created: number; summary?: boolean;
    error?: unknown; parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean; filename?: string; mime?: string; url?: string }[] }[];
};
export type GovernanceNative = {
  snapshot: () => Promise<GovernanceNativeSnapshot>;
  deleteMessage: (messageID: string) => Promise<void>;
};
/** Projected native v2 message: only what the history-only revert guard needs. */
export type GovernanceV2Message = {
  id: string; type: string; digest: string; text: string;
  files: { filename: string; mime: string }[]; contentCount: number; changedFiles: number;
};
export type GovernanceNativeV2Snapshot = {
  idle: boolean; revert: string | null; title: string; inboxEmpty: boolean; messages: GovernanceV2Message[];
  /** False when older history exists beyond the page that was read. */
  historyComplete: boolean;
};
export type GovernanceNativeV2 = {
  snapshot: () => Promise<GovernanceNativeV2Snapshot>;
  /** Must stage `{ messageID, files: false }`; never the file-restoring revert. */
  stageRevert: (messageID: string) => Promise<void>;
  commitRevert: () => Promise<void>;
};
type AnyNative = GovernanceNative | GovernanceNativeV2;
export const governanceReportSchema = z.object({
  directory: z.string().min(1), sessionID: id, messageID: id, requestID: id,
  phase: z.enum(["begin", "finish"]), agent: z.string().max(128),
  error: gatewayGovernanceErrorSchema.optional(), correlated: z.boolean().optional(),
  outcome: z.enum(["response", "transport_failed"]).optional(),
}).strict();
export type GovernanceReport = z.infer<typeof governanceReportSchema>;
export const governanceV2ReportSchema = governanceReportSchema.omit({ messageID: true }).extend({
  agent: z.string().max(128).optional(), phase: z.enum(["check", "begin", "finish", "reject"]),
});
export type GovernanceV2Report = z.infer<typeof governanceV2ReportSchema>;
export type GovernanceReportResult = { recorded: true; blocked?: NonNullable<GovernanceEntry["error"]>; contribution?: string };
export const governanceCleanupRequestSchema = z.union([
  z.object({}).strict(),
  z.object({ intent: z.literal("retry"), messageID: id }).strict(),
]);
export type GovernanceCleanupRequest = z.infer<typeof governanceCleanupRequestSchema>;
export class GovernanceAdmissionError extends Error {
  constructor() { super("Organization policy recovery is required"); }
}
export class GovernanceCleanupRequestError extends Error {
  constructor() { super("This message can’t be retried in place"); }
}
export type GovernanceAutoCleanup = { wait: (ms: number) => Promise<void>; now: () => number; deadlineMs: number };

type Kind = "policy" | "retry";
type Mode = "auto" | "manual";
const RETRYABLE_CODES = new Set(["openwork_gateway_governance_unavailable", "openwork_gateway_governance_policy_changed",
  "openwork_gateway_governance_uncertain", "openwork_gateway_governance_unsupported_input"]);

function requestRole(agent: string | undefined): "primary" | "title" | "compaction" {
  return agent === "title" ? "title" : agent === "compaction" ? "compaction" : "primary";
}
function policyBlock(error: GovernanceEntry["error"]) {
  return error?.error.code === "openwork_gateway_governance_blocked" && error.error.evaluation_complete && error.error.violations.length > 0;
}
function retryable(error: GovernanceEntry["error"]) {
  return Boolean(error && !policyBlock(error) && RETRYABLE_CODES.has(error.error.code));
}
function kindMatches(entry: GovernanceEntry, kind: Kind) {
  return kind === "policy" ? policyBlock(entry.error) : retryable(entry.error);
}
function errorRank(error: GovernanceEntry["error"], correlated: boolean) {
  return policyBlock(error) ? correlated ? 3 : 2 : error ? 1 : 0;
}
function applyDecision(entry: GovernanceEntry, error: NonNullable<GovernanceEntry["error"]>, role: string, correlated: boolean) {
  if (role === "title" && !policyBlock(error)) { entry.auxiliaryError = error; return; }
  if (errorRank(error, correlated) > errorRank(entry.error, entry.decisionCorrelated)) {
    entry.error = error;
    entry.decisionCorrelated = correlated;
  }
}
function updateState(entry: GovernanceEntry) {
  if (entry.state === "excluded" || entry.state === "unsupported" || entry.state === "withdrawn") return;
  entry.state = entry.error ? policyBlock(entry.error) ? "cleanup_pending" : "paused"
    : Object.values(entry.requests).includes("pending") ? "checking" : "allowed";
  if (entry.state === "allowed") { entry.text = ""; entry.files = []; }
}
function holdsAdmission(entry: GovernanceEntry) {
  return !["checking", "allowed", "excluded", "withdrawn"].includes(entry.state);
}
function retired(entry: GovernanceEntry) {
  return entry.state === "excluded" || entry.state === "unsupported" || entry.state === "withdrawn";
}
function pending(entry: GovernanceEntry) {
  return Object.values(entry.requests).includes("pending");
}
function settledWithoutDisclosure(entry: GovernanceEntry) {
  return Object.values(entry.requests).every((state) => state === "rejected" || state === "not_dispatched");
}
function autoEligible(entry: GovernanceEntry) {
  return entry.state === "cleanup_pending" && entry.decisionCorrelated && entry.correlation !== "session"
    && entry.deleteAttempted.length === 0 && !entry.autoStopped && policyBlock(entry.error);
}
function isV2(native: AnyNative): native is GovernanceNativeV2 {
  return "stageRevert" in native;
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function finish(entry: GovernanceEntry, kind: Kind) {
  entry.state = kind === "policy" ? "excluded" : "withdrawn";
  if (kind === "retry") { entry.text = ""; entry.files = []; }
}

export function safeGovernanceTail(snapshot: GovernanceNativeSnapshot, entry: GovernanceEntry, kind: Kind = "policy"): string[] | null {
  if (!snapshot.idle || snapshot.reverted || snapshot.title !== entry.title || entry.unsafe || !entry.decisionCorrelated || !kindMatches(entry, kind)
    || entry.requiresTitleProof && entry.titleRequestIDs.length === 0 || !settledWithoutDisclosure(entry)) return null;
  const index = snapshot.messages.findIndex((message) => message.id === entry.messageID);
  if (index < 0) return [];
  const user = snapshot.messages[index];
  if (digest(user) !== entry.fingerprint || user.role !== "user" || user.parts.some((part) => !["text", "file"].includes(part.type))) return null;
  const tail = snapshot.messages.slice(index + 1);
  if (tail.some((message) => message.role !== "assistant" || message.parentID !== entry.messageID || message.summary
    || message.parts.some((part) => part.type !== "step-start"))) return null;
  return tail.map((message) => message.id);
}

/** Native v2 revert removes the boundary and everything after it, so the
 * rejected user message must be the isolated newest tail: nothing after it but
 * empty assistant placeholders, no file changes, no staged revert, no queue. */
export function safeGovernanceV2Tail(snapshot: GovernanceNativeV2Snapshot, entry: GovernanceEntry, kind: Kind = "policy"): string[] | null {
  if (!snapshot.idle || snapshot.revert !== null || !snapshot.inboxEmpty || snapshot.title !== entry.title || entry.unsafe
    || entry.correlation === "session" || !entry.decisionCorrelated || !kindMatches(entry, kind)
    || entry.requiresTitleProof && entry.titleRequestIDs.length === 0 || !settledWithoutDisclosure(entry)) return null;
  const index = snapshot.messages.findIndex((message) => message.id === entry.messageID);
  if (index < 0) return null;
  const user = snapshot.messages[index];
  if (user.type !== "user" || user.digest !== entry.fingerprint) return null;
  const tail = snapshot.messages.slice(index + 1);
  if (tail.some((message) => message.type !== "assistant" || message.contentCount > 0 || message.changedFiles > 0)) return null;
  return tail.map((message) => message.id);
}

/** The exact contribution a v2 model request carries, or null when it can't be
 * established: only a prompt this host submitted, only while it is the newest
 * user message with nothing after it but empty assistant placeholders. */
export function resolveGovernanceV2Contribution(snapshot: GovernanceNativeV2Snapshot, kind: string | undefined, submitted: readonly string[]): GovernanceV2Message | null {
  if (snapshot.revert !== null || (kind !== "primary" && kind !== "title")) return null;
  const users = snapshot.messages.filter((message) => message.type === "user");
  const latest = users.at(-1);
  if (!latest || !submitted.includes(latest.id) || kind === "title" && (users.length !== 1 || !snapshot.historyComplete)) return null;
  const index = snapshot.messages.lastIndexOf(latest);
  if (snapshot.messages.slice(index + 1).some((message) => message.type !== "assistant" || message.contentCount > 0 || message.changedFiles > 0)) return null;
  return latest;
}

export function createGovernanceRecovery(deps: {
  load: (scope: string) => Promise<GovernanceJournal | null>;
  save: (scope: string, journal: GovernanceJournal) => Promise<void>;
  remove: (scope: string) => Promise<void>;
  list?: () => Promise<GovernanceJournal[]>;
  autoCleanup?: GovernanceAutoCleanup;
}) {
  let tail = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const operation = tail.catch(() => {}).then(run);
    tail = operation.then(() => {}, () => {});
    return operation;
  };
  const journals = new Map<string, GovernanceJournal>();
  const submittedV2 = new Map<string, string[]>();
  const submittingV2 = new Map<string, Set<Promise<void>>>();
  const running = new Map<string, Promise<void>>();
  const read = async (scope: string, sessionID: string) => {
    const cached = journals.get(scope);
    const journal = cached ?? await deps.load(scope) ?? { sessionID, entries: [], scope };
    if (journal.sessionID !== sessionID) throw new Error("Conversation identity mismatch");
    journal.scope = scope;
    if (!cached && journal.entries.some((entry) => entry.state === "checking")) {
      for (const entry of journal.entries) if (entry.state === "checking") entry.state = "paused";
      await deps.save(scope, journal);
    }
    journals.set(scope, journal);
    return journal;
  };
  const held = (journal: GovernanceJournal) => journal.entries.some(holdsAdmission);

  const removeV1 = async (entry: GovernanceEntry, native: GovernanceNative, kind: Kind, mode: Mode, save: () => Promise<void>): Promise<boolean> => {
    let snapshot = await native.snapshot();
    if (!snapshot.idle || pending(entry)) return mode === "auto";
    if (entry.deleteAttempted.length === 0) {
      // A first contribution's title request may not have started yet.
      if (mode === "auto" && entry.requiresTitleProof && entry.titleRequestIDs.length === 0) return true;
      const placeholders = safeGovernanceTail(snapshot, entry, kind);
      if (placeholders === null || !snapshot.messages.some((message) => message.id === entry.messageID)) {
        entry.state = "unsupported"; await save(); return false;
      }
      entry.placeholderIDs = placeholders;
      await save();
    }
    for (const messageID of [...entry.placeholderIDs, entry.messageID]) {
      snapshot = await native.snapshot();
      if (!snapshot.idle || snapshot.reverted) break;
      if (!snapshot.messages.some((message) => message.id === messageID)) continue;
      const safe = safeGovernanceTail(snapshot, entry, kind);
      if (safe === null || safe.some((id) => !entry.placeholderIDs.includes(id))) {
        entry.state = "unsupported"; break;
      }
      if (entry.deleteAttempted.includes(messageID)) break;
      entry.deleteAttempted.push(messageID);
      await save();
      try { await native.deleteMessage(messageID); } catch { }
      const observed = await native.snapshot();
      if (observed.messages.some((message) => message.id === messageID)) break;
    }
    snapshot = await native.snapshot();
    if (entry.state !== "unsupported" && snapshot.idle && !snapshot.reverted && snapshot.title === entry.title
      && !snapshot.messages.some((message) => [...entry.placeholderIDs, entry.messageID].includes(message.id) || message.parentID === entry.messageID)) finish(entry, kind);
    await save();
    return false;
  };

  const removeV2 = async (entry: GovernanceEntry, native: GovernanceNativeV2, kind: Kind, mode: Mode, save: () => Promise<void>): Promise<boolean> => {
    let snapshot = await native.snapshot();
    if (!snapshot.idle) return mode === "auto";
    if (entry.deleteAttempted.length === 0) {
      // v2 has no transport-failure hook: an unanswered request may have been
      // disclosed. Wait while automatic, then fall back.
      if (pending(entry) || entry.requiresTitleProof && entry.titleRequestIDs.length === 0 || !snapshot.inboxEmpty) {
        if (mode === "auto") return true;
      }
      const placeholders = safeGovernanceV2Tail(snapshot, entry, kind);
      if (placeholders === null) { entry.state = "unsupported"; await save(); return false; }
      entry.placeholderIDs = placeholders;
      entry.deleteAttempted.push(entry.messageID);
      await save();
      try { await native.stageRevert(entry.messageID); } catch { }
      snapshot = await native.snapshot();
    }
    const index = snapshot.messages.findIndex((message) => message.id === entry.messageID);
    const unexpected = index >= 0 && snapshot.messages.slice(index + 1).some((message) => !entry.placeholderIDs.includes(message.id));
    if (snapshot.revert === entry.messageID && !entry.revertCommitAttempted && snapshot.idle && snapshot.inboxEmpty
      && entry.deleteAttempted.includes(entry.messageID) && !unexpected) {
      entry.revertCommitAttempted = true;
      await save();
      try { await native.commitRevert(); } catch { }
      snapshot = await native.snapshot();
    }
    if (snapshot.idle && snapshot.revert === null && snapshot.title === entry.title
      && !snapshot.messages.some((message) => [...entry.placeholderIDs, entry.messageID].includes(message.id))) finish(entry, kind);
    await save();
    return false;
  };

  const runCleanup = (scope: string, sessionID: string, native: AnyNative, engine: "v1" | "v2", mode: Mode, target?: string) => serial(async () => {
    const journal = await read(scope, sessionID);
    const save = () => deps.save(scope, journal);
    let waiting = false;
    const candidates = target
      ? journal.entries.filter((item) => item.messageID === target)
      : journal.entries.filter((item) => item.state === "cleanup_pending" && (mode === "manual" || autoEligible(item)));
    if (target) {
      const entry = candidates[0];
      if (!entry || entry.state !== "paused" || entry.correlation === "session" || !retryable(entry.error)) throw new GovernanceCleanupRequestError();
    }
    const kind: Kind = target ? "retry" : "policy";
    for (const entry of candidates) {
      if (engine === "v2" && (!isV2(native) || entry.correlation === "session")) {
        entry.state = "unsupported";
        await save();
        continue;
      }
      if (engine === "v1" && isV2(native)) throw new Error("Engine mismatch");
      waiting = (isV2(native) ? await removeV2(entry, native, kind, mode, save) : await removeV1(entry, native, kind, mode, save)) || waiting;
    }
    return waiting;
  });

  const schedule = (scope: string, sessionID: string, native: AnyNative, engine: "v1" | "v2") => {
    const auto = deps.autoCleanup;
    if (!auto || running.has(scope)) return;
    const task = (async () => {
      const started = auto.now();
      let delay = 250;
      let observed = false;
      try {
        while (true) {
          await auto.wait(delay);
          let waiting: boolean;
          try {
            waiting = await runCleanup(scope, sessionID, native, engine, "auto");
            observed = true;
          } catch { waiting = true; }
          if (!waiting) return;
          if (auto.now() - started >= auto.deadlineMs) {
            // Only a conversation that stayed busy or unprovable stops being
            // automatic; an engine that never answered is retried on resume.
            if (observed) await serial(async () => {
              const journal = await read(scope, sessionID);
              for (const entry of journal.entries) if (autoEligible(entry)) entry.autoStopped = true;
              await deps.save(scope, journal);
            });
            return;
          }
          delay = Math.min(delay * 2, 4_000);
        }
      } finally { running.delete(scope); }
    })();
    running.set(scope, task);
  };
  const scheduleIfEligible = (journal: GovernanceJournal, scope: string, native: AnyNative, engine: "v1" | "v2") => {
    if (journal.entries.some(autoEligible)) schedule(scope, journal.sessionID, native, engine);
  };

  const reportV2Serial = (scope: string, report: GovernanceV2Report, native?: GovernanceNativeV2) => serial(async (): Promise<GovernanceReportResult> => {
    const journal = await read(scope, report.sessionID);
    const role = requestRole(report.agent);
    if (report.phase === "check") {
      const submitted = submittedV2.get(scope) ?? [];
      const snapshot = native && submitted.length && (report.agent === "primary" || report.agent === "title") ? await native.snapshot() : null;
      const contribution = snapshot ? resolveGovernanceV2Contribution(snapshot, report.agent, submitted) : null;
      let entry = contribution ? journal.entries.find((item) => item.messageID === contribution.id) : undefined;
      if (journal.entries.some((item) => item !== entry && holdsAdmission(item)) || entry && retired(entry)) throw new GovernanceAdmissionError();
      if (!contribution || !snapshot) {
        // A native v2 request without an exact identity can carry an open
        // contribution as context, so that contribution is no longer removable.
        let changed = false;
        if (native) for (const item of journal.entries) if (item.correlation !== "session" && !retired(item) && item.state !== "allowed" && !item.unsafe) { item.unsafe = true; changed = true; }
        if (changed) await deps.save(scope, journal);
        return { recorded: true };
      }
      if (entry?.error) {
        entry.requests[report.requestID] = "not_dispatched";
        entry.requestRoles[report.requestID] = role;
        if (role === "title") entry.titleRequestIDs.push(report.requestID);
        await deps.save(scope, journal);
        return { recorded: true, blocked: entry.error };
      }
      if (!entry) {
        const users = snapshot.messages.filter((message) => message.type === "user").length;
        entry = { messageID: contribution.id, created: Date.now(), title: snapshot.title, fingerprint: contribution.digest, text: contribution.text,
          files: contribution.files.map((file) => ({ ...file, url: "" })), correlation: "message",
          state: "checking", requests: {}, requestRoles: {}, auxiliaryError: null, decisionCorrelated: false,
          unsafe: false, error: null, deleteAttempted: [], placeholderIDs: [], requiresTitleProof: users === 1, titleRequestIDs: [],
          autoStopped: false, revertCommitAttempted: false };
        journal.entries.push(entry);
      }
      if (entry.requests[report.requestID]) throw new Error("Duplicate governance request");
      entry.requests[report.requestID] = "pending";
      entry.requestRoles[report.requestID] = role;
      if (role === "title") entry.titleRequestIDs.push(report.requestID);
      updateState(entry);
      await deps.save(scope, journal);
      return { recorded: true, contribution: contribution.id };
    }
    const messageID = `local_${report.requestID}`;
    let entry = journal.entries.find((item) => report.phase === "reject" ? item.correlation === "session" && item.error
      : report.phase === "finish" ? item.requests[report.requestID] === "pending" : item.messageID === messageID);
    if (report.phase === "reject" && !report.error) throw new Error("A trusted rejection is required");
    if (report.phase === "begin" || report.phase === "reject") {
      if (report.phase === "begin" && held(journal)) throw new GovernanceAdmissionError();
      if (entry && report.phase === "begin") throw new Error("Duplicate governance request");
      if (!entry) {
        entry = { messageID, created: Date.now(), text: "Conversation paused", files: [], fingerprint: "", title: "", correlation: "session",
          state: "checking", requests: {}, requestRoles: {}, auxiliaryError: null, decisionCorrelated: false,
          unsafe: true, error: null, deleteAttempted: [], placeholderIDs: [], requiresTitleProof: false, titleRequestIDs: [],
          autoStopped: false, revertCommitAttempted: false };
        journal.entries.push(entry);
      }
      entry.requests[report.requestID] = report.error ? "rejected" : "pending";
      entry.requestRoles[report.requestID] = role;
    } else {
      if (!entry || entry.requests[report.requestID] !== "pending") throw new Error("Unknown governance request");
      if (entry.correlation !== "session" && entry.requestRoles[report.requestID] !== role) throw new Error("Unknown governance request");
      entry.requests[report.requestID] = report.error ? "rejected" : report.outcome === "transport_failed" ? "transport_failed" : "exposed";
      if (report.outcome === "transport_failed") entry.unsafe = true;
    }
    const correlated = entry.correlation !== "session" && report.correlated === true && report.error?.error.contribution_id === entry.messageID;
    if (report.error) applyDecision(entry, report.error, role, correlated);
    updateState(entry);
    if (entry.correlation === "session") {
      if (entry.error && policyBlock(entry.error)) entry.state = "unsupported";
      if (entry.state === "allowed") journal.entries = journal.entries.filter((item) => item !== entry);
    }
    await deps.save(scope, journal);
    if (native) scheduleIfEligible(journal, scope, native, "v2");
    return { recorded: true };
  });

  return {
    view: (scope: string, sessionID: string) => serial(async () => {
      const journal = await read(scope, sessionID);
      const automatic = running.has(scope);
      return { held: held(journal), recoveryHeld: held(journal) || journal.entries.some(pending),
        entries: journal.entries.filter((entry) => holdsAdmission(entry) || entry.state === "excluded")
          .map((entry) => ({ ...entry, autoCleanup: automatic && autoEligible(entry) })) };
    }),
    assertAdmission: (scope: string, sessionID: string, messageID?: string) => serial(async () => {
      const journal = await read(scope, sessionID);
      if (held(journal) || journal.entries.some((entry) => entry.messageID === messageID && (entry.state === "excluded" || entry.state === "withdrawn"))) {
        throw new Error("Organization policy recovery is required. Review the blocked message or start a new conversation.");
      }
    }),
    report: (scope: string, report: GovernanceReport, native: GovernanceNative) => serial(async (): Promise<GovernanceReportResult> => {
      const journal = await read(scope, report.sessionID);
      let entry = journal.entries.find((item) => item.messageID === report.messageID);
      const role = requestRole(report.agent);
      if (report.phase === "begin") {
        if (journal.entries.some((item) => item !== entry && holdsAdmission(item)) || entry && retired(entry)) throw new GovernanceAdmissionError();
        if (entry?.error) {
          entry.requests[report.requestID] = "not_dispatched";
          entry.requestRoles[report.requestID] = role;
          if (role === "title") entry.titleRequestIDs.push(report.requestID);
          await deps.save(scope, journal);
          return { recorded: true, blocked: entry.error };
        }
        if (entry && holdsAdmission(entry)) throw new GovernanceAdmissionError();
        const snapshot = await native.snapshot();
        const user = snapshot.messages.find((message) => message.id === report.messageID && message.sessionID === report.sessionID && message.role === "user");
        if (!user) throw new Error("The exact user contribution could not be verified");
        if (!entry) {
          entry = { messageID: user.id, created: user.created, title: snapshot.title, fingerprint: digest(user), text: "", files: [],
            state: "checking", requests: {}, requestRoles: {}, auxiliaryError: null, decisionCorrelated: false,
            unsafe: snapshot.reverted || role === "compaction"
              || (snapshot.messages.filter((message) => message.role === "user").length === 1 && !snapshot.title.startsWith("New session - "))
              || user.parts.every((part) => part.synthetic) || user.parts.some((part) => !["text", "file"].includes(part.type)),
            error: null, deleteAttempted: [], placeholderIDs: [], requiresTitleProof: snapshot.messages.filter((message) => message.role === "user").length === 1, titleRequestIDs: [],
            autoStopped: false, revertCommitAttempted: false };
          journal.entries.push(entry);
        }
        entry.text = user.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored).map((part) => part.text ?? "").join("\n");
        entry.files = user.parts.flatMap((part) => part.type === "file" && part.url && part.mime
          ? [{ filename: part.filename ?? "Attachment", mime: part.mime, url: part.url.startsWith("file:") ? part.url : "" }] : []);
        if (entry.requests[report.requestID]) throw new Error("Duplicate governance request");
        entry.requests[report.requestID] = "pending";
        entry.requestRoles[report.requestID] = role;
        if (role === "title") entry.titleRequestIDs.push(report.requestID);
        entry.unsafe ||= role === "compaction";
        updateState(entry);
        await deps.save(scope, journal);
        return { recorded: true };
      }
      if (!entry || entry.requests[report.requestID] !== "pending" || entry.requestRoles[report.requestID] !== role) throw new Error("Unknown governance request");
      entry.requests[report.requestID] = report.error ? "rejected" : report.outcome === "transport_failed" ? "transport_failed" : "exposed";
      if (report.error) applyDecision(entry, report.error, role, report.correlated === true && report.error.error.contribution_id === entry.messageID);
      if (report.outcome === "transport_failed") entry.unsafe = true;
      updateState(entry);
      await deps.save(scope, journal);
      scheduleIfEligible(journal, scope, native, "v1");
      return { recorded: true };
    }),
    /** Records a prompt the host itself submitted to native v2; only these can
     * later be named as the exact contribution of a model request. */
    noteV2Prompt: (scope: string, messageID: string) => {
      if (!id.safeParse(messageID).success) return;
      const list = (submittedV2.get(scope) ?? []).filter((item) => item !== messageID);
      list.push(messageID);
      submittedV2.set(scope, list.slice(-32));
    },
    /** Marks a prompt submission in flight; a model request that starts before
     * its admitted identity is known waits (bounded) instead of losing it. */
    trackV2Prompt: (scope: string) => {
      let release = () => {};
      const settled = new Promise<void>((resolve) => { release = resolve; });
      const inflight = submittingV2.get(scope) ?? new Set<Promise<void>>();
      inflight.add(settled);
      submittingV2.set(scope, inflight);
      return () => {
        release();
        inflight.delete(settled);
        if (!inflight.size) submittingV2.delete(scope);
      };
    },
    reportV2: async (scope: string, report: GovernanceV2Report, native?: GovernanceNativeV2) => {
      const inflight = report.phase === "check" ? [...submittingV2.get(scope) ?? []] : [];
      if (inflight.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled(inflight), new Promise((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref?.(); })]);
        clearTimeout(timer);
      }
      return reportV2Serial(scope, report, native);
    },
    cleanup: async (scope: string, sessionID: string, native: AnyNative, engine: "v1" | "v2", request: GovernanceCleanupRequest = {}) => {
      await runCleanup(scope, sessionID, native, engine, "manual", "intent" in request ? request.messageID : undefined);
    },
    /** Resumes automatic removal for a conversation left mid-recovery. */
    resumeAutomatic: (scope: string, sessionID: string, native: () => AnyNative | null, engine: "v1" | "v2") => serial(async () => {
      if (!deps.autoCleanup || running.has(scope)) return;
      const journal = await read(scope, sessionID);
      if (!journal.entries.some(autoEligible)) return;
      const resolved = native();
      if (resolved) schedule(scope, sessionID, resolved, engine);
    }),
    resumeAll: async (resolve: (scope: string, sessionID: string) => Promise<{ native: AnyNative; engine: "v1" | "v2" } | null>) => {
      if (!deps.autoCleanup || !deps.list) return;
      for (const journal of await deps.list().catch(() => [])) {
        if (!journal.scope || !journal.entries.some(autoEligible) || running.has(journal.scope)) continue;
        const resolved = await resolve(journal.scope, journal.sessionID).catch(() => null);
        if (resolved) schedule(journal.scope, journal.sessionID, resolved.native, resolved.engine);
      }
    },
    /** Test and shutdown seam: resolves once automatic removal settles. */
    settled: (scope: string) => running.get(scope) ?? Promise.resolve(),
    clear: (scope: string) => serial(async () => { await deps.remove(scope); journals.delete(scope); submittedV2.delete(scope); }),
  };
}

const hosts = new WeakMap<ServerConfig, ReturnType<typeof createGovernanceHost>>();
function createGovernanceHost(config: ServerConfig) {
  const token = randomBytes(32).toString("base64url");
  const directory = join(runtimeStorageDir(config), "gateway-governance");
  const file = (scope: string) => join(directory, `${createHash("sha256").update(scope).digest("hex")}.json`);
  const recovery = createGovernanceRecovery({
    load: async (scope) => {
      try { return journalSchema.parse(JSON.parse(await readFile(file(scope), "utf8"))); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw new Error("Local policy recovery data could not be verified"); }
    },
    save: async (scope, journal) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const path = file(scope);
      const pending = `${path}.pending`;
      const handle = await open(pending, "w", 0o600);
      try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
      await rename(pending, path);
      if (process.platform !== "win32") {
        const parent = await open(directory, "r");
        try { await parent.sync(); } finally { await parent.close(); }
      }
    },
    remove: async (scope) => { await rm(file(scope), { force: true }); await rm(`${file(scope)}.pending`, { force: true }); },
    list: async () => {
      const names = await readdir(directory).catch(() => []);
      const journals: GovernanceJournal[] = [];
      for (const name of names.filter((item) => /^[0-9a-f]{64}\.json$/.test(item))) {
        try {
          const journal = journalSchema.parse(JSON.parse(await readFile(join(directory, name), "utf8")));
          if (journal.scope && file(journal.scope) === join(directory, name)) journals.push(journal);
        } catch { }
      }
      return journals;
    },
    autoCleanup: {
      wait: (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }),
      now: () => Date.now(),
      deadlineMs: 60_000,
    },
  });
  return { ...recovery, token, authenticates: (request: Request) => {
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } };
}
export function governanceHost(config: ServerConfig) {
  let host = hosts.get(config);
  if (!host) { host = createGovernanceHost(config); hosts.set(config, host); }
  return host;
}
export function governanceScope(workspaceID: string, engine: "v1" | "v2", sessionID: string) {
  return JSON.stringify([workspaceID, engine, sessionID]);
}
export function parseGovernanceScope(scope: string): { workspaceID: string; engine: "v1" | "v2"; sessionID: string } | null {
  let value: unknown;
  try { value = JSON.parse(scope); } catch { return null; }
  const parsed = z.tuple([z.string(), z.enum(["v1", "v2"]), id]).safeParse(value);
  return parsed.success ? { workspaceID: parsed.data[0], engine: parsed.data[1], sessionID: parsed.data[2] } : null;
}
