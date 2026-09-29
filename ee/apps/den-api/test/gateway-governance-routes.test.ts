import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { generateSpecs } from "hono-openapi"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { parseGatewayGovernanceConfig } from "@openwork-ee/utils/gateway-governance"
import { GatewayGovernanceWriteError, type GatewayGovernanceState } from "@openwork-ee/den-db/gateway-governance"
import type { GatewayGovernanceDecision, GatewayGovernanceDecisionListResponse, GatewayGovernancePolicy, GatewayGovernancePolicyPatch, GatewayGovernancePolicyWrite, GatewayGovernanceSettingsPatch } from "@openwork/types/den/gateway-governance"
import type { GatewayGovernanceDecisionPageQuery, GatewayGovernanceScope } from "@openwork-ee/den-db/gateway-governance"
import * as validation from "../src/middleware/validation.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/not_connected"
process.env.DEN_DB_ENCRYPTION_KEY = "fixture-governance-encryption-not-a-secret"
process.env.BETTER_AUTH_SECRET = "fixture-governance-auth-not-a-secret"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.OPENWORK_DEV_MODE = "1"
process.env.GATEWAY_ENABLED = "false"
process.env.GATEWAY_GOVERNANCE_MODE = "disabled"

mock.module("../src/db.js", () => ({ db: { transaction: () => { throw new Error("unexpected_database_access") } } }))
const organizationId = createDenTypeId("organization"), memberId = createDenTypeId("member")
let authenticated = true, fresh = true, apiKey = false, role = "owner", failure: Error | undefined
let activeOrganizationId = organizationId
const memberRoute: MiddlewareHandler = async (c, next) => {
  if (!authenticated) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", { organization: { id: activeOrganizationId, metadata: { plan: { tier: "enterprise" } } }, currentMember: { id: memberId, role, isOwner: role === "owner" } })
  c.set("session", { createdAt: new Date(Date.now() - (fresh ? 0 : 3_600_000)) })
  c.set("apiKey", apiKey ? { id: "fixture-key" } : null)
  await next()
}
mock.module("../src/middleware/index.js", () => ({ ...validation, orgMemberRoute: () => memberRoute }))
const { registerOrgGatewayGovernanceRoutes, authorizeGatewayGovernance } = await import("../src/routes/org/gateway-governance.js")
const config = parseGatewayGovernanceConfig({
  GATEWAY_GOVERNANCE_MODE: "hosted", TYPESAFE_API_KEY: "synthetic-key", GATEWAY_GOVERNANCE_PROCESSING_APPROVED: "true",
  GATEWAY_GOVERNANCE_PASS_MAX: "0.1", GATEWAY_GOVERNANCE_BLOCK_MIN: "0.9",
})
const policy: GatewayGovernancePolicy = { id: "00000000-0000-4000-8000-000000000001", name: "Synthetic rule", guidance: "Synthetic guidance", status: "draft", revision: 1, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z" }
let state: GatewayGovernanceState
const decisionFixture = (index: number, tenant = organizationId): GatewayGovernanceDecision & { tenant: typeof organizationId } => ({
  tenant, decisionId: `decision_${index}`, createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, 60 - index)).toISOString(), route: "provider",
  outcome: index === 1 ? "blocked" : "allowed", memberId, memberName: "Fixture Member", policySetRevision: 2,
  failedPolicies: index === 1 ? [{ id: "policy_fixture", revision: 2, name: "Synthetic rule" }] : [], latencyMs: 40, evaluatorModel: "jev-1.13.0",
})
const decisionStore = [...Array.from({ length: 5 }, (_, index) => decisionFixture(index)), decisionFixture(9, createDenTypeId("organization"))]
const service = {
  listDecisions: mock(async (target: GatewayGovernanceScope, query: GatewayGovernanceDecisionPageQuery = {}): Promise<GatewayGovernanceDecisionListResponse> => {
    if (failure) throw failure
    const rows = decisionStore.filter((row) => row.tenant === target.organizationId)
    const start = query.cursor ? Number(query.cursor.replace("c", "")) : 0
    if (!Number.isInteger(start)) throw new GatewayGovernanceWriteError("invalid_governance_decision_cursor", 400, "Decision cursor is invalid. Reload the first page.")
    const limit = query.limit ?? 50
    const decisions = rows.slice(start, start + limit).map(({ tenant: _tenant, ...decision }) => decision)
    return { decisions, nextCursor: start + limit < rows.length ? `c${start + limit}` : null }
  }),
  overview: mock(async (_scope: GatewayGovernanceScope) => { if (failure) throw failure; return state }),
  updateSettings: mock(async (_scope: GatewayGovernanceScope, input: GatewayGovernanceSettingsPatch) => {
    if (failure) throw failure
    return { ...state.settings, enabled: input.enabled, revision: state.settings.revision + 1 }
  }),
  createPolicy: mock(async (_scope: GatewayGovernanceScope, input: GatewayGovernancePolicyWrite) => { if (failure) throw failure; return { ...policy, ...input } }),
  updatePolicy: mock(async (_scope: GatewayGovernanceScope, id: string, input: GatewayGovernancePolicyPatch) => { if (failure) throw failure; return { ...policy, id, status: input.status ?? policy.status, revision: 2 } }),
}
const app = new Hono<{ Variables: OrgRouteVariables }>()
registerOrgGatewayGovernanceRoutes(app, config, service)
const request = (path = "", method = "GET", body?: unknown) => app.request(`/v1/gateway-governance${path}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
})
beforeEach(() => {
  authenticated = true; fresh = true; apiKey = false; role = "owner"; failure = undefined; activeOrganizationId = organizationId
  state = { organizationId, metadata: { plan: { tier: "enterprise" } }, settings: { enabled: false, revision: 1, policySetRevision: 1 }, policies: [] }
  service.overview.mockClear(); service.createPolicy.mockClear(); service.updatePolicy.mockClear(); service.updateSettings.mockClear(); service.listDecisions.mockClear()
})
afterAll(() => mock.restore())

test("read returns fresh authoritative overview even when ordinary Gateway management is disabled", async () => {
  state.metadata = { plan: { tier: "free" } }
  const response = await request()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("private, no-store")
  expect(await response.json()).toMatchObject({ settings: { enabled: false, revision: 1 }, policies: [], availability: { available: false, reason: "enterprise_required" } })
  expect(service.overview).toHaveBeenCalledWith({ organizationId, memberId })
  expect(service.createPolicy).not.toHaveBeenCalled()
})

test("read failures are unavailable, never a fabricated disabled overview, and never leak raw errors", async () => {
  failure = new Error("synthetic-private-guidance-marker")
  const response = await request()
  expect(response.status).toBe(503)
  const body = await response.text()
  expect(body).toContain("gateway_governance_unavailable")
  expect(body).not.toContain("synthetic-private-guidance-marker")
  expect(body).not.toContain("settings")
})

test("unauthenticated and ordinary members cannot read or mutate governance", async () => {
  authenticated = false
  expect((await request()).status).toBe(401)
  authenticated = true; role = "member"
  expect((await request()).status).toBe(403)
  expect((await request("/policies", "POST", { name: "Rule", guidance: "Guidance" })).status).toBe(403)
  expect(service.overview).not.toHaveBeenCalled()
  expect(service.createPolicy).not.toHaveBeenCalled()
})

test("every mutation requires a fresh interactive administrator session", async () => {
  const mutations = [
    { path: "/settings", method: "PATCH", body: { expectedRevision: 1, enabled: false } },
    { path: "/policies", method: "POST", body: { name: "Rule", guidance: "Guidance" } },
    { path: `/policies/${policy.id}`, method: "PATCH", body: { expectedRevision: 1, status: "active" } },
  ]
  for (const useKey of [false, true]) {
    apiKey = useKey; fresh = useKey
    for (const mutation of mutations) {
      const response = await request(mutation.path, mutation.method, mutation.body)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: "reauth", reason: "fresh_auth_required" })
    }
  }
  expect(service.createPolicy).not.toHaveBeenCalled()
  expect(service.updatePolicy).not.toHaveBeenCalled()
  expect(service.updateSettings).not.toHaveBeenCalled()
})

test("strict request schemas reject tenant, activation, revision, and content injection", async () => {
  for (const body of [
    { name: "Rule", guidance: "Guidance", organizationId: "other" }, { name: "Rule", guidance: "Guidance", status: "active" },
    { name: " ", guidance: "Guidance" }, { name: "Rule", guidance: "x".repeat(4001) },
  ]) expect((await request("/policies", "POST", body)).status).toBe(400)
  expect((await request("/settings", "PATCH", { enabled: true, expectedRevision: 1, processingAcknowledged: "true" })).status).toBe(400)
  expect((await request(`/policies/${policy.id}`, "PATCH", { expectedRevision: 1 })).status).toBe(400)
  expect(service.createPolicy).not.toHaveBeenCalled()
  expect(service.updateSettings).not.toHaveBeenCalled()
})

test("policy and settings responses match client contracts and carry only authenticated tenant scope", async () => {
  const created = await request("/policies", "POST", { name: policy.name, guidance: policy.guidance })
  expect(created.status).toBe(201)
  expect(await created.json()).toEqual({ policy })
  const updated = await request(`/policies/${policy.id}`, "PATCH", { expectedRevision: 1, status: "active" })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toMatchObject({ policy: { id: policy.id, status: "active", revision: 2 } })
  const settings = await request("/settings", "PATCH", { expectedRevision: 1, enabled: false })
  expect(await settings.json()).toEqual({ settings: { enabled: false, revision: 2, policySetRevision: 1 } })
  expect(service.createPolicy.mock.calls[0][0]).toEqual({ organizationId, memberId })
})

test("revision conflicts and tenant-scoped not-found remain distinct from lookup failures", async () => {
  failure = new GatewayGovernanceWriteError("governance_revision_conflict", 409, "Reload before editing.")
  expect((await request("/settings", "PATCH", { expectedRevision: 1, enabled: false })).status).toBe(409)
  failure = new GatewayGovernanceWriteError("governance_policy_not_found", 404, "Not found.")
  expect((await request(`/policies/${policy.id}`, "PATCH", { expectedRevision: 1, status: "active" })).status).toBe(404)
})

test("policy-budget failures retain their actionable conflict code", async () => {
  failure = new GatewayGovernanceWriteError("governance_policy_budget_exceeded", 409, "Shorten active policy guidance.")
  const response = await request(`/policies/${policy.id}`, "PATCH", { expectedRevision: 1, status: "active" })
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: "governance_policy_budget_exceeded", message: "Shorten active policy guidance." })
})

test("authorizer requires hosted Enterprise or explicit module plus operational approval", () => {
  expect(() => authorizeGatewayGovernance(config, { plan: { tier: "team" } })).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, mode: "disabled" }, state.metadata)).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, apiKey: undefined }, state.metadata)).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, model: "jev-1.13.1" }, state.metadata)).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, timeoutMs: 5001 }, state.metadata)).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, processingApproved: false }, state.metadata)).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, blockMin: undefined }, state.metadata)).toThrow()
  expect(() => authorizeGatewayGovernance({ ...config, mode: "self_hosted_module" }, null)).not.toThrow()
})

test("decision history pages newest first for administrators without caching", async () => {
  const first = await request("/decisions?limit=2")
  expect(first.status).toBe(200)
  expect(first.headers.get("cache-control")).toBe("private, no-store")
  const page: unknown = await first.json()
  expect(page).toEqual({ decisions: decisionStore.slice(0, 2).map(({ tenant: _tenant, ...decision }) => decision), nextCursor: "c2" })
  expect(service.listDecisions).toHaveBeenLastCalledWith({ organizationId, memberId }, { limit: 2 })
  const second = await request("/decisions?limit=2&cursor=c2")
  expect(await second.json()).toMatchObject({ decisions: [{ decisionId: "decision_2" }, { decisionId: "decision_3" }], nextCursor: "c4" })
  expect(service.listDecisions).toHaveBeenLastCalledWith({ organizationId, memberId }, { limit: 2, cursor: "c2" })
  const last = await request("/decisions?limit=2&cursor=c4")
  expect(await last.json()).toMatchObject({ decisions: [{ decisionId: "decision_4" }], nextCursor: null })
  await request("/decisions")
  expect(service.listDecisions).toHaveBeenLastCalledWith({ organizationId, memberId }, { limit: 50 })
})

test("decision history is scoped to the authenticated organization, never a requested tenant", async () => {
  const response = await request(`/decisions?organizationId=${decisionStore[5].tenant}`)
  expect(response.status).toBe(400)
  activeOrganizationId = decisionStore[5].tenant
  const other = await request("/decisions")
  const { tenant: _tenant, ...foreign } = decisionStore[5]
  expect(await other.json()).toEqual({ decisions: [foreign], nextCursor: null })
  expect(service.listDecisions).toHaveBeenLastCalledWith({ organizationId: decisionStore[5].tenant, memberId }, { limit: 50 })
  const body = JSON.stringify(await (await request("/decisions")).json())
  expect(body).not.toContain("decision_0")
})

test("decision history rejects members, anonymous callers, and malformed paging before reading", async () => {
  authenticated = false
  expect((await request("/decisions")).status).toBe(401)
  authenticated = true; role = "member"
  const forbidden = await request("/decisions")
  expect(forbidden.status).toBe(403)
  expect(forbidden.headers.get("cache-control")).toBe("private, no-store")
  role = "owner"
  for (const query of ["limit=0", "limit=101", "limit=abc", "limit=1.5", "cursor=", "cursor=bad%20cursor", `cursor=${"a".repeat(257)}`]) {
    expect((await request(`/decisions?${query}`)).status).toBe(400)
  }
  expect(service.listDecisions).not.toHaveBeenCalled()
  role = "admin"
  expect((await request("/decisions?limit=100")).status).toBe(200)
})

test("decision history maps invalid cursors and failures without leaking internals", async () => {
  expect((await request("/decisions?cursor=cx")).status).toBe(400)
  failure = new Error("synthetic-private-prompt-marker")
  const response = await request("/decisions")
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain("synthetic-private-prompt-marker")
})

test("OpenAPI advertises the exact shared resource paths and create status", async () => {
  const spec = await generateSpecs(app)
  expect(spec.paths?.["/v1/gateway-governance/decisions"]?.get?.tags).toEqual(["Gateway Governance"])
  expect(spec.paths?.["/v1/gateway-governance"]?.get).toBeDefined()
  expect(spec.paths?.["/v1/gateway-governance/settings"]?.patch).toBeDefined()
  expect(spec.paths?.["/v1/gateway-governance/policies"]?.post?.responses?.["201"]).toBeDefined()
  expect(spec.paths?.["/v1/gateway-governance/policies/{id}"]?.patch).toBeDefined()
})
