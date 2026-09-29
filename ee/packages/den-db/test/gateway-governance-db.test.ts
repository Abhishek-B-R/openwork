import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import { and, eq, sql } from "drizzle-orm"
import mysql from "mysql2/promise"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { getGatewayGovernanceAvailability, getGatewayGovernancePolicySetBudget, parseGatewayGovernanceConfig } from "@openwork-ee/utils/gateway-governance"
import { createDenDb } from "../src/client"
import {
  createGatewayGovernance, createGatewayGovernanceAdmission, deleteGatewayGovernanceAdmissionsForMember, deleteGatewayGovernanceForOrganization,
  findGatewayGovernanceAdmission, GatewayGovernanceWriteError, listGatewayGovernanceDecisions, provisionGatewayGovernance,
  pruneGatewayGovernanceRecords, readGatewayGovernanceState, recordGatewayGovernanceDecision, type GatewayGovernanceDecisionInput,
} from "../src/gateway-governance"
import { AuthUserTable, MemberTable, OrganizationTable, GatewayGovernancePolicyTable, GatewayGovernanceAuditTable, GatewayGovernancePolicySetTable, GatewayGovernancePolicyRevisionTable, GatewayGovernanceSettingsTable, GatewayGovernanceDecisionTable, GatewayGovernanceAdmissionTable } from "../src/schema"
import { localConnectionConfig, migrateLocalDatabase } from "../scripts/dev-migrate"
import { loadMigrationPlan, record } from "../scripts/migration-baseline"

const url = process.env.DEN_GOVERNANCE_TEST_DATABASE_URL
if (url && (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname) || !/^\/governance_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname))) {
  throw new Error("Use an isolated loopback governance_test database only.")
}
const connection = url ? createDenDb({ mode: "mysql", databaseUrl: url }) : null
const db = connection?.db
const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
before(async () => {
  if (!url) return
  const client = await mysql.createConnection({ ...localConnectionConfig(url), multipleStatements: true })
  try {
    await migrateLocalDatabase({ query: async (sql, args = []) => {
      const [result] = await client.query(sql, args)
      const rows: unknown = result
      return Array.isArray(rows) ? rows.filter(record) : []
    } }, plan)
  } finally { await client.end() }
})
after(async () => {
  if (connection && "end" in connection.client) await connection.client.end()
})
const dbTest = (name: string, work: () => Promise<void>) => test(name, { skip: !url }, work)
const write = { name: "Synthetic credentials rule", guidance: "synthetic-sensitive-guidance-marker" }
const config = parseGatewayGovernanceConfig({
  GATEWAY_GOVERNANCE_MODE: "hosted", TYPESAFE_API_KEY: "synthetic-key",
  GATEWAY_GOVERNANCE_PROCESSING_APPROVED: "true", GATEWAY_GOVERNANCE_PASS_MAX: "0.1", GATEWAY_GOVERNANCE_BLOCK_MIN: "0.9",
})
async function fixture(tier = "enterprise") {
  assert.ok(db)
  const database = db
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  const userId = createDenTypeId("user")
  await database.transaction(async (tx) => {
    await tx.insert(OrganizationTable).values({ id: organizationId, name: "Governance fixture", slug: randomUUID(), metadata: { plan: { tier } } })
    await provisionGatewayGovernance(tx, organizationId)
    await tx.insert(AuthUserTable).values({ id: userId, name: "Fixture", email: `${userId}@example.test` })
    await tx.insert(MemberTable).values({ id: memberId, organizationId, userId, role: "owner" })
  })
  const scope = { organizationId, memberId }
  const service = createGatewayGovernance(database, { authorize: (metadata) => {
    if (!getGatewayGovernanceAvailability(config, metadata).available) throw new GatewayGovernanceWriteError("unavailable", 403, "Not available.")
  } })
  return { database, scope, service }
}
const code = (expected: string) => (error: unknown) => error instanceof GatewayGovernanceWriteError && error.code === expected

