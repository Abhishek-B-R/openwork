import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { getGatewayGovernancePolicySetBudget } from "@openwork-ee/utils/gateway-governance"
import {
  DEFAULT_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE,
  MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES,
  MAX_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE,
  gatewayGovernanceAdmissionRecordSchema,
  gatewayGovernanceContributionDigestSchema,
  gatewayGovernanceDecisionCursorSchema,
  gatewayGovernanceDecisionRecordSchema,
  gatewayGovernanceDecisionSchema,
  gatewayGovernancePolicyPatchSchema,
  gatewayGovernancePolicySchema,
  gatewayGovernancePolicyWriteSchema,
  gatewayGovernanceSettingsPatchSchema,
  gatewayGovernanceSettingsSchema,
  type GatewayGovernanceAdmissionRecord,
  type GatewayGovernanceDecision,
  type GatewayGovernanceDecisionListResponse,
  type GatewayGovernanceDecisionOutcome,
  type GatewayGovernanceDecisionRoute,
  type GatewayGovernancePolicy,
  type GatewayGovernancePolicyPatch,
  type GatewayGovernancePolicyWrite,
  type GatewayGovernanceSettings,
  type GatewayGovernanceSettingsPatch,
} from "@openwork/types/den/gateway-governance"
import type { DenDb } from "./client"
import { AuthUserTable } from "./schema/auth"
import { MemberTable, OrganizationTable } from "./schema/org"
import { TeamMemberTable, TeamTable } from "./schema/teams"
import {
  GatewayGovernanceSettingsTable as S,
  GatewayGovernancePolicyTable as P,
  GatewayGovernancePolicyRevisionTable as V,
  GatewayGovernancePolicySetTable as R,
  GatewayGovernanceAuditTable as A,
  GatewayGovernanceDecisionTable as D,
  GatewayGovernanceAdmissionTable as M,
} from "./schema/gateway-governance"

export type GatewayGovernanceTx = Parameters<Parameters<DenDb["transaction"]>[0]>[0]
export type GatewayGovernanceState = {
  organizationId: string
  metadata: typeof OrganizationTable.$inferSelect.metadata
  settings: GatewayGovernanceSettings
  policies: GatewayGovernancePolicy[]
}
export type GatewayGovernanceScope = {
  organizationId: typeof OrganizationTable.$inferSelect.id
  memberId: typeof MemberTable.$inferSelect.id
}

export class GatewayGovernanceWriteError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(message)
    this.name = "GatewayGovernanceWriteError"
  }
}

function unavailable(): never {
  throw new GatewayGovernanceWriteError("gateway_governance_unavailable", 503, "Organization governance state is unavailable.")
}
function assertPublicationBudget(policies: GatewayGovernancePolicy[]): void {
  if (!getGatewayGovernancePolicySetBudget(policies).publishable) {
    throw new GatewayGovernanceWriteError("governance_policy_budget_exceeded", 409, "Active policy guidance exceeds the evaluator budget. Shorten the guidance or archive policies to retain at least 4096 serialized contribution bytes.")
  }
}
function nextRevision(revision: number): number {
  if (!Number.isInteger(revision) || revision < 1 || revision >= 2_147_483_647) {
    throw new GatewayGovernanceWriteError("governance_revision_exhausted", 409, "Governance revision exhausted.")
  }
  return revision + 1
}
function policyView(row: typeof P.$inferSelect): GatewayGovernancePolicy {
  const parsed = gatewayGovernancePolicySchema.safeParse({
    id: row.id, name: row.name, guidance: row.guidance, status: row.status, revision: row.revision,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  })
  if (!parsed.success) return unavailable()
  return parsed.data
}
function storedEnabled(value: unknown): boolean {
  if (value === true || value === 1 || value === "1") return true
  if (value === false || value === 0 || value === "0") return false
  return unavailable()
}
function settingsView(row: typeof S.$inferSelect): GatewayGovernanceSettings {
  const parsed = gatewayGovernanceSettingsSchema.safeParse({
    enabled: row.enabled, revision: row.revision, policySetRevision: row.policySetRevision,
  })
  if (!parsed.success) return unavailable()
  return parsed.data
}
function equalPolicies(left: GatewayGovernancePolicy[], right: GatewayGovernancePolicy[]): boolean {
  const ordered = (policies: GatewayGovernancePolicy[]) => [...policies].sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right))
}

