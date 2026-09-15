import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export function workspaceReadinessError() {
  return Object.assign(new Error("The AI configuration changed before submission. Your draft is kept; wait for preparation and try again."), { code: "readiness_changed" });
}

const selection = (coworker) => ({
  slug: coworker.slug ?? ".coordinator", path: path.resolve(coworker.path),
  createdAt: coworker.createdAt, workspaceId: coworker.workspaceId,
  abilities: coworker.abilities, role: coworker.role, mission: coworker.mission, personality: coworker.personality,
});

export function createWorkspaceAdmission({ readCoworker, assertRuntime, readNativeState }) {
  const prepared = new Map();
  const read = async (coworker, signal) => {
    try {
      const before = structuredClone(selection(coworker));
      const directory = await realpath(coworker.path);
      const names = coworker.slug ? [".opencode/coworker-abilities.json", ".opencode/coworker-context.json"] : [];
      const documents = await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), { encoding: "utf8", signal }))));
      const native = await readNativeState(directory, signal);
      if (!isDeepStrictEqual(before, selection(await readCoworker(before.slug))) || await realpath(coworker.path) !== directory) throw workspaceReadinessError();
      signal?.throwIfAborted();
      return { coworker: before, directory, documents, native };
    } catch {
      signal?.throwIfAborted();
      throw workspaceReadinessError();
    }
  };
  const matches = (workspaceId, snapshot) => isDeepStrictEqual(prepared.get(workspaceId)?.snapshot, snapshot);
  const record = (snapshot, generation) => {
    const workspaceId = snapshot.coworker.workspaceId;
    if (!matches(workspaceId, snapshot) || prepared.get(workspaceId)?.generation !== generation) prepared.set(workspaceId, { key: randomUUID(), snapshot: structuredClone(snapshot), generation });
    return prepared.get(workspaceId).key;
  };
  return {
    read, matches, record,
    same: isDeepStrictEqual,
    forget: (workspaceId) => prepared.delete(workspaceId),
    current: (expected) => typeof expected.workspaceKey === "string" && prepared.get(expected.workspaceId)?.key === expected.workspaceKey,
    async assertKey(workspaceId, directory, key, signal) {
      const current = prepared.get(workspaceId);
      if (!key || current?.key !== key || current.snapshot.directory !== await realpath(directory).catch(() => null)) throw workspaceReadinessError();
      const { slug, createdAt } = current.snapshot.coworker;
      await this.assert({ workspaceId, createdAt, workspaceKey: key, readinessKey: current.generation }, { slug, workspaceId, coworkerCreatedAt: createdAt }, signal);
    },
    async assert(expected, owner, signal) {
      if (!expected || !owner) throw workspaceReadinessError();
      assertRuntime(expected, owner);
      const current = prepared.get(expected.workspaceId);
      if (!current || current.key !== expected.workspaceKey) throw workspaceReadinessError();
      const stale = () => {
        if (prepared.get(expected.workspaceId) === current) prepared.delete(expected.workspaceId);
        throw workspaceReadinessError();
      };
      let snapshot;
      try { snapshot = await read(await readCoworker(owner.slug ?? current.snapshot.coworker.slug), signal); }
      catch { signal?.throwIfAborted(); stale(); }
      if (!matches(expected.workspaceId, snapshot)) stale();
      if (prepared.get(expected.workspaceId) !== current) throw workspaceReadinessError();
      assertRuntime(expected, owner);
    },
  };
}