dbTest("provisioning is explicitly disabled and idempotent without resetting enabled settings", async () => {
  const { database, scope, service } = await fixture()
  assert.deepEqual((await readGatewayGovernanceState(database, scope.organizationId))?.settings, { enabled: false, revision: 1, policySetRevision: 1 })
  await assert.rejects(service.updateSettings(scope, { expectedRevision: 1, enabled: true }), code("processing_acknowledgment_required"))
  await service.updateSettings(scope, { expectedRevision: 1, enabled: true, processingAcknowledged: true })
  await database.transaction((tx) => provisionGatewayGovernance(tx, scope.organizationId))
  const state = await readGatewayGovernanceState(database, scope.organizationId)
  assert.equal(state?.settings.enabled, true)
  assert.equal(state?.settings.revision, 2)
  assert.deepEqual(state?.policies, [])
})

dbTest("publication and active edits preserve immutable history and archive without deleting", async () => {
  const { database, scope, service } = await fixture()
  const draft = await service.createPolicy(scope, write)
  assert.equal(draft.status, "draft")
  assert.equal((await service.overview(scope)).settings.enabled, false)
  assert.equal((await service.overview(scope)).settings.policySetRevision, 1)
  const active = await service.updatePolicy(scope, draft.id, { expectedRevision: 1, status: "active" })
  assert.equal(active.revision, 2)
  assert.deepEqual((await service.overview(scope)).settings, { enabled: false, revision: 2, policySetRevision: 2 })
  const edited = await service.updatePolicy(scope, active.id, { expectedRevision: 2, name: "Updated rule" })
  await service.updatePolicy(scope, edited.id, { expectedRevision: 3, status: "archived" })
  const state = await readGatewayGovernanceState(database, scope.organizationId)
  assert.equal(state?.policies[0].status, "archived")
  assert.equal(state?.settings.policySetRevision, 4)
  const versions = await database.select().from(GatewayGovernancePolicyRevisionTable).where(eq(GatewayGovernancePolicyRevisionTable.organizationId, scope.organizationId))
  assert.equal(versions.length, 4)
  assert.deepEqual(versions.find((version) => version.revision === 2)?.snapshot, active)
  const sets = await database.select().from(GatewayGovernancePolicySetTable).where(eq(GatewayGovernancePolicySetTable.organizationId, scope.organizationId))
  assert.deepEqual(sets.find((set) => set.revision === 2)?.policies, [active])
  const audits = await database.select().from(GatewayGovernanceAuditTable).where(eq(GatewayGovernanceAuditTable.organizationId, scope.organizationId))
  assert.equal(audits.length, 4)
  assert.ok(!JSON.stringify(audits).includes(write.guidance))
  assert.ok(!JSON.stringify(audits).includes(write.name))
})

dbTest("missing state is not off and missing or malformed immutable snapshots fail unavailable", async () => {
  const { database, scope, service } = await fixture()
  assert.equal(await readGatewayGovernanceState(database, createDenTypeId("organization")), null)
  await database.delete(GatewayGovernanceSettingsTable).where(eq(GatewayGovernanceSettingsTable.organizationId, scope.organizationId))
  assert.equal(await readGatewayGovernanceState(database, scope.organizationId), null)
  await assert.rejects(service.overview(scope), code("gateway_governance_unavailable"))
  await assert.rejects(database.transaction((tx) => provisionGatewayGovernance(tx, scope.organizationId)), code("gateway_governance_unavailable"))
  assert.equal(await readGatewayGovernanceState(database, scope.organizationId), null)
  const other = await fixture()
  await database.update(GatewayGovernancePolicySetTable).set({ policies: {} }).where(eq(GatewayGovernancePolicySetTable.organizationId, other.scope.organizationId))
  await assert.rejects(readGatewayGovernanceState(database, other.scope.organizationId), code("gateway_governance_unavailable"))
  await assert.rejects(database.transaction((tx) => provisionGatewayGovernance(tx, other.scope.organizationId)), code("gateway_governance_unavailable"))
  await database.delete(GatewayGovernancePolicySetTable).where(eq(GatewayGovernancePolicySetTable.organizationId, other.scope.organizationId))
  await assert.rejects(readGatewayGovernanceState(database, other.scope.organizationId), code("gateway_governance_unavailable"))
})

