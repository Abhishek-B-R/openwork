import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { browserScript } from "@openwork/cdp";
import { connectorBranding } from "./library.ts";
import { configureProvider, fixtureInputFocus } from "./chat.ts";

/** Anonymous fixture covering one conversation, with native engine differences. */
export async function wholeActivity(seed: Seed) {
  const base = await connectorBranding(seed);
  const engine = resolveEvalEngine();
  const directory = seed.tmpPath("whole-activity");
  await mkdir(directory, { recursive: true });
  const path = await realpath(directory);
  const fixture = join(path, "fixture.txt");
  await writeFile(fixture, "Fixture version: 3\n");
  // v2 reads native workspace configuration from disk; OpenWork's provider
  // mirror deliberately does not invent or copy custom agent policy.
  await writeFile(join(path, "opencode.json"), JSON.stringify(engine === "v2" ? {
    agents: { "fixture-helper": { mode: "subagent", permissions: [{ action: "question", resource: "*", effect: "allow" }] } },
  } : { agent: { "fixture-helper": { mode: "subagent", permission: { question: "allow" } } } }));
  const workspace = await seed.workspace(base.app, path, { create: true });
  const provider = "whole-fixture";
  const firstModel = "first";
  const secondModel = "second";
  const shortPrompt = "Name the fixture version in two words.";
  const prompt = "Read the fixture, check its output, list three Slack channels and ask a helper to confirm the format.";
  const childPrompt = "Confirm the fixture format. Ask which format to use before preparing the result.";
  const followup = "Include the version in the fixture result.";
  const answer = "The fixture is version 3, the channels were listed, and the helper chose a checklist.";
  const stopPrompt = "Keep checking the fixture until I stop you.";
  const continuePrompt = "Continue by reporting the fixture version without more checks.";
  const backgroundPrompt = "Have a background helper check the fixture and tell me when it finishes.";
  const backgroundBrief = "Check the fixture in the background and report its version.";
  const backgroundDone = "Background fixture check completed: version 3.";
  const backgroundWake = "The background fixture helper finished with version 3.";
  const backgroundStopPrompt = "Start another background fixture check so I can stop it from the tray.";
  const backgroundStopBrief = "Wait while checking the fixture in the background.";
  const serviceSteps = engine === "v2" ? [{ tool: "execute", arguments: { code: `
    const found = await tools["openwork-cloud"].search_capabilities({ query: "Slack list_channels", type: "mcp", limit: 1 });
    const result = typeof found === "string" ? JSON.parse(found) : found;
    const catalog = result.matches ? result : JSON.parse(result.content[0].text);
    return await tools["openwork-cloud"].execute_capability({ name: catalog.matches[0].name, body: { limit: 3 } });
  ` } }] : [
    { tool: "search_capabilities", arguments: { query: "Slack list_channels", type: "mcp", limit: 1 } },
    { tool: "execute_capability", arguments: { body: { limit: 3 } }, argumentsFrom: "capability-search" },
  ];
  const delegate = (description: string, prompt: string, background = false) => ({ tool: engine === "v2" ? "subagent" : "task", arguments: {
    description, prompt, ...(engine === "v2" ? { agent: "fixture-helper", background } : { subagent_type: "fixture-helper" }),
  } });
  const workloads = [
    { promptMarker: shortPrompt, latestUserTurn: true, finalReply: "Version three.", steps: [] },
    { promptMarker: prompt, latestUserTurn: true, finalReasoning: "The file, command and helper agree.", finalReply: answer, steps: [
      { tool: "read", arguments: { filePath: fixture, path: fixture } },
      { tool: engine === "v2" ? "shell" : "bash", arguments: { command: "sleep 2 && echo 'Fixture output version: 3'", description: "Check fixture output" } },
      ...serviceSteps,
      delegate("Confirm fixture format", childPrompt),
    ] },
    { promptMarker: childPrompt, latestUserTurn: true, finalReply: "Preparing the fixture checklist. Fixture checklist completed.",
      finalReplyChunks: ["Preparing the fixture checklist. ", "Fixture checklist completed."], finalReplyInitiallyReleasedChunks: 1,
      steps: [{ tool: "question", arguments: { questions: [{ header: "Format", question: "Which fixture format should I use?", options: [
        { label: "Fixture checklist", description: "Use a checklist" }, { label: "Fixture outline", description: "Use an outline" },
      ] }] } }] },
    { promptMarker: followup, latestUserTurn: true, finalReply: "The checklist includes fixture version 3.", steps: [] },
    { promptMarker: stopPrompt, latestUserTurn: true, finalReply: "The long fixture check finished.", steps: [
      { tool: engine === "v2" ? "shell" : "bash", arguments: { command: "sleep 40 && echo 'Fixture check finished'", description: "Keep checking fixture" } },
    ] },
    { promptMarker: continuePrompt, latestUserTurn: true, finalReply: "The fixture version is 3.", steps: [] },
    ...(engine === "v2" ? [
      { promptMarker: backgroundPrompt, latestUserTurn: true, finalReply: "The fixture helper is checking in the background.", steps: [delegate("Background fixture check", backgroundBrief, true)] },
      { promptMarker: backgroundBrief, latestUserTurn: true, finalReply: `Checking the background fixture. ${backgroundDone}`,
        finalReplyChunks: ["Checking the background fixture. ", backgroundDone], finalReplyInitiallyReleasedChunks: 1, steps: [] },
      { promptMarker: backgroundDone, latestUserTurn: true, finalReply: backgroundWake, steps: [] },
      { promptMarker: backgroundStopPrompt, latestUserTurn: true, finalReply: "Another fixture helper is checking in the background.", steps: [delegate("Background check to stop", backgroundStopBrief, true)] },
      { promptMarker: backgroundStopBrief, latestUserTurn: true, finalReply: "Background check started. Background check finished.",
        finalReplyChunks: ["Background check started. ", "Background check finished."], finalReplyInitiallyReleasedChunks: 1, steps: [] },
    ] : []),
  ];
  const configured = await fetch(`${base.den.mocks.connector.url}/admin/agent-workloads`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workloads }),
  });
  if (!configured.ok) throw new Error("Could not configure the whole conversation fixture");
  await configureProvider(seed, base.app, workspace.workspaceId, provider, firstModel, {
    permission: { read: "allow", bash: "allow", task: "allow", question: "allow" },
    // A fixture-owned helper can ask a question. The engine's built-in General
    // agent intentionally denies questions; leave that product policy intact.
    agent: { "fixture-helper": { mode: "subagent", tools: { question: true }, permission: { question: "allow" } } },
    provider: { [provider]: { npm: "@ai-sdk/openai-compatible", name: "Fixture provider",
      options: { baseURL: `${base.den.mocks.connector.url}/v1`, apiKey: "sk-whole-fixture" },
      models: { [firstModel]: { name: "First fixture model" }, [secondModel]: { name: "Second fixture model" } },
    } },
  });
  const session = await seed.session(base.app, { title: "Whole fixture conversation" });
  return { ...base, workspace, session, shortPrompt, prompt, childPrompt, followup, answer, stopPrompt, continuePrompt,
    inputFocus: () => fixtureInputFocus(seed, base.app),
    backgroundPrompt, backgroundStopPrompt, backgroundWake,
    childState: () => base.den.mocks.connector.agentReplyState(childPrompt),
    finishChild: () => base.den.mocks.connector.releaseAgentReply(childPrompt),
    backgroundState: () => base.den.mocks.connector.agentReplyState(backgroundBrief),
    finishBackground: () => base.den.mocks.connector.releaseAgentReply(backgroundBrief),
    stoppedBackgroundState: () => base.den.mocks.connector.agentReplyState(backgroundStopBrief),
    nativeTools: (): Promise<{ tool?: string; state?: { status: string; error?: unknown; metadata?: unknown } }[]> => seed.evalIn(base.app, browserScript(async (workspaceId, engine) => {
      const sessionId = document.querySelector("[data-session-surface-id]")?.getAttribute("data-session-surface-id");
      const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/workspace/" + encodeURIComponent(workspaceId)
        + (engine === "v2" ? "/opencode2/api" : "/opencode") + "/session/" + encodeURIComponent(sessionId ?? "") + "/message?limit=50", {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
      });
      if (!response.ok) throw new Error("Could not inspect native fixture delegation");
      const raw = await response.json();
      return (Array.isArray(raw) ? raw : raw.data ?? []).flatMap((message: { parts?: { type: string; tool?: string; state?: { status: string; error?: unknown; metadata?: unknown } }[]; content?: { type: string; name?: string; state?: { status: string; error?: unknown; metadata?: unknown } }[] }) =>
        (message.parts ?? message.content ?? []).filter(part => part.type === "tool")
          .map(part => ({ tool: "tool" in part ? part.tool : "name" in part ? part.name : undefined, state: part.state })));
    }, [workspace.workspaceId, engine]), { awaitPromise: true }),
  };
}
