import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceAdmission, workspaceReadinessError } from "./workspace-admission.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = new Map();
  const runtime = { key: "runtime-1", pending: false };
  let beforeRead = async () => {};
  for (const slug of ["scout", "editor"]) {
    const directory = path.join(root, slug);
    await mkdir(path.join(directory, ".opencode"), { recursive: true });
    records.set(slug, { slug, path: directory, workspaceId: `ws_${slug}`, createdAt: "original", role: "Research", model: "fixture/one", abilities: { revision: 0 } });
    await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ agents: {}, permissions: [{ action: "shell", resource: "*", effect: "deny" }] }));
    await writeFile(path.join(directory, ".opencode/coworker-abilities.json"), JSON.stringify({ abilities: { revision: 0 }, token: "fixture-only" }));
    await writeFile(path.join(directory, ".opencode/coworker-context.json"), JSON.stringify({ token: "fixture-only" }));
  }
  const admissions = createWorkspaceAdmission({
    readNativeState: async (directory) => readFile(path.join(directory, "opencode.json"), "utf8"),
    readCoworker: async (slug) => { await beforeRead(); return structuredClone(records.get(slug)); },
    assertRuntime: (expected, owner) => {
      if (runtime.pending || expected.readinessKey !== runtime.key || expected.workspaceId !== owner.workspaceId || expected.createdAt !== owner.coworkerCreatedAt) throw workspaceReadinessError();
    },
  });
  const prepare = async (slug) => {
    const coworker = records.get(slug);
    return { workspaceId: coworker.workspaceId, createdAt: coworker.createdAt, readinessKey: runtime.key, workspaceKey: admissions.record(await admissions.read(coworker), runtime.key) };
  };
  const owner = (slug) => ({ slug, workspaceId: records.get(slug).workspaceId, coworkerCreatedAt: records.get(slug).createdAt });
  return { admissions, records, runtime, prepare, owner, onRead: (callback) => { beforeRead = callback; } };
}

test("workspace receipts ignore no-ops and per-turn model choices without sharing another workspace's configuration", async (t) => {
  const f = await fixture(t);
  const a = await f.prepare("scout");
  const b = await f.prepare("editor");
  f.records.get("scout").model = "fixture/two";
  f.records.get("scout").modelVariant = "high";
  f.records.get("editor").abilities.revision++;
  await f.admissions.assert(a, f.owner("scout"));
  assert.deepEqual(await f.prepare("scout"), a);
  await assert.rejects(f.admissions.assert(b, f.owner("editor")), { code: "readiness_changed" });
  await f.admissions.assertKey(a.workspaceId, f.records.get("scout").path, a.workspaceKey);
  await assert.rejects(f.admissions.assertKey(b.workspaceId, f.records.get("editor").path, a.workspaceKey), { code: "readiness_changed" });
  await assert.rejects(f.admissions.assertKey(a.workspaceId, f.records.get("editor").path, a.workspaceKey), { code: "readiness_changed" });
});

test("workspace configuration changes cannot resurrect an old receipt after a failed check", async (t) => {
  const f = await fixture(t);
  for (const name of ["opencode.json", ".opencode/coworker-abilities.json", ".opencode/coworker-context.json"]) {
    const expected = await f.prepare("scout");
    const file = path.join(f.records.get("scout").path, name);
    const original = await readFile(file, "utf8");
    await writeFile(file, JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "allow" }], token: "rotated-fixture" }));
    await assert.rejects(f.admissions.assert(expected, f.owner("scout")), { code: "readiness_changed" });
    await writeFile(file, original);
    await assert.rejects(f.admissions.assert(expected, f.owner("scout")), { code: "readiness_changed" });
    assert.notEqual((await f.prepare("scout")).workspaceKey, expected.workspaceKey);
  }
});

test("readiness checks again after awaited ownership and distinguishes pending no-op from a changed runtime", async (t) => {
  const f = await fixture(t);
  const expected = await f.prepare("scout");
  f.runtime.pending = true;
  await assert.rejects(f.admissions.assert(expected, f.owner("scout")), { code: "readiness_changed" });
  f.runtime.pending = false;
  await f.admissions.assert(expected, f.owner("scout"));
  await assert.rejects(f.admissions.assert(expected, f.owner("scout"), AbortSignal.abort()), { name: "AbortError" });
  await f.admissions.assert(expected, f.owner("scout"));
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  f.onRead(async () => { entered.resolve(); await release.promise; });
  const checking = f.admissions.assert(expected, f.owner("scout"));
  await entered.promise;
  f.runtime.key = "runtime-2";
  release.resolve();
  await assert.rejects(checking, { code: "readiness_changed" });
  assert.notEqual((await f.prepare("scout")).workspaceKey, expected.workspaceKey);
});

test("unconfirmed activation, changed roles and replaced coworker identities reject prior prepared input", async (t) => {
  const f = await fixture(t);
  let expected = await f.prepare("scout");
  f.admissions.forget(expected.workspaceId);
  await assert.rejects(f.admissions.assert(expected, f.owner("scout")), { code: "readiness_changed" });
  expected = await f.prepare("scout");
  f.records.get("scout").role = "Editor";
  await assert.rejects(f.admissions.assert(expected, f.owner("scout")), { code: "readiness_changed" });
  expected = await f.prepare("scout");
  f.records.get("scout").createdAt = "replacement";
  await assert.rejects(f.admissions.assert(expected, f.owner("scout")), { code: "readiness_changed" });
});
