import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DynamicToolUIPart } from "ai";

import { CodeModeTool } from "../src/components/chat/code-mode-tool";
import { CapabilityCallLine } from "../src/components/chat/capability-call-line";
import { ToolResultPreview } from "../src/components/chat/tool-result-preview";
import {
  buildConnectorToolIdentities,
  resolveConnectorToolIdentity,
} from "../src/react-app/domains/connections/connector-tool-identity";

test("renders probe branding and accessible human labels in every state", () => {
  const base = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "probe-ui",
    input: { name: "mcp:emc_probe:*" },
  } satisfies Partial<DynamicToolUIPart>;
  const parts: DynamicToolUIPart[] = [
    { ...base, state: "input-available" },
    { ...base, state: "output-available", output: {} },
    { ...base, state: "output-error", errorText: "Probe failed" },
  ];
  const connector = {
    id: "connection:emc_probe", connectionId: "emc_probe", name: "Notion",
    iconUrl: "/ext-notion.svg", serviceUrl: null, toolNamespace: null,
  };
  for (const part of parts) {
    const label = part.state === "input-available" ? "Checking Notion connection…"
      : part.state === "output-error" ? "Couldn&#x27;t check Notion connection" : "Checked Notion connection";
    const html = renderToStaticMarkup(<CapabilityCallLine part={part} connector={connector} />);
    expect(html).toContain('data-connector-name="Notion"');
    expect(html).toContain("/ext-notion.svg");
    expect(html).toContain(label);
    expect(html).toContain(`aria-label="${label}.`);
    expect(html).not.toContain("Used *");
    expect(html).not.toContain("mcp:emc_probe:*");
    expect(html).not.toContain("Waiting for your action");
  }
  const html = renderToStaticMarkup(<CapabilityCallLine part={parts[0]!} statusUnknown />);
  expect(html).toContain("status unavailable");
  expect(html).not.toContain("animate-spin");
});

test("valid probe payload names do not brand unknown connections", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "unknown-probe",
    state: "output-available", input: { name: "mcp:emc_unknown:*" },
    output: { connectionStatus: {
      schemaVersion: "1", connectionId: "emc_unknown", connectionName: "Notion",
      state: "connected", actor: null, message: "Connected", action: null,
    } },
  };
  const inventory = buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] });
  const connector = resolveConnectorToolIdentity(part, inventory);
  expect(connector).toBeNull();
  const html = renderToStaticMarkup(<CapabilityCallLine part={part} connector={connector} />);
  expect(html).toContain("Checked connection");
  expect(html).not.toContain("Notion");
  expect(html).not.toContain("ext-notion.svg");
  expect(html).not.toContain("emc_unknown");
  const known = resolveConnectorToolIdentity(part, [{
    id: "connection:emc_unknown", connectionId: "emc_unknown", name: "Notion",
    iconUrl: "/ext-notion.svg", serviceUrl: null, toolNamespace: null,
  }]);
  const knownHtml = renderToStaticMarkup(<CapabilityCallLine part={part} connector={known} />);
  expect(knownHtml).toContain("Checked Notion connection");
  expect(knownHtml).toContain('data-connector-name="Notion"');
  expect(knownHtml).toContain("/ext-notion.svg");
});

test("unfinished code mode calls do not resume animating after interruption", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability_script", toolCallId: "script",
    state: "input-available", input: {},
  };
  const call: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "nested",
    state: "input-available", input: { name: "mcp:emc_probe:*" },
  };
  for (const lifecycle of [null, "interrupted"] satisfies Array<null | "interrupted">) {
    const html = renderToStaticMarkup(<CodeModeTool part={part} calls={[call]} lifecycle={lifecycle} connectors={[]} />);
    expect(html.toLowerCase()).toContain("status unavailable");
    expect(html).toContain("Checking connection");
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("Task interrupted");
    expect(html).not.toContain("Completed");
  }
});

test("code-mode mutations summarize the outcome, not the last lookup, and fold when finished", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script-write", state: "output-available", input: { code: "return await tools.linear.create_note({})" }, output: "Saved" };
  const calls: DynamicToolUIPart[] = [
    { type: "dynamic-tool", toolName: "linear_create_note", toolCallId: "create", state: "output-available", input: {}, output: undefined },
    { type: "dynamic-tool", toolName: "linear_list_teams", toolCallId: "read", state: "output-available", input: {}, output: undefined },
  ];
  const html = renderToStaticMarkup(<CodeModeTool part={part} calls={calls} lifecycle={null} connectors={[]} />);
  expect(html).toContain("Created a note in Linear");
  expect(html).toContain("Show steps");
  expect(html).not.toContain("List teams. Show");
  expect(html).not.toContain("Tool activity");
  expect(html).not.toContain("text-destructive");
});

test("code-mode failures remain neutral and do not hide the failed call", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "script-retry", state: "input-available", input: { code: "retry" } };
  const calls: DynamicToolUIPart[] = [
    { type: "dynamic-tool", toolName: "linear_get_note", toolCallId: "first", state: "output-error", input: {}, errorText: "Missing" },
    { type: "dynamic-tool", toolName: "linear_list_teams", toolCallId: "second", state: "input-available", input: {} },
  ];
  const html = renderToStaticMarkup(<CodeModeTool part={part} calls={calls} lifecycle="running" connectors={[]} />);
  expect(html).toContain("1 failed call");
  expect(html).toContain("Couldn&#x27;t");
  expect(html).toContain("ow-text-shimmer");
  expect(html).not.toContain("text-destructive");
  expect(html).not.toContain("Completed with errors");
});

