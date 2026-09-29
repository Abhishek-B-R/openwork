import { z } from "zod";
import type { UIMessage } from "ai";
import { gatewayGovernanceErrorSchema, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { createDesktopFetch } from "@/app/lib/opencode";
import { getMessageCreated } from "@/components/chat/utils";
import { presentOpencodeSessionError } from "./session-error";

export const governanceViewSchema = z.object({
  held: z.boolean(), unsupported: z.boolean().optional(),
  entries: z.array(z.object({
    messageID: z.string(), created: z.number(), text: z.string(), correlation: z.enum(["message", "session"]).optional(),
    files: z.array(z.object({ filename: z.string(), mime: z.string(), url: z.string() })),
    state: z.enum(["checking", "allowed", "cleanup_pending", "excluded", "paused", "unsupported", "withdrawn"]),
    error: gatewayGovernanceErrorSchema.nullable(), deleteAttempted: z.array(z.string()).optional(),
    autoCleanup: z.boolean().optional(),
  })),
});
export type GovernanceView = z.infer<typeof governanceViewSchema>;
export type GovernanceDisplayEntry = GovernanceView["entries"][number];
export type GovernanceCleanup = false | true | { intent: "retry"; messageID: string };
export const governanceQueryPrefix = ["local-governance-display"];
export function governanceTitle(error: GatewayGovernanceError | null) {
  return error ? presentOpencodeSessionError(null, "Session failed", error).title : "Message outcome needs review";
}
export function isGovernancePolicyBlock(error: GatewayGovernanceError | null) {
  return error?.error.code === "openwork_gateway_governance_blocked" && error.error.evaluation_complete && error.error.violations.length > 0;
}
/** Outcomes that are not violations: an outage or policy change can be sent
 * again unchanged; an uncertain or unsupported input needs editing first. */
export function governanceRetryAction(entry: GovernanceDisplayEntry): "resend" | "edit" | null {
  if (entry.state !== "paused" || entry.correlation === "session" || !entry.error || isGovernancePolicyBlock(entry.error)) return null;
  const code = entry.error.error.code;
  return code === "openwork_gateway_governance_unavailable" || code === "openwork_gateway_governance_policy_changed" ? "resend" : "edit";
}
export async function readGovernanceView(baseUrl: string, sessionID: string, token?: string, cleanup: GovernanceCleanup = false): Promise<GovernanceView> {
  const response = await createDesktopFetch({ mode: "openwork", token })(`${baseUrl.replace(/\/+$/, "")}/session/${encodeURIComponent(sessionID)}/governance${cleanup ? "/cleanup" : ""}`, {
    method: cleanup ? "POST" : "GET",
    ...(cleanup ? { headers: { "content-type": "application/json" }, body: JSON.stringify(cleanup === true ? {} : cleanup) } : {}),
  });
  if (response.status === 404) return { held: false, entries: [], unsupported: true };
  if (!response.ok) throw new Error("Couldn’t verify organization policy recovery. Check again before sending.");
  return governanceViewSchema.parse(await response.json());
}
export function mergeGovernanceDisplay(messages: UIMessage[], entries: GovernanceDisplayEntry[]): UIMessage[] {
  const result = [...messages];
  for (const entry of entries) {
    if (!entry.error && entry.state === "checking") continue;
    if (result.some((message) => message.id === entry.messageID)) continue;
    const message: UIMessage = { id: entry.messageID, role: "user", metadata: { opencode: { created: entry.created } }, parts: [{ type: "text", text: entry.text }] };
    const index = result.findIndex((candidate) => (getMessageCreated(candidate) ?? 0) > entry.created);
    result.splice(index < 0 ? result.length : index, 0, message);
  }
  return result;
}