dbTest("malformed SQL boolean values cannot be decoded as an implicit opt-out", async () => {
  const { database, scope } = await fixture()
  await database.execute(sql`update ${GatewayGovernanceSettingsTable} set enabled = 2 where ${GatewayGovernanceSettingsTable.organizationId} = ${scope.organizationId}`)
  await assert.rejects(readGatewayGovernanceState(database, scope.organizationId), code("gateway_governance_unavailable"))
})

dbTest("current policy revision must have an immutable tenant-bound snapshot", async () => {
  const { database, scope, service } = await fixture()
  const draft = await service.createPolicy(scope, write)
  await service.updatePolicy(scope, draft.id, { expectedRevision: 1, status: "active" })
  await database.delete(GatewayGovernancePolicyRevisionTable).where(eq(GatewayGovernancePolicyRevisionTable.organizationId, scope.organizationId))
  await assert.rejects(readGatewayGovernanceState(database, scope.organizationId), code("gateway_governance_unavailable"))
})

dbTest("fresh metadata denies enablement after downgrade and still permits explicit disable", async () => {
  const { database, scope, service } = await fixture()
  await service.updateSettings(scope, { expectedRevision: 1, enabled: true, processingAcknowledged: true })
  await database.update(OrganizationTable).set({ metadata: { plan: { tier: "free" } } }).where(eq(OrganizationTable.id, scope.organizationId))
  await assert.rejects(service.createPolicy(scope, write), code("unavailable"))
  await assert.rejects(service.updateSettings(scope, { expectedRevision: 2, enabled: true, processingAcknowledged: true }), code("unavailable"))
  assert.equal((await service.updateSettings(scope, { expectedRevision: 2, enabled: false })).enabled, false)
  assert.equal((await service.overview(scope)).settings.revision, 3)
})

