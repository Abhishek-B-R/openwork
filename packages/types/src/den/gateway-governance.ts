import { z } from "zod"

export const MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES = 20
export const GATEWAY_GOVERNANCE_ERROR_HEADER = "x-openwork-governance-error"
export const GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER = "x-openwork-governance-contribution-id"
export const GATEWAY_GOVERNANCE_SESSION_HEADER = "x-openwork-governance-session-id"

const revisionSchema = z.number().int().min(1).max(2_147_483_647)
const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const gatewayGovernancePolicyStatusSchema = z.enum(["draft", "active", "archived"])
export const gatewayGovernancePolicyWriteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  guidance: z.string().trim().min(1).max(4000),
}).strict()
export const gatewayGovernancePolicyPatchSchema = gatewayGovernancePolicyWriteSchema.partial().extend({
  expectedRevision: revisionSchema,
  status: gatewayGovernancePolicyStatusSchema.optional(),
}).strict().refine((value) => value.name !== undefined || value.guidance !== undefined || value.status !== undefined, {
  message: "Provide a policy change.",
})
export const gatewayGovernancePolicySchema = gatewayGovernancePolicyWriteSchema.extend({
  id: identifierSchema,
  status: gatewayGovernancePolicyStatusSchema,
  revision: revisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict()
export const gatewayGovernanceSettingsSchema = z.object({
  enabled: z.boolean(),
  revision: revisionSchema,
  policySetRevision: revisionSchema,
}).strict()
export const gatewayGovernanceSettingsPatchSchema = z.object({
  expectedRevision: revisionSchema,
  enabled: z.boolean(),
  processingAcknowledged: z.boolean().optional(),
}).strict()
export const gatewayGovernanceAvailabilitySchema = z.object({
  available: z.boolean(),
  mode: z.enum(["disabled", "hosted", "self_hosted_module"]),
  reason: z.enum(["ready", "enterprise_required", "module_disabled", "evaluator_unavailable", "processing_approval_required", "thresholds_required"]),
}).strict()
export const gatewayGovernanceOverviewSchema = z.object({
  settings: gatewayGovernanceSettingsSchema,
  policies: z.array(gatewayGovernancePolicySchema).refine(
    (policies) => policies.filter((policy) => policy.status === "active").length <= MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES,
    "Too many active governance policies.",
  ),
  availability: gatewayGovernanceAvailabilitySchema,
}).strict()
export const gatewayGovernanceViolationSchema = z.object({
  policy_id: identifierSchema,
  policy_revision: revisionSchema,
  policy_name: z.string().min(1).max(120),
}).strict()
export const gatewayGovernanceErrorSchema = z.object({
  error: z.object({
    source: z.literal("openwork_gateway"),
    type: z.literal("governance_error"),
    code: z.enum([
      "openwork_gateway_governance_blocked",
      "openwork_gateway_governance_uncertain",
      "openwork_gateway_governance_unsupported_input",
      "openwork_gateway_governance_unavailable",
      "openwork_gateway_governance_policy_changed",
    ]),
    message: z.string().min(1).max(4096),
    schema_version: z.literal(1),
    request_id: identifierSchema,
    decision_id: identifierSchema,
    contribution_id: identifierSchema.optional(),
    input_scope: z.literal("new_user_contribution"),
    upstream_dispatched: z.literal(false),
    retryable: z.literal(false),
    evaluation_complete: z.boolean(),
    violations: z.array(gatewayGovernanceViolationSchema).max(MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES),
  }).strict(),
}).strict()

export const MAX_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE = 100
export const DEFAULT_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE = 50
export const gatewayGovernanceDecisionRouteSchema = z.enum(["provider", "managed"])
export const gatewayGovernanceDecisionOutcomeSchema = z.enum([
  "allowed",
  "receipt_reused",
  "blocked",
  "uncertain",
  "unsupported_input",
  "unavailable",
  "policy_changed",
])
export const gatewayGovernanceDecisionPolicySchema = z.object({
  id: identifierSchema,
  revision: revisionSchema,
}).strict()
export const gatewayGovernanceFailedPolicySchema = gatewayGovernanceDecisionPolicySchema.extend({
  name: z.string().min(1).max(120),
}).strict()
export const gatewayGovernanceDecisionSchema = z.object({
  decisionId: identifierSchema,
  createdAt: z.iso.datetime(),
  route: gatewayGovernanceDecisionRouteSchema,
  outcome: gatewayGovernanceDecisionOutcomeSchema,
  memberId: z.string().min(1).max(64).nullable(),
  memberName: z.string().min(1).max(255).nullable(),
  policySetRevision: revisionSchema.nullable(),
  failedPolicies: z.array(gatewayGovernanceFailedPolicySchema).max(MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES),
  latencyMs: z.number().int().min(0).max(2_147_483_647),
  evaluatorModel: z.string().min(1).max(128).nullable(),
}).strict()
export const gatewayGovernanceDecisionCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/)
export const gatewayGovernanceDecisionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE).default(DEFAULT_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE),
  cursor: gatewayGovernanceDecisionCursorSchema.optional(),
}).strict()
export const gatewayGovernanceDecisionListResponseSchema = z.object({
  decisions: z.array(gatewayGovernanceDecisionSchema).max(MAX_GATEWAY_GOVERNANCE_DECISION_PAGE_SIZE),
  nextCursor: gatewayGovernanceDecisionCursorSchema.nullable(),
}).strict()