export async function provisionGatewayGovernance(
  tx: GatewayGovernanceTx,
  organizationId: typeof OrganizationTable.$inferSelect.id,
): Promise<void> {
  const [organization] = await tx.select({ id: OrganizationTable.id }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId)).for("update")
  if (!organization) return unavailable()
  const [settings] = await tx.select({ organizationId: S.organizationId }).from(S)
    .where(eq(S.organizationId, organizationId)).for("update")
  if (settings) {
    if (!(await readState(tx, organizationId, "update"))) return unavailable()
    return
  }
  const [set] = await tx.select({ organizationId: R.organizationId }).from(R).where(eq(R.organizationId, organizationId)).limit(1).for("share")
  const [policy] = await tx.select({ organizationId: P.organizationId }).from(P).where(eq(P.organizationId, organizationId)).limit(1).for("share")
  const [version] = await tx.select({ organizationId: V.organizationId }).from(V).where(eq(V.organizationId, organizationId)).limit(1).for("share")
  const [audit] = await tx.select({ organizationId: A.organizationId }).from(A).where(eq(A.organizationId, organizationId)).limit(1).for("share")
  if (set || policy || version || audit) return unavailable()
  await tx.insert(R).values({ organizationId, revision: 1, policies: [] })
  await tx.insert(S).values({ organizationId, enabled: false, revision: 1, policySetRevision: 1 })
}

async function readState(tx: GatewayGovernanceTx, organizationId: GatewayGovernanceScope["organizationId"], lock: "share" | "update") {
  const [organization] = await tx.select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
    .from(OrganizationTable).where(eq(OrganizationTable.id, organizationId)).for(lock)
  if (!organization) return null
  const [row] = await tx.select({ ...getTableColumns(S), enabled: sql<unknown>`${S.enabled}`.mapWith(storedEnabled) })
    .from(S).where(eq(S.organizationId, organizationId)).for(lock)
  if (!row) return null
  const settings = settingsView(row)
  const rows = await tx.select().from(P).where(eq(P.organizationId, organizationId)).orderBy(asc(P.id)).for("share")
  const policies = rows.map(policyView)
  const active = policies.filter((policy) => policy.status === "active")
  if (active.length > MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES) return unavailable()
  const [set] = await tx.select().from(R)
    .where(and(eq(R.organizationId, organizationId), eq(R.revision, settings.policySetRevision))).for("share")
  if (!set) return unavailable()
  const snapshot = gatewayGovernancePolicySchema.array().max(MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES).safeParse(set.policies)
  if (!snapshot.success || !equalPolicies(active, snapshot.data)) return unavailable()
  const versions = await tx.select({ snapshot: V.snapshot }).from(V).innerJoin(P, and(
    eq(P.organizationId, V.organizationId), eq(P.id, V.policyId), eq(P.revision, V.revision),
  )).where(eq(V.organizationId, organizationId)).for("share")
  const saved = gatewayGovernancePolicySchema.array().safeParse(versions.map((version) => version.snapshot))
  if (!saved.success || !equalPolicies(policies, saved.data)) return unavailable()
  return { organizationId: organization.id, metadata: organization.metadata, settings, policies }
}

export function readGatewayGovernanceState(db: DenDb, organizationId: string): Promise<GatewayGovernanceState | null> {
  return db.transaction((tx) => readState(tx, normalizeDenTypeId("organization", organizationId), "share"))
}

