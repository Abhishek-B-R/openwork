import { gatewayGovernanceErrorSchema, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import type { GovernanceV2Report } from "../governance-recovery.js";
import { record } from "../gateway-quota.js";

export class GovernanceRecoveryHeldError extends Error {
  constructor() { super("Organization policy recovery is required. Review this conversation or start a new one."); }
}

export type GovernanceReportReply = { recorded: boolean; blocked?: GatewayGovernanceError; contribution?: string };

async function sendReport(path: string, body: unknown): Promise<GovernanceReportReply> {
  const base = process.env.OPENWORK_SERVER_URL;
  const token = process.env.OPENWORK_GOVERNANCE_TOKEN;
  if (!base || !token) return { recorded: false };
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
  } catch { return { recorded: false }; }
  if (response.status === 409) {
    await response.body?.cancel();
    throw new GovernanceRecoveryHeldError();
  }
  if (!response.ok) { await response.body?.cancel(); return { recorded: false }; }
  try {
    const payload: unknown = await response.json();
    if (!record(payload) || payload.recorded !== true) return { recorded: false };
    const contribution = typeof payload.contribution === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(payload.contribution) ? payload.contribution : undefined;
    if (payload.contribution !== undefined && !contribution) return { recorded: false };
    if (payload.blocked === undefined) return { recorded: true, ...(contribution ? { contribution } : {}) };
    const parsed = gatewayGovernanceErrorSchema.safeParse(payload.blocked);
    return parsed.success ? { recorded: true, blocked: parsed.data } : { recorded: false };
  } catch { return { recorded: false }; }
}

export function reportGovernanceV2(report: GovernanceV2Report) {
  return sendReport("/gateway-governance/report-v2", report);
}
export function reportGovernanceNotice(report: GovernanceV2Report) {
  return sendReport("/gateway-governance/notice", report);
}
export type GovernanceAttempt = { directory: string; sessionID: string; messageID?: string; agent: string };
export function reportGovernance(attempt: GovernanceAttempt, requestID: string, phase: "begin" | "finish", error?: GatewayGovernanceError, correlated = false, outcome?: "response" | "transport_failed") {
  return sendReport("/gateway-governance/report", { ...attempt, requestID, phase, correlated, ...(error ? { error } : {}), ...(outcome ? { outcome } : {}) });
}
