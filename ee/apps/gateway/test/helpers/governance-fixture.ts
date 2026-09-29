import type { GatewayGovernancePolicy } from "@openwork/types/den/gateway-governance"
import { parseGatewayGovernanceConfig } from "@openwork-ee/utils/gateway-governance"
import { createGatewayGovernanceResolver, type ResolveGatewayGovernance } from "../../src/governance.js"
import { createGatewayGovernanceRecords, type GatewayGovernanceStore, type GovernanceAdmissionLookup, type GovernanceAdmissionWrite, type GovernanceDecisionRecord } from "../../src/governance-records.js"

export const knownGovernanceOff: ResolveGatewayGovernance = async () => ({ kind: "off", settingsRevision: 1 })

export function policyFixture(overrides: Partial<GatewayGovernancePolicy> = {}): GatewayGovernancePolicy {
  return { id: "policy_one", name: "Restricted content", guidance: "Reject the synthetic string BLOCK_ME.", status: "active", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides }
}

export function governanceConfig(overrides: Record<string, string | undefined> = {}) {
  return parseGatewayGovernanceConfig({
    GATEWAY_GOVERNANCE_MODE: "hosted",
    TYPESAFE_API_KEY: "synthetic-evaluator-key",
    GATEWAY_GOVERNANCE_PROCESSING_APPROVED: "true",
    GATEWAY_GOVERNANCE_PASS_MAX: "0.1",
    GATEWAY_GOVERNANCE_BLOCK_MIN: "0.9",
    ...overrides,
  })
}

export function governanceFixture(policies: GatewayGovernancePolicy[] = [policyFixture()]) {
  const state = { organizationId: "org_test_org", metadata: { plan: { tier: "enterprise" } },
    settings: { enabled: true, revision: 1, policySetRevision: 1 }, policies }
  const config = governanceConfig()
  const resolve = createGatewayGovernanceResolver({ loadState: async () => state, config: () => config })
  return { state, config, resolve }
}

export type MemoryGovernanceStore = GatewayGovernanceStore & {
  decisions: GovernanceDecisionRecord[]
  admissions: GovernanceAdmissionWrite[]
  lookups: GovernanceAdmissionLookup[]
  failLookup: boolean
  failWrite: boolean
  failDecision: boolean
}

export function memoryGovernanceStore(): MemoryGovernanceStore {
  const store: MemoryGovernanceStore = {
    decisions: [], admissions: [], lookups: [], failLookup: false, failWrite: false, failDecision: false,
    async recordDecision(row) {
      if (store.failDecision) throw new Error("PRIVATE_DECISION_WRITE_FAILURE")
      store.decisions.push(row)
    },
    async findAdmission(lookup) {
      store.lookups.push(lookup)
      if (store.failLookup) throw new Error("PRIVATE_LOOKUP_FAILURE")
      const found = store.admissions.find((row) => row.organizationId === lookup.organizationId && row.memberId === lookup.memberId
        && row.digest === lookup.digest && row.expiresAt.getTime() > lookup.now.getTime())
      return found ? { decisionId: found.decisionId, policySetRevision: found.policySetRevision, expiresAt: found.expiresAt } : null
    },
    async createAdmission(write) {
      if (store.failWrite) throw new Error("PRIVATE_RECEIPT_WRITE_FAILURE")
      const index = store.admissions.findIndex((row) => row.organizationId === write.organizationId && row.memberId === write.memberId && row.digest === write.digest)
      if (index >= 0) store.admissions[index] = write
      else store.admissions.push(write)
    },
  }
  return store
}

export function memoryGovernanceRecords(store: MemoryGovernanceStore = memoryGovernanceStore()) {
  return { store, records: createGatewayGovernanceRecords({ secret: () => "synthetic-db-encryption-key-for-governance-tests-0123456789", store }) }
}

export async function waitForDecisions(store: MemoryGovernanceStore, count = 1) {
  for (let attempt = 0; attempt < 100 && store.decisions.length < count; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  return store.decisions
}