dbTest("concurrent writes fence stale policy/settings revisions and cap active policies at twenty", async () => {
  const { scope, service } = await fixture()
  const policy = await service.createPolicy(scope, write)
  const edits = await Promise.allSettled([
    service.updatePolicy(scope, policy.id, { expectedRevision: 1, name: "One" }),
    service.updatePolicy(scope, policy.id, { expectedRevision: 1, name: "Two" }),
  ])
  assert.equal(edits.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(edits.filter((result) => result.status === "rejected" && code("governance_revision_conflict")(result.reason)).length, 1)
  const drafts = await Promise.all(Array.from({ length: 21 }, (_, index) => service.createPolicy(scope, { ...write, name: `Rule ${index}` })))
  const publications = await Promise.allSettled(drafts.map((draft) => service.updatePolicy(scope, draft.id, { expectedRevision: 1, status: "active" })))
  assert.equal(publications.filter((result) => result.status === "fulfilled").length, 20)
  assert.equal(publications.filter((result) => result.status === "rejected" && code("governance_policy_limit")(result.reason)).length, 1)
  const state = await service.overview(scope)
  assert.equal(state.policies.filter((item) => item.status === "active").length, 20)
  const changes = await Promise.allSettled([
    service.updateSettings(scope, { expectedRevision: state.settings.revision, enabled: false }),
    service.updateSettings(scope, { expectedRevision: state.settings.revision, enabled: true, processingAcknowledged: true }),
  ])
  assert.equal(changes.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(changes.filter((result) => result.status === "rejected" && code("governance_revision_conflict")(result.reason)).length, 1)
})

dbTest("publication budget is enforced atomically across competing publishers without partial snapshots", async () => {
  const { database, scope, service } = await fixture()
  const drafts = await Promise.all(Array.from({ length: 20 }, (_, index) => service.createPolicy(scope, { name: `Large rule ${index}`, guidance: "x".repeat(4000) })))
  const expected = drafts.filter((_draft, index) => getGatewayGovernancePolicySetBudget(drafts.slice(0, index + 1)).publishable).length
  assert.ok(expected > 0 && expected < 20)
  const results = await Promise.allSettled(drafts.map((draft) => service.updatePolicy(scope, draft.id, { expectedRevision: 1, status: "active" })))
  assert.equal(results.filter((result) => result.status === "fulfilled").length, expected)
  assert.equal(results.filter((result) => result.status === "rejected" && code("governance_policy_budget_exceeded")(result.reason)).length, drafts.length - expected)
  const state = await service.overview(scope)
  assert.deepEqual(state.settings, { enabled: false, revision: expected + 1, policySetRevision: expected + 1 })
  assert.ok(getGatewayGovernancePolicySetBudget(state.policies.filter((policy) => policy.status === "active")).publishable)
  const sets = await database.select().from(GatewayGovernancePolicySetTable).where(eq(GatewayGovernancePolicySetTable.organizationId, scope.organizationId))
  const audits = await database.select().from(GatewayGovernanceAuditTable).where(eq(GatewayGovernanceAuditTable.organizationId, scope.organizationId))
  assert.equal(sets.length, expected + 1)
  assert.equal(audits.length, drafts.length + expected)
})

dbTest("oversized active edits roll back and oversized persisted rules cannot be enabled but can be archived", async () => {
  const { database, scope, service } = await fixture()
  const draft = await service.createPolicy(scope, write)
  const active = await service.updatePolicy(scope, draft.id, { expectedRevision: 1, status: "active" })
  const previous = await service.overview(scope)
  const guidance = String.fromCharCode(0).repeat(4000)
  await assert.rejects(service.updatePolicy(scope, active.id, { expectedRevision: 2, guidance }), code("governance_policy_budget_exceeded"))
  assert.deepEqual(await service.overview(scope), previous)
  const legacy = { ...active, guidance }
  await database.transaction(async (tx) => {
    await tx.update(GatewayGovernancePolicyTable).set({ guidance }).where(eq(GatewayGovernancePolicyTable.id, active.id))
    await tx.update(GatewayGovernancePolicyRevisionTable).set({ snapshot: legacy }).where(and(eq(GatewayGovernancePolicyRevisionTable.policyId, active.id), eq(GatewayGovernancePolicyRevisionTable.revision, active.revision)))
    await tx.update(GatewayGovernancePolicySetTable).set({ policies: [legacy] }).where(and(eq(GatewayGovernancePolicySetTable.organizationId, scope.organizationId), eq(GatewayGovernancePolicySetTable.revision, previous.settings.policySetRevision)))
  })
  await assert.rejects(service.updateSettings(scope, { expectedRevision: 2, enabled: true, processingAcknowledged: true }), code("governance_policy_budget_exceeded"))
  assert.equal((await service.updateSettings(scope, { expectedRevision: 2, enabled: false })).enabled, false)
  await service.updatePolicy(scope, active.id, { expectedRevision: 2, status: "archived" })
  assert.equal((await service.updateSettings(scope, { expectedRevision: 4, enabled: true, processingAcknowledged: true })).enabled, true)
})

dbTest("concurrent provisioning produces one initial snapshot and transaction failure rolls back organization creation", async () => {
  const { database } = await fixture()
  const organizationId = createDenTypeId("organization")
  await database.insert(OrganizationTable).values({ id: organizationId, name: "Provision fixture", slug: randomUUID() })
  await Promise.all(Array.from({ length: 3 }, () => database.transaction((tx) => provisionGatewayGovernance(tx, organizationId))))
  assert.deepEqual((await readGatewayGovernanceState(database, organizationId))?.settings, { enabled: false, revision: 1, policySetRevision: 1 })
  const rolledBack = createDenTypeId("organization")
  await assert.rejects(database.transaction(async (tx) => {
    await tx.insert(OrganizationTable).values({ id: rolledBack, name: "Rollback fixture", slug: randomUUID() })
    await provisionGatewayGovernance(tx, rolledBack)
    throw new Error("synthetic_post_provision_failure")
  }), /synthetic_post_provision_failure/)
  assert.equal(await readGatewayGovernanceState(database, rolledBack), null)
  assert.deepEqual(await database.select().from(GatewayGovernancePolicySetTable).where(eq(GatewayGovernancePolicySetTable.organizationId, rolledBack)), [])
})

dbTest("independent database clients observe enablement and publication without cached off state", async () => {
  assert.ok(url)
  const { scope, service } = await fixture()
  const replica = createDenDb({ mode: "mysql", databaseUrl: url })
  try {
    assert.equal((await readGatewayGovernanceState(replica.db, scope.organizationId))?.settings.enabled, false)
    await service.updateSettings(scope, { expectedRevision: 1, enabled: true, processingAcknowledged: true })
    const draft = await service.createPolicy(scope, write)
    await service.updatePolicy(scope, draft.id, { expectedRevision: 1, status: "active" })
    const freshState = await readGatewayGovernanceState(replica.db, scope.organizationId)
    assert.deepEqual(freshState?.settings, { enabled: true, revision: 3, policySetRevision: 2 })
    assert.equal(freshState?.policies[0].revision, 2)
  } finally { if ("end" in replica.client) await replica.client.end() }
})

dbTest("tenant binding and live administrator membership are checked inside the transaction", async () => {
  const one = await fixture(), two = await fixture()
  const draft = await one.service.createPolicy(one.scope, write)
  await assert.rejects(two.service.updatePolicy(two.scope, draft.id, { expectedRevision: 1, status: "active" }), code("governance_policy_not_found"))
  await assert.rejects(one.service.overview({ ...one.scope, memberId: two.scope.memberId }), code("forbidden"))
  await one.database.update(MemberTable).set({ role: "member" }).where(eq(MemberTable.id, one.scope.memberId))
  await assert.rejects(one.service.createPolicy(one.scope, write), code("forbidden"))
  await one.database.update(MemberTable).set({ role: "owner", removedAt: new Date() }).where(eq(MemberTable.id, one.scope.memberId))
  await assert.rejects(one.service.updateSettings(one.scope, { expectedRevision: 1, enabled: false }), code("forbidden"))
})

dbTest("organization erasure removes settings, definition history, sets, and audit metadata", async () => {
  const { database, scope, service } = await fixture()
  await service.createPolicy(scope, write)
  await database.transaction((tx) => deleteGatewayGovernanceForOrganization(tx, scope.organizationId))
  assert.equal(await readGatewayGovernanceState(database, scope.organizationId), null)
  const audits = await database.select().from(GatewayGovernanceAuditTable).where(eq(GatewayGovernanceAuditTable.organizationId, scope.organizationId))
  assert.deepEqual(audits, [])
})

dbTest("migration backfills old organizations disabled with a real empty policy set", async () => {
  assert.ok(url)
  const client = await mysql.createConnection({ ...localConnectionConfig(url), multipleStatements: true })
  const name = `governance_test_migration_${randomUUID().replaceAll("-", "")}`
  try {
    await client.query(`CREATE DATABASE \`${name}\``)
    await client.query(`USE \`${name}\``)
    await client.query("CREATE TABLE organization (id varchar(64) PRIMARY KEY)")
    await client.query("INSERT INTO organization (id) VALUES ('org_migration_fixture')")
    const source = await readFile(new URL("../drizzle/0111_gateway_governance.sql", import.meta.url), "utf8")
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement)
    }
    const [settings] = await client.query("SELECT enabled, revision, policy_set_revision FROM gateway_governance_settings WHERE organization_id = 'org_migration_fixture'")
    const [sets] = await client.query("SELECT policies FROM gateway_governance_policy_set WHERE organization_id = 'org_migration_fixture' AND revision = 1")
    assert.ok(Array.isArray(settings) && settings.length === 1 && record(settings[0]))
    assert.equal(settings[0].enabled, 0)
    assert.equal(settings[0].revision, 1)
    assert.equal(settings[0].policy_set_revision, 1)
    assert.ok(Array.isArray(sets) && sets.length === 1 && record(sets[0]))
    assert.deepEqual(typeof sets[0].policies === "string" ? JSON.parse(sets[0].policies) : sets[0].policies, [])
  } finally {
    try { await client.query(`DROP DATABASE IF EXISTS \`${name}\``) } finally { await client.end() }
  }
})

