import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

export const placementPrompt = "Open the connected calculator.";
export const placementLeadIn = "Opening your connected calculator now.";
export const placementReply = "The calculator is ready above.";
export const placementResourceUri = "ui://sample/calculator.html";

/** A connected SDK App in chat, independent of Den and authored App rollouts. */
export async function mcpAppChatPlacement(seed: Seed) {
  const appRequire = createRequire(new URL("../../apps/app/package.json", import.meta.url));
  const { build } = await import(createRequire(appRequire.resolve("vite")).resolve("esbuild"));
  const bundle = await build({
    stdin: { resolveDir: fileURLToPath(new URL("../../apps/app", import.meta.url)), contents: `
      import { App } from "@modelcontextprotocol/ext-apps";
      const app = new App({ name: "Connected calculator", version: "1" }, {});
      app.ontoolresult = () => { document.querySelector("p").textContent = "Calculator ready"; };
      app.connect();
    ` },
    bundle: true, write: false, format: "iife", platform: "browser", minify: true,
  });
  const appHtml = `<!doctype html><html><head><title>Connected calculator</title></head><body><p>Waiting for calculator</p><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`;
  const workspacePath = seed.tmpPath("mcp-app-chat-placement");
  const app = await seed.appWeb({ name: "mcp-app-chat-placement", workspacePath, mocks: {
    calculator: seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true,
      tools: [{ name: "open_calculator", description: "Open the connected calculator", inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false }, _meta: { ui: { resourceUri: placementResourceUri } },
        appHtml, delayMs: 3_000, result: { content: [{ type: "text", text: "Calculator opened" }] } }],
      agentWorkloads: [{ promptMarker: placementPrompt, finalReply: placementReply,
        steps: [{ tool: "open_calculator", text: placementLeadIn, arguments: {} }] }],
    }),
  } });
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "placement-model", "placement-model", {
    provider: { "placement-model": { npm: "@ai-sdk/openai-compatible", name: "Placement model",
      options: { baseURL: `${app.mocks.calculator.url}/v1`, apiKey: "sk-placement-fixture" },
      models: { "placement-model": { name: "Placement model" } } } },
    mcp: { calculator: { type: "remote", url: app.mocks.calculator.mcpUrl, enabled: true, oauth: false } },
  });
  const session = await seed.session(app, { title: "Connected calculator placement" });
  return { app, session, mock: app.mocks.calculator };
}
