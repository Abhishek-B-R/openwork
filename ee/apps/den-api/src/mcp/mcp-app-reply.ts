import type { ExecuteCapabilityToolResult } from "./capability-registry.js"

/**
 * Model-facing note for a result that opens an MCP App. OpenWork shows the App
 * to the person right above the model's reply, so a long reply pushes it out of
 * view. Clients that cannot show Apps still get the App's text after it.
 */
export const MCP_APP_SHOWN_NOTE = "In OpenWork the person now sees this App right above your reply: answer in one or two sentences, and do not repeat what it shows, list its tools, or give its MCP URL unless asked."

/**
 * Adds the note to a successful result that carries an OpenWork App launch.
 * A connection_action launch is OpenWork's own connection card, not an App.
 */
export function withMcpAppShownNote(result: ExecuteCapabilityToolResult): ExecuteCapabilityToolResult {
  const launch = result._meta?.["openwork/mcpApp"]
  if (result.isError === true || !launch || typeof launch !== "object" || ("toolName" in launch && launch.toolName === "connection_action")) return result
  return { ...result, content: [...result.content, { type: "text", text: MCP_APP_SHOWN_NOTE }] }
}
