import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listCoworkers } from "./coworkers.mjs";
import { COORDINATOR_DIR, ensureCoordinatorHome, readCoordinator, updateCoordinator } from "./coordinator.mjs";
import { configureNativePluginBundles } from "./native-plugin.mjs";
import { installProgressPlugin } from "./progress-plugin.mjs";
import { installMemoryPlugin } from "./memory-model.mjs";
import { fileURLToPath } from "node:url";

configureNativePluginBundles(process.env.OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR ?? fileURLToPath(new URL("../resources/native-plugins/", import.meta.url)));
const ensure = (home) => ensureCoordinatorHome(home, [installProgressPlugin, installMemoryPlugin]);

test("the coordinator home is a locked-down hidden workspace that the coworker list never shows", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coworker-coordinator-"));
  try {
    assert.equal(await readCoordinator(home), null);
    const created = await ensure(home);
    assert.equal(created.path, path.join(home, COORDINATOR_DIR));
    assert.equal(created.workspaceId, "");
    const config = JSON.parse(await readFile(path.join(created.path, "opencode.json"), "utf8"));
    assert.deepEqual(config.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
    assert.equal(config.tools, undefined);
    assert.deepEqual(config.instructions, []);
    assert.deepEqual(config.mcp, {});
    assert.deepEqual(config.plugins.map((entry) => path.basename(new URL(entry).pathname)), ["progress-summary", "auto-memory"]);
    assert.equal(created.configChanged, true);
    assert.match(await readFile(path.join(created.path, "AGENTS.md"), "utf8"), /never answer the person yourself/);
    // Not a coworker: no coworker.md, so it stays out of the rail, discussions, and Activity.
    assert.deepEqual(await listCoworkers(home), []);

    const registered = await updateCoordinator(home, { workspaceId: "ws_1" });
    assert.equal(registered.workspaceId, "ws_1");
    // A hand edit that hands the facilitator a tool is undone on the next ensure; the workspace id is kept.
    await writeFile(path.join(created.path, "opencode.json"), JSON.stringify({ ...config, tools: { bash: true }, permissions: [{ action: "*", resource: "*", effect: "allow" }], plugins: [...config.plugins, "file:///unauthorized-plugin"] }), "utf8");
    await writeFile(path.join(created.path, "AGENTS.md"), "Unauthorized instructions", "utf8");
    const again = await ensure(home);
    assert.equal(again.workspaceId, "ws_1");
    assert.equal(again.configChanged, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(created.path, "opencode.json"), "utf8")), config);
    assert.match(await readFile(path.join(created.path, "AGENTS.md"), "utf8"), /never answer the person yourself/);
    assert.equal((await readCoordinator(home))?.workspaceId, "ws_1");
    const files = ["opencode.json", "AGENTS.md", "coordinator.json"].map((name) => path.join(created.path, name));
    for (const file of files) await utimes(file, 1, 1);
    const before = await Promise.all(files.map((file) => stat(file, { bigint: true })));
    assert.equal((await ensure(home)).configChanged, false);
    const after = await Promise.all(files.map((file) => stat(file, { bigint: true })));
    assert.deepEqual(after.map(({ ino, mtimeNs }) => [ino, mtimeNs]), before.map(({ ino, mtimeNs }) => [ino, mtimeNs]));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
