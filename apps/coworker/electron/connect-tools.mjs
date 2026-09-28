/**
 * The coworker's way to ask for an app it needs: `app_connect` puts a Connect
 * card in the conversation (logo, what the app is for, one button), served on
 * the same loopback MCP server as its documents and memory. The card itself —
 * which account, whether the app is set up, the sign-in — is the app's job in
 * the renderer, from the person's live OpenWork connections; the tool only
 * names the app and why. Nothing here connects anything.
 *
 * No Electron imports: exercised by `node --test electron/connect-tools.test.mjs`.
 */
import { CONNECT_TOOL_NAMES } from "../src/lib/coworker-tools.ts";

const APP_LIMIT = 60;
const REASON_LIMIT = 200;
const CONNECTION_ID_LIMIT = 120;

function clip(value, limit) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, limit) : "";
}

/** The connect tool as the engine lists it; its name matches `src/lib/coworker-tools.ts`. */
export function connectToolCatalog() {
  const [appConnect] = CONNECT_TOOL_NAMES;
  return [{
    name: appConnect,
    description: "Ask the person to connect an app this work needs (Gmail, Slack, Notion, any OpenWork Connect app) that is not connected yet: a Connect card with a sign-in button appears in this conversation. Then say in one line what you will do once it is connected and end the turn; connecting continues the work here. Never send them to a website.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app as the person knows it, e.g. \"Gmail\"." },
        reason: { type: "string", description: "One short sentence: what you will do with it, e.g. \"to read and draft your email\"." },
        connectionId: { type: "string", description: "The connection id from a search or call result, when one named it." },
      },
      required: ["app", "reason"],
      additionalProperties: false,
    },
  }];
}

export function createConnectToolHandlers() {
  const [appConnect] = CONNECT_TOOL_NAMES;
  return {
    [appConnect]: async (_slug, args = {}) => {
      const app = clip(args.app, APP_LIMIT);
      if (!app) throw new Error("Name the app to connect, as the person knows it.");
      const reason = clip(args.reason, REASON_LIMIT);
      const connectionId = clip(args.connectionId, CONNECTION_ID_LIMIT);
      return {
        text: `The person now sees a card to connect ${app} here. Say in one short line what you will do once it is connected, then end this turn. When they connect, the conversation continues with you.`,
        structured: { connect: { app, reason, ...(connectionId ? { connectionId } : {}) } },
      };
    },
  };
}