async function authorizeAdmin(tx: GatewayGovernanceTx, scope: GatewayGovernanceScope): Promise<void> {
  const [member] = await tx.select().from(MemberTable).where(and(
    eq(MemberTable.id, scope.memberId), eq(MemberTable.organizationId, scope.organizationId),
    isNull(MemberTable.removedAt), isNotNull(MemberTable.userId),
  )).for("share")
  if (!member) throw new GatewayGovernanceWriteError("forbidden", 403, "Current organization administrator required.")
  if (member.role.split(",").some((role) => ["owner", "admin", "super-admin"].includes(role.trim()))) return
  const teams = await tx.select({ id: TeamTable.id }).from(TeamMemberTable).innerJoin(TeamTable, and(
    eq(TeamTable.id, TeamMemberTable.teamId), eq(TeamTable.organizationId, scope.organizationId), eq(TeamTable.grantsOrganizationAdmin, true),
  )).where(eq(TeamMemberTable.orgMembershipId, scope.memberId)).for("share")
  if (!teams.length) throw new GatewayGovernanceWriteError("forbidden", 403, "Current organization administrator required.")
}

export function createGatewayGovernance(
  db: DenDb,
  options: { authorize: (metadata: unknown) => void; clock?: () => Date },
) {
  const clock = options.clock ?? (() => new Date())
  async function withAdmin<T>(scope: GatewayGovernanceScope, lock: "share" | "update", work: (tx: GatewayGovernanceTx, state: GatewayGovernanceState) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      const state = await readState(tx, scope.organizationId, lock)
      if (!state) return unavailable()
      await authorizeAdmin(tx, scope)
      return work(tx, state)
    })
  }
  async function audit(tx: GatewayGovernanceTx, scope: GatewayGovernanceScope, settings: GatewayGovernanceSettings, action: typeof A.$inferInsert.action, now: Date, policy?: GatewayGovernancePolicy, acknowledged = false) {
    await tx.insert(A).values({
      id: randomUUID(), organizationId: scope.organizationId, actorId: scope.memberId, action,
      policyId: policy?.id, policyRevision: policy?.revision, settingsRevision: settings.revision,
      policySetRevision: settings.policySetRevision, processingAcknowledged: acknowledged, createdAt: now,
    })
  }
  async function saveVersion(tx: GatewayGovernanceTx, scope: GatewayGovernanceScope, policy: GatewayGovernancePolicy, now: Date) {
    await tx.insert(V).values({ organizationId: scope.organizationId, policyId: policy.id, revision: policy.revision,
      snapshot: policy, createdBy: scope.memberId, createdAt: now })
  }
  async function saveSet(tx: GatewayGovernanceTx, scope: GatewayGovernanceScope, state: GatewayGovernanceState, policy: GatewayGovernancePolicy, now: Date): Promise<GatewayGovernanceSettings> {
    const active = state.policies.filter((existing) => existing.id !== policy.id && existing.status === "active")
    if (policy.status === "active") active.push(policy)
    if (active.length > MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES) {
      throw new GatewayGovernanceWriteError("governance_policy_limit", 409, "At most 20 governance policies can be active.")
    }
    if (policy.status === "active") assertPublicationBudget(active)
    const settings = { ...state.settings, revision: nextRevision(state.settings.revision), policySetRevision: nextRevision(state.settings.policySetRevision) }
    await tx.insert(R).values({ organizationId: scope.organizationId, revision: settings.policySetRevision, policies: active, createdBy: scope.memberId, createdAt: now })
    await tx.update(S).set({ ...settings, updatedBy: scope.memberId, updatedAt: now }).where(eq(S.organizationId, scope.organizationId))
    return settings
  }
  return {
    overview(scope: GatewayGovernanceScope): Promise<GatewayGovernanceState> {
      return withAdmin(scope, "share", async (_tx, state) => state)
    },
    updateSettings(scope: GatewayGovernanceScope, input: GatewayGovernanceSettingsPatch): Promise<GatewayGovernanceSettings> {
      const patch = gatewayGovernanceSettingsPatchSchema.parse(input)
      return withAdmin(scope, "update", async (tx, state) => {
        if (state.settings.revision !== patch.expectedRevision) {
          throw new GatewayGovernanceWriteError("governance_revision_conflict", 409, "Governance settings changed. Reload before editing.")
        }
        if (patch.enabled) {
          options.authorize(state.metadata)
          assertPublicationBudget(state.policies.filter((policy) => policy.status === "active"))
          if (patch.processingAcknowledged !== true) {
            throw new GatewayGovernanceWriteError("processing_acknowledgment_required", 400, "Acknowledge that new contributions and policy guidance are sent to TypeSafe before enabling governance.")
          }
        }
        const now = clock()
        const settings = { ...state.settings, enabled: patch.enabled, revision: nextRevision(state.settings.revision) }
        await tx.update(S).set({ ...settings, updatedBy: scope.memberId, updatedAt: now,
          ...(patch.enabled ? { processingAcknowledgedAt: now, processingAcknowledgedBy: scope.memberId } : {}),
        }).where(eq(S.organizationId, scope.organizationId))
        await audit(tx, scope, settings, patch.enabled ? "enabled" : "disabled", now, undefined, patch.enabled)
        return settings
      })
    },
    createPolicy(scope: GatewayGovernanceScope, input: GatewayGovernancePolicyWrite): Promise<GatewayGovernancePolicy> {
      const write = gatewayGovernancePolicyWriteSchema.parse(input)
      return withAdmin(scope, "update", async (tx, state) => {
        options.authorize(state.metadata)
        const now = clock()
        const policy: GatewayGovernancePolicy = { ...write, id: randomUUID(), status: "draft", revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() }
        await tx.insert(P).values({ ...policy, organizationId: scope.organizationId, createdBy: scope.memberId, updatedBy: scope.memberId, createdAt: now, updatedAt: now })
        await saveVersion(tx, scope, policy, now)
        await audit(tx, scope, state.settings, "policy_created", now, policy)
        return policy
      })
    },
    async listDecisions(scope: GatewayGovernanceScope, query: GatewayGovernanceDecisionPageQuery = {}): Promise<GatewayGovernanceDecisionListResponse> {
      const page = decisionPage(query)
      return db.transaction(async (tx) => {
        await authorizeAdmin(tx, scope)
        return listDecisionPage(tx, scope.organizationId, page)
      })
    },
    updatePolicy(scope: GatewayGovernanceScope, id: string, input: GatewayGovernancePolicyPatch): Promise<GatewayGovernancePolicy> {
      const patch = gatewayGovernancePolicyPatchSchema.parse(input)
      return withAdmin(scope, "update", async (tx, state) => {
        const previous = state.policies.find((policy) => policy.id === id)
        if (!previous) throw new GatewayGovernanceWriteError("governance_policy_not_found", 404, "Governance policy not found.")
        if (previous.revision !== patch.expectedRevision) {
          throw new GatewayGovernanceWriteError("governance_revision_conflict", 409, "Governance policy changed. Reload before editing.")
        }
        options.authorize(state.metadata)
        const now = clock()
        const policy: GatewayGovernancePolicy = {
          ...previous, name: patch.name ?? previous.name, guidance: patch.guidance ?? previous.guidance,
          status: patch.status ?? previous.status, revision: nextRevision(previous.revision), updatedAt: now.toISOString(),
        }
        let settings = state.settings
        if (previous.status === "active" || policy.status === "active") settings = await saveSet(tx, scope, state, policy, now)
        await tx.update(P).set({ name: policy.name, guidance: policy.guidance, status: policy.status, revision: policy.revision, updatedAt: now, updatedBy: scope.memberId })
          .where(and(eq(P.organizationId, scope.organizationId), eq(P.id, id)))
        await saveVersion(tx, scope, policy, now)
        await audit(tx, scope, settings, policy.status === "archived" ? "policy_archived" : policy.status === "active" ? "policy_published" : "policy_updated", now, policy)
        return policy
      })
    },
  }
}

