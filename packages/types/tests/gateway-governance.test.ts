import { expect, test } from "bun:test"
import {
  decodeGatewayGovernanceEngineBody,
  encodeGatewayGovernanceEngineBody,
  gatewayGovernanceEngineStatus,
  gatewayGovernanceDecisionListQuerySchema,
  gatewayGovernanceDecisionListResponseSchema,
  gatewayGovernanceDecisionSchema,
  gatewayGovernanceErrorSchema,
  gatewayGovernanceOverviewSchema,
  gatewayGovernancePolicyPatchSchema,
  gatewayGovernancePolicyWriteSchema,
  gatewayGovernanceSettingsPatchSchema,
  hasGatewayGovernanceHttpMarker,
  type GatewayGovernanceDecision,
  type GatewayGovernanceError,
  type GatewayGovernancePolicy,
} from "../src/den/gateway-governance"

const policy: GatewayGovernancePolicy = {
  id: "policy_fixture", name: "Credentials", guidance: "Block access credentials.", status: "active", revision: 1,
  createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z",
}
const envelope: GatewayGovernanceError = { error: {
  source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked",
  message: "Blocked by organization policy.", schema_version: 1, request_id: "request_fixture", decision_id: "decision_fixture",
  contribution_id: "contribution_fixture", input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false,
  evaluation_complete: true, violations: [{ policy_id: policy.id, policy_revision: 1, policy_name: policy.name }],
} }

test("policy writes and patches are strict, bounded, and revisioned", () => {
  expect(gatewayGovernancePolicyWriteSchema.parse({ name: " Rule ", guidance: " Guidance " })).toEqual({ name: "Rule", guidance: "Guidance" })
  for (const input of [
    { name: "", guidance: "x" }, { name: "x".repeat(121), guidance: "x" },
    { name: "x", guidance: " " }, { name: "x", guidance: "x".repeat(4001) },
    { name: "x", guidance: "x", organizationId: "other" }, { name: "x", guidance: "x", status: "active" },
  ]) expect(gatewayGovernancePolicyWriteSchema.safeParse(input).success).toBe(false)
  expect(gatewayGovernancePolicyPatchSchema.safeParse({ expectedRevision: 1 }).success).toBe(false)
  expect(gatewayGovernancePolicyPatchSchema.safeParse({ expectedRevision: 0, status: "active" }).success).toBe(false)
  expect(gatewayGovernancePolicyPatchSchema.parse({ expectedRevision: 1, status: "archived" }).status).toBe("archived")
  expect(gatewayGovernanceSettingsPatchSchema.safeParse({ expectedRevision: 1, enabled: "false" }).success).toBe(false)
  expect(gatewayGovernanceSettingsPatchSchema.safeParse({ expectedRevision: 1, enabled: true, processingAcknowledged: "true" }).success).toBe(false)
})

test("overview requires known settings and bounds active policies without capping archives", () => {
  const overview = { settings: { enabled: false, revision: 1, policySetRevision: 1 }, policies: [], availability: { available: false, mode: "disabled", reason: "module_disabled" } }
  expect(gatewayGovernanceOverviewSchema.safeParse(overview).success).toBe(true)
  expect(gatewayGovernanceOverviewSchema.safeParse({ ...overview, settings: undefined }).success).toBe(false)
  expect(gatewayGovernanceOverviewSchema.safeParse({ ...overview, policies: Array.from({ length: 21 }, (_, index) => ({ ...policy, id: `policy_${index}` })) }).success).toBe(false)
  expect(gatewayGovernanceOverviewSchema.safeParse({ ...overview, policies: Array.from({ length: 21 }, (_, index) => ({ ...policy, id: `policy_${index}`, status: "archived" })) }).success).toBe(true)
})

test("error envelope preserves all bounded policy references and rejects raw-content fields", () => {
  expect(gatewayGovernanceErrorSchema.parse(envelope)).toEqual(envelope)
  for (const patch of [
    { source: "other" }, { schema_version: 2 }, { retryable: true }, { upstream_dispatched: true },
    { message: "x".repeat(4097) }, { prompt: "private input" }, { guidance: "private rule" },
    { contribution_id: "bad\nheader" }, { request_id: "x".repeat(129) },
    { violations: Array(21).fill(envelope.error.violations[0]) },
    { violations: [{ ...envelope.error.violations[0], guidance: "private rule" }] },
  ]) expect(gatewayGovernanceErrorSchema.safeParse({ error: { ...envelope.error, ...patch } }).success).toBe(false)
})

