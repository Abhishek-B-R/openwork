import type { Seed } from "@openwork/env";
import { connectorBranding } from "./library.ts";
import { fixtureInputFocus } from "./chat.ts";
import { browserScript } from "@openwork/cdp";

/** Own a known destination so fixture navigation cannot race the first keystroke. */
export async function connectorActivity(seed: Seed) {
  const base = await connectorBranding(seed);
  const session = await seed.session(base.app, { title: "Connector activity" });
  return { ...base, session, inputFocus: () => fixtureInputFocus(seed, base.app),
    nativeTools: () => seed.evalIn(base.app, browserScript(async (workspaceId, sessionId, engine) => {
      const response = await fetch("http://127.0.0.1:" + localStorage.getItem("openwork.server.port") + "/workspace/" + encodeURIComponent(workspaceId)
        + (engine === "v2" ? "/opencode2/api" : "/opencode") + "/session/" + encodeURIComponent(sessionId) + "/message?limit=50", {
        headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") },
      });
      if (!response.ok) throw new Error("Could not inspect native connector fixture calls");
      const raw = await response.json();
      return (Array.isArray(raw) ? raw : raw.data ?? []).flatMap((message: { parts?: { type: string; tool?: string; state?: unknown }[]; content?: { type: string; name?: string; state?: unknown }[] }) =>
        (message.parts ?? message.content ?? []).filter(part => part.type === "tool")
          .map(part => ({ tool: "tool" in part ? part.tool : "name" in part ? part.name : undefined, state: part.state })));
    }, [base.workspace.workspaceId, session.sessionId, base.engine]), { awaitPromise: true }),
  };
}