export async function deleteGatewayGovernanceForOrganization(tx: GatewayGovernanceTx, organizationId: GatewayGovernanceScope["organizationId"]): Promise<void> {
  await tx.delete(M).where(eq(M.organizationId, organizationId))
  await tx.delete(D).where(eq(D.organizationId, organizationId))
  await tx.delete(A).where(eq(A.organizationId, organizationId))
  await tx.delete(V).where(eq(V.organizationId, organizationId))
  await tx.delete(R).where(eq(R.organizationId, organizationId))
  await tx.delete(P).where(eq(P.organizationId, organizationId))
  await tx.delete(S).where(eq(S.organizationId, organizationId))
}

export type GatewayGovernanceDecisionInput = {
  decisionId: string
  requestId: string
  organizationId: string
  memberId: string | null
  route: GatewayGovernanceDecisionRoute
  outcome: GatewayGovernanceDecisionOutcome
  policySetRevision: number | null
  policies: { id: string; revision: number }[]
  failedPolicies: { id: string; revision: number; name: string }[]
  evaluatorModel: string | null
  extractorVersion: string
  decisionVersion: string
  latencyMs: number
  evaluatorInputTokens: number | null
  evaluatorOutputTokens: number | null
  evaluatorAttempts: number
  createdAt: Date
}
export type GatewayGovernanceAdmissionLookup = { organizationId: string; memberId: string; digest: string; now: Date }
export type GatewayGovernanceAdmission = { decisionId: string; policySetRevision: number; expiresAt: Date }
export type GatewayGovernanceAdmissionInput = GatewayGovernanceAdmissionRecord
export type GatewayGovernanceDecisionPageQuery = { limit?: number; cursor?: string }
export type GatewayGovernancePruneResult = { decisions: number; admissions: number }

