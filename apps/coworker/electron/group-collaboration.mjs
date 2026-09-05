/** Group-scoped shared work. Identity comes from the tool token, never tool arguments. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendGroupEvent, getGroup, listGroups, readGroupTimeline } from "./groups.mjs";
import { getCoworker } from "./coworkers.mjs";
import { createDocument, listDocuments, listRevisions, readDocument, updateDocument } from "./documents.mjs";

const MAX_REQUESTS = 4;
const WINDOW_MS = 10 * 60_000;
const MAX_BODY = 100_000;

export function createGroupCollaboration({ coworkersDir, ask, now = Date.now }) {
  const active = new Map();
  const recipients = new Set();
  const writes = new Map();
  async function access(groupId, slug) {
    const group = await getGroup(coworkersDir, groupId);
    if (group.archivedAt !== null) throw new Error("This group is archived.");
    if (slug) {
      if (!group.collaborationEnabled || !group.participantSlugs.includes(slug)) throw new Error("Collaboration is paused or you are no longer a member of this group.");
      await getCoworker(coworkersDir, slug);
    }
    return group;
  }
  async function serial(groupId, fn) {
    const prior = writes.get(groupId) ?? Promise.resolve();
    const pending = prior.catch(() => undefined).then(fn);
    writes.set(groupId, pending);
    try { return await pending; } finally { if (writes.get(groupId) === pending) writes.delete(groupId); }
  }
  function documentHome(groupId) { return path.join(coworkersDir, ".groups", groupId); }
  async function documentEvent(groupId, slug, doc) {
    await appendGroupEvent(coworkersDir, groupId, { kind: "status", status: "document", text: `${doc.author} updated ${doc.title}`, documentId: doc.id, revision: doc.revision, ...(slug ? { slug } : {}) });
  }
  const api = {
    async list(slug) {
      await getCoworker(coworkersDir, slug);
      return (await listGroups(coworkersDir)).filter((g) => g.collaborationEnabled && g.archivedAt === null && g.participantSlugs.includes(slug)).map((g) => ({ id: g.id, name: g.name, members: g.participantSlugs }));
    },
    async history(groupId, slug) { await access(groupId, slug); return readGroupTimeline(coworkersDir, groupId, { limit: 60 }); },
    async documents(groupId, slug = null) { await access(groupId, slug); return listDocuments(documentHome(groupId), "shared"); },
    async read(groupId, id, slug = null) { await access(groupId, slug); return readDocument(documentHome(groupId), "shared", id); },
    async revisions(groupId, id, slug = null) { await access(groupId, slug); return listRevisions(documentHome(groupId), "shared", id); },
    async save(groupId, input, slug = null) {
      return serial(groupId, async () => {
        await access(groupId, slug);
        if (typeof input.body !== "string" || input.body.length > MAX_BODY) throw new Error("A shared document needs a body of at most 100,000 characters.");
        const author = slug ? (await getCoworker(coworkersDir, slug)).name : "You";
        const options = { by: slug ? "coworker" : "person", author };
        const home = documentHome(groupId);
        let result;
        if (input.id) {
          const current = await readDocument(home, "shared", input.id);
          if (current.revision !== input.expectedRevision) throw new Error(`This document changed. Read revision ${current.revision}, reconcile your changes, then save again.`);
          result = await updateDocument(home, "shared", input.id, input, options);
        } else {
          result = await createDocument(home, "shared", input, options);
        }
        if (result.changed !== false) await documentEvent(groupId, slug, result);
        return result;
      });
    },
    async restore(groupId, id, revision, expectedRevision) {
      const old = (await api.revisions(groupId, id)).find((item) => item.revision === revision);
      if (!old) throw new Error("That revision is no longer available.");
      return api.save(groupId, { ...old, id, expectedRevision });
    },
    async request(groupId, from, to, question) {
      const group = await access(groupId, from);
      if (!group.participantSlugs.includes(to) || from === to) throw new Error("Choose another member of this group.");
      if (typeof question !== "string" || !question.trim() || question.length > 4000) throw new Error("Ask one clear question, up to 4,000 characters.");
      // Reserve synchronously before any later await. A recipient cannot initiate another request while answering one.
      if (active.size >= 2 || active.has(groupId) || recipients.has(from) || recipients.has(to)) throw new Error("A collaboration request is already in progress. Wait for its answer before asking again.");
      const controller = new AbortController();
      active.set(groupId, { controller, from, to });
      recipients.add(to);
      const deadline = setTimeout(() => controller.abort(), 180_000);
      deadline.unref?.();
      let requestId = "";
      let onAbort;
      try {
        if (controller.signal.aborted) throw new Error("Collaboration stopped.");
        const target = await getCoworker(coworkersDir, to);
        const sender = await getCoworker(coworkersDir, from);
        const history = await readGroupTimeline(coworkersDir, groupId);
        if (history.filter((e) => e.status === "requested" && e.at > now() - WINDOW_MS).length >= MAX_REQUESTS) throw new Error("This group reached its limit of four requests in ten minutes. Ask the person to review the conversation before continuing later.");
        await access(groupId, from);
        await access(groupId, to);
        if (controller.signal.aborted) throw new Error("Collaboration stopped.");
        requestId = `request_${randomUUID().replace(/-/g, "")}`;
        await appendGroupEvent(coworkersDir, groupId, { kind: "coworker", slug: from, toSlug: to, requestId, status: "requested", text: question.trim() });
        if (controller.signal.aborted) throw new Error("Collaboration stopped.");
        const interrupted = new Promise((_, reject) => {
          onAbort = () => reject(new Error("Collaboration stopped. Ask again when you are ready."));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([
          ask({ group, sender, target, question: question.trim(), requestId, history: history.slice(-30), signal: controller.signal }),
          interrupted,
        ]);
        if (controller.signal.aborted) throw new Error("Collaboration stopped.");
        await access(groupId, from);
        await access(groupId, to);
        if (!result.text?.trim()) throw new Error("The coworker finished without an answer. Please retry the request.");
        const reply = result.text.slice(0, 20_000);
        await appendGroupEvent(coworkersDir, groupId, { kind: "coworker", slug: to, toSlug: from, requestId, status: "answered", threadId: result.threadId, text: reply });
        return { groupId, groupName: group.name, requestId, status: "answered", from: to, fromName: target.name, reply };
      } catch (error) {
        if (requestId) await appendGroupEvent(coworkersDir, groupId, { kind: "status", requestId, slug: to, status: controller.signal.aborted ? "stopped" : "failed", text: controller.signal.aborted ? "Collaboration stopped." : `${to} could not answer. ${error instanceof Error ? error.message : "Try again."}` });
        throw error;
      } finally {
        clearTimeout(deadline);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        active.delete(groupId); recipients.delete(to);
      }
    },
    stop(groupId) { active.get(groupId)?.controller.abort(); },
    async recover() {
      for (const group of await listGroups(coworkersDir)) {
        if (active.has(group.id)) continue;
        const events = await readGroupTimeline(coworkersDir, group.id);
        for (const event of events.filter((e) => e.status === "requested")) {
          if (!events.some((e) => e.requestId === event.requestId && ["answered", "stopped", "failed"].includes(e.status))) {
            await appendGroupEvent(coworkersDir, group.id, { kind: "status", requestId: event.requestId, status: "stopped", text: "This request stopped when the app closed. Ask again to continue." });
          }
        }
      }
    },
  };
  return api;
}

export function groupToolCatalog() {
  const groupId = { type: "string", description: "The group id returned by group_list; choose one relevant group shared by both coworkers." };
  const id = { type: "string", description: "Shared document id." };
  const tool = (name, description, properties, required) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
  return [
    tool("group_list", "Find my groups where the person enabled collaboration. Group membership is the permission boundary. Never copy private conversation, memory, or files into a group unless the person explicitly shared them.", {}, []),
    tool("group_history", "Read a group's public conversation before asking for help.", { groupId }, ["groupId"]),
    tool("group_request", "Publicly ask another member of an enabled group for information or specialist help needed for the current task. Wait for their actual answer, then continue your work; never invent it. This runs using their own model and permitted tools. At most four requests per group in ten minutes, no nested requests. Cite the group in your reply.", { groupId, to: { type: "string", description: "Recipient coworker slug from group_list." }, question: { type: "string", maxLength: 4000 } }, ["groupId", "to", "question"]),
    tool("group_documents", "Discover documents explicitly shared in this group; private coworker documents are separate.", { groupId }, ["groupId"]),
    tool("group_document_read", "Read a shared document and its current revision before editing it.", { groupId, id }, ["groupId", "id"]),
    tool("group_document_save", "Create or update a shared document. Existing documents require expectedRevision from your latest read. If it changed, read again and reconcile before saving; never overwrite another writer's work blindly. The saved revision records your actual identity.", { groupId, id, expectedRevision: { type: "integer", minimum: 1 }, title: { type: "string" }, summary: { type: "string" }, body: { type: "string", maxLength: MAX_BODY } }, ["groupId", "title", "body"]),
  ];
}

export function groupToolHandlers(api) {
  const handlers = {
    group_list: (slug) => api.list(slug),
    group_history: (slug, args) => api.history(args.groupId, slug),
    group_request: (slug, args) => api.request(args.groupId, slug, args.to, args.question),
    group_documents: (slug, args) => api.documents(args.groupId, slug),
    group_document_read: (slug, args) => api.read(args.groupId, args.id, slug),
    group_document_save: (slug, args) => api.save(args.groupId, args, slug),
  };
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (slug, args) => {
    const result = await handler(slug, args);
    return { text: JSON.stringify(result), structured: { group: result } };
  }]));
}
