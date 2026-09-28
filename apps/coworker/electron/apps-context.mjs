/**
 * A coworker's picture of its apps for this turn, added to its home context:
 * which OpenWork Connect apps are connected for the person, which are set up
 * but waiting on their sign-in, and the one way to use or ask for them. It is
 * built from Den's usable connections (`GET /v1/mcp-connections?scope=usable`),
 * so the coworker knows before it searches, and asks with a Connect card
 * instead of guessing or sending the person to settings.
 *
 * No Electron imports: exercised by `node --test electron/apps-context.test.mjs`.
 */

const LIST_LIMIT = 12;
const NAME_LIMIT = 60;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
}

/** The apps a connection gives, as the person knows them: Google Workspace is Gmail, Calendar and Drive. */
function appsOf(connection) {
  const key = connection.nativeProviderKey ?? connection.id;
  if (key === "google-workspace") return "Gmail, Google Calendar and Google Drive (Google Workspace)";
  if (key === "microsoft-365") return "Outlook (Microsoft 365)";
  return clean(connection.name);
}

function list(connections) {
  const names = [...new Set(connections.map(appsOf).filter(Boolean))];
  return names.length > LIST_LIMIT ? `${names.slice(0, LIST_LIMIT).join("; ")}; and ${names.length - LIST_LIMIT} more` : names.join("; ");
}

const HOW = "Use a connected app through openwork-cloud_search_capabilities, then execute_capability with the exact returned name. When the work needs an app that is not connected yet or not listed, call coworker_app_connect: the person gets a Connect card here. Never ask for keys or passwords, or send them to settings.";

/** The section itself; `connections` is null when the person is not signed in to OpenWork. */
export function appsContext(connections) {
  if (connections === null) {
    return "### Apps (OpenWork Connect)\nThe person is not signed in to OpenWork, so no apps are connected. When the work needs one (Gmail, Slack, Notion…), call coworker_app_connect: the Connect card asks them to sign in first.";
  }
  const connected = connections.filter((connection) => connection.connectedForMe === true);
  const waiting = connections.filter((connection) => connection.connectedForMe !== true);
  return [
    "### Apps (OpenWork Connect, as of this turn)",
    `Connected for the person: ${connected.length ? list(connected) : "none yet"}.`,
    ...(waiting.length ? [`Set up, not connected yet: ${list(waiting)}.`] : []),
    HOW,
  ].join("\n");
}

/**
 * Den read once and kept briefly, so every turn carries a current picture
 * without a request per turn; a failed read keeps the last picture or says
 * nothing rather than delaying the turn.
 */
export function createAppsContext({ currentSession, fetchImpl = fetch, now = Date.now, ttlMs = 15_000, timeoutMs = 3_000 }) {
  let cached = { session: null, at: 0, text: "" };
  return async function read() {
    const session = currentSession();
    if (!session) return appsContext(null);
    if (cached.session === session && now() - cached.at < ttlMs) return cached.text;
    try {
      const response = await fetchImpl(`${session.baseUrl}/v1/mcp-connections?scope=usable`, {
        headers: { Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`OpenWork answered ${response.status}.`);
      const payload = await response.json();
      const connections = Array.isArray(payload?.connections) ? payload.connections.filter((item) => item && typeof item.id === "string") : [];
      if (currentSession() !== session) return "";
      cached = { session, at: now(), text: appsContext(connections) };
      return cached.text;
    } catch {
      return cached.session === session ? cached.text : "";
    }
  };
}