const PRUNE_BATCH_SIZE = 500
const PRUNE_MAX_BATCHES = 20
const MAX_DECISION_RETENTION_DAYS = 3650
const DAY_MS = 86_400_000

function invalid(code: string, message: string): never {
  throw new GatewayGovernanceWriteError(code, 400, message)
}
function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime())
}
function scopedId<TName extends "organization" | "member">(name: TName, value: string, code: string) {
  try {
    return normalizeDenTypeId(name, value)
  } catch {
    return invalid(code, `Invalid ${name} identifier.`)
  }
}

export async function recordGatewayGovernanceDecision(db: DenDb, row: GatewayGovernanceDecisionInput): Promise<void> {
  const parsed = gatewayGovernanceDecisionRecordSchema.safeParse(row)
  if (!parsed.success) return invalid("invalid_governance_decision", "Governance decision record is invalid.")
  const record = parsed.data
  const organizationId = scopedId("organization", record.organizationId, "invalid_governance_decision")
  const orgMembershipId = record.memberId === null ? null : scopedId("member", record.memberId, "invalid_governance_decision")
  await db.insert(D).values({
    id: randomUUID(),
    decisionId: record.decisionId,
    requestId: record.requestId,
    organizationId,
    orgMembershipId,
    route: record.route,
    outcome: record.outcome,
    policySetRevision: record.policySetRevision,
    policies: record.policies.map((policy) => ({ id: policy.id, revision: policy.revision })),
    failedPolicies: record.failedPolicies.map((policy) => ({ id: policy.id, revision: policy.revision, name: policy.name })),
    evaluatorModel: record.evaluatorModel,
    extractorVersion: record.extractorVersion,
    decisionVersion: record.decisionVersion,
    latencyMs: record.latencyMs,
    evaluatorInputTokens: record.evaluatorInputTokens,
    evaluatorOutputTokens: record.evaluatorOutputTokens,
    evaluatorAttempts: record.evaluatorAttempts,
    createdAt: record.createdAt,
  }).onDuplicateKeyUpdate({ set: { decisionId: sql`${D.decisionId}` } })
}

