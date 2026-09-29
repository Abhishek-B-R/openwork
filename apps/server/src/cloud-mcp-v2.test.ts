import { afterEach, expect, test } from "bun:test";
import { createNativeCloudMcpResolver, createRoutedCloudMcpRegistrar } from "./cloud-mcp-v2.js";
import type { EngineV2PreviewStatus } from "./engine-v2-preview.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const stops: Array<() => void> = [];
afterEach(() => { while (stops.length) stops.pop()?.(); });
const workspace: WorkspaceInfo = { id: "fixture", name: "Fixture", path: "/tmp/connect fixture", preset: "starter", workspaceType: "local" };
const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: "/tmp/connect-fixture.json", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [workspace.path], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
function status(chatRouting: boolean): EngineV2PreviewStatus {
  return { enabled: chatRouting, running: chatRouting, chatRouting, mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [], migration: { state: "idle", imported: 0, skipped: 0, total: 0 } };
}

test("native diagnostics use scoped authenticated APIs and never fall back to v1 when v2 is down", async () => {
  const requests: Array<{ path: string; directory: string | null; auth: string | null }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    requests.push({ path: url.pathname, directory: url.searchParams.get("location[directory]"), auth: request.headers.get("Authorization") });
    return Response.json({ data: [] });
  } });
  stops.push(() => server.stop(true));
  let chatRouting = true;
  let running = true;
  const resolve = createNativeCloudMcpResolver({ status: () => status(chatRouting), connection: () => running ? { url: `http://127.0.0.1:${server.port}`, username: "fixture", password: "fixture-secret" } : undefined });
  await resolve(workspace)?.request("/api/model", workspace.path);
  expect(requests).toEqual([{ path: "/api/model", directory: workspace.path, auth: `Basic ${Buffer.from("fixture:fixture-secret").toString("base64")}` }]);
  expect(resolve({ ...workspace, workspaceType: "remote" })).toBeUndefined();
  running = false;
  await expect(resolve(workspace)?.request("/api/model", workspace.path)).rejects.toThrow("OpenCode v2 is not running");
  chatRouting = false;
  expect(resolve(workspace)).toBeUndefined();
});

test("a v2 refresh hands the requested names to the folder's reconciler and never restarts them itself; v1 and remote repairs retain their owner", async () => {
  const operations: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    operations.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response(null, { status: 204 });
  } });
  stops.push(() => server.stop(true));
  let chatRouting = true;
  const register = createRoutedCloudMcpRegistrar({
    status: () => status(chatRouting), connection: () => ({ url: `http://127.0.0.1:${server.port}`, username: "fixture", password: "fixture" }),
    syncWorkspaceMcp: async (id, directory, options) => { operations.push(`sync ${id} ${directory} ${options?.reconnect?.join(",")}`); },
    warmWorkspace: (id, directory) => { operations.push(`warm ${id} ${directory}`); },
  }, async () => { operations.push("v1-or-remote"); return { status: "ok", syncedNames: [], failures: [] }; });
  expect((await register(config, workspace, ["openwork-direct-a", "openwork-direct-b"])).status).toBe("ok");
  expect((await register(config, workspace)).syncedNames).toEqual(["openwork-cloud"]);
  // No engine request of its own: in particular no unconditional /connect.
  expect(operations).toEqual([`sync fixture ${workspace.path} openwork-direct-a,openwork-direct-b`, `sync fixture ${workspace.path} openwork-cloud`]);
  await register(config, { ...workspace, workspaceType: "remote" });
  chatRouting = false;
  await register(config, workspace);
  expect(operations.slice(2)).toEqual(["v1-or-remote", "v1-or-remote"]);
});

test("a periodic refresh restarts nothing on v2; an explicit request still names its reconnects", async () => {
  const operations: string[] = [];
  const register = createRoutedCloudMcpRegistrar({
    status: () => status(true), connection: () => ({ url: "http://127.0.0.1:1", username: "fixture", password: "fixture" }),
    syncWorkspaceMcp: async (_id, _directory, options) => { operations.push(`sync ${options?.reconnect?.join(",") ?? ""}`); },
    warmWorkspace: () => { operations.push("warm"); },
  }, async () => { operations.push("v1"); return { status: "ok", syncedNames: [], failures: [] }; });
  expect(await register(config, workspace, ["openwork-direct-a"], { throwOnFailure: false, background: true }))
    .toEqual({ status: "ok", syncedNames: ["openwork-direct-a"], failures: [] });
  // Only starts upkeep for a folder the engine has not seen; no reconnect names.
  expect(operations).toEqual(["warm"]);
  await register(config, workspace, ["openwork-direct-a"]);
  expect(operations).toEqual(["warm", "sync openwork-direct-a"]);
});

test("health reads share the folder's live MCP status and engine changes discard it", async () => {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return request.method === "POST" ? new Response(null, { status: 204 }) : Response.json({ data: [] });
  } });
  stops.push(() => server.stop(true));
  const events: string[] = [];
  const resolve = createNativeCloudMcpResolver({
    status: () => status(true), connection: () => ({ url: `http://127.0.0.1:${server.port}`, username: "fixture", password: "fixture" }),
    readMcpStatus: async (directory) => { events.push(`shared ${directory}`); return { data: [{ name: "openwork-cloud", status: { status: "connected" } }] }; },
    invalidateMcpStatus: (directory) => { events.push(`invalidate ${directory}`); },
  });
  expect(await resolve(workspace)?.request("/api/mcp", workspace.path)).toEqual({ data: [{ name: "openwork-cloud", status: { status: "connected" } }] });
  await resolve(workspace)?.request("/api/mcp/openwork-cloud/disconnect", workspace.path, "POST");
  expect(requests).toEqual(["POST /api/mcp/openwork-cloud/disconnect"]);
  expect(events).toEqual([`shared ${workspace.path}`, `invalidate ${workspace.path}`, `invalidate ${workspace.path}`]);
});
