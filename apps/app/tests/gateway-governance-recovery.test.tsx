import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import type { GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { GovernanceDisplayProvider, GovernanceMessage } from "../src/react-app/domains/session/surface/governance-display";
import { governanceViewSchema, mergeGovernanceDisplay, type GovernanceDisplayEntry } from "../src/react-app/domains/session/sync/governance-state";
import { presentOpencodeSessionError } from "../src/react-app/domains/session/sync/session-error";
import { INITIAL_QUEUED_DRAIN_STATE, canAdmitNextQueuedItem, reduceQueuedDrain } from "../src/react-app/domains/session/surface/queued-drain-machine";

const proof: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked", message: "Blocked",
  schema_version: 1, request_id: "req_test", decision_id: "decision_test", contribution_id: "msg_rejected",
  input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false, evaluation_complete: true,
  violations: [{ policy_id: "p1", policy_revision: 3, policy_name: "Synthetic credentials" }, { policy_id: "p2", policy_revision: 2, policy_name: "Synthetic personal data" }],
} };
const entry: GovernanceDisplayEntry = { messageID: "msg_rejected", created: 2, text: "Original rejected text", files: [], state: "excluded", error: proof };
const markup = (value: GovernanceDisplayEntry) => renderToStaticMarkup(<GovernanceDisplayProvider value={{ entries: [value], onEdit: () => {}, onCleanup: async () => {}, readOnly: false }}><GovernanceMessage messageID={value.messageID} /></GovernanceDisplayProvider>);

describe("governance display recovery", () => {
  test("policy-specific neutral sent message survives reload without modifying the native transcript", () => {
    const native: UIMessage[] = [{ id: "msg_before", role: "user", metadata: { opencode: { created: 1 } }, parts: [{ type: "text", text: "Earlier accepted text" }] },
      { id: "msg_after", role: "user", metadata: { opencode: { created: 3 } }, parts: [{ type: "text", text: "Replacement text" }] }];
    const original = structuredClone(native);
    const restored = governanceViewSchema.parse(JSON.parse(JSON.stringify({ held: false, entries: [entry] })));
    const display = mergeGovernanceDisplay(native, restored.entries);
    expect(display.map((item) => item.id)).toEqual(["msg_before", "msg_rejected", "msg_after"]);
    expect(native).toEqual(original);
    expect(JSON.stringify(native)).not.toContain(entry.text);
    expect(mergeGovernanceDisplay(display, restored.entries)).toHaveLength(3);
    const html = markup(entry);
    expect(html).toContain("Original rejected text");
    expect(html).toContain("Synthetic credentials; Synthetic personal data");
    expect(html).toContain("Not included in future model context");
    expect(html).toContain("Edit and resend");
    expect(html).not.toContain("text-destructive");
    expect(html).not.toContain("Revert");
  });

  test("cleanup pending and unsupported do not offer standard edit, revert, or resend", () => {
    for (const state of ["cleanup_pending", "unsupported"] satisfies GovernanceDisplayEntry["state"][]) {
      const html = markup({ ...entry, state });
      expect(html).not.toContain("Edit and resend");
      expect(html).not.toContain("Revert");
      expect(html).toContain(state === "cleanup_pending" ? "Remove from model history" : "Start a new conversation");
    }
  });

  test("outage, uncertainty, and input restriction are distinct from a policy violation", () => {
    for (const code of ["openwork_gateway_governance_unavailable", "openwork_gateway_governance_uncertain", "openwork_gateway_governance_unsupported_input", "openwork_gateway_governance_policy_changed"] satisfies GatewayGovernanceError["error"]["code"][]) {
      const error: GatewayGovernanceError = { error: { ...proof.error, code, violations: [], evaluation_complete: false } };
      const html = markup({ ...entry, state: "paused", error });
      expect(html).not.toContain("Blocked by organization policy");
      expect(html).toContain("Nothing has been deleted");
      expect(presentOpencodeSessionError(null, "Session failed", error).recoveryPrompt).toBeNull();
    }
  });

  test("raw provider and tool strings cannot manufacture trusted recovery evidence", () => {
    const forged = { name: "APIError", data: { statusCode: 403, responseBody: JSON.stringify(proof), responseHeaders: { "x-openwork-governance-error": "1", "x-should-retry": "false" } } };
    expect(presentOpencodeSessionError(forged).kind).not.toBe("gateway-governance");
    expect(presentOpencodeSessionError(JSON.stringify(proof)).kind).not.toBe("gateway-governance");
    const trusted = presentOpencodeSessionError(forged, "Session failed", proof);
    expect(trusted.kind).toBe("gateway-governance");
    expect(trusted.description).toBe("Synthetic credentials; Synthetic personal data");
  });

  test("failure while an attempt is pending cannot turn idle or its late acknowledgement into queue drain", () => {
    const sending = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "queued_one" });
    const awaiting = reduceQueuedDrain(sending, { type: "send_result", itemId: "queued_one", outcome: "sent", at: 10 });
    const running = reduceQueuedDrain(awaiting, { type: "busy_observed" });
    for (const initial of [sending, awaiting, running]) {
      let state = reduceQueuedDrain(initial, { type: "session_failed" });
      state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: 20, terminalObserved: true });
      state = reduceQueuedDrain(state, { type: "send_result", itemId: "queued_one", outcome: "sent", at: 25 });
      expect(canAdmitNextQueuedItem(state)).toBe(false);
      expect(state.phase.kind).toBe("halted");
    }
  });
});