function decision(organizationId: string, memberId: string | null, overrides: Partial<GatewayGovernanceDecisionInput> = {}): GatewayGovernanceDecisionInput {
  return {
    decisionId: `decision_${randomUUID()}`, requestId: `request_${randomUUID()}`, organizationId, memberId, route: "provider", outcome: "allowed",
    policySetRevision: 2, policies: [{ id: "policy_one", revision: 2 }], failedPolicies: [], evaluatorModel: "jev-1.13.0",
    extractorVersion: "extract-1", decisionVersion: "decision-1", latencyMs: 42, evaluatorInputTokens: 120, evaluatorOutputTokens: 4,
    evaluatorAttempts: 1, createdAt: new Date("2026-09-29T10:00:00.000Z"), ...overrides,
  }
}
const digest = (seed: string) => seed.repeat(64).slice(0, 64)

dbTest("decision records are idempotent, bounded, and store metadata only", async () => {
  const { database, scope } = await fixture()
  const row = decision(scope.organizationId, scope.memberId, { outcome: "blocked", failedPolicies: [{ id: "policy_one", revision: 2, name: "Credentials" }] })
  await recordGatewayGovernanceDecision(database, row)
  await recordGatewayGovernanceDecision(database, { ...row, outcome: "allowed", latencyMs: 1 })
  const stored = await database.select().from(GatewayGovernanceDecisionTable).where(eq(GatewayGovernanceDecisionTable.organizationId, scope.organizationId))
  assert.equal(stored.length, 1)
  assert.equal(stored[0].outcome, "blocked")
  assert.equal(stored[0].latencyMs, 42)
  assert.deepEqual(stored[0].failedPolicies, [{ id: "policy_one", revision: 2, name: "Credentials" }])
  assert.equal(stored[0].orgMembershipId, scope.memberId)
  for (const patch of [
    { latencyMs: -1 }, { latencyMs: 1.5 }, { evaluatorAttempts: 17 }, { evaluatorInputTokens: -1 }, { policySetRevision: 0 },
    { decisionId: "bad id" }, { requestId: "x".repeat(129) }, { extractorVersion: "" }, { evaluatorModel: "x".repeat(129) },
    { createdAt: new Date(Number.NaN) }, { createdAt: new Date("2040-01-01T00:00:00.000Z") }, { organizationId: "not-an-org" },
    { memberId: createDenTypeId("organization") }, { policies: Array.from({ length: 21 }, (_, index) => ({ id: `p${index}`, revision: 1 })) },
    { policies: [{ id: "dup", revision: 1 }, { id: "dup", revision: 2 }] }, { failedPolicies: [{ id: "policy_one", revision: 2, name: "" }] },
  ] satisfies Partial<GatewayGovernanceDecisionInput>[]) {
    await assert.rejects(recordGatewayGovernanceDecision(database, decision(scope.organizationId, scope.memberId, patch)), code("invalid_governance_decision"))
  }
  const extra = { ...decision(scope.organizationId, null), prompt: "synthetic-private-prompt" }
  await assert.rejects(recordGatewayGovernanceDecision(database, extra), code("invalid_governance_decision"))
  assert.equal((await database.select().from(GatewayGovernanceDecisionTable).where(eq(GatewayGovernanceDecisionTable.organizationId, scope.organizationId))).length, 1)
})

