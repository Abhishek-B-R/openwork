import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { GovernanceDisplayProvider, GovernanceMessage } from "../src/react-app/domains/session/surface/governance-display";
import { governanceRetryAction, readGovernanceView, type GovernanceDisplayEntry } from "../src/react-app/domains/session/sync/governance-state";

const blocked: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked", message: "Blocked",
  schema_version: 1, request_id: "req_test", decision_id: "decision_test", contribution_id: "msg_rejected",
  input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false, evaluation_complete: true,
  violations: [{ policy_id: "p1", policy_revision: 3, policy_name: "Synthetic credentials" }],
} };
const outcome = (code: GatewayGovernanceError["error"]["code"]): GatewayGovernanceError => ({ error: { ...blocked.error, code, evaluation_complete: false, violations: [] } });
const entry: GovernanceDisplayEntry = { messageID: "msg_rejected", created: 2, text: "Original rejected text", files: [], state: "cleanup_pending", error: blocked };
const markup = (value: GovernanceDisplayEntry) => renderToStaticMarkup(<GovernanceDisplayProvider value={{ entries: [value], onEdit: () => {}, onCleanup: async () => {},
  onRetry: async () => {}, readOnly: false }}><GovernanceMessage messageID={value.messageID} /></GovernanceDisplayProvider>);
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("automatic removal display", () => {
  test("while the host removes the blocked message automatically, the message stays in place with no manual step", () => {
    const html = markup({ ...entry, autoCleanup: true });
    expect(html).toContain("Original rejected text");
    expect(html).toContain("Synthetic credentials");
    expect(html).toContain('data-governance-state="cleanup_pending"');
    expect(html).not.toContain("Remove from model history");
    expect(html).not.toContain("Edit and resend");
    expect(html).not.toMatch(/Removing|Preparing|…/);
  });

  test("manual removal is only the fallback when automatic removal could not complete", () => {
    const fallback = markup(entry);
    expect(fallback).toContain("Couldn’t remove this message from model history automatically.");
    expect(fallback).toContain("Remove from model history");
    const uncertain = markup({ ...entry, deleteAttempted: ["msg_placeholder"] });
    expect(uncertain).toContain("Check status");
    expect(uncertain).not.toContain("Remove from model history");
    const excluded = markup({ ...entry, state: "excluded" });
    expect(excluded).toContain("Edit and resend");
    expect(excluded).toContain('data-governance-state="excluded"');
  });
});

describe("in-place retry display for outcomes that are not violations", () => {
  test("outages and policy changes offer Try again; uncertain and unsupported input offer Edit message", () => {
    const cases: [GatewayGovernanceError["error"]["code"], string][] = [
      ["openwork_gateway_governance_unavailable", "Try again"], ["openwork_gateway_governance_policy_changed", "Try again"],
      ["openwork_gateway_governance_uncertain", "Edit message"], ["openwork_gateway_governance_unsupported_input", "Edit message"],
    ];
    for (const [code, label] of cases) {
      const html = markup({ ...entry, state: "paused", error: outcome(code) });
      expect(html).toContain(label);
      expect(html).toContain("Nothing has been deleted");
      expect(html).not.toContain("Blocked by organization policy");
      expect(html).not.toContain("Policies:");
      expect(html).not.toContain("Remove from model history");
      expect(html).not.toContain("text-destructive");
    }
  });

  test("an unconfirmed retry removal offers only a status check, and unsafe history falls back to a new conversation", () => {
    const paused: GovernanceDisplayEntry = { ...entry, state: "paused", error: outcome("openwork_gateway_governance_unavailable") };
    expect(markup({ ...paused, deleteAttempted: ["msg_rejected"] })).toContain("Check status");
    expect(markup({ ...paused, deleteAttempted: ["msg_rejected"] })).not.toContain("Try again");
    const unsupported = markup({ ...paused, state: "unsupported" });
    expect(unsupported).toContain("Start a new conversation");
    expect(unsupported).not.toContain("Try again");
    expect(unsupported).not.toContain("Blocked by organization policy");
    expect(markup({ ...paused, correlation: "session" })).not.toContain("Try again");
  });

  test("retry mapping never applies to a policy block or a session-only rejection", () => {
    expect(governanceRetryAction({ ...entry, state: "paused" })).toBeNull();
    expect(governanceRetryAction({ ...entry, state: "paused", error: outcome("openwork_gateway_governance_unavailable"), correlation: "session" })).toBeNull();
    expect(governanceRetryAction({ ...entry, state: "paused", error: outcome("openwork_gateway_governance_uncertain") })).toBe("edit");
    expect(governanceRetryAction({ ...entry, state: "paused", error: outcome("openwork_gateway_governance_policy_changed") })).toBe("resend");
  });

  test("retry asks the host to remove exactly one named attempt", async () => {
    const requests: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
      return Response.json({ held: false, entries: [] });
    }, originalFetch);
    await readGovernanceView("http://127.0.0.1:4096/workspace/ws/opencode", "ses_test", "token", { intent: "retry", messageID: "msg_rejected" });
    await readGovernanceView("http://127.0.0.1:4096/workspace/ws/opencode", "ses_test", "token", true);
    expect(requests).toEqual([
      { url: "http://127.0.0.1:4096/workspace/ws/opencode/session/ses_test/governance/cleanup", method: "POST", body: JSON.stringify({ intent: "retry", messageID: "msg_rejected" }) },
      { url: "http://127.0.0.1:4096/workspace/ws/opencode/session/ses_test/governance/cleanup", method: "POST", body: "{}" },
    ]);
  });
});
