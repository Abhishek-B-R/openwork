/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { createDefaultPlatform, PlatformProvider } from "../src/react-app/kernel/platform";

// Without a live conversation origin the App frame renders this notice, which marks its place.
const APP_MARKER = "This App is missing its conversation origin";

function appPart(id: string, app = { connectionId: "emc_fixture", resourceUri: "ui://fixture/calculator.html" }): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: id,
    state: "output-available",
    input: { name: `plugin:plg_fixture:${app.connectionId}` },
    output: "Opened Order calculator.",
    callProviderMetadata: { openwork: { mcpResult: {
      content: [{ type: "text", text: "Opened Order calculator." }],
      _meta: { "openwork/mcpApp": { connectionId: app.connectionId, toolName: "open_app", resourceUri: app.resourceUri, arguments: { input: {} } } },
    } } },
  };
}

function bashPart(id: string): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName: "bash", toolCallId: id, state: "output-available", input: { command: `echo ${id}`, description: "run" }, output: "ok" };
}

function withoutWindow<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (descriptor?.configurable) Reflect.deleteProperty(globalThis, "window");
  try {
    return run();
  } finally {
    if (descriptor?.configurable) Object.defineProperty(globalThis, "window", descriptor);
  }
}

function renderList(messages: UIMessage[]) {
  return withoutWindow(() => renderToStaticMarkup(
    <PlatformProvider value={createDefaultPlatform()}>
      <MessageListProvider
        workspaceId="ws" sessionId="session" showThinking={true} developerMode={false} displaySuggestions={false}
        providerConnectedCount={1} dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={() => Promise.reject(new Error("unused"))} onMcpReopenAuthorization={() => Promise.resolve()}
      >
        <MessageList messages={messages} status="ready" activityStatus="idle" />
      </MessageListProvider>
    </PlatformProvider>
  ));
}

const user: UIMessage = { id: "user-1", role: "user", metadata: { opencode: { created: 1_000 } }, parts: [{ type: "text", text: "Open the order calculator", state: "done" }] };

function assistant(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", metadata: { opencode: { created: 2_000, completed: 90_000 } }, parts };
}

/** Position of each text in the markup; every text must be present exactly once. */
function order(markup: string, texts: string[]) {
  return texts.map((text) => {
    const at = markup.indexOf(text);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(markup.indexOf(text, at + 1)).toBe(-1);
    return at;
  });
}

describe("an MCP App renders where its tool call happened", () => {
  test("a turn delivered as separate messages shows the App after the prose written before it", () => {
    const markup = renderList([
      user,
      assistant("a-think", [{ type: "reasoning", text: "Finding the App", state: "done" }]),
      assistant("a-prose", [{ type: "text", text: "Looking for connected apps matching that.", state: "done" }]),
      assistant("a-open", [appPart("open-1")]),
      assistant("a-answer", [{ type: "text", text: "Found it, it is open above.", state: "done" }]),
    ]);
    const [prose, app, answer] = order(markup, ["Looking for connected apps matching that.", APP_MARKER, "Found it, it is open above."]);
    expect(prose).toBeLessThan(app);
    expect(app).toBeLessThan(answer);
  });

  test("an App opened during steps that fold stays visible, between the folded run and the answer", () => {
    const markup = renderList([
      user,
      assistant("a-turn", [
        { type: "step-start" },
        { type: "reasoning", text: "Checking a few things first", state: "done" },
        bashPart("c1"), bashPart("c2"), bashPart("c3"), bashPart("c4"), bashPart("c5"), bashPart("c6"),
        appPart("open-2"),
        { type: "text", text: "Here is the calculator.", state: "done" },
      ]),
    ]);
    expect(markup).toContain("Worked for");
    const [app, answer] = order(markup, [APP_MARKER, "Here is the calculator."]);
    expect(app).toBeLessThan(answer);
  });

  test("an App opened after the last prose shows after that prose", () => {
    const markup = renderList([
      user,
      assistant("a-turn", [{ type: "text", text: "Opening the calculator now.", state: "done" }, appPart("open-3")]),
    ]);
    const [prose, app] = order(markup, ["Opening the calculator now.", APP_MARKER]);
    expect(prose).toBeLessThan(app);
  });
});