const MYSQL_TIMESTAMP_MIN_MS = Date.UTC(1970, 0, 1, 0, 0, 1)
const MYSQL_TIMESTAMP_MAX_MS = Date.UTC(2038, 0, 19, 3, 14, 7)
const storedTimestampSchema = z.date().refine(
  (value) => value.getTime() >= MYSQL_TIMESTAMP_MIN_MS && value.getTime() <= MYSQL_TIMESTAMP_MAX_MS,
  "Timestamp is outside the storable range.",
)
const versionLabelSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/)
const counterSchema = z.number().int().min(0).max(2_147_483_647)
const distinctPolicyIds = (policies: { id: string }[]) => new Set(policies.map((policy) => policy.id)).size === policies.length
export const MAX_GATEWAY_GOVERNANCE_EVALUATOR_ATTEMPTS = 16
export const gatewayGovernanceContributionDigestSchema = z.string().length(64).regex(/^[0-9a-f]{64}$/)
export const gatewayGovernanceDecisionRecordSchema = z.object({
  decisionId: identifierSchema,
  requestId: identifierSchema,
  organizationId: z.string().min(1).max(64),
  memberId: z.string().min(1).max(64).nullable(),
  route: gatewayGovernanceDecisionRouteSchema,
  outcome: gatewayGovernanceDecisionOutcomeSchema,
  policySetRevision: revisionSchema.nullable(),
  policies: z.array(gatewayGovernanceDecisionPolicySchema).max(MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES).refine(distinctPolicyIds, "Duplicate policy reference."),
  failedPolicies: z.array(gatewayGovernanceFailedPolicySchema).max(MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES).refine(distinctPolicyIds, "Duplicate failed policy reference."),
  evaluatorModel: z.string().min(1).max(128).nullable(),
  extractorVersion: versionLabelSchema,
  decisionVersion: versionLabelSchema,
  latencyMs: counterSchema,
  evaluatorInputTokens: counterSchema.nullable(),
  evaluatorOutputTokens: counterSchema.nullable(),
  evaluatorAttempts: z.number().int().min(0).max(MAX_GATEWAY_GOVERNANCE_EVALUATOR_ATTEMPTS),
  createdAt: storedTimestampSchema,
}).strict()
export const gatewayGovernanceAdmissionRecordSchema = z.object({
  organizationId: z.string().min(1).max(64),
  memberId: z.string().min(1).max(64),
  digest: gatewayGovernanceContributionDigestSchema,
  policySetRevision: revisionSchema,
  decisionId: identifierSchema,
  expiresAt: storedTimestampSchema,
  createdAt: storedTimestampSchema,
}).strict().refine((value) => value.expiresAt.getTime() > value.createdAt.getTime(), "Admission must expire after it is created.")

