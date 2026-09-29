import {
  createGatewayGovernance,
  GatewayGovernanceWriteError,
  type GatewayGovernanceScope,
} from "@openwork-ee/den-db/gateway-governance"
import { getGatewayGovernanceAvailability, type GatewayGovernanceConfig } from "@openwork-ee/utils/gateway-governance"
import {
  gatewayGovernanceDecisionListQuerySchema,
  gatewayGovernanceDecisionListResponseSchema,
  gatewayGovernanceOverviewSchema,
  gatewayGovernancePolicyPatchSchema,
  gatewayGovernancePolicySchema,
  gatewayGovernancePolicyWriteSchema,
  gatewayGovernanceSettingsPatchSchema,
  gatewayGovernanceSettingsSchema,
} from "@openwork/types/den/gateway-governance"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import {
  ensureOrganizationAdmin,
  ensureOrganizationAdminRole,
  getFreshPrivilegedSessionRequiredResponse,
  orgAccessFailureStatus,
  type OrgRouteVariables,
} from "./shared.js"

const managementMessage = "Only workspace owners and admins can manage AI Gateway governance."
const errorSchema = z.object({ error: z.string(), message: z.string().optional(), reason: z.string().optional() })
const policyResponseSchema = z.object({ policy: gatewayGovernancePolicySchema }).strict()
const settingsResponseSchema = z.object({ settings: gatewayGovernanceSettingsSchema }).strict()
const paramsSchema = z.object({ id: z.string().uuid() }).strict()
const route = (summary: string, schema: z.ZodType, status: 200 | 201 = 200) => describeRoute({
  tags: ["Gateway Governance"], summary,
  description: "Organization-wide new-user-contribution screening. Governance is explicitly off initially. Active policy edits publish immutable revisions; archiving never deletes policy history. Publication and enablement validate serialized UTF-8 question sizes against both Jev limits while reserving at least 4096 bytes for serialized new contributions. Reads remain available to admins when the feature is locked. Writes require a recently authenticated owner/admin session. Enabling requires deployment availability, strict hosted Enterprise eligibility (or the self-hosted module), approved evaluator processing, configured thresholds, and explicit acknowledgment that new contributions and policy guidance are sent to TypeSafe. Disabling remains available after entitlement or evaluator loss.",
  security: [{ bearerAuth: [] }],
  responses: {
    [status]: jsonResponse(summary, schema),
    400: jsonResponse("Invalid request or missing disclosure acknowledgment", errorSchema),
    401: jsonResponse("Sign-in required", errorSchema),
    403: jsonResponse("Administrator permission, fresh authentication, or governance availability required", errorSchema),
    404: jsonResponse("Organization policy not found", errorSchema),
    409: jsonResponse("Revision conflict, active policy limit, or policy input budget exceeded", errorSchema),
    503: jsonResponse("Governance state unavailable", errorSchema),
  },
})
const decisionsRoute = describeRoute({
  tags: ["Gateway Governance"],
  summary: "List recent AI Gateway governance decisions",
  description: "Newest-first, tenant-scoped decision metadata for the authenticated organization: time, route, outcome, member, published policy-set revision, failed policy names, latency and evaluator model. Contributions, policy guidance and evaluator probabilities are never recorded or returned. Pass the returned opaque nextCursor to read older decisions; null means there are no more. Readable by owners and admins, including when governance is locked or disabled.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: jsonResponse("Recent governance decisions", gatewayGovernanceDecisionListResponseSchema),
    400: jsonResponse("Invalid limit or cursor", errorSchema),
    401: jsonResponse("Sign-in required", errorSchema),
    403: jsonResponse("Administrator permission required", errorSchema),
    503: jsonResponse("Governance decision history unavailable", errorSchema),
  },
})
type RouteContext = Context<{ Variables: OrgRouteVariables }>
const readAdmin: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  c.header("cache-control", "private, no-store")
  const permission = ensureOrganizationAdminRole(c, managementMessage)
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
  await next()
}
const writeAdmin: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  c.header("cache-control", "private, no-store")
  const permission = ensureOrganizationAdmin(c, managementMessage)
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
  if (c.get("apiKey")) return c.json(getFreshPrivilegedSessionRequiredResponse(), 403)
  await next()
}
function scope(c: { get: (key: "organizationContext") => OrgRouteVariables["organizationContext"] }): GatewayGovernanceScope {
  const actor = c.get("organizationContext")
  if (!actor) throw new GatewayGovernanceWriteError("organization_not_found", 404, "Organization not found.")
  return { organizationId: actor.organization.id, memberId: actor.currentMember.id }
}
async function respond<T>(c: Pick<RouteContext, "json">, work: () => Promise<T>, status: 200 | 201 = 200) {
  try {
    return c.json(await work(), status)
  } catch (error) {
    if (error instanceof GatewayGovernanceWriteError) return c.json({ error: error.code, message: error.message }, error.status)
    return c.json({ error: "gateway_governance_unavailable", message: "Organization governance state is unavailable." }, 503)
  }
}

export function authorizeGatewayGovernance(config: GatewayGovernanceConfig, metadata: unknown): void {
  const availability = getGatewayGovernanceAvailability(config, metadata)
  if (!availability.available) {
    throw new GatewayGovernanceWriteError(availability.reason, 403, "AI Gateway governance is not available with the current organization or deployment configuration.")
  }
}

export function registerOrgGatewayGovernanceRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  config: GatewayGovernanceConfig = env.gatewayGovernance,
  service = createGatewayGovernance(db, { authorize: (metadata) => authorizeGatewayGovernance(config, metadata) }),
) {
  app.get("/v1/gateway-governance", route("Read AI Gateway governance", gatewayGovernanceOverviewSchema), orgMemberRoute(), readAdmin,
    (c) => respond(c, async () => {
      const state = await service.overview(scope(c))
      return gatewayGovernanceOverviewSchema.parse({ settings: state.settings, policies: state.policies, availability: getGatewayGovernanceAvailability(config, state.metadata) })
    }))
  app.get("/v1/gateway-governance/decisions", decisionsRoute, orgMemberRoute(), readAdmin,
    queryValidator(gatewayGovernanceDecisionListQuerySchema),
    (c) => respond(c, async () => gatewayGovernanceDecisionListResponseSchema.parse(await service.listDecisions(scope(c), c.req.valid("query")))))
  app.patch("/v1/gateway-governance/settings", route("Update AI Gateway governance settings", settingsResponseSchema), orgMemberRoute(), writeAdmin,
    jsonValidator(gatewayGovernanceSettingsPatchSchema),
    (c) => respond(c, async () => ({ settings: await service.updateSettings(scope(c), c.req.valid("json")) })))
  app.post("/v1/gateway-governance/policies", route("Create a draft AI Gateway governance policy", policyResponseSchema, 201), orgMemberRoute(), writeAdmin,
    jsonValidator(gatewayGovernancePolicyWriteSchema),
    (c) => respond(c, async () => ({ policy: await service.createPolicy(scope(c), c.req.valid("json")) }), 201))
  app.patch("/v1/gateway-governance/policies/:id", route("Update or publish an AI Gateway governance policy", policyResponseSchema), orgMemberRoute(), writeAdmin,
    paramValidator(paramsSchema), jsonValidator(gatewayGovernancePolicyPatchSchema),
    (c) => respond(c, async () => ({ policy: await service.updatePolicy(scope(c), c.req.valid("param").id, c.req.valid("json")) })))
}