test("HTTP recognition requires both reserved nonretry markers and a supported status", () => {
  const headers = { "x-openwork-governance-error": "1", "x-should-retry": "false" }
  for (const status of [403, 422, 503]) expect(hasGatewayGovernanceHttpMarker(new Response(null, { status, headers }))).toBe(true)
  expect(hasGatewayGovernanceHttpMarker(new Response(null, { status: 400, headers }))).toBe(false)
  expect(hasGatewayGovernanceHttpMarker(new Response(null, { status: 403, headers: { "x-openwork-governance-error": "1" } }))).toBe(false)
})

test("decision records expose metadata only and page with bounded opaque cursors", () => {
  const decision: GatewayGovernanceDecision = {
    decisionId: "decision_fixture", createdAt: "2026-09-29T00:00:00.000Z", route: "provider", outcome: "blocked",
    memberId: "member_fixture", memberName: "Fixture Member", policySetRevision: 3,
    failedPolicies: [{ id: policy.id, revision: 1, name: policy.name }], latencyMs: 120, evaluatorModel: "jev-1.13.0",
  }
  expect(gatewayGovernanceDecisionSchema.parse(decision)).toEqual(decision)
  for (const patch of [
    { outcome: "denied" }, { route: "direct" }, { latencyMs: -1 }, { policySetRevision: 0 },
    { prompt: "private input" }, { guidance: "private rule" }, { probability: 0.5 },
    { failedPolicies: [{ ...decision.failedPolicies[0], guidance: "private rule" }] },
    { failedPolicies: Array(21).fill(decision.failedPolicies[0]) },
  ]) expect(gatewayGovernanceDecisionSchema.safeParse({ ...decision, ...patch }).success).toBe(false)
  expect(gatewayGovernanceDecisionSchema.safeParse({ ...decision, memberId: null, memberName: null, policySetRevision: null, evaluatorModel: null, failedPolicies: [] }).success).toBe(true)
  expect(gatewayGovernanceDecisionListResponseSchema.parse({ decisions: [decision], nextCursor: null })).toEqual({ decisions: [decision], nextCursor: null })
  expect(gatewayGovernanceDecisionListResponseSchema.safeParse({ decisions: Array(101).fill(decision), nextCursor: null }).success).toBe(false)
  expect(gatewayGovernanceDecisionListQuerySchema.parse({})).toEqual({ limit: 50 })
  expect(gatewayGovernanceDecisionListQuerySchema.parse({ limit: "100", cursor: "abc_-1" })).toEqual({ limit: 100, cursor: "abc_-1" })
  for (const query of [{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { cursor: "a=b" }, { cursor: "" }, { organizationId: "other" }]) {
    expect(gatewayGovernanceDecisionListQuerySchema.safeParse(query).success).toBe(false)
  }
})

test("engine envelope round-trips exactly, carries no digits, and rejects tampering", () => {
  const error: GatewayGovernanceError = { error: {
    source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked",
    message: "Blocked: Kundendaten – 503 rate limit ✓", schema_version: 1, request_id: "req_500", decision_id: "dec_502",
    contribution_id: "msg_429", input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false,
    evaluation_complete: true, violations: [{ policy_id: "policy_524", policy_revision: 504, policy_name: "Données personnelles 500" }],
  } }
  const encoded = encodeGatewayGovernanceEngineBody(error)
  expect(encoded).not.toMatch(/[0-9]/)
  expect(decodeGatewayGovernanceEngineBody(encoded)).toEqual(error)
  expect(decodeGatewayGovernanceEngineBody(JSON.stringify(error))).toEqual(error)
  expect(gatewayGovernanceEngineStatus(error)).toBe(403)
  expect(gatewayGovernanceEngineStatus({ error: { ...error.error, code: "openwork_gateway_governance_unavailable" } })).toBe(422)
  const payload = String(JSON.parse(encoded).openwork_governance)
  for (const tampered of [
    JSON.stringify({ openwork_governance: payload.slice(1) }),
    JSON.stringify({ openwork_governance: payload.replace(/^./, "z") }),
    JSON.stringify({ openwork_governance: encodeGatewayGovernanceEngineBody(error).length }),
    JSON.stringify({ openwork_governance: "pppp" }),
    "not json",
    " ".repeat(262_145),
  ]) expect(decodeGatewayGovernanceEngineBody(tampered)).toBeNull()
})
