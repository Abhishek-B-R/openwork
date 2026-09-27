import { randomUUID } from "node:crypto";
import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { startMockMcp, type MockMcpHandle } from "@openwork/labs";
import { engineParity } from "./engine-parity.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real app, server and pinned engine with a local design app MCP whose port is
 * reserved but closed until `startApp()` opens it. Only the model and the
 * design app are synthetic.
 */
export async function localMcpLateStart(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const base = setup.use(await engineParity(seed, context));
  const port = await allocateFreePort();
  const name = "design-app";
  const tool = "read_canvas";
  const proof = `Canvas has 3 frames ${randomUUID()}`;
  const appUrl = `http://127.0.0.1:${port}/mcp`;
  let designApp: MockMcpHandle | undefined;
  setup.defer(async () => { await designApp?.stop(); });

  const listed = await base.request("/workspaces");
  const items = record(listed.body) && Array.isArray(listed.body.items) ? listed.body.items.filter(record) : [];
  const workspaceId = items.find((item) => item.path === base.workspacePath)?.id;
  if (typeof workspaceId !== "string") throw new Error("The fixture workspace is not listed");
  const workspace = `/workspace/${encodeURIComponent(workspaceId)}`;

  const resources = setup.move();
  return {
    ...base, name, tool, proof, appUrl, workspaceId,
    /** Add the design app connection the way the Library does. */
    async connect() {
      return base.request(`${workspace}/mcp`, "POST", { name, config: { type: "remote", url: appUrl, oauth: false } });
    },
    /** The engine's own live status for the connection, or "missing". */
    async liveStatus() {
      const response = await base.request(`${workspace}/opencode2/api/mcp`);
      const entries = record(response.body) && Array.isArray(response.body.data) ? response.body.data.filter(record) : [];
      const entry = entries.find((item) => item.name === name);
      if (!entry) return "missing";
      return record(entry.status) && typeof entry.status.status === "string" ? entry.status.status : "unknown";
    },
    /** The member opens the design app: its MCP server starts on the reserved port. */
    async startApp() {
      designApp = await startMockMcp({ port, allowUnauthenticatedMcp: true, tools: [{
        name: tool, description: "Read the frames on the open design canvas", inputSchema: { type: "object", properties: {} },
        result: { content: [{ type: "text", text: proof }] },
      }] });
      const health = await fetch(`${designApp.url}/health`, { signal: AbortSignal.timeout(10_000) });
      return { ok: health.ok, status: health.status };
    },
    async toolCalls(sinceIso?: string) {
      if (!designApp) return [];
      return designApp.toolCalls({ name: tool, ...(sinceIso ? { sinceIso } : {}) });
    },
    /** Script the next turn to call the design app tool through Code Mode. */
    async prepareCanvasTurn(prompt: string) {
      await base.prepareTurn(prompt, "The canvas was not read", [
        { tool: "execute", arguments: { code: `return await tools[${JSON.stringify(name)}].${tool}({});` } },
      ], "last-tool-text");
    },
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}

/**
 * The same world after the member added the design app connection while the
 * app was closed: the engine has already tried it once and marked it failed.
 */
export async function localMcpAddedWhileClosed(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const world = setup.use(await localMcpLateStart(seed, context));
  const added = await world.connect();
  if (added.status !== 200) throw new Error(`Adding the design app connection failed: ${added.status}`);
  const deadline = Date.now() + 30_000;
  let status = await world.liveStatus();
  while (status !== "failed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await world.liveStatus();
  }
  if (status !== "failed") throw new Error(`Expected the closed design app to fail to start; engine status is ${status}`);
  const resources = setup.move();
  return {
    ...world,
    async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
  };
}