dbTest("admissions are tenant and member scoped, upsert, validate digests strictly, and expire", async () => {
  const { database, scope } = await fixture()
  const other = await fixture()
  const now = new Date("2026-09-29T10:00:00.000Z")
  const expiresAt = new Date("2026-09-29T11:00:00.000Z")
  const key = { organizationId: scope.organizationId, memberId: scope.memberId, digest: digest("a1") }
  const lookup = { ...key, now }
  assert.equal(await findGatewayGovernanceAdmission(database, lookup), null)
  await createGatewayGovernanceAdmission(database, { ...key, policySetRevision: 2, decisionId: "decision_first", expiresAt, createdAt: now })
  assert.deepEqual(await findGatewayGovernanceAdmission(database, lookup), { decisionId: "decision_first", policySetRevision: 2, expiresAt })
  const later = new Date("2026-09-29T12:00:00.000Z")
  await createGatewayGovernanceAdmission(database, { ...key, policySetRevision: 3, decisionId: "decision_second", expiresAt: later, createdAt: now })
  assert.deepEqual(await findGatewayGovernanceAdmission(database, lookup), { decisionId: "decision_second", policySetRevision: 3, expiresAt: later })
  assert.equal((await database.select().from(GatewayGovernanceAdmissionTable).where(eq(GatewayGovernanceAdmissionTable.organizationId, scope.organizationId))).length, 1)
  assert.equal(await findGatewayGovernanceAdmission(database, { ...lookup, now: later }), null)
  assert.equal(await findGatewayGovernanceAdmission(database, { ...lookup, organizationId: other.scope.organizationId }), null)
  assert.equal(await findGatewayGovernanceAdmission(database, { ...lookup, memberId: other.scope.memberId }), null)
  for (const bad of [digest("A1"), digest("g1"), "a1".repeat(31), `${digest("a1")}0`, ` ${digest("a1").slice(1)}`]) {
    await assert.rejects(findGatewayGovernanceAdmission(database, { ...lookup, digest: bad }), code("invalid_governance_admission"))
  }
  await assert.rejects(findGatewayGovernanceAdmission(database, { ...lookup, now: new Date(Number.NaN) }), code("invalid_governance_admission"))
  await assert.rejects(createGatewayGovernanceAdmission(database, { ...key, policySetRevision: 1, decisionId: "decision_bad", expiresAt: now, createdAt: now }), code("invalid_governance_admission"))
  await assert.rejects(createGatewayGovernanceAdmission(database, { ...key, policySetRevision: 0, decisionId: "decision_bad", expiresAt, createdAt: now }), code("invalid_governance_admission"))
  await assert.rejects(createGatewayGovernanceAdmission(database, { ...key, digest: digest("F0"), policySetRevision: 1, decisionId: "decision_bad", expiresAt, createdAt: now }), code("invalid_governance_admission"))
  await database.transaction((tx) => deleteGatewayGovernanceAdmissionsForMember(tx, scope))
  assert.equal(await findGatewayGovernanceAdmission(database, lookup), null)
})