function admissionScope(input: { organizationId: string; memberId: string; digest: string }) {
  const digest = gatewayGovernanceContributionDigestSchema.safeParse(input.digest)
  if (!digest.success) return invalid("invalid_governance_admission", "Contribution digest must be 64 lowercase hexadecimal characters.")
  return {
    organizationId: scopedId("organization", input.organizationId, "invalid_governance_admission"),
    orgMembershipId: scopedId("member", input.memberId, "invalid_governance_admission"),
    digest: digest.data,
  }
}

export async function findGatewayGovernanceAdmission(db: DenDb, input: GatewayGovernanceAdmissionLookup): Promise<GatewayGovernanceAdmission | null> {
  const scope = admissionScope(input)
  if (!validDate(input.now)) return invalid("invalid_governance_admission", "Admission lookup time is invalid.")
  const [row] = await db.select({ decisionId: M.decisionId, policySetRevision: M.policySetRevision, expiresAt: M.expiresAt }).from(M).where(and(
    eq(M.organizationId, scope.organizationId),
    eq(M.orgMembershipId, scope.orgMembershipId),
    eq(M.contributionDigest, scope.digest),
    gt(M.expiresAt, input.now),
  )).limit(1)
  if (!row || row.expiresAt.getTime() <= input.now.getTime()) return null
  return { decisionId: row.decisionId, policySetRevision: row.policySetRevision, expiresAt: row.expiresAt }
}

export async function createGatewayGovernanceAdmission(db: DenDb, input: GatewayGovernanceAdmissionInput): Promise<void> {
  const parsed = gatewayGovernanceAdmissionRecordSchema.safeParse(input)
  if (!parsed.success) return invalid("invalid_governance_admission", "Governance admission record is invalid.")
  const record = parsed.data
  const scope = admissionScope(record)
  await db.insert(M).values({
    id: randomUUID(),
    organizationId: scope.organizationId,
    orgMembershipId: scope.orgMembershipId,
    contributionDigest: scope.digest,
    policySetRevision: record.policySetRevision,
    decisionId: record.decisionId,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  }).onDuplicateKeyUpdate({ set: {
    policySetRevision: record.policySetRevision,
    decisionId: record.decisionId,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  } })
}

export async function pruneGatewayGovernanceRecords(db: DenDb, input: { now: Date; decisionRetentionDays: number }): Promise<GatewayGovernancePruneResult> {
  if (!validDate(input.now)) return invalid("invalid_governance_retention", "Retention time is invalid.")
  if (!Number.isInteger(input.decisionRetentionDays) || input.decisionRetentionDays < 1 || input.decisionRetentionDays > MAX_DECISION_RETENTION_DAYS) {
    return invalid("invalid_governance_retention", `Decision retention must be between 1 and ${MAX_DECISION_RETENTION_DAYS} days.`)
  }
  const decisionCutoff = new Date(input.now.getTime() - input.decisionRetentionDays * DAY_MS)
  let decisions = 0
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const ids = (await db.select({ id: D.id }).from(D).where(lt(D.createdAt, decisionCutoff)).orderBy(asc(D.createdAt)).limit(PRUNE_BATCH_SIZE)).map((row) => row.id)
    if (!ids.length) break
    await db.delete(D).where(and(inArray(D.id, ids), lt(D.createdAt, decisionCutoff)))
    decisions += ids.length
    if (ids.length < PRUNE_BATCH_SIZE) break
  }
  let admissions = 0
  for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
    const ids = (await db.select({ id: M.id }).from(M).where(lte(M.expiresAt, input.now)).orderBy(asc(M.expiresAt)).limit(PRUNE_BATCH_SIZE)).map((row) => row.id)
    if (!ids.length) break
    await db.delete(M).where(and(inArray(M.id, ids), lte(M.expiresAt, input.now)))
    admissions += ids.length
    if (ids.length < PRUNE_BATCH_SIZE) break
  }
  return { decisions, admissions }
}

export async function deleteGatewayGovernanceAdmissionsForMember(tx: GatewayGovernanceTx, scope: GatewayGovernanceScope): Promise<void> {
  await tx.delete(M).where(and(eq(M.organizationId, scope.organizationId), eq(M.orgMembershipId, scope.memberId)))
}

