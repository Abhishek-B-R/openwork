// What one desktop connection refresh costs on OpenCode v2 in steady state:
// Den requests, runtime config writes, and engine calls. Drives the real
// server pieces (health read, catalog refresh, routed registrar, the folder's
// reconciler) against a scripted Den and a scripted engine; nothing is spawned.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { cloudMcpDeliveryState, readOpenworkCloudMcpHealth, refreshOpenworkCloudMcpCatalog } from "./cloud-mcp-health.js";
import { createNativeCloudMcpResolver, createRoutedCloudMcpRegistrar } from "./cloud-mcp-v2.js";
import {
  CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION,
  CONNECT_MCP_SERVER_INDEX_URI,
  connectDirectMcpRuntimeName,
  writeOpenWorkConnectMcpAppHostAuthorization,
} from "./connect-mcp-server-catalog.js";
import { createEngineV2Preview } from "./engine-v2-preview.js";
import * as managedV2 from "./managed-opencode-v2.js";
import * as localAuth from "./opencode-v2-local-auth.js";
import { onRuntimeOpencodeConfigWrite, writeGlobalRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Server = { connectionId: string; name: string; description: null; url: string; exposeDirectly: boolean };

const cleanups: Array<() => void | Promise<void>> = [];
const previous = { db: process.env.OPENWORK_RUNTIME_DB, dev: process.env.OPENWORK_DEV_MODE, bin: process.env.OPENWORK_OPENCODE2_BIN };
beforeEach(() => {
  process.env.OPENWORK_DEV_MODE = "1";
  process.env.OPENWORK_OPENCODE2_BIN = "opencode2-fixture";
});
afterEach(async () => {
  cloudMcpDeliveryState.clear();
  while (cleanups.length) await cleanups.pop()?.();
  for (const [key, value] of [["OPENWORK_RUNTIME_DB", previous.db], ["OPENWORK_DEV_MODE", previous.dev], ["OPENWORK_OPENCODE2_BIN", previous.bin]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Den's /mcp/agent: initialize, initialized notice, then the connection index. */
function startDen(servers: () => Server[]) {
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body: unknown = await request.json().catch(() => null);
    const method = isRecord(body) && typeof body.method === "string" ? body.method : "?";
    requests.push(method);
    const id = isRecord(body) ? body.id : undefined;
    if (method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "den", version: "1" } } }, { headers: { "mcp-session-id": "session" } });
    }
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "resources/read") {
      const text = JSON.stringify({ schemaVersion: CONNECT_MCP_SERVER_INDEX_SCHEMA_VERSION, servers: servers() });
      return Response.json({ jsonrpc: "2.0", id, result: { contents: [{ uri: CONNECT_MCP_SERVER_INDEX_URI, mimeType: "application/json", text }] } });
    }
    return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
  } });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

/** The pinned engine's MCP registry: an identical PUT is ignored, /connect restarts, DELETE forgets. */
function startEngine(up: (name: string) => boolean) {
  const servers = new Map<string, { config: string; status: string }>([["openwork-cloud", { config: "cloud", status: "connected" }]]);
  const calls: string[] = [];
  const reply = async (path: string, method: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    calls.push(`${method} ${path}`);
    const name = decodeURIComponent(path.split("/")[3] ?? "");
    if (path === "/api/mcp" && method === "GET") {
      return { status: 200, json: { data: [...servers].map(([entry, server]) => ({ name: entry, status: { status: server.status } })) } };
    }
    if (path.endsWith("/connect") && method === "POST") {
      const server = servers.get(name);
      if (server) server.status = up(name) ? "connected" : "failed";
      return { status: 204, json: null };
    }
    if (method === "PUT") {
      const config = JSON.stringify(body);
      if (servers.get(name)?.config !== config) servers.set(name, { config, status: up(name) ? "connected" : "failed" });
      return { status: 204, json: null };
    }
    if (method === "DELETE") { servers.delete(name); return { status: 204, json: null }; }
    return { status: 200, json: { data: [] } };
  };
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const result = await reply(url.pathname, request.method, request.method === "GET" ? undefined : await request.json().catch(() => undefined));
    return result.status === 204 ? new Response(null, { status: 204 }) : Response.json(result.json, { status: result.status });
  } });
  cleanups.push(() => http.stop(true));
  return { url: `http://127.0.0.1:${http.port}`, servers, calls, reply };
}