export type GatewayGovernanceDecisionRecord = z.infer<typeof gatewayGovernanceDecisionRecordSchema>
export type GatewayGovernanceAdmissionRecord = z.infer<typeof gatewayGovernanceAdmissionRecordSchema>
export type GatewayGovernanceDecisionRoute = z.infer<typeof gatewayGovernanceDecisionRouteSchema>
export type GatewayGovernanceDecisionOutcome = z.infer<typeof gatewayGovernanceDecisionOutcomeSchema>
export type GatewayGovernanceDecisionPolicy = z.infer<typeof gatewayGovernanceDecisionPolicySchema>
export type GatewayGovernanceFailedPolicy = z.infer<typeof gatewayGovernanceFailedPolicySchema>
export type GatewayGovernanceDecision = z.infer<typeof gatewayGovernanceDecisionSchema>
export type GatewayGovernanceDecisionListQuery = z.infer<typeof gatewayGovernanceDecisionListQuerySchema>
export type GatewayGovernanceDecisionListResponse = z.infer<typeof gatewayGovernanceDecisionListResponseSchema>
export type GatewayGovernancePolicy = z.infer<typeof gatewayGovernancePolicySchema>
export type GatewayGovernancePolicyWrite = z.infer<typeof gatewayGovernancePolicyWriteSchema>
export type GatewayGovernancePolicyPatch = z.infer<typeof gatewayGovernancePolicyPatchSchema>
export type GatewayGovernanceSettings = z.infer<typeof gatewayGovernanceSettingsSchema>
export type GatewayGovernanceSettingsPatch = z.infer<typeof gatewayGovernanceSettingsPatchSchema>
export type GatewayGovernanceOverview = z.infer<typeof gatewayGovernanceOverviewSchema>
export type GatewayGovernanceViolation = z.infer<typeof gatewayGovernanceViolationSchema>
export type GatewayGovernanceError = z.infer<typeof gatewayGovernanceErrorSchema>

/**
 * Engine-facing transport for a governance error. The native engine retries any
 * API error whose status is 5xx or whose message/body text contains transient
 * patterns (for example "500", "503", "rate limit", "try again later"), even
 * when the error is marked non-retryable. Request IDs, decision IDs, policy
 * IDs and admin-authored policy names can contain such text, so the engine
 * never sees them in the clear: it gets a non-5xx status, a static message, and
 * a body whose payload uses only the letters a–p (no digits, no words).
 */
export const GATEWAY_GOVERNANCE_ENGINE_BODY_KEY = "openwork_governance"
export const GATEWAY_GOVERNANCE_ENGINE_MESSAGE = "OpenWork organization policies stopped this request."
const ENGINE_ALPHABET = "abcdefghijklmnop"
const MAX_ENGINE_BODY_LENGTH = 262_144

export function gatewayGovernanceEngineStatus(error: GatewayGovernanceError): 403 | 422 {
  return error.error.code === "openwork_gateway_governance_blocked" ? 403 : 422
}

export function encodeGatewayGovernanceEngineBody(error: GatewayGovernanceError): string {
  const bytes = new TextEncoder().encode(JSON.stringify(error))
  let payload = ""
  for (const byte of bytes) payload += ENGINE_ALPHABET.charAt(byte >> 4) + ENGINE_ALPHABET.charAt(byte & 15)
  return JSON.stringify({ [GATEWAY_GOVERNANCE_ENGINE_BODY_KEY]: payload })
}

/** Accepts either the engine envelope or a raw Gateway governance body. */
export function decodeGatewayGovernanceEngineBody(body: string): GatewayGovernanceError | null {
  if (body.length > MAX_ENGINE_BODY_LENGTH) return null
  try {
    const parsed: unknown = JSON.parse(body)
    const raw = gatewayGovernanceErrorSchema.safeParse(parsed)
    if (raw.success) return raw.data
    if (!parsed || typeof parsed !== "object" || !(GATEWAY_GOVERNANCE_ENGINE_BODY_KEY in parsed)) return null
    const payload: unknown = Reflect.get(parsed, GATEWAY_GOVERNANCE_ENGINE_BODY_KEY)
    if (typeof payload !== "string" || payload.length % 2 !== 0 || !/^[a-p]*$/.test(payload)) return null
    const bytes = new Uint8Array(payload.length / 2)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = (ENGINE_ALPHABET.indexOf(payload.charAt(index * 2)) << 4) | ENGINE_ALPHABET.indexOf(payload.charAt(index * 2 + 1))
    }
    const decoded = gatewayGovernanceErrorSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
    return decoded.success ? decoded.data : null
  } catch {
    return null
  }
}

export function hasGatewayGovernanceHttpMarker(response: Pick<Response, "status" | "headers">): boolean {
  return [403, 422, 503].includes(response.status)
    && response.headers.get(GATEWAY_GOVERNANCE_ERROR_HEADER) === "1"
    && response.headers.get("x-should-retry") === "false"
}