test("renders a connector logo beside a human-readable completed tool call", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "call-google-calendar",
    state: "output-available",
    input: { name: "getCapabilitiesGoogleWorkspaceCalendarEvents", body: {} },
    output: { events: [] },
  };
  const identity = resolveConnectorToolIdentity(
    part,
    buildConnectorToolIdentities({ mcpServers: [], orgConnections: [] }),
  );
  const html = renderToStaticMarkup(<CapabilityCallLine part={part} connector={identity} />);

  expect(html).toContain('data-connector-name="Google Workspace"');
  expect(html).toContain("ext-google-workspace.svg");
  expect(html).toContain("Fetched Google Workspace Calendar Events");
});

test("ordinary preserved MCP content remains a bounded readable result instead of becoming an App", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "notes_list", toolCallId: "ordinary-mcp", state: "output-available", input: {}, output: "native output",
    callProviderMetadata: { openwork: { mcpResult: { content: [{ type: "text", text: "Exact fixture note. " + "x".repeat(3_000) }] } } } };
  const html = renderToStaticMarkup(<ToolResultPreview part={part} />);
  expect(html).toContain("Exact fixture note.");
  expect(html).toContain("More in Technical details");
  expect(html).not.toContain("x".repeat(3_000));
});

test("a known execution route is disclosed without guessing from a service name", () => {
  const base: DynamicToolUIPart = { type: "dynamic-tool", toolName: "notes_list", toolCallId: "route", state: "output-available", input: {}, output: "Fixture notes" };
  const unknown = renderToStaticMarkup(<CapabilityCallLine part={base} />);
  expect(unknown).not.toContain("via OpenWork Cloud");
  expect(unknown).not.toContain("on this computer");
  const known = renderToStaticMarkup(<CapabilityCallLine part={{ ...base, callProviderMetadata: { openwork: { executionSource: "cloud" } } }} />);
  expect(known).toContain("via OpenWork Cloud");
});

test("an exact Cloud catalog connection and its gateway call disclose the route", () => {
  const connector = { id: "connection:fixture", name: "Slack", connectionId: "fixture", toolNamespace: null, iconUrl: null, serviceUrl: "https://fixture.invalid/mcp", executionSource: "cloud" as const };
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "catalog-route", state: "output-available",
    input: { name: "mcp:fixture:list_channels" }, output: "Fixture channels" };
  expect(renderToStaticMarkup(<CapabilityCallLine part={part} connector={connector} />)).toContain("via OpenWork Cloud");
  expect(renderToStaticMarkup(<CapabilityCallLine part={{ ...part, input: { name: "mcp:other:list_channels" } }} connector={connector} />)).not.toContain("via OpenWork Cloud");
  expect(renderToStaticMarkup(<CapabilityCallLine part={{ ...part, toolName: "slack_list_channels" }} connector={connector} />)).not.toContain("via OpenWork Cloud");
});

test("the first code-mode invocation keeps its DOM identity when a second call starts", async () => {
  const ownsDom = typeof window === "undefined";
  if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const previous = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "steady-script", state: "input-available", input: {} };
  const call: DynamicToolUIPart = { type: "dynamic-tool", toolName: "notes_list", toolCallId: "steady-script:call:0", state: "input-available", input: {} };
  try {
    await act(async () => root.render(<CodeModeTool part={part} calls={[call]} lifecycle="running" connectors={[]} />));
    const first = container.querySelector('[data-code-mode-invocation="steady-script:call:0"]');
    expect(first).not.toBeNull();
    await act(async () => root.render(<CodeModeTool part={part} calls={[{ ...call, state: "output-available", output: "Fixture notes" }, { ...call, toolCallId: "steady-script:call:1" }]} lifecycle="running" connectors={[]} />));
    expect(container.querySelector('[data-code-mode-invocation="steady-script:call:0"]')).toBe(first);
    expect(container.querySelectorAll("[data-code-mode-invocation]")).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    if (ownsDom) GlobalRegistrator.unregister();
  }
});


test("an execution without nested calls exposes its exact result without an empty call group", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "plain-execution", state: "output-available", input: { code: "return fixtureVersion" }, output: "Fixture version 3" };
  const html = renderToStaticMarkup(<CodeModeTool part={part} calls={[]} lifecycle={null} connectors={[]} />);
  expect(html).toContain("Fixture version 3");
  expect(html).toContain("Technical details");
  expect(html).not.toContain("0 steps");
});


test("catalog previews use recorded descriptions and keep capability identifiers in technical details", () => {
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork_cloud_search_capabilities", toolCallId: "catalog-preview", state: "output-available", input: {}, output: { content: [{ type: "text", text: JSON.stringify({ matches: [{ name: "mcp:fixture:list_channels", summary: "List the workspace channels" }] }) }] } };
  const html = renderToStaticMarkup(<ToolResultPreview part={part} />);
  expect(html).toContain("List the workspace channels");
  expect(html).not.toContain("mcp:fixture:list_channels");
});
