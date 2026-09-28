/**
 * Connect cards: an app the work needs, shown in the conversation with its
 * logo and one button. A card comes from the coworker asking for the app
 * (`coworker_app_connect`) or from OpenWork Connect saying a connection needs
 * the person (a status probe, a call that failed for want of a connection, or a
 * search made to connect). Whether it can be connected right now is read live
 * from the person's OpenWork connections, never from the transcript.
 */
import { coworkerToolName } from "./coworker-tools.ts";
import { connectionStatusWords, parseCloudConnectionStatus, type CloudConnectionStatus } from "./connection-words.ts";
import { keptResult } from "./documents.ts";
import { CONNECTORS, connectionFor, setupPath, type ConnectorCatalog, type MarketplaceConnector } from "./marketplace.ts";

type ToolCallLike = { tool: string; status: string; input: Record<string, unknown>; output: unknown; metadata: Record<string, unknown> };

export type ConnectCardData = {
  /** One card per app in a turn: the connection id when known, otherwise the app's name. */
  key: string;
  app: string;
  /** What the coworker will do with it, in its words ("to read and draft your email"). */
  reason: string;
  connectionId: string | null;
  /** OpenWork Connect's own status, when the card came from it: who has to act, and what it said. */
  status: CloudConnectionStatus | null;
};

export type ConnectCardState =
  | { kind: "signin" }
  | { kind: "connected"; connectionId: string | null }
  | { kind: "connect"; connectionId: string; reconnect: boolean }
  | { kind: "setup"; path: string }
  | { kind: "elsewhere"; words: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const settled = (status: string) => ["completed", "success", "succeeded", "error", "failed"].includes(status);

/** The JSON a Connect tool answered in text, when its structured result was not kept. */
function jsonFromContent(content: readonly unknown[]): Record<string, unknown> | null {
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(part.text);
      if (isRecord(parsed)) return parsed;
    } catch { /* Plain words, not a status. */ }
  }
  return null;
}

/** Connection statuses a Connect result carries: the payload itself, its `connectionStatus`, or a search's `connectionAction`. */
function statusesIn(call: ToolCallLike): CloudConnectionStatus[] {
  const kept = keptResult(call);
  const payload = kept?.structuredContent ?? jsonFromContent(kept?.content ?? (Array.isArray(call.output) ? call.output : []))
    ?? (typeof call.output === "string" ? jsonFromContent([{ type: "text", text: call.output }]) : null);
  if (!payload) return [];
  // An ordinary search only lists blocked apps for information; a search made to connect names one.
  const candidates = call.tool.endsWith("search_capabilities")
    ? [payload.connectionAction, isRecord(payload.connectionAction) ? payload.connectionAction.connectionStatus : undefined]
    : [payload, payload.connectionStatus];
  return candidates.map(parseCloudConnectionStatus).filter((status): status is CloudConnectionStatus => status !== null && status.state !== "provider_error");
}

/** The Connect cards one turn's tool calls ask for, one per app, in the order they were asked. */
export function connectCardsFromCalls(calls: readonly ToolCallLike[]): ConnectCardData[] {
  const cards: ConnectCardData[] = [];
  const add = (card: ConnectCardData) => {
    const same = cards.find((existing) => existing.key === card.key || existing.app.toLowerCase() === card.app.toLowerCase()
      || (card.connectionId !== null && existing.connectionId === card.connectionId));
    if (!same) { cards.push(card); return; }
    same.reason ||= card.reason;
    same.connectionId ??= card.connectionId;
    same.status ??= card.status;
  };
  for (const call of calls) {
    if (!settled(call.status)) continue;
    if (coworkerToolName(call.tool) === "app_connect") {
      const kept = keptResult(call);
      if (kept?.isError || call.status === "error" || call.status === "failed") continue;
      const connect = isRecord(kept?.structuredContent?.connect) ? kept.structuredContent.connect : call.input;
      const app = typeof connect.app === "string" ? connect.app.trim() : "";
      if (!app) continue;
      const connectionId = typeof connect.connectionId === "string" && connect.connectionId.trim() ? connect.connectionId.trim() : null;
      add({ key: connectionId ?? app.toLowerCase(), app, reason: typeof connect.reason === "string" ? connect.reason.trim() : "", connectionId, status: null });
      continue;
    }
    if (!call.tool.startsWith("openwork-cloud_")) continue;
    for (const status of statusesIn(call)) add({ key: status.connectionId, app: status.connectionName, reason: "", connectionId: status.connectionId, status });
  }
  return cards;
}

/** The catalog entry behind a card (for its logo and description), by name first, then by its connection. */
export function connectorForCard(card: Pick<ConnectCardData, "app" | "connectionId">, catalog: ConnectorCatalog): MarketplaceConnector | undefined {
  const name = card.app.trim().toLowerCase();
  const exact = CONNECTORS.find((entry) => entry.name.toLowerCase() === name || entry.id === name.replace(/\s+/g, "-"));
  if (exact) return exact;
  if (card.connectionId) {
    const byConnection = CONNECTORS.filter((entry) => connectionFor(entry, catalog.connections, catalog.presets)?.id === card.connectionId);
    const named = byConnection.find((entry) => name.includes(entry.name.toLowerCase()));
    if (named ?? byConnection[0]) return named ?? byConnection[0];
  }
  return CONNECTORS.find((entry) => entry.target.kind !== "built-in" && name.includes(entry.name.toLowerCase()));
}

/** Where a card stands for this person right now. */
export function connectCardState(card: ConnectCardData, catalog: ConnectorCatalog, renewed = false): ConnectCardState {
  // Someone other than the person has to act (an admin, the provider): say who, offer no button.
  if (card.status && card.status.actor !== "member") return { kind: "elsewhere", words: connectionStatusWords(card.status).humanAction };
  if (!catalog.signedIn) return { kind: "signin" };
  const entry = connectorForCard(card, catalog);
  if (entry?.target.kind === "built-in") return { kind: "connected", connectionId: null };
  const connection = (entry ? connectionFor(entry, catalog.connections, catalog.presets) : undefined)
    ?? catalog.connections.find((candidate) => candidate.id === card.connectionId || candidate.name.toLowerCase() === card.app.trim().toLowerCase());
  if (!connection) return { kind: "setup", path: entry ? setupPath(entry) : "/dashboard/library/connectors/new" };
  if (!connection.connectedForMe) return { kind: "connect", connectionId: connection.id, reconnect: false };
  if (card.status?.state === "reauth_required" && !renewed) return { kind: "connect", connectionId: connection.id, reconnect: true };
  return { kind: "connected", connectionId: connection.id };
}

/** Who the person signs in with for a connector, in the button's words. */
export function signInWith(entry: MarketplaceConnector | undefined, app: string): string {
  if (entry?.target.kind === "google-workspace") return "Google";
  if (entry?.target.kind === "microsoft-365") return "Microsoft";
  return entry?.name ?? app;
}
