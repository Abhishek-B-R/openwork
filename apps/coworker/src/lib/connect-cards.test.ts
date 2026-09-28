import assert from "node:assert/strict";
import { test } from "node:test";
import { connectCardState, connectCardsFromCalls } from "./connect-cards.ts";
import type { CloudConnectionStatus } from "./connection-words.ts";
import type { ConnectorCatalog } from "./marketplace.ts";

const call = (tool: string, fields: { input?: Record<string, unknown>; output?: unknown; metadata?: Record<string, unknown>; status?: string }) =>
  ({ tool, status: fields.status ?? "completed", input: fields.input ?? {}, output: fields.output ?? [], metadata: fields.metadata ?? {} });

const needsGmail: CloudConnectionStatus = {
  connectionId: "google-workspace", connectionName: "Gmail", state: "needs_connection", actor: "member",
  action: { type: "connect", surface: "openwork_your_connections", label: "Connect Gmail" }, message: "You haven't connected your Gmail account yet.",
};

test("a turn asks for each app once, from the coworker's request or from Connect saying it needs the person", () => {
  const cards = connectCardsFromCalls([
    call("coworker_app_connect", { input: { app: "Gmail", reason: "to read and draft your email" }, metadata: { structuredContent: { connect: { app: "Gmail", reason: "to read and draft your email" } } } }),
    // A call that failed for want of the connection says the same thing; it joins the coworker's card.
    call("openwork-cloud_execute_capability", { status: "error", output: [{ type: "text", text: JSON.stringify({ error: "needs_connection", connectionStatus: needsGmail }) }] }),
    // An admin-owned connection gets its own card that names who has to act.
    call("openwork-cloud_execute_capability", { metadata: { structuredContent: { ...needsGmail, connectionId: "slack", connectionName: "Slack", actor: "organization_admin", action: { type: "connect", surface: "openwork_organization_connections" } } } }),
    // An ordinary search lists blocked apps only for information.
    call("openwork-cloud_search_capabilities", { metadata: { structuredContent: { matches: [{ kind: "connection_status", connectionStatus: { ...needsGmail, connectionId: "notion", connectionName: "Notion" } }] } } }),
    call("coworker_app_connect", { status: "running", input: { app: "Linear", reason: "to file the bug" } }),
  ]);
  assert.deepEqual(cards.map((card) => [card.app, card.reason, card.connectionId]), [["Gmail", "to read and draft your email", "google-workspace"], ["Slack", "", "slack"]]);
  assert.equal(cards[0]?.status?.state, "needs_connection");
});

test("a card reads where the app stands for this person, live", () => {
  const [gmail] = connectCardsFromCalls([call("coworker_app_connect", { input: { app: "Gmail", reason: "to triage" } })]);
  assert.ok(gmail);
  const catalog = (connectedForMe: boolean | null): ConnectorCatalog => ({
    signedIn: true, presets: [],
    connections: connectedForMe === null ? [] : [{ id: "google-workspace", name: "Google Workspace", url: "", connected: true, connectedForMe, nativeProviderKey: "google-workspace" }],
  });
  assert.equal(connectCardState(gmail, { signedIn: false, connections: [], presets: [] }).kind, "signin");
  assert.equal(connectCardState(gmail, catalog(null)).kind, "setup");
  assert.deepEqual(connectCardState(gmail, catalog(false)), { kind: "connect", connectionId: "google-workspace", reconnect: false });
  assert.deepEqual(connectCardState(gmail, catalog(true)), { kind: "connected", connectionId: "google-workspace" });
  const expired = { ...gmail, status: { ...needsGmail, state: "reauth_required", action: { type: "reconnect", surface: "openwork_your_connections" } } satisfies CloudConnectionStatus };
  assert.deepEqual(connectCardState(expired, catalog(true)), { kind: "connect", connectionId: "google-workspace", reconnect: true });
  assert.equal(connectCardState(expired, catalog(true), true).kind, "connected", "a finished reconnect reads as connected");
  const adminOwned = { ...gmail, status: { ...needsGmail, actor: "organization_admin" } satisfies CloudConnectionStatus };
  const elsewhere = connectCardState(adminOwned, catalog(false));
  assert.equal(elsewhere.kind, "elsewhere", "someone else has to act, so there is no button");
  assert.match(elsewhere.kind === "elsewhere" ? elsewhere.words : "", /Ask an organization admin/);
});
