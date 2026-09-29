import { sql } from "drizzle-orm"
import { boolean, char, check, index, int, json, mysqlEnum, mysqlTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

const organization = () => denTypeIdColumn("organization", "organization_id").notNull()
const date = (name: string) => timestamp(name, { fsp: 3 }).notNull().defaultNow()

export const GatewayGovernanceSettingsTable = mysqlTable("gateway_governance_settings", {
  organizationId: organization().primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  revision: int("revision").notNull().default(1),
  policySetRevision: int("policy_set_revision").notNull().default(1),
  updatedBy: denTypeIdColumn("member", "updated_by"),
  processingAcknowledgedAt: timestamp("processing_acknowledged_at", { fsp: 3 }),
  processingAcknowledgedBy: denTypeIdColumn("member", "processing_acknowledged_by"),
  createdAt: date("created_at"),
  updatedAt: date("updated_at"),
}, (t) => [check("gateway_governance_settings_revisions", sql`${t.revision} >= 1 and ${t.policySetRevision} >= 1`)])

export const GatewayGovernancePolicyTable = mysqlTable("gateway_governance_policy", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  organizationId: organization(),
  name: varchar("name", { length: 120 }).notNull(),
  guidance: text("guidance").notNull(),
  status: mysqlEnum("status", ["draft", "active", "archived"]).notNull().default("draft"),
  revision: int("revision").notNull().default(1),
  createdBy: denTypeIdColumn("member", "created_by").notNull(),
  updatedBy: denTypeIdColumn("member", "updated_by").notNull(),
  createdAt: date("created_at"),
  updatedAt: date("updated_at"),
}, (t) => [index("gateway_governance_policy_org").on(t.organizationId), check("gateway_governance_policy_revision", sql`${t.revision} >= 1`)])

export const GatewayGovernancePolicyRevisionTable = mysqlTable("gateway_governance_policy_revision", {
  organizationId: organization(),
  policyId: varchar("policy_id", { length: 64 }).notNull(),
  revision: int("revision").notNull(),
  snapshot: json("snapshot").$type<unknown>().notNull(),
  createdBy: denTypeIdColumn("member", "created_by").notNull(),
  createdAt: date("created_at"),
}, (t) => [primaryKey({ name: "gateway_governance_policy_revision_pk", columns: [t.organizationId, t.policyId, t.revision] })])

export const GatewayGovernancePolicySetTable = mysqlTable("gateway_governance_policy_set", {
  organizationId: organization(),
  revision: int("revision").notNull(),
  policies: json("policies").$type<unknown>().notNull(),
  createdBy: denTypeIdColumn("member", "created_by"),
  createdAt: date("created_at"),
}, (t) => [primaryKey({ columns: [t.organizationId, t.revision] })])

export const GatewayGovernanceAuditTable = mysqlTable("gateway_governance_audit", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  organizationId: organization(),
  actorId: denTypeIdColumn("member", "actor_id").notNull(),
  action: mysqlEnum("action", ["enabled", "disabled", "policy_created", "policy_updated", "policy_published", "policy_archived"]).notNull(),
  policyId: varchar("policy_id", { length: 64 }),
  policyRevision: int("policy_revision"),
  settingsRevision: int("settings_revision").notNull(),
  policySetRevision: int("policy_set_revision").notNull(),
  processingAcknowledged: boolean("processing_acknowledged").notNull().default(false),
  createdAt: date("created_at"),
}, (t) => [index("gateway_governance_audit_org_time").on(t.organizationId, t.createdAt)])

export const gatewayGovernanceDecisionRoutes = ["provider", "managed"] as const
export const gatewayGovernanceDecisionOutcomes = ["allowed", "receipt_reused", "blocked", "uncertain", "unsupported_input", "unavailable", "policy_changed"] as const
export type GatewayGovernanceDecisionPolicyRef = { id: string; revision: number }
export type GatewayGovernanceDecisionFailedPolicyRef = { id: string; revision: number; name: string }

export const GatewayGovernanceDecisionTable = mysqlTable("gateway_governance_decision", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  decisionId: varchar("decision_id", { length: 128 }).notNull(),
  requestId: varchar("request_id", { length: 128 }).notNull(),
  organizationId: organization(),
  orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
  route: mysqlEnum("route", gatewayGovernanceDecisionRoutes).notNull(),
  outcome: mysqlEnum("outcome", gatewayGovernanceDecisionOutcomes).notNull(),
  policySetRevision: int("policy_set_revision"),
  policies: json("policies").$type<GatewayGovernanceDecisionPolicyRef[]>().notNull(),
  failedPolicies: json("failed_policies").$type<GatewayGovernanceDecisionFailedPolicyRef[]>().notNull(),
  evaluatorModel: varchar("evaluator_model", { length: 128 }),
  extractorVersion: varchar("extractor_version", { length: 64 }).notNull(),
  decisionVersion: varchar("decision_version", { length: 64 }).notNull(),
  latencyMs: int("latency_ms").notNull(),
  evaluatorInputTokens: int("evaluator_input_tokens"),
  evaluatorOutputTokens: int("evaluator_output_tokens"),
  evaluatorAttempts: int("evaluator_attempts").notNull(),
  createdAt: date("created_at"),
}, (t) => [
  uniqueIndex("gateway_governance_decision_decision_id").on(t.decisionId),
  index("gateway_governance_decision_org_time").on(t.organizationId, t.createdAt, t.id),
  index("gateway_governance_decision_created").on(t.createdAt),
])

export const GatewayGovernanceAdmissionTable = mysqlTable("gateway_governance_admission", {
  id: varchar("id", { length: 64 }).notNull().primaryKey(),
  organizationId: organization(),
  orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
  contributionDigest: char("contribution_digest", { length: 64 }).notNull(),
  policySetRevision: int("policy_set_revision").notNull(),
  decisionId: varchar("decision_id", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  createdAt: date("created_at"),
}, (t) => [
  uniqueIndex("gateway_governance_admission_scope").on(t.organizationId, t.orgMembershipId, t.contributionDigest),
  index("gateway_governance_admission_expires").on(t.expiresAt),
])