type DecisionCursor = { createdAt: Date; id: string }
type DecisionPage = { limit: number; cursor: DecisionCursor | null }

export function encodeGatewayGovernanceDecisionCursor(cursor: DecisionCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.getTime(), cursor.id]), "utf8").toString("base64url")
}

export function decodeGatewayGovernanceDecisionCursor(value: string): DecisionCursor | null {
  if (!gatewayGovernanceDecisionCursorSchema.safeParse(value).success) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!Array.isArray(decoded) || decoded.length !== 2) return null
  const [time, id] = decoded
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0) return null
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  const cursor = { createdAt: new Date(time), id }
  return encodeGatewayGovernanceDecisionCursor(cursor) === value ? cursor : null
}

function decisionPage(query: GatewayGovernanceDecisionPageQuery): DecisionPage {
  const limit = query.limit ?? DEFAULT_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE) {
    return invalid("invalid_governance_decision_query", `Limit must be between 1 and ${MAX_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE}.`)
  }
  if (query.cursor === undefined) return { limit, cursor: null }
  const cursor = decodeGatewayGovernanceDecisionCursor(query.cursor)
  if (!cursor) return invalid("invalid_governance_decision_cursor", "Decision cursor is invalid. Reload the first page.")
  return { limit, cursor }
}

function decisionView(row: {
  decisionId: string; createdAt: Date; route: GatewayGovernanceDecisionRoute; outcome: GatewayGovernanceDecisionOutcome
  memberId: string | null; memberName: string | null; policySetRevision: number | null
  failedPolicies: unknown; latencyMs: number; evaluatorModel: string | null
}): GatewayGovernanceDecision {
  const parsed = gatewayGovernanceDecisionSchema.safeParse({
    decisionId: row.decisionId, createdAt: row.createdAt.toISOString(), route: row.route, outcome: row.outcome,
    memberId: row.memberId, memberName: row.memberName ? row.memberName : null, policySetRevision: row.policySetRevision,
    failedPolicies: row.failedPolicies, latencyMs: row.latencyMs, evaluatorModel: row.evaluatorModel,
  })
  if (!parsed.success) return unavailable()
  return parsed.data
}

async function listDecisionPage(tx: GatewayGovernanceTx, organizationId: GatewayGovernanceScope["organizationId"], page: DecisionPage): Promise<GatewayGovernanceDecisionListResponse> {
  const rows = await tx.select({
    id: D.id, decisionId: D.decisionId, createdAt: D.createdAt, route: D.route, outcome: D.outcome,
    memberId: D.orgMembershipId, memberName: AuthUserTable.name, policySetRevision: D.policySetRevision,
    failedPolicies: D.failedPolicies, latencyMs: D.latencyMs, evaluatorModel: D.evaluatorModel,
  }).from(D)
    .leftJoin(MemberTable, and(eq(MemberTable.id, D.orgMembershipId), eq(MemberTable.organizationId, D.organizationId)))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(
      eq(D.organizationId, organizationId),
      page.cursor ? or(lt(D.createdAt, page.cursor.createdAt), and(eq(D.createdAt, page.cursor.createdAt), lt(D.id, page.cursor.id))) : undefined,
    ))
    .orderBy(desc(D.createdAt), desc(D.id))
    .limit(page.limit + 1)
  const visible = rows.slice(0, page.limit)
  const last = visible.at(-1)
  return {
    decisions: visible.map(decisionView),
    nextCursor: rows.length > page.limit && last ? encodeGatewayGovernanceDecisionCursor({ createdAt: last.createdAt, id: last.id }) : null,
  }
}

export async function listGatewayGovernanceDecisions(db: DenDb, input: { organizationId: string } & GatewayGovernanceDecisionPageQuery): Promise<GatewayGovernanceDecisionListResponse> {
  const organizationId = scopedId("organization", input.organizationId, "invalid_governance_decision_query")
  const page = decisionPage(input)
  return db.transaction((tx) => listDecisionPage(tx, organizationId, page))
}
