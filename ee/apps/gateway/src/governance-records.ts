import { createHmac, hkdfSync } from "node:crypto"

export const governanceAdmissionKeyInfo = "openwork-gateway-governance-admission-v1"
export const governanceAdmissionTtlMs = 30 * 60_000
export const governanceDecisionRetentionDays = 30

export type GovernanceDecisionOutcome = "allowed" | "receipt_reused" | "blocked" | "uncertain" | "unsupported_input" | "unavailable" | "policy_changed"
export type GovernanceRoute = "provider" | "managed"

export type GovernanceDecisionRecord = {
  decisionId: string
  requestId: string
  organizationId: string
  memberId: string | null
  route: GovernanceRoute
  outcome: GovernanceDecisionOutcome
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

export type GovernanceAdmissionLookup = { organizationId: string; memberId: string; digest: string; now: Date }
export type GovernanceAdmissionReceipt = { decisionId: string; policySetRevision: number; expiresAt: Date }
export type GovernanceAdmissionWrite = {
  organizationId: string
  memberId: string
  digest: string
  policySetRevision: number
  decisionId: string
  expiresAt: Date
  createdAt: Date
}
export type GovernancePruneResult = { decisions: number; admissions: number }

/** Persistence operations, shaped like the den-db helpers without the database handle. */
export type GatewayGovernanceStore = {
  recordDecision(row: GovernanceDecisionRecord): Promise<void>
  findAdmission(input: GovernanceAdmissionLookup): Promise<GovernanceAdmissionReceipt | null>
  createAdmission(input: GovernanceAdmissionWrite): Promise<void>
}

export type GovernanceDigestInput = { organizationId: string; memberId: string; extractorVersion: string; state: unknown }

export type GatewayGovernanceRecords = GatewayGovernanceStore & {
  digest(input: GovernanceDigestInput): string
}

export function deriveGovernanceAdmissionKey(secret: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), governanceAdmissionKeyInfo, 32))
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite value cannot be canonicalized")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`
  }
  throw new Error("Unsupported value cannot be canonicalized")
}

export function governanceAdmissionDigest(key: Uint8Array, input: GovernanceDigestInput): string {
  return createHmac("sha256", key)
    .update(canonical([input.organizationId, input.memberId, input.extractorVersion, input.state]), "utf8")
    .digest("hex")
}

export function createGatewayGovernanceRecords(input: { secret: () => string; store: GatewayGovernanceStore }): GatewayGovernanceRecords {
  let key: Uint8Array | undefined
  return {
    digest(digestInput) {
      key ??= deriveGovernanceAdmissionKey(input.secret())
      return governanceAdmissionDigest(key, digestInput)
    },
    recordDecision: (row) => input.store.recordDecision(row),
    findAdmission: (lookup) => input.store.findAdmission(lookup),
    createAdmission: (write) => input.store.createAdmission(write),
  }
}

export const dbGatewayGovernanceStore: GatewayGovernanceStore = {
  async recordDecision(row) {
    const [{ db }, helpers] = await Promise.all([import("./db.js"), import("@openwork-ee/den-db/gateway-governance")])
    await helpers.recordGatewayGovernanceDecision(db, row)
  },
  async findAdmission(lookup) {
    const [{ db }, helpers] = await Promise.all([import("./db.js"), import("@openwork-ee/den-db/gateway-governance")])
    return helpers.findGatewayGovernanceAdmission(db, lookup)
  },
  async createAdmission(write) {
    const [{ db }, helpers] = await Promise.all([import("./db.js"), import("@openwork-ee/den-db/gateway-governance")])
    await helpers.createGatewayGovernanceAdmission(db, write)
  },
}

export async function pruneGatewayGovernanceRecordsFromDb(now: Date): Promise<GovernancePruneResult> {
  const [{ db }, helpers] = await Promise.all([import("./db.js"), import("@openwork-ee/den-db/gateway-governance")])
  return helpers.pruneGatewayGovernanceRecords(db, { now, decisionRetentionDays: governanceDecisionRetentionDays })
}

export function createDbGatewayGovernanceRecords(secret: () => string): GatewayGovernanceRecords {
  return createGatewayGovernanceRecords({ secret, store: dbGatewayGovernanceStore })
}