dbTest("decision history pages newest first with a stable tenant-scoped cursor and live member names", async () => {
  const { database, scope, service } = await fixture()
  const other = await fixture()
  const base = Date.parse("2026-09-29T10:00:00.000Z")
  const ids: string[] = []
  for (let index = 0; index < 5; index++) {
    const row = decision(scope.organizationId, index === 4 ? null : scope.memberId, { createdAt: new Date(base + Math.floor(index / 2) * 1000), outcome: index === 3 ? "blocked" : "allowed", failedPolicies: index === 3 ? [{ id: "policy_one", revision: 2, name: "Credentials" }] : [] })
    ids.push(row.decisionId)
    await recordGatewayGovernanceDecision(database, row)
  }
  await recordGatewayGovernanceDecision(database, decision(other.scope.organizationId, other.scope.memberId, { createdAt: new Date(base + 5000) }))
  await recordGatewayGovernanceDecision(database, decision(scope.organizationId, other.scope.memberId, { createdAt: new Date(base - 1000) }))
  const seen: string[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = await service.listDecisions(scope, { limit: 2, ...(cursor ? { cursor } : {}) })
    pages++
    assert.ok(page.decisions.length <= 2)
    seen.push(...page.decisions.map((item) => item.decisionId))
    for (const item of page.decisions) {
      if (item.memberId === scope.memberId) assert.equal(item.memberName, "Fixture")
      else assert.equal(item.memberName, null)
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(pages, 3)
  assert.equal(seen.length, 6)
  assert.equal(new Set(seen).size, 6)
  assert.deepEqual(new Set(seen.slice(0, 5)), new Set(ids))
  assert.equal(seen[0], ids[4])
  const all = await listGatewayGovernanceDecisions(database, { organizationId: scope.organizationId, limit: 100 })
  assert.deepEqual(all.decisions.map((item) => item.decisionId), seen)
  assert.equal(all.nextCursor, null)
  const times = all.decisions.map((item) => Date.parse(item.createdAt))
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
  assert.deepEqual(all.decisions.find((item) => item.outcome === "blocked")?.failedPolicies, [{ id: "policy_one", revision: 2, name: "Credentials" }])
  assert.ok(!JSON.stringify(all).includes("extract-1") && !JSON.stringify(all).includes("request_"))
  const otherPage = await other.service.listDecisions(other.scope, { limit: 100 })
  assert.equal(otherPage.decisions.length, 1)
  const firstPage = await service.listDecisions(scope, { limit: 2 })
  assert.ok(firstPage.nextCursor)
  assert.deepEqual((await other.service.listDecisions(other.scope, { limit: 100, cursor: firstPage.nextCursor })).decisions.map((item) => item.decisionId).every((id) => !seen.includes(id)), true)
  await assert.rejects(service.listDecisions(scope, { cursor: "not_a_cursor" }), code("invalid_governance_decision_cursor"))
  await assert.rejects(service.listDecisions(scope, { limit: 101 }), code("invalid_governance_decision_query"))
  await assert.rejects(service.listDecisions({ ...scope, memberId: other.scope.memberId }), code("forbidden"))
  await database.update(MemberTable).set({ role: "member" }).where(eq(MemberTable.id, scope.memberId))
  await assert.rejects(service.listDecisions(scope), code("forbidden"))
})

dbTest("retention pruning deletes only expired admissions and old decisions in bounded batches", async () => {
  const { database, scope } = await fixture()
  const now = new Date("2026-09-29T10:00:00.000Z")
  const old = new Date(now.getTime() - 31 * 86_400_000)
  const oldIds = Array.from({ length: 3 }, () => `decision_${randomUUID()}`)
  for (const decisionId of oldIds) await recordGatewayGovernanceDecision(database, decision(scope.organizationId, scope.memberId, { decisionId, createdAt: old }))
  const fresh = decision(scope.organizationId, scope.memberId, { createdAt: new Date(now.getTime() - 86_400_000) })
  await recordGatewayGovernanceDecision(database, fresh)
  const key = { organizationId: scope.organizationId, memberId: scope.memberId }
  const lookup = { ...key, now }
  await createGatewayGovernanceAdmission(database, { ...key, digest: digest("b2"), policySetRevision: 1, decisionId: "decision_expired", expiresAt: new Date(now.getTime() - 1), createdAt: old })
  await createGatewayGovernanceAdmission(database, { ...key, digest: digest("c3"), policySetRevision: 1, decisionId: "decision_live", expiresAt: new Date(now.getTime() + 60_000), createdAt: now })
  await assert.rejects(pruneGatewayGovernanceRecords(database, { now, decisionRetentionDays: 0 }), code("invalid_governance_retention"))
  await assert.rejects(pruneGatewayGovernanceRecords(database, { now, decisionRetentionDays: 1.5 }), code("invalid_governance_retention"))
  const result = await pruneGatewayGovernanceRecords(database, { now, decisionRetentionDays: 30 })
  assert.ok(result.decisions >= 3)
  assert.ok(result.admissions >= 1)
  const remaining = await database.select({ decisionId: GatewayGovernanceDecisionTable.decisionId }).from(GatewayGovernanceDecisionTable).where(eq(GatewayGovernanceDecisionTable.organizationId, scope.organizationId))
  assert.deepEqual(remaining.map((row) => row.decisionId), [fresh.decisionId])
  assert.equal(await findGatewayGovernanceAdmission(database, { ...lookup, digest: digest("c3") }).then((row) => row?.decisionId), "decision_live")
  const admissions = await database.select().from(GatewayGovernanceAdmissionTable).where(eq(GatewayGovernanceAdmissionTable.organizationId, scope.organizationId))
  assert.deepEqual(admissions.map((row) => row.decisionId), ["decision_live"])
  assert.deepEqual(await pruneGatewayGovernanceRecords(database, { now, decisionRetentionDays: 30 }), { decisions: 0, admissions: 0 })
})

dbTest("organization erasure removes decision history and admissions", async () => {
  const { database, scope } = await fixture()
  await recordGatewayGovernanceDecision(database, decision(scope.organizationId, scope.memberId))
  const now = new Date("2026-09-29T10:00:00.000Z")
  await createGatewayGovernanceAdmission(database, { organizationId: scope.organizationId, memberId: scope.memberId, digest: digest("d4"), policySetRevision: 1, decisionId: "decision_erase", expiresAt: new Date(now.getTime() + 60_000), createdAt: now })
  await database.transaction((tx) => deleteGatewayGovernanceForOrganization(tx, scope.organizationId))
  assert.deepEqual(await database.select().from(GatewayGovernanceDecisionTable).where(eq(GatewayGovernanceDecisionTable.organizationId, scope.organizationId)), [])
  assert.deepEqual(await database.select().from(GatewayGovernanceAdmissionTable).where(eq(GatewayGovernanceAdmissionTable.organizationId, scope.organizationId)), [])
})