async function harness(input: { servers: Server[]; up?: (name: string) => boolean }) {
  const root = await mkdtemp(join(tmpdir(), "openwork-refresh-tick-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const servers = input.servers;
  const den = startDen(() => servers);
  for (const server of servers) server.url = `${den.url}/mcp/agent/connections/${server.connectionId}`;
  const engine = startEngine(input.up ?? (() => true));
  const workspace: WorkspaceInfo = { id: "ws_1", name: "Fixture", path: root, preset: "starter", workspaceType: "local", baseUrl: engine.url };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const cloud = { type: "remote", url: `${den.url}/mcp/agent`, enabled: true, headers: { Authorization: "Bearer owt_member_fixture" }, oauth: false };
  await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, mcp: { "openwork-cloud": cloud } }));
  await writeOpenWorkConnectMcpAppHostAuthorization(config, workspace.id, "Bearer owt_app_host_fixture", cloud.url);

  const fake = {
    url: engine.url, username: "opencode", password: "fixture", childPid: 1, exitCode: null, stdout: "", stderr: "",
    health: async () => ({ healthy: true, version: "fixture", pid: 1 }),
    injectProvider: async () => {}, setProviders: async () => false, setSkills: async () => {}, close: async () => {},
    fetchJson: (path: string, init: { method?: string; body?: unknown } = {}) => engine.reply(path, init.method ?? "GET", init.body),
  } satisfies managedV2.ManagedOpencodeV2Server;
  const spies = [
    spyOn(managedV2, "createManagedOpencodeV2Server").mockResolvedValue(fake),
    spyOn(localAuth, "readLocalProviderApiKeys").mockResolvedValue(new Map()),
  ];
  // A short shared-status window so ticks here, milliseconds apart, stand in
  // for real ones minutes apart without sharing a read across ticks.
  const preview = createEngineV2Preview({ config, deferStart: true, waits: { mcpStatusTtlMs: 300 } });
  cleanups.push(async () => { await preview.stop(); for (const spy of spies) spy.mockRestore(); });
  await preview.setEnabled(true);
  await preview.setChatRouting(true);
  for (let attempt = 0; attempt < 200 && !preview.status().running; attempt++) await Bun.sleep(5);
  expect(preview.status().running).toBe(true);

  let configWrites = 0;
  cleanups.push(onRuntimeOpencodeConfigWrite(() => { configWrites += 1; }));
  const nativeEngineForWorkspace = createNativeCloudMcpResolver(preview);
  const registerRuntimeMcp = createRoutedCloudMcpRegistrar(preview, async () => { throw new Error("v1 registrar is not used on v2"); });
  const opencode = createOpencodeClient({ baseUrl: engine.url });
  const shared = { config, workspace, directory: root, createWorkspaceOpencodeClient: () => opencode, nativeEngineForWorkspace };

  const catalogWrittenAt = () => {
    const db = new Database(join(root, "runtime.sqlite"), { readonly: true });
    try {
      const row: unknown = db.query("SELECT updated_at AS updatedAt FROM connect_mcp_app_host_catalogs WHERE workspace_id = ?").get(workspace.id);
      return isRecord(row) && typeof row.updatedAt === "number" ? row.updatedAt : null;
    } catch {
      return null; // Created on first write.
    } finally {
      db.close();
    }
  };

  /** One desktop refresh: the health check, then the catalog refresh, then its background registration. */
  async function tick() {
    await Bun.sleep(350);
    const before = { den: den.requests.length, engine: engine.calls.length, writes: configWrites, catalog: catalogWrittenAt() };
    await readOpenworkCloudMcpHealth(shared);
    const health = await refreshOpenworkCloudMcpCatalog({ ...shared, registerRuntimeMcp });
    // Registration is fire-and-forget; let it and any reconciler run finish.
    await Bun.sleep(150);
    const engineCalls = engine.calls.slice(before.engine);
    return {
      usable: health.usable,
      den: den.requests.length - before.den,
      configWrites: configWrites - before.writes,
      catalogWrites: catalogWrittenAt() === before.catalog ? 0 : 1,
      engineCalls,
      engineMutations: engineCalls.filter((call) => !call.startsWith("GET ")),
    };
  }
  return { tick, engine, den, preview, workspace, root, config, servers };
}

const direct = (id: string, exposeDirectly = true): Server => ({ connectionId: id, name: `Fixture ${id}`, description: null, url: "", exposeDirectly });

test("steady-state refresh tick: all connections healthy", async () => {
  const { tick, engine } = await harness({ servers: [direct("emc_a"), direct("emc_b")] });
  const first = await tick();
  expect(first.usable).toBe(true);
  expect(engine.servers.has(connectDirectMcpRuntimeName(direct("emc_a")))).toBe(true);
  const steady = await tick();
  console.log("healthy tick", JSON.stringify(steady));
  expect(steady.configWrites).toBe(0);
  expect(steady.catalogWrites).toBe(0);
  expect(steady.engineMutations).toEqual([]);
});

test("steady-state refresh tick: one direct connection keeps failing", async () => {
  const failing = connectDirectMcpRuntimeName(direct("emc_down"));
  const { tick } = await harness({ servers: [direct("emc_a"), direct("emc_down")], up: (name) => name !== failing });
  await tick();
  const ticks = [await tick(), await tick(), await tick()];
  console.log("failing tick", JSON.stringify(ticks));
  // Inside the reconciler's back-off a refresh restarts nothing.
  expect(ticks.flatMap((entry) => entry.engineMutations)).toEqual([]);
});

test("a rotated member token or a changed catalog still reaches the engine on the next tick", async () => {
  const { tick, config, servers } = await harness({ servers: [direct("emc_a")] });
  await tick();
  const a = connectDirectMcpRuntimeName(direct("emc_a"));
  // Token rotation: the direct entries carry the member credential, so they are replaced.
  await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, mcp: { ...current.mcp,
    "openwork-cloud": { ...current.mcp?.["openwork-cloud"], headers: { Authorization: "Bearer owt_member_rotated" } } } }));
  const rotated = await tick();
  expect(rotated.configWrites).toBe(1);
  expect(rotated.engineMutations.sort()).toEqual([`DELETE /api/mcp/${a}`, `PUT /api/mcp/${a}`]);
  // An administrator exposes another connection: only it is registered.
  const added = direct("emc_b");
  added.url = servers[0]!.url.replace("emc_a", "emc_b");
  servers.push(added);
  const grown = await tick();
  expect(grown.catalogWrites).toBe(1);
  expect(grown.engineMutations).toEqual([`PUT /api/mcp/${connectDirectMcpRuntimeName(added)}`]);
  // And then nothing again.
  const steady = await tick();
  expect([steady.configWrites, steady.catalogWrites, steady.engineMutations.length]).toEqual([0, 0, 0]);
});
